/**
 * Item 5 of spike #2: the engine cannot be the undo store.
 *
 * The claim is checked in the browser against the **installed** pdf.js build — the
 * page imports `pdfjs-dist/build/pdf.mjs?raw`, so the source it greps is the exact
 * file the running engine came from (Vite resolves it out of `node_modules`,
 * `pdfjs-dist@6.3.289`), not a quote copied out of a document. The same file on
 * disk was also inspected during development at the same line numbers.
 *
 * What is asserted:
 *  1. `class CommandManager` defaults to a 128-command history;
 *  2. a full history drops the oldest command with `#commands.splice(0, 1)`;
 *  3. it stores `{ cmd, undo, post, type }` — **function objects**;
 *  4. `saveDocument()` serializes `annotationStorage`, not the command history.
 * The function-object part is then confirmed at run time by the structured-clone /
 * IndexedDB probe in `persistence.ts`.
 */
import { version as pdfjsVersion } from 'pdfjs-dist';
import pdfjsSource from 'pdfjs-dist/build/pdf.mjs?raw';
import type { EngineHistoryEvidence, FunctionCloneProbe } from './types';

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export async function collectEngineEvidence(
  cloneProbe: FunctionCloneProbe | null,
): Promise<EngineHistoryEvidence> {
  const source = typeof pdfjsSource === 'string' ? pdfjsSource : '';
  const start = source.indexOf('class CommandManager');
  const slice = start >= 0 ? source.slice(start, start + 1500) : '';

  const maxSizeMatch = /constructor\(maxSize = (\d+)\)/.exec(slice);
  const capMatch = /if \(next === this\.#maxSize\) \{\s*this\.#commands\.splice\(0, 1\);\s*\}/.exec(slice);
  const addMatch = /add\(\{\s*cmd,\s*undo,\s*post,\s*mustExec,\s*type = NaN/.exec(slice);
  const saveMatch = /saveDocument\(\) \{\s*if \(this\.annotationStorage\.size <= 0\)/.exec(source);

  const defaultMaxSize = maxSizeMatch?.[1] ? Number.parseInt(maxSizeMatch[1], 10) : null;
  const capStatement = capMatch?.[0]?.replace(/\s+/g, ' ') ?? null;
  const addSignature = addMatch?.[0]?.replace(/\s+/g, ' ') ?? null;
  const storesFunctions =
    capStatement !== null &&
    addSignature !== null &&
    /const save = \{\s*cmd,\s*undo,\s*post,\s*type\s*\};/.test(slice);
  const saveDocumentSerializesAnnotationStorage = saveMatch !== null;

  const quoteStart = slice.indexOf('add({');
  const quote = slice
    .slice(0, quoteStart > 0 ? quoteStart + 260 : 480)
    .replace(/\n\s*/g, ' ')
    .trim();

  return {
    sourceAvailable: source.length > 0 && start >= 0,
    pdfjsVersion,
    sourceBytes: source.length,
    commandManagerLine: start >= 0 ? lineOf(source, start) : -1,
    defaultMaxSize,
    capStatement,
    addSignature,
    storesFunctions,
    saveDocumentSerializesAnnotationStorage,
    quote,
    cloneProbe,
    verdict:
      defaultMaxSize === 128 && capStatement !== null && storesFunctions
        ? 'pdf.js history is a 128-slot ring of function objects: not cloneable, not persistable, so the journal must own the store (K12)'
        : 'engine history could not be characterised from the installed source',
  };
}
