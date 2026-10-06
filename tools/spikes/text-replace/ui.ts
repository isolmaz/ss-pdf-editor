/**
 * Compact result view for spike #3 (throwaway, `PLAN.md §9/K21`).
 * Renders the per-case table, the before/after renders and the raw numbers.
 */

import { spikeWindow } from './globals';
import type { CaseResult, Round2Variant, SpikeResult } from './main';

function element(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function yesNo(value: boolean | undefined): HTMLElement {
  const span = element('span', value ? 'yes' : 'NO');
  span.className = value ? 'ok' : 'bad';
  return span;
}

function row(cells: (string | number | HTMLElement | null)[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (const cell of cells) {
    const td = element('td');
    if (cell instanceof HTMLElement) td.append(cell);
    else td.textContent = cell === null ? '—' : String(cell);
    tr.append(td);
  }
  return tr;
}

function table(headers: string[], rows: HTMLTableRowElement[]): HTMLTableElement {
  const node = document.createElement('table');
  const head = element('thead');
  const headRow = element('tr');
  for (const header of headers) headRow.append(element('th', header));
  head.append(headRow);
  const body = element('tbody');
  for (const entry of rows) body.append(entry);
  node.append(head, body);
  return node;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function caseRow(entry: CaseResult): HTMLTableRowElement {
  const rulesChanged = entry.pixels.rules.reduce((total, diff) => total + diff.changedPixels, 0);
  const images = entry.images.before.length === 0 ? 'n/a' : entry.images.survived ? 'intact' : 'CHANGED';
  return row([
    `${entry.label} (p${entry.page + 1})`,
    yesNo(entry.checks.oldTargetGoneMuPdf),
    yesNo(entry.checks.oldTargetGonePdfJs),
    yesNo(entry.checks.newTextSearchableMuPdf),
    yesNo(entry.checks.newTextSearchablePdfJs),
    yesNo(entry.checks.neighbourLinesIdentical),
    `${entry.checks.pageCountBefore}/${entry.checks.pageCountAfter}`,
    percent(entry.pixels.target.ratio),
    `${entry.pixels.neighbourTotal.changedPixels}/${entry.pixels.neighbourTotal.totalPixels}`,
    entry.pixels.rules.length === 0 ? 'n/a' : `${rulesChanged}/${entry.pixels.rules.length} bands`,
    images,
  ]);
}

function detailRow(entry: CaseResult): HTMLTableRowElement {
  return row([
    `${entry.id} region ${entry.region.map((value) => value.toFixed(1)).join(', ')}`,
    `wrapped ${entry.write.lines.length} lines${entry.write.overflowed ? ' (OVERFLOW)' : ''}`,
    `font ${entry.write.fontResource}${entry.write.embeddedNewFont ? ' (new)' : ' (reused)'}`,
    `missing ${entry.write.missingChars.length === 0 ? '—' : entry.write.missingChars.join('')}`,
    `Δplacement ${entry.checks.placementDelta?.map((value) => value.toFixed(1)).join(', ') ?? '—'}`,
    `advanceScale ${entry.placement.advanceScale.toFixed(4)}`,
    `bytes ${(entry.sizes.fixtureBytes / 1024).toFixed(1)}→${(entry.sizes.erasedBytes / 1024).toFixed(1)}→${(entry.sizes.finalBytes / 1024).toFixed(1)} KiB`,
    `objects ${entry.before.objects}→${entry.sizes.objectsAfter}`,
    `fonts ${entry.sizes.fontResourcesAfter.join(',')}`,
    `neighbours Δpx max ${entry.pixels.neighbourTotal.maxChannelDelta}`,
  ]);
}

function round2Row(entry: Round2Variant): HTMLTableRowElement {
  const missing = entry.coverageRound2Text.filter((item) => item.gid === 0).map((item) => item.char);
  const unusedMissing = entry.coverageUnusedSample.filter((item) => item.gid === 0).map((item) => item.char);
  return row([
    entry.label,
    yesNo(entry.locatedRound1Text),
    yesNo(entry.round1GoneMuPdf),
    yesNo(entry.round2SearchableMuPdf),
    yesNo(entry.round2SearchablePdfJs),
    yesNo(entry.neighbourLinesIdentical),
    `${entry.fontResourcesBefore.length}→${entry.fontResourcesAfter.length} fonts`,
    `${(entry.bytesBefore / 1024).toFixed(1)}→${(entry.bytesAfter / 1024).toFixed(1)} KiB`,
    `objects ${entry.objectsBefore}→${entry.objectsAfter}`,
    missing.length === 0 ? 'all covered' : `missing ${missing.join('')}`,
    unusedMissing.length === 0 ? 'unused sample covered' : `unused sample missing ${unusedMissing.join('')}`,
    entry.subsetFontsCalled ? 'subsetFonts()' : 'no subset',
  ]);
}

function renderJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, item) => {
      if (key === 'pngBefore' || key === 'pngAfter') return `<png ${String(item).length}B>`;
      return item as unknown;
    },
    1,
  );
}

export function renderResult(result: SpikeResult | null): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.replaceChildren();

  const error = spikeWindow.__spikeError;
  if (error) {
    const pre = element('pre', error, 'error');
    root.append(element('h2', 'Spike failed'), pre);
    return;
  }
  if (!result) {
    root.append(element('p', spikeWindow.__spikeProgress.join(' → ') || 'waiting for the harness'));
    return;
  }

  const summary = result.summary;
  root.append(
    element(
      'p',
      `summary: ${summary.oldTargetGone}/${summary.cases} old text gone · ${summary.newTextSearchable}/${summary.cases} new text searchable · ${summary.neighboursIntact}/${summary.cases} neighbours intact · ${summary.pageCountIntact}/${summary.cases} page counts intact · ${summary.ruleBandsUntouched}/${summary.ruleBandsTotal} rule bands untouched · images ${summary.imagesSurvived}/${summary.cases}`,
      'summary',
    ),
  );

  root.append(
    table(
      [
        'case',
        'old gone (mupdf)',
        'old gone (pdf.js)',
        'new found (mupdf)',
        'new found (pdf.js)',
        'neighbours',
        'pages',
        'target Δpx',
        'neighbour Δpx',
        'rules Δ',
        'image',
      ],
      result.cases.map(caseRow),
    ),
  );

  const details = element('details');
  details.append(element('summary', 'per-case detail'));
  details.append(
    table(
      [
        'region / placement',
        'wrap',
        'font',
        'glyph gaps',
        'placement Δ',
        'calibration',
        'size',
        'objects',
        'fonts on page',
        'noise',
      ],
      result.cases.map(detailRow),
    ),
  );
  root.append(details);

  const figures = element('div', undefined, 'figures');
  for (const entry of result.cases) {
    const card = element('figure');
    card.append(element('figcaption', `${entry.label} — before / after`));
    const pair = element('div', undefined, 'pair');
    for (const [label, png] of [
      ['before', entry.pngBefore],
      ['after', entry.pngAfter],
    ] as const) {
      if (!png) continue;
      const image = document.createElement('img');
      image.src = `data:image/png;base64,${png}`;
      image.alt = `${entry.id} ${label}`;
      pair.append(image);
    }
    card.append(pair);
    card.append(
      element(
        'p',
        `erase ${entry.erase.annotRect.map((value) => value.toFixed(1)).join(', ')} · pixels ${entry.pixels.target.changedPixels}/${entry.pixels.target.totalPixels} changed`,
        'caption',
      ),
    );
    figures.append(card);
  }
  root.append(figures);

  if (result.round2) {
    root.append(element('h2', 'Second edit round (reopen, replace again)'));
    root.append(
      table(
        [
          'variant',
          'located',
          'round1 gone',
          'round2 found (mupdf)',
          'round2 found (pdf.js)',
          'neighbours',
          'font res',
          'bytes',
          'objects',
          'new text coverage',
          'unused chars',
          'subsetting',
        ],
        result.round2.map(round2Row),
      ),
    );
  }

  root.append(element('h2', 'Fixture'));
  root.append(
    table(
      ['stage', 'page', 'font resource', 'BaseFont', 'embedded', 'subset', 'embedded bytes'],
      [
        ...result.meta.fixture.fontsBeforeSubset.map((font) =>
          row([
            'before subsetFonts()',
            font.page + 1,
            font.resource,
            font.baseFont,
            String(font.embedded),
            String(font.subset),
            font.embeddedBytes,
          ]),
        ),
        ...result.meta.fixture.fontsAfterSubset.map((font) =>
          row([
            'after subsetFonts()',
            font.page + 1,
            font.resource,
            font.baseFont,
            String(font.embedded),
            String(font.subset),
            font.embeddedBytes,
          ]),
        ),
      ],
    ),
  );
  root.append(
    element(
      'p',
      `fixture font coverage: ${result.meta.fixture.coverage.map((item) => `${item.char}=${item.gid}`).join(' ')}`,
      'caption',
    ),
  );

  const raw = element('details');
  raw.append(element('summary', 'raw window.__spikeResult'));
  raw.append(element('pre', renderJson(result)));
  root.append(raw);
}
