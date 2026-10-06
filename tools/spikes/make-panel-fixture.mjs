/**
 * Panel-content fixture (throwaway, `PLAN.md §9/K21`): one page that actually carries the
 * three things the reader panels exist for —
 *
 *   1. an **embedded file** (`/Names /EmbeddedFiles`) named `notlar.txt`,
 *   2. two **optional content groups** (layers) with content inside them, so visibility
 *      can be toggled and the page really changes,
 *   3. a **signature field** (`/FT /Sig`) with its widget, unsigned.
 *
 * Built on MuPDF's object model (`mupdf-fixture.mjs`); the layers and the signature
 * field are dictionaries written by hand. The fixture is throwaway tooling: never
 * committed as a document, regenerated on demand.
 *
 * Usage: node tools/spikes/make-panel-fixture.mjs [--out <path>]
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as mupdf from 'mupdf';
import { createFixture } from './mupdf-fixture.mjs';

const args = process.argv.slice(2);
const out = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : join(tmpdir(), 'pdf-editor-panels', 'panels-1p.pdf');
mkdirSync(dirname(out), { recursive: true });

const fixture = createFixture(mupdf);
const { doc } = fixture;
const page = fixture.addPage(595, 842);

// --- 1. embedded file -------------------------------------------------------------------
fixture.attach('notlar.txt', new TextEncoder().encode('PDF Editor panel fixture: embedded file payload\n'), {
  mimeType: 'text/plain',
  description: 'Fixture ek dosyasi',
});

// --- 2. optional content groups (layers) -------------------------------------------------
const onGroup = doc.addObject({ Type: 'OCG', Name: doc.newString('Zemin') });
const offGroup = doc.addObject({ Type: 'OCG', Name: doc.newString('Notlar') });
fixture.catalog().put('OCProperties', {
  OCGs: [onGroup, offGroup],
  D: { ON: [onGroup], OFF: [], Order: [onGroup, offGroup] },
});

page.text('Panel fixture', { x: 60, y: 780, size: 20 });
page.text('Layer content follows', { x: 60, y: 740, size: 14 });

// The two layers get their own marked content so a visibility toggle changes the page.
// The named OCGs have to resolve: /oc1 and /oc2 point at the group references.
const helv = fixture.helvetica();
page
  .resource('Properties', 'oc1', onGroup)
  .resource('Properties', 'oc2', offGroup)
  .raw(`q /OC /oc1 BDC 1 0 0 1 60 700 cm BT /${helv.key} 18 Tf 0 0 Td (Zemin katmani) Tj ET EMC Q`)
  .raw(`q /OC /oc2 BDC 1 0 0 1 60 660 cm BT /${helv.key} 18 Tf 0 0 Td (Notlar katmani) Tj ET EMC Q`);

// --- 3. signature field ------------------------------------------------------------------
const widget = page.annotate(
  doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: doc.newString('imzaAlani'),
    Rect: [60, 560, 260, 620],
    F: 4,
    P: page.object,
    MK: {},
  }),
);
fixture.catalog().put('AcroForm', doc.addObject({ Fields: [widget], SigFlags: 3, NeedAppearances: true }));

writeFileSync(out, fixture.save());
console.log(JSON.stringify({ out, bytes: statSync(out).size }, null, 1));
