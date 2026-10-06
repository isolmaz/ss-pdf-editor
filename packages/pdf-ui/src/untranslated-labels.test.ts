import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslator } from 'pdf-shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../../shared/src/i18n/en';
import { tr } from '../../shared/src/i18n/tr';
import { imageEditDialog } from './ops/image-edit';

/**
 * Regression: the pages panel's hover actions and the home screen's "remove from list"
 * button carried Turkish as a literal `title` / `aria-label`, so an English interface
 * announced "Saat Yönünde Döndür" and "Listeden kaldır". Every user-facing attribute must
 * come from the i18n catalogue; the only literals allowed are the language names the
 * language switcher shows in their own language.
 *
 * The scan reads the source as a syntax tree rather than with a pattern, so every way of
 * writing a literal into an attribute (quotes, template literals, either branch of a
 * conditional, a `??` default on something that is not a translator) is one case of the
 * same walk. `scanner` below is itself tested against a fixture per form, because a scan
 * that silently stops matching one form passes for ever.
 */
const here = dirname(fileURLToPath(import.meta.url));
const roots = [here, join(here, '..', '..', '..', 'apps', 'web', 'src')];
const OWN_LANGUAGE_NAMES = new Set(['Türkçe', 'English']);
const ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'alt',
  'label',
]);
const TURKISH_LETTER = /[çğıöşüÇĞİÖŞÜ]/;
/** A literal that is verbatim a catalogue message is a hard-coded copy of it, in either language. */
const CATALOGUE_TEXT = new Set(
  [...Object.values(tr), ...Object.values(en)]
    .map((message) => message.trim().toLowerCase())
    .filter((message) => message.length >= 3 && !message.includes('{')),
);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

/** `t(…)`, `t?.(…)`, `text_(…)` and `context.t(…)`: the catalogue's own lookup, whose second argument is a default. */
function isTranslatorCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression.getText();
  return callee === 't' || callee === 'text_' || callee.endsWith('.t');
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

/** Every string a value can render as, minus what a translator call supplies. */
function literalsOf(node: ts.Node, out: string[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) {
      literalsOf(span.expression, out);
      out.push(span.literal.text);
    }
    return;
  }
  if (isTranslatorCall(node)) return;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    // `t?.(key) ?? 'fallback'` is a shell mounted without a translator; any other left side is not.
    if (isTranslatorCall(unwrap(node.left))) return;
  }
  if (ts.isConditionalExpression(node)) {
    // `t ? t('key') : 'fallback'`: the same translator-less default as `t?.(key) ?? 'fallback'`.
    if (node.condition.getText() === 't') return;
    literalsOf(node.whenTrue, out);
    literalsOf(node.whenFalse, out);
    return;
  }
  // A comparison is logic, not text: `kind === 'ş'` renders nothing.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
    return;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    return;
  ts.forEachChild(node, (child) => literalsOf(child, out));
}

/** The user-facing literals of a `.tsx` source that are Turkish or a hard-coded catalogue message. */
function scanner(fileName: string, text: string): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const consider = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || OWN_LANGUAGE_NAMES.has(trimmed)) return;
    if (TURKISH_LETTER.test(trimmed) || CATALOGUE_TEXT.has(trimmed.toLowerCase())) found.push(trimmed);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText()) && node.initializer !== undefined) {
      const values: string[] = [];
      literalsOf(node.initializer, values);
      for (const value of values) consider(value);
    }
    if (ts.isJsxText(node)) {
      // Bare text between tags is shown as written. Only Turkish letters are judged here:
      // punctuation, numbers and single glyphs between tags are not catalogue messages.
      if (TURKISH_LETTER.test(node.text)) found.push(node.text.trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the scan itself', () => {
  const scan = (jsx: string): string[] => scanner('fixture.tsx', `export const X = () => (${jsx});`);

  it.each([
    ['a double-quoted attribute', '<b title="Saat Yönünde Döndür" />'],
    ['aria-label', '<b aria-label="Listeden kaldır" />'],
    ['placeholder', '<b placeholder="Ara…ş" />'],
    ['alt', '<b alt="Görsel" />'],
    ['a label prop', '<b label="Döndür" />'],
    ['a single-quoted expression', "<b title={'Döndür'} />"],
    ['a conditional, single quotes', "<b aria-label={open ? 'Kapat ışık' : 'Aç'} />"],
    ['a conditional, double quotes', '<b title={cond ? "Döndür" : text_(\'k\')} />'],
    ['the else branch only', "<b title={cond ? text_('k') : 'Döndür'} />"],
    ['a template literal', '<b title={`Döndür`} />'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is JSX source text
    ['a template literal with a substitution', '<b title={`Sayfa ${n} döndür`} />'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is JSX source text
    ['a substitution inside a template', "<b title={`${'Döndür'} ${n}`} />"],
    ['a ?? default on something that is not a translator', "<b title={label ?? 'Döndür'} />"],
    ['a conditional on something other than the translator', "<b title={ready ? 'Language' : 'x'} />"],
    ['a call that is not the translator', "<b title={format('Döndür')} />"],
    ['an attribute on its own line', '<b\n  title="Döndür" />'],
    ['a parenthesised expression', "<b title={('Döndür')} />"],
    ['a concatenation', "<b title={'Sayfa ' + 'döndür'} />"],
    ['bare text between tags', '<b>Döndür</b>'],
    ['a Turkish-free but hard-coded catalogue message', '<b title="Kapat" />'],
    ['a hard-coded English catalogue message', '<b title="Close" />'],
  ])('catches %s', (_name, jsx) => {
    expect(scan(jsx), jsx).not.toEqual([]);
  });

  it.each([
    ['a translator call', "<b title={t('k')} />"],
    ['a translator call with a default', "<b title={text_('k', 'Döndür')} />"],
    ['an optional translator call with a default', "<b aria-label={t?.('k') ?? 'Arayüz modu ş'} />"],
    ['a translator-or-default conditional', "<b aria-label={t ? t('k') : 'Language'} />"],
    ['a context translator', "<b title={context.t('k', { n: 1 })} />"],
    ['the language names, in their own language', '<b title="Türkçe" aria-label={\'English\'} />'],
    ['a comparison inside a conditional', "<b title={kind === 'ş' ? text_('a') : text_('b')} />"],
    ['an unrelated attribute', '<b data-note="Döndür" className="ş" />'],
    ['a dynamic value', '<b title={name} alt={image.alt ?? ""} />'],
    ['plain ASCII text between tags', '<b>12</b>'],
  ])('lets through %s', (_name, jsx) => {
    expect(scan(jsx), jsx).toEqual([]);
  });
});

describe('user-facing attributes are translated', () => {
  it('has no Turkish literal or hard-coded catalogue message in a user-facing attribute or in bare text', () => {
    const files = roots.flatMap(sources);
    // The scan reaching nothing would pass vacuously: pin that it really read the shell.
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((file) =>
      scanner(file, readFileSync(file, 'utf8')).map((value) => `${file}: ${value}`),
    );
    expect(offenders).toEqual([]);
  });

  it('builds the image picker labels from the catalogue, in the language of the translator', () => {
    const target = imageEditDialog.fields.find((field) => field.id === 'target');
    if (target === undefined || target.kind !== 'choice') throw new Error('the image dialog has no picker');
    const image = {
      pageIndex: 2,
      name: 'Im7',
      width: 100,
      height: 50,
      filter: null,
      bytes: 2048,
      hasMask: true,
      transformable: false,
      editable: true,
    };
    const labels = (locale: 'en' | 'tr') =>
      target.options({ t: createTranslator(locale), images: [image] } as never).map((option) => option.label);
    expect(labels('en')).toEqual([
      'Page 3 · Im7 · 100×50 · uncompressed · 2 KB · transparency · replace only',
    ]);
    expect(labels('tr')).toEqual([
      '3. sayfa · Im7 · 100×50 · sıkıştırılmamış · 2 KB · saydamlık · yalnızca değiştirilebilir',
    ]);
    // A named filter and a plain image: the optional pieces vanish rather than print "undefined".
    const plain = { ...image, filter: 'DCTDecode', hasMask: false, transformable: true };
    expect(target.options({ t: createTranslator('en'), images: [plain] } as never)[0]?.label).toBe(
      'Page 3 · Im7 · 100×50 · DCTDecode · 2 KB',
    );
  });
});
