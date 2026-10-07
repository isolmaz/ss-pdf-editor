/**
 * The home screen's tool grid, rendered with the real tool table: which tools it lists for
 * a set of commands, and when a tile is disabled.
 *
 * The translator stub renders the dictionary key, so the markup names what it shows.
 */

import type { Command } from 'pdf-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomeToolGrid from './HomeToolGrid';

const t = Object.assign((key: string) => key, { locale: 'en' as const }) as never;

function command(id: string, disabled?: boolean): Command {
  return {
    id,
    labelKey: 'tools.all',
    group: 'tools' as never,
    ...(disabled === undefined ? {} : { disabled }),
    run: () => undefined,
  };
}

function render(
  commands: readonly Command[],
  activeDocumentName: string | null,
  standalone: ReadonlySet<string> = new Set(),
): string {
  return renderToStaticMarkup(
    <HomeToolGrid
      t={t}
      commands={commands}
      activeDocumentName={activeDocumentName}
      standalone={standalone}
      onRun={() => undefined}
    />,
  );
}

/** Each tile's button, with whether it is disabled. */
function tiles(markup: string): { readonly description: string; readonly disabled: boolean }[] {
  return [
    ...markup.matchAll(/<button type="button"([^>]*)>.*?<span class="mt-0\.5[^>]*>([^<]*)<\/span>/g),
  ].map((match) => ({ description: match[2] ?? '', disabled: (match[1] ?? '').includes(' disabled=""') }));
}

describe('HomeToolGrid', () => {
  it('lists only the tools whose command exists, and says so when none does', () => {
    expect(render([], null)).toContain('home.tools.empty');
    const markup = render([command('tools.ink')], null);
    expect(tiles(markup)).toEqual([{ description: 'home.tool.ink', disabled: false }]);
    expect(markup).not.toContain('home.tools.empty');
  });

  it('names the open document and keeps a disabled command disabled for it', () => {
    const open = render([command('tools.ink', true)], 'report.pdf');
    expect(open).toContain('home.tools.activeDocument');
    expect(tiles(open)).toEqual([{ description: 'home.tool.ink', disabled: true }]);
  });

  it('offers a disabled tool anyway with no document open, and a standalone one with a document', () => {
    expect(tiles(render([command('tools.ink', true)], null))).toEqual([
      { description: 'home.tool.ink', disabled: false },
    ]);
    expect(tiles(render([command('tools.ink', true)], 'report.pdf', new Set(['tools.ink'])))).toEqual([
      { description: 'home.tool.ink', disabled: false },
    ]);
  });
});
