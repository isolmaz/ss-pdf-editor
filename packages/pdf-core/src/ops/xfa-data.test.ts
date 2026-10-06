/**
 * The XFA data layer, pure XML: how an AcroForm field name finds its data node through the
 * template, what a sync writes, what it refuses to guess, the date picture both ways, and
 * the markup of imported and exported data. The wrong answers that matter: a value written
 * to the wrong node (an unnamed subform counted as a data group), a check box that stores
 * "Yes" where the template says "1", a date stored as it is shown, a skipped field written
 * anyway, and a strict import that accepts a file that is not well-formed.
 */

import { describe, expect, it } from 'vitest';
import {
  dataElementOf,
  dataEntries,
  dataMarkupOf,
  decodePacket,
  displayDateToIso,
  encodePacket,
  exportDataXml,
  fillValueFor,
  isoDateToDisplay,
  parseXml,
  planSync,
  readBoundValue,
  replaceData,
  resolveBindings,
  type XfaFieldSnapshot,
} from './xfa-data';

const TEMPLATE = `<?xml version="1.0"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
  <subform name="form1">
    <pageSet><pageArea name="Page1"/></pageSet>
    <subform>
      <field name="Name"><ui><textEdit/></ui></field>
      <field name="Agree"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items></field>
      <field name="Birth"><ui><dateTimeEdit/></ui><format><picture>date{DD/MM/YYYY}</picture></format></field>
      <field name="Amount"><ui><numericEdit/></ui><format><picture>num{z,zz9.99}</picture></format></field>
      <field name="Scratch"><ui><textEdit/></ui><bind match="none"/></field>
      <field name="Linked"><ui><textEdit/></ui><bind match="dataRef" ref="$.Other.Thing"/></field>
      <exclGroup name="Size">
        <field name="Small"><ui><checkButton/></ui><items><text>S</text></items></field>
        <field name="Large"><ui><checkButton/></ui><items><text>L</text></items></field>
      </exclGroup>
    </subform>
    <subform name="Address"><field name="City"><ui><textEdit/></ui></field></subform>
  </subform>
</template>`;

const DATASETS = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Old</Name><Agree>0</Agree><Birth>2000-01-01</Birth><Address><City>Ankara</City></Address></form1></xfa:data></xfa:datasets>`;

const names = {
  name: 'form1[0].#subform[0].Name[0]',
  agree: 'form1[0].#subform[0].Agree[0]',
  birth: 'form1[0].#subform[0].Birth[0]',
  amount: 'form1[0].#subform[0].Amount[0]',
  scratch: 'form1[0].#subform[0].Scratch[0]',
  linked: 'form1[0].#subform[0].Linked[0]',
  small: 'form1[0].#subform[0].Size[0].Small[0]',
  large: 'form1[0].#subform[0].Size[0].Large[0]',
  city: 'form1[0].Address[0].City[0]',
};

const FIELDS = [
  { name: names.name, kind: 'text' },
  { name: names.agree, kind: 'checkbox' },
  { name: names.birth, kind: 'text' },
  { name: names.amount, kind: 'text' },
  { name: names.scratch, kind: 'text' },
  { name: names.linked, kind: 'text' },
  { name: names.small, kind: 'radio' },
  { name: names.large, kind: 'radio' },
  { name: names.city, kind: 'text' },
] as const;

const snap = (name: string, text: string | null, on: boolean | null = null): XfaFieldSnapshot => ({
  name,
  kind: FIELDS.find((field) => field.name === name)?.kind ?? 'text',
  text,
  on,
});

const bindingOf = (name: string) => {
  const found = resolveBindings(TEMPLATE, FIELDS).find((binding) => binding.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

describe('xfa-data bindings', () => {
  it('binds names to data nodes: named subforms are groups, unnamed ones and page areas are not', () => {
    expect(bindingOf(names.name).path).toEqual([
      { name: 'form1', index: 0 },
      { name: 'Name', index: 0 },
    ]);
    expect(bindingOf(names.city).path).toEqual([
      { name: 'form1', index: 0 },
      { name: 'Address', index: 0 },
      { name: 'City', index: 0 },
    ]);
    const agree = bindingOf(names.agree);
    expect([agree.on, agree.off]).toEqual(['1', '0']);
    expect(bindingOf(names.birth).datePicture).toBe('DD/MM/YYYY');
    // Radio buttons of one exclusion group share the group's data node.
    const small = bindingOf(names.small);
    const large = bindingOf(names.large);
    expect(small.path).toEqual(large.path);
    expect(small.path?.at(-1)?.name).toBe('Size');
    expect([small.group, large.group, small.on, large.on]).toEqual(['Size', 'Size', 'S', 'L']);
  });

  it('says why a field is not bound instead of guessing', () => {
    expect(bindingOf(names.scratch)).toMatchObject({ path: null, skip: 'no-binding' });
    expect(bindingOf(names.linked)).toMatchObject({ path: null, skip: 'data-ref' });
    expect(bindingOf(names.amount)).toMatchObject({ path: null, skip: 'formatted' });
    const [stray] = resolveBindings(TEMPLATE, [{ name: 'form9[0].Missing[0]', kind: 'text' }]);
    expect(stray).toMatchObject({ path: null, skip: 'unmapped' });
    // With no template packet at all, the shape of the name is the binding.
    const [bare] = resolveBindings(null, [{ name: 'form1[0].#subform[0].Name[0]', kind: 'text' }]);
    expect(bare?.path).toEqual([
      { name: 'form1', index: 0 },
      { name: 'Name', index: 0 },
    ]);
  });
});

describe('xfa-data dates', () => {
  it('converts between a display picture and the ISO date the data stores', () => {
    expect(displayDateToIso('31/01/2024', 'DD/MM/YYYY')).toBe('2024-01-31');
    expect(displayDateToIso('3.2.24', 'D.M.YY')).toBe('2024-02-03');
    expect(displayDateToIso('3.2.85', 'D.M.YY')).toBe('1985-02-03');
    expect(displayDateToIso('2024-02-03', 'DD/MM/YYYY')).toBeNull();
    expect(displayDateToIso('32/01/2024', 'DD/MM/YYYY')).toBeNull();
    expect(displayDateToIso('10/13/2024', 'DD/MM/YYYY')).toBeNull();
    expect(isoDateToDisplay('2024-01-31', 'DD/MM/YYYY')).toBe('31/01/2024');
    expect(isoDateToDisplay('2024-02-03', 'D.M.YY')).toBe('3.2.24');
    expect(isoDateToDisplay('31/01/2024', 'DD/MM/YYYY')).toBeNull();
    // The two directions agree.
    expect(displayDateToIso(isoDateToDisplay('1999-12-05', 'DD/MM/YYYY') ?? '', 'DD/MM/YYYY')).toBe(
      '1999-12-05',
    );
  });
});

describe('xfa-data sync plan', () => {
  const bindings = resolveBindings(TEMPLATE, FIELDS);

  it('writes what the widgets say into the nodes they bind to, and nothing else', () => {
    const plan = planSync(DATASETS, bindings, [
      snap(names.name, 'Çağrı Işık'),
      snap(names.agree, 'Yes', true),
      snap(names.birth, '31/01/2024'),
      snap(names.city, 'Ankara'),
      snap(names.scratch, 'ignored'),
      snap(names.linked, 'ignored'),
      snap(names.amount, '1,5'),
    ]);
    expect(plan?.changed).toEqual([names.name, names.agree, names.birth]);
    expect(plan?.unchanged).toBe(1);
    expect(plan?.skipped).toEqual([
      { name: names.amount, reason: 'formatted' },
      { name: names.scratch, reason: 'no-binding' },
      { name: names.linked, reason: 'data-ref' },
    ]);
    const xml = plan?.xml ?? '';
    // The check box stores the template's on item, the date the ISO date, never the widget's text.
    expect(dataEntries(xml)).toEqual([
      { path: 'form1/Name', value: 'Çağrı Işık' },
      { path: 'form1/Agree', value: '1' },
      { path: 'form1/Birth', value: '2024-01-31' },
      { path: 'form1/Address/City', value: 'Ankara' },
    ]);
    expect(xml).toContain('<Name>Çağrı Işık</Name>');
    expect(xml).not.toContain('ignored');
  });

  it('writes an unchecked box as the off item, a radio group by its chosen button, and only the fields asked for', () => {
    const off = planSync(DATASETS, bindings, [snap(names.agree, 'Off', false)]);
    // The data held "0" already: nothing to write.
    expect(off).toMatchObject({ xml: null, changed: [], unchanged: 1 });

    const chosen = planSync(DATASETS, bindings, [
      snap(names.small, 'Off', false),
      snap(names.large, 'x', true),
    ]);
    expect(dataEntries(chosen?.xml ?? '').find((entry) => entry.path === 'form1/Size')).toEqual({
      path: 'form1/Size',
      value: 'L',
    });
    // One data node however many buttons: it is written once.
    expect(chosen?.changed).toHaveLength(1);
    expect(chosen?.unchanged).toBe(1);

    // `only` leaves the others as the data holds them, however different the widgets are.
    const some = planSync(
      DATASETS,
      bindings,
      [snap(names.name, 'Yeni'), snap(names.city, 'İzmir')],
      new Set([names.name]),
    );
    expect(some?.changed).toEqual([names.name]);
    expect(some?.xml).toContain('<City>Ankara</City>');
  });

  it('creates the data nodes and the data element when they are missing, and refuses a group', () => {
    const empty = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"/>`;
    const created = planSync(empty, bindings, [snap(names.city, 'Van')]);
    expect(dataEntries(created?.xml ?? '')).toEqual([{ path: 'form1/Address/City', value: 'Van' }]);

    // A data node that already holds elements is a group: the field is skipped, the group is untouched.
    const grouped = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name><First>A</First></Name></form1></xfa:data></xfa:datasets>`;
    const plan = planSync(grouped, bindings, [snap(names.name, 'B')]);
    expect(plan).toMatchObject({ xml: null, skipped: [{ name: names.name, reason: 'data-group' }] });

    expect(planSync('<not xml', bindings, [snap(names.name, 'B')])).toBeNull();
    expect(readBoundValue(DATASETS, bindingOf(names.city))).toBe('Ankara');
    expect(readBoundValue(DATASETS, bindingOf(names.scratch))).toBeNull();
    expect(fillValueFor(bindingOf(names.agree), '1')).toEqual({ value: true });
    expect(fillValueFor(bindingOf(names.agree), '0')).toEqual({ value: false });
    expect(fillValueFor(bindingOf(names.birth), '2024-01-31')).toEqual({ value: '31/01/2024' });
    expect(fillValueFor(bindingOf(names.birth), 'soon')).toBeNull();
  });
});

describe('xfa-data import and export markup', () => {
  const bare = '<form1><Name>Ali</Name><Note>a &amp; b</Note></form1>';

  it('takes the same data out of a bare file, xfa:data, a datasets packet and a whole XDP', () => {
    const ns = 'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"';
    const wrapped = [
      bare,
      `<xfa:data ${ns}>${bare}</xfa:data>`,
      `<xfa:datasets ${ns}><xfa:data>${bare}</xfa:data></xfa:datasets>`,
      `<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><xfa:datasets ${ns}><xfa:data>${bare}</xfa:data></xfa:datasets></xdp:xdp>`,
    ];
    for (const file of wrapped) expect(dataMarkupOf(file)).toBe(bare);
    expect(dataEntries(`<xfa:datasets ${ns}><xfa:data>${bare}</xfa:data></xfa:datasets>`)).toEqual([
      { path: 'form1/Name', value: 'Ali' },
      { path: 'form1/Note', value: 'a & b' },
    ]);
    // A file that is not data: not XML, mismatched tags (strict), or an empty data element.
    expect(dataMarkupOf('plain text')).toBeNull();
    expect(dataMarkupOf('<form1><Name>Ali</form1>')).toBeNull();
    expect(dataMarkupOf(`<xfa:data ${ns}/>`)).toBeNull();
  });

  it('exports the data as a standalone file and replaces it from markup, keeping the packet around it', () => {
    expect(exportDataXml(DATASETS)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<form1><Name>Old</Name><Agree>0</Agree><Birth>2000-01-01</Birth><Address><City>Ankara</City></Address></form1>\n',
    );
    expect(exportDataXml('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"/>')).toBeNull();

    const replaced = replaceData(DATASETS, bare);
    expect(dataEntries(replaced ?? '')).toEqual([
      { path: 'form1/Name', value: 'Ali' },
      { path: 'form1/Note', value: 'a & b' },
    ]);
    expect(replaced).toContain('xfa:datasets');
    expect(replaceData(DATASETS, '<form1>&bogus;</form1>')).toBeNull();
    expect(replaceData('<other/>', bare)).toBeNull();
    const document = parseXml(replaced ?? '');
    expect(document === null ? null : dataElementOf(document)?.localName).toBe('data');
  });

  it('parses a producer quirk leniently and refuses it strictly; packets keep their encoding honest', () => {
    const quirky = '<a b=1><c/></a>';
    expect(parseXml(quirky)?.documentElement.localName).toBe('a');
    expect(parseXml(quirky, true)).toBeNull();
    // A mismatched tag is recovered from in a packet read from a document, refused in a file handed in.
    expect(parseXml('<a><b></a>')?.documentElement.localName).toBe('a');
    expect(parseXml('<a><b></a>', true)).toBeNull();
    expect(parseXml('<a>&bogus;</a>')).toBeNull();
    expect(parseXml('')).toBeNull();

    // UTF-16 with a byte-order mark decodes; what is written back is UTF-8 and says so.
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...[...'<a>Ş</a>'].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
    ]);
    expect(decodePacket(utf16)).toBe('<a>Ş</a>');
    const written = encodePacket('<?xml version="1.0" encoding="UTF-16"?><a>Ş</a>');
    expect(new TextDecoder().decode(written)).toBe('<?xml version="1.0" encoding="UTF-8"?><a>Ş</a>');
  });
});
