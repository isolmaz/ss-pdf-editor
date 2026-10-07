/**
 * `runPdfaConversion` against a stand-in for the Ghostscript module (the Emscripten boundary:
 * `callMain` and an in-memory `FS`). The real wasm is exercised by the PDF/A suites; here the
 * module's own behaviours are scripted that a real run does not show on demand: progress lines,
 * stderr, an exit that arrives as a thrown status, a failure that is no status, no output file,
 * and files that are already gone when the cleanup runs.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectWarnings,
  type GhostscriptFactoryOptions,
  type GhostscriptModule,
  ghostscriptFactory,
  type PdfaRunRequest,
  runPdfaConversion,
} from './ghostscript-run';

const request: PdfaRunRequest = {
  input: new Uint8Array([1, 2, 3]),
  part: 2,
  info: {
    title: null,
    author: null,
    subject: null,
    keywords: null,
    creator: null,
    creationDate: null,
    language: null,
  },
};

interface Behaviour {
  /** What the conversion call does, given the module's printers. */
  convert: (io: GhostscriptFactoryOptions, write: (path: string, data: Uint8Array) => void) => number;
  /** Files whose unlink throws. */
  stuck?: readonly string[];
}

function module(behaviour: Behaviour) {
  const files = new Map<string, string | Uint8Array>();
  const unlinked: string[] = [];
  let calls = 0;
  let io: GhostscriptFactoryOptions = { print: () => undefined, printErr: () => undefined };
  const factory = async (options: GhostscriptFactoryOptions): Promise<GhostscriptModule> => {
    io = options;
    return {
      callMain: () => {
        calls += 1;
        // The first call only copies the profile out of the read-only file system.
        if (calls === 1) return 0;
        return behaviour.convert(io, (path, data) => files.set(path, data));
      },
      FS: {
        writeFile: (path, data) => {
          files.set(path, data);
        },
        readFile: (path) => {
          const data = files.get(path);
          if (!(data instanceof Uint8Array)) throw new Error(`no such file ${path}`);
          return data;
        },
        unlink: (path) => {
          if (behaviour.stuck?.includes(path) === true || !files.has(path)) throw new Error('ENOENT');
          files.delete(path);
          unlinked.push(path);
        },
      },
    };
  };
  return { factory, files, unlinked };
}

describe('runPdfaConversion', () => {
  it('reports each page as it is written, collects the warnings, and removes its files', async () => {
    const gs = module({
      convert: (io, write) => {
        io.print('Processing pages 1 through 2.');
        io.print('Page 1');
        io.printErr('GPL Ghostscript 10.0: font substituted');
        io.printErr('GPL Ghostscript 10.0: font substituted');
        io.print('Page 2');
        io.print('something else');
        write('/tmp/output.pdf', new Uint8Array([9, 9]));
        return 0;
      },
    });
    const pages: Array<[number, number]> = [];
    const result = await runPdfaConversion(gs.factory, request, (page, total) => pages.push([page, total]));
    expect(pages).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(result).toEqual({
      output: new Uint8Array([9, 9]),
      exitCode: 0,
      warnings: [{ text: 'font substituted', count: 2 }],
      pageCount: 2,
    });
    expect([...gs.files.keys()]).toEqual([]);
  });

  it('runs without a page callback', async () => {
    const gs = module({
      convert: (io, write) => {
        io.print('Page 1');
        write('/tmp/output.pdf', new Uint8Array([1]));
        return 0;
      },
    });
    expect((await runPdfaConversion(gs.factory, request)).pageCount).toBe(1);
  });

  it('takes the exit status the engine throws, and returns the output it left', async () => {
    const gs = module({
      convert: (_io, write) => {
        write('/tmp/output.pdf', new Uint8Array([7]));
        throw { status: 3 };
      },
    });
    const result = await runPdfaConversion(gs.factory, request);
    expect(result.exitCode).toBe(3);
    expect(result.output).toEqual(new Uint8Array([7]));
  });

  it('answers an empty output when the engine wrote none', async () => {
    const gs = module({ convert: () => 1 });
    const result = await runPdfaConversion(gs.factory, request);
    expect(result.output).toEqual(new Uint8Array(0));
    expect(result.exitCode).toBe(1);
  });

  it('rethrows a failure that carries no numeric status', async () => {
    for (const thrown of [new Error('wasm trap'), { status: 'x' }, 'text', null]) {
      const gs = module({
        convert: () => {
          throw thrown;
        },
      });
      await expect(runPdfaConversion(gs.factory, request)).rejects.toBe(thrown);
    }
  });

  it('finishes even when a file cannot be removed', async () => {
    const gs = module({
      convert: (_io, write) => {
        write('/tmp/output.pdf', new Uint8Array([5]));
        return 0;
      },
      stuck: ['/tmp/output.pdf'],
    });
    const result = await runPdfaConversion(gs.factory, request);
    expect(result.output).toEqual(new Uint8Array([5]));
    expect(gs.files.has('/tmp/output.pdf')).toBe(true);
  });
});

describe('ghostscriptFactory', () => {
  it('imports the loader at the given URL and points its wasm lookup at the pinned file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gs-loader-'));
    try {
      const loader = join(directory, 'gs.mjs');
      writeFileSync(
        loader,
        `export default async (options) => ({ located: [options.locateFile('gs.wasm'), options.locateFile('gs.data')], print: options.print, printErr: options.printErr });`,
      );
      const printed: string[] = [];
      const factory = ghostscriptFactory(pathToFileURL(loader).href, 'https://example.test/pinned.wasm');
      const loaded = await factory({ print: (text) => printed.push(text), printErr: () => undefined });
      expect(loaded).toMatchObject({ located: ['https://example.test/pinned.wasm', 'gs.data'] });
      (loaded as unknown as { print: (text: string) => void }).print('hello');
      expect(printed).toEqual(['hello']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('collectWarnings', () => {
  it('drops a warning that says nothing', () => {
    expect(collectWarnings(['GPL Ghostscript 10.0:', 'GPL Ghostscript 10.0: real'])).toEqual([
      { text: 'real', count: 1 },
    ]);
  });
});
