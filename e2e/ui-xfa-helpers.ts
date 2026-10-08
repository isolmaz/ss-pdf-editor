/**
 * A dynamic XFA form as a plain-text PDF: a catalog whose AcroForm has no fields and an
 * `/XFA` array of packets, over one page that only says "Please wait…". pdf.js lays the
 * template out itself (`isPureXfa`), which is what the fill dialog and the flatten
 * operation open it for.
 */

export const XFA_TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb" locale="en_US" restoreState="auto">
<pageSet><pageArea id="Page1" name="Page1"><contentArea x="0.25in" y="0.25in" w="7.5in" h="10.5in"/><medium stock="default" short="8.5in" long="11in"/></pageArea></pageSet>
<subform layout="tb" w="7.5in">
<draw name="Heading" w="5in" h="0.4in"><ui><textEdit/></ui><value><text>Customer registration</text></value><font typeface="Helvetica" size="16pt" weight="bold"/></draw>
<field name="Name" w="3in" h="0.35in"><ui><textEdit><border><edge/></border></textEdit></ui><font typeface="Helvetica" size="12pt"/><caption placement="left" reserve="1in"><value><text>Full name</text></value></caption></field>
<field name="City" w="3in" h="0.35in"><ui><textEdit><border><edge/></border></textEdit></ui><font typeface="Helvetica" size="12pt"/><caption placement="left" reserve="1in"><value><text>City</text></value></caption></field>
</subform>
</subform>
</template>`;

export const XFA_DATASETS =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Ada Lovelace</Name><City>London</City></form1></xfa:data></xfa:datasets>';

const PREAMBLE = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">';
const POSTAMBLE = '</xdp:xdp>';

/** The dynamic form's bytes. All content is ASCII, so the offsets recorded are the real ones. */
export function dynamicXfaPdf(template = XFA_TEMPLATE, datasets = XFA_DATASETS): Uint8Array {
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  const placeholder = 'BT /F1 14 Tf 40 700 Td (Please wait...) Tj ET\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R /NeedsRendering true >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 4 0 R >>',
    stream(placeholder),
    '<< /Fields [] /XFA [(preamble) 6 0 R (template) 7 0 R (datasets) 8 0 R (postamble) 9 0 R] >>',
    stream(PREAMBLE),
    stream(template),
    stream(datasets),
    stream(POSTAMBLE),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets: number[] = [];
  let offset = (chunks[0] ?? '').length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xref = [
    'xref\n',
    `0 ${bodies.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return new Uint8Array([...(chunks.join('') + xref + trailer)].map((character) => character.charCodeAt(0)));
}
