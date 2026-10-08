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
  type XfaBinding,
  type XfaFieldKind,
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

const NS_DATA = 'http://www.xfa.org/schema/xfa-data/1.0/';
const datasetsOf = (data: string) =>
  `<xfa:datasets xmlns:xfa="${NS_DATA}"><xfa:data>${data}</xfa:data></xfa:datasets>`;
const NS_TEMPLATE = 'http://www.xfa.org/schema/xfa-template/3.3/';

/** A binding written out by hand, to drive the sync with exactly the shape a test needs. */
const bound = (over: Partial<XfaBinding> = {}): XfaBinding => ({
  name: 'f',
  kind: 'text',
  path: [
    { name: 'form1', index: 0 },
    { name: 'F', index: 0 },
  ],
  skip: null,
  on: null,
  off: null,
  group: null,
  datePicture: null,
  ...over,
});
const snapshot = (over: Partial<XfaFieldSnapshot> = {}): XfaFieldSnapshot => ({
  name: 'f',
  kind: 'text',
  text: null,
  on: null,
  ...over,
});
const entries = (xml: string | null | undefined) => dataEntries(xml ?? '');

describe('xfa-data templates the producers write beyond the usual shape', () => {
  const template = (body: string) =>
    `<template xmlns="${NS_TEMPLATE}"><subform name="form1">${body}</subform></template>`;
  const one = (xml: string, name: string, kind: XfaFieldKind = 'text') => {
    const [found] = resolveBindings(xml, [{ name, kind }]);
    if (found === undefined) throw new Error(name);
    return found;
  };
  const shape = template(`
    <area name="A1"><field name="InArea"><ui><textEdit/></ui></field></area>
    <exclGroup><field name="Small"><ui><checkButton/></ui></field></exclGroup>
    <subform name="Sub"/>
    <field name="Bare"/>
    <field name="Odd"><items><text>x</text></items></field>
    <field name="Day"><ui><dateTimeEdit/></ui><edit><picture>date{YYYY}</picture></edit></field>
    <field name="OnWidget"><ui><dateTimeEdit><picture>date{DD.MM.YYYY}</picture></dateTimeEdit></ui></field>
    <field name="NoPic"><ui><dateTimeEdit/></ui></field>
    <field name="EmptyDate"><ui><dateTimeEdit/></ui><format><picture>date{}</picture></format></field>
    <field name="Numeric"><ui><numericEdit/></ui></field>
    <field name="WordPic"><ui><textEdit/></ui><format><picture>text{999}</picture></format></field>
    <field name="Dup"/>
    <subform name="Other"><field name="Dup"/></subform>
    <subform><subform><field name="Deep"/></subform></subform>`);
  const root = { name: 'form1', index: 0 };

  it('skips the named area and keeps the form and the field in the data path', () => {
    expect(one(shape, 'form1[0].A1[0].InArea[0]').path).toEqual([root, { name: 'InArea', index: 0 }]);
    // A name without any [n] is the first occurrence.
    expect(one(shape, 'form1.Bare').path).toEqual([root, { name: 'Bare', index: 0 }]);
    expect(one(shape, 'form1[2].Bare[3]').path).toEqual([
      { name: 'form1', index: 2 },
      { name: 'Bare', index: 3 },
    ]);
  });

  it('binds a name that finds no node by the one template field that carries its last segment', () => {
    // `x` names no root subform; `InArea` is unique, so the template field is used and the
    // form's own index (0) stands in for the segments the name does not carry.
    expect(one(shape, 'x[0].InArea[0]').path).toEqual([root, { name: 'InArea', index: 0 }]);
    // Two template fields named `Dup`: nothing says which, so nothing is bound.
    expect(one(shape, 'x[0].Dup[0]')).toMatchObject({ path: null, skip: 'unmapped' });
    // A radio button in an unnamed exclusion group has no data node of its own to name.
    expect(one(shape, 'form1[0].Small[0]', 'radio')).toMatchObject({ path: null, skip: 'unmapped' });
  });

  it('counts an unnamed container past the template as the first one', () => {
    expect(one(shape, 'form1[0].#subform[7].#subform[0].Deep[0]').path).toEqual([
      root,
      { name: 'Deep', index: 0 },
    ]);
    expect(one(shape, 'form1[0].#pageSet[0].Deep[0]').path).toEqual([root, { name: 'Deep', index: 0 }]);
  });

  it('binds a name that is a subform and a field with no editor to their own data nodes', () => {
    expect(one(shape, 'form1[0].Sub[0]')).toMatchObject({
      path: [root, { name: 'Sub', index: 0 }],
      skip: null,
      on: null,
      off: null,
      datePicture: null,
    });
    expect(one(shape, 'form1[0].Bare[0]')).toMatchObject({ skip: null, on: null, group: null });
    expect(one(shape, 'form1[0].Odd[0]')).toMatchObject({ skip: null, on: 'x', off: null });
  });

  it('finds a date picture in /format, in /edit or on the widget, and skips a date it cannot reverse', () => {
    expect(one(shape, 'form1[0].Day[0]').datePicture).toBe('YYYY');
    expect(one(shape, 'form1[0].OnWidget[0]').datePicture).toBe('DD.MM.YYYY');
    expect(one(shape, 'form1[0].NoPic[0]')).toMatchObject({ path: null, skip: 'formatted' });
    expect(one(shape, 'form1[0].EmptyDate[0]')).toMatchObject({ path: null, skip: 'formatted' });
    expect(one(shape, 'form1[0].WordPic[0]')).toMatchObject({ path: null, skip: 'formatted' });
    expect(one(shape, 'form1[0].Numeric[0]')).toMatchObject({ skip: null, datePicture: null });
  });

  it('does not bind what a bind element sends elsewhere, wherever it sits above the field', () => {
    const global = template('<bind match="global"/><field name="F"/>');
    expect(one(global, 'form1[0].F[0]')).toMatchObject({ path: null, skip: 'global-binding' });
  });

  it('binds with no template by the shape of the name, except an untyped field or a name of containers only', () => {
    const [other, containers, plain] = resolveBindings(null, [
      { name: 'a.b', kind: 'other' },
      { name: '#subform[0]', kind: 'text' },
      { name: 'a.#subform[0].b', kind: 'text' },
    ]);
    expect(other).toMatchObject({ path: null, skip: 'unmapped' });
    expect(containers).toMatchObject({ path: null, skip: 'unmapped' });
    expect(plain?.path).toEqual([
      { name: 'a', index: 0 },
      { name: 'b', index: 0 },
    ]);
  });
});

describe('xfa-data XML plumbing', () => {
  it('returns null for text the parser refuses, by error or by throwing', () => {
    expect(parseXml('')).toBeNull();
    // A CDATA section followed by a doctype makes the parser itself throw.
    expect(parseXml('<a><![CDATA[x]]><!DOCTYPE')).toBeNull();
  });

  it('decodes UTF-16 in both byte orders', () => {
    const units = [...'<a>İ</a>'].map((character) => character.charCodeAt(0));
    const big = Uint8Array.from([0xfe, 0xff, ...units.flatMap((unit) => [unit >> 8, unit & 0xff])]);
    const little = Uint8Array.from([0xff, 0xfe, ...units.flatMap((unit) => [unit & 0xff, unit >> 8])]);
    expect(decodePacket(big)).toBe('<a>İ</a>');
    expect(decodePacket(little)).toBe('<a>İ</a>');
    expect(decodePacket(new TextEncoder().encode('<a>İ</a>'))).toBe('<a>İ</a>');
  });

  it('finds xfa:data as the root or below it, and nothing in another namespace', () => {
    const asRoot = parseXml(`<xfa:data xmlns:xfa="${NS_DATA}"><a>1</a></xfa:data>`);
    expect(asRoot === null ? null : dataElementOf(asRoot)?.localName).toBe('data');
    expect(entries(`<xfa:data xmlns:xfa="${NS_DATA}"><a>1</a></xfa:data>`)).toEqual([
      { path: 'a', value: '1' },
    ]);
    for (const text of [
      '<datasets><data><a>1</a></data></datasets>',
      '<data xmlns="urn:other"><a>1</a></data>',
    ]) {
      const document = parseXml(text);
      expect(document === null ? 'unparsed' : dataElementOf(document)).toBeNull();
      expect(entries(text)).toEqual([]);
    }
  });

  it('reads CDATA and a list’s value children as the text of a data node', () => {
    const xml = datasetsOf(
      '<sel><value>a</value><value>b</value></sel><c><![CDATA[x<y]]></c><d>1<!-- note -->2</d>',
    );
    expect(entries(xml)).toEqual([
      { path: 'sel', value: 'ab' },
      { path: 'c', value: 'x<y' },
      { path: 'd', value: '12' },
    ]);
  });
});

describe('xfa-data sync by hand-made bindings', () => {
  const DATA = datasetsOf('<form1><F>Old</F></form1>');

  it('writes an unset text field as empty', () => {
    expect(entries(planSync(DATA, [bound()], [snapshot({ text: null })])?.xml)).toEqual([
      { path: 'form1/F', value: '' },
    ]);
  });

  it('writes a choice field’s text, or nothing for an unset one', () => {
    for (const kind of ['dropdown', 'optionlist'] as const) {
      const set = planSync(DATA, [bound({ kind })], [snapshot({ kind, text: 'Bir' })]);
      expect(entries(set?.xml)).toEqual([{ path: 'form1/F', value: 'Bir' }]);
      const unset = planSync(DATA, [bound({ kind })], [snapshot({ kind, text: null })]);
      expect(entries(unset?.xml)).toEqual([{ path: 'form1/F', value: '' }]);
    }
  });

  it('writes a date as ISO, an empty date as empty, and skips a date it cannot read', () => {
    const date = bound({ datePicture: 'DD/MM/YYYY' });
    expect(entries(planSync(DATA, [date], [snapshot({ text: '31/01/2024' })])?.xml)).toEqual([
      { path: 'form1/F', value: '2024-01-31' },
    ]);
    expect(entries(planSync(DATA, [date], [snapshot({ text: '' })])?.xml)).toEqual([
      { path: 'form1/F', value: '' },
    ]);
    expect(planSync(DATA, [date], [snapshot({ text: '31/13/2024' })])).toMatchObject({
      xml: null,
      skipped: [{ name: 'f', reason: 'formatted' }],
    });
  });

  it('stores a checked box as the template’s on item, else the widget’s state, else 1; unchecked as the off item or nothing', () => {
    const box = (over: Partial<XfaBinding>, on: boolean, text: string | null) =>
      entries(
        planSync(DATA, [bound({ kind: 'checkbox', ...over })], [snapshot({ kind: 'checkbox', on, text })])
          ?.xml,
      );
    expect(box({ on: 'Y' }, true, 'Yes')).toEqual([{ path: 'form1/F', value: 'Y' }]);
    expect(box({}, true, 'Yes')).toEqual([{ path: 'form1/F', value: 'Yes' }]);
    expect(box({}, true, null)).toEqual([{ path: 'form1/F', value: '1' }]);
    expect(box({ off: 'N' }, false, null)).toEqual([{ path: 'form1/F', value: 'N' }]);
    expect(box({}, false, null)).toEqual([{ path: 'form1/F', value: '' }]);
  });

  it('stores a chosen radio button, an unchosen one as empty, and skips one with nothing to store', () => {
    const radio = (over: Partial<XfaBinding>, on: boolean, text: string | null) =>
      planSync(DATA, [bound({ kind: 'radio', ...over })], [snapshot({ kind: 'radio', on, text })]);
    expect(entries(radio({ on: 'S' }, true, 'x')?.xml)).toEqual([{ path: 'form1/F', value: 'S' }]);
    expect(entries(radio({}, true, 'chosen')?.xml)).toEqual([{ path: 'form1/F', value: 'chosen' }]);
    expect(entries(radio({}, false, null)?.xml)).toEqual([{ path: 'form1/F', value: '' }]);
    expect(radio({}, true, null)).toMatchObject({ xml: null, skipped: [{ name: 'f', reason: 'unmapped' }] });
  });

  it('shares one data node between the buttons of a group, whatever they carry', () => {
    const group = (name: string, over: Partial<XfaBinding> = {}) =>
      bound({ name, kind: 'radio', group: 'G', ...over });
    const plan = planSync(
      DATA,
      [group('a'), group('b', { on: 'B' })],
      [
        { name: 'a', kind: 'radio', text: null, on: true },
        { name: 'b', kind: 'radio', text: null, on: false },
      ],
    );
    // `a` is on but carries neither an on item nor a state: the group stores empty; `b` is off.
    expect(entries(plan?.xml)).toEqual([{ path: 'form1/F', value: '' }]);
  });

  it('skips a field of a kind it cannot store, and says nothing of one that has no data node by design', () => {
    expect(planSync(DATA, [bound({ kind: 'signature' })], [snapshot({ kind: 'signature' })])).toMatchObject({
      skipped: [{ name: 'f', reason: 'unmapped' }],
    });
    for (const skip of ['unmapped', null] as const) {
      expect(planSync(DATA, [bound({ path: null, skip })], [snapshot({ text: 'x' })])).toMatchObject({
        xml: null,
        skipped: [],
      });
    }
    expect(
      planSync(DATA, [bound({ path: null, skip: 'no-binding' })], [snapshot({ text: 'x' })]),
    ).toMatchObject({
      skipped: [{ name: 'f', reason: 'no-binding' }],
    });
  });

  it('makes the missing occurrences of a repeated node, each below its own parent', () => {
    const data = datasetsOf('<form1><Row><Cell>a</Cell></Row></form1>');
    const path = (row: number) => [
      { name: 'form1', index: 0 },
      { name: 'Row', index: row },
      { name: 'Cell', index: 0 },
    ];
    const plan = planSync(data, [bound({ path: path(3) })], [snapshot({ text: 'd' })]);
    expect(entries(plan?.xml)).toEqual([
      { path: 'form1/Row/Cell', value: 'a' },
      { path: 'form1/Row', value: '' },
      { path: 'form1/Row', value: '' },
      { path: 'form1/Row/Cell', value: 'd' },
    ]);
  });
});

describe('xfa-data reading values back', () => {
  const DATA = datasetsOf('<form1><F>x</F><Group><K>1</K></Group></form1>');

  it('reads a bound value, and null for text that is not XML, no data, no node or a group', () => {
    expect(readBoundValue(DATA, bound())).toBe('x');
    expect(readBoundValue('<not xml', bound())).toBeNull();
    expect(readBoundValue(`<xfa:datasets xmlns:xfa="${NS_DATA}"/>`, bound())).toBeNull();
    expect(
      readBoundValue(
        DATA,
        bound({
          path: [
            { name: 'form1', index: 0 },
            { name: 'Missing', index: 0 },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      readBoundValue(
        DATA,
        bound({
          path: [
            { name: 'form1', index: 0 },
            { name: 'Group', index: 0 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('turns a data value into what the widget takes, per kind', () => {
    expect(fillValueFor(bound({ kind: 'dropdown' }), 'Bir')).toEqual({ value: 'Bir' });
    expect(fillValueFor(bound({ kind: 'text' }), 'plain')).toEqual({ value: 'plain' });
    expect(fillValueFor(bound({ kind: 'text', datePicture: 'DD/MM/YYYY' }), '')).toEqual({ value: '' });
    // Without a template item a box is on for any value that is not empty or its off item.
    expect(fillValueFor(bound({ kind: 'checkbox', off: '0' }), 'x')).toEqual({ value: true });
    expect(fillValueFor(bound({ kind: 'checkbox', off: '0' }), '0')).toEqual({ value: false });
    expect(fillValueFor(bound({ kind: 'checkbox' }), '')).toEqual({ value: false });
    for (const kind of ['optionlist', 'radio', 'other'] as const) {
      expect(fillValueFor(bound({ kind }), 'x')).toBeNull();
    }
  });

  it('turns a date through every picture token and refuses what the picture does not describe', () => {
    expect(displayDateToIso('x', 'x')).toBeNull();
    expect(isoDateToDisplay('2024-03-05', 'D.M.YY')).toBe('5.3.24');
  });

  it('lists no entries for text that is not XML or has no data', () => {
    expect(entries('<not xml')).toEqual([]);
    expect(entries(`<xfa:datasets xmlns:xfa="${NS_DATA}"/>`)).toEqual([]);
  });
});

describe('xfa-data files with nothing to import', () => {
  const XDP = (inside: string) => `<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">${inside}</xdp:xdp>`;

  it('finds no data in an XDP or a datasets packet that has no xfa:data', () => {
    expect(dataMarkupOf(XDP(`<template xmlns="${NS_TEMPLATE}"/>`))).toBeNull();
    expect(dataMarkupOf(XDP(`<xfa:datasets xmlns:xfa="${NS_DATA}"><other/></xfa:datasets>`))).toBeNull();
    expect(dataMarkupOf(`<xfa:datasets xmlns:xfa="${NS_DATA}"><other/></xfa:datasets>`)).toBeNull();
    expect(
      dataMarkupOf(XDP(`<xfa:datasets xmlns:xfa="${NS_DATA}"><xfa:data><a>1</a></xfa:data></xfa:datasets>`)),
    ).toBe('<a>1</a>');
  });

  it('takes a bare document as the data unless it is empty', () => {
    expect(dataMarkupOf('<a/>')).toBeNull();
    expect(dataMarkupOf('<a>text</a>')).toBe('<a>text</a>');
  });

  it('exports and replaces nothing for text that is not XML or has no data to hold it', () => {
    expect(exportDataXml('<not xml')).toBeNull();
    expect(exportDataXml(`<xfa:datasets xmlns:xfa="${NS_DATA}"/>`)).toBeNull();
    expect(exportDataXml(datasetsOf(''))).toBeNull();
    expect(replaceData('<not xml', '<a/>')).toBeNull();
    expect(replaceData(`<xfa:datasets xmlns:xfa="${NS_DATA}"/>`, '<a/>')).toBeNull();
  });
});
