/**
 * The sample document the README recordings open (`readme-media.mjs`): a three-page service
 * agreement with headings, body text, a form field and a signature line, written with
 * MuPDF like every other fixture here. Not shipped; it exists so the GIFs show a document
 * that reads like a real one.
 */
import * as mupdf from 'mupdf';
import { createFixture } from './mupdf-fixture.mjs';

const INK = [0.12, 0.14, 0.18];
const MUTED = [0.38, 0.41, 0.47];
const ACCENT = [0.12, 0.3, 0.56];

/** Wrap `text` into lines of at most `width` characters (Helvetica body text at 11 pt). */
function wrap(text, width = 92) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (`${line} ${word}`.trim().length > width) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

/** @returns {Uint8Array} */
export function readmeDemoPdf() {
  const pdf = createFixture(mupdf);
  const bold = pdf.standardFont('Helvetica-Bold');
  pdf.info({ Title: 'Service Agreement', Author: 'Northwind Studio' });

  const sections = [
    [
      '1. Scope of work',
      'Northwind Studio will design and deliver a responsive website for the client, including ' +
        'a content audit, visual design, front-end development and a two-week launch period. ' +
        'Any work outside this scope is agreed in writing before it starts.',
    ],
    [
      '2. Timeline',
      'The project starts on 1 November 2026 and runs for ten weeks. Milestones are reviewed ' +
        'every Friday; a delay on either side moves the following milestones by the same amount.',
    ],
    [
      '3. Fees and payment',
      'The total fee is EUR 18,400, invoiced in three parts: 30% on signature, 40% at design ' +
        'approval and 30% on launch. Invoices are payable within 14 days of receipt.',
    ],
    [
      '4. Confidentiality',
      'Both parties keep confidential any information marked as such, during the project and ' +
        'for three years after it ends. This clause survives the termination of the agreement.',
    ],
  ];

  const pages = [
    { title: 'Service Agreement', sections: sections.slice(0, 2) },
    { title: 'Commercial terms', sections: sections.slice(2) },
    { title: 'Signatures', sections: [] },
  ];

  pages.forEach(({ title, sections: body }, index) => {
    const page = pdf.addPage(595.28, 841.89);
    page.rect({ x: 0, y: 801.89, width: 595.28, height: 40, color: ACCENT });
    page.text('NORTHWIND STUDIO', { x: 56, y: 816, size: 11, font: bold, color: [1, 1, 1] });
    page.text(`Page ${index + 1} of ${pages.length}`, { x: 470, y: 816, size: 10, color: [1, 1, 1] });
    page.text(title, { x: 56, y: 740, size: 24, font: bold, color: INK });
    let y = 700;
    if (index === 0) {
      page.text('Agreement no. NW-2026-114  |  Effective 1 November 2026', {
        x: 56,
        y,
        size: 10,
        color: MUTED,
      });
      y -= 40;
    }
    for (const [heading, text] of body) {
      page.text(heading, { x: 56, y, size: 14, font: bold, color: INK });
      y -= 24;
      for (const line of wrap(text)) {
        page.text(line, { x: 56, y, size: 11, color: INK });
        y -= 17;
      }
      y -= 22;
    }
    if (index === 2) {
      page.text('Client name', { x: 56, y: 680, size: 11, font: bold, color: INK });
      page.rect({ x: 56, y: 640, width: 260, height: 28, color: [0.95, 0.96, 0.98] });
      page.textField('client', [56, 640, 316, 668], '', { fontSize: 12 });
      page.text('Signed for Northwind Studio', { x: 56, y: 560, size: 11, font: bold, color: INK });
      page.rect({ x: 56, y: 500, width: 260, height: 1, color: MUTED });
      page.text('Name, date and signature', { x: 56, y: 484, size: 9, color: MUTED });
    }
  });
  return pdf.save();
}
