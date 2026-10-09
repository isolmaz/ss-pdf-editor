#!/usr/bin/env node
/**
 * docs-sync: the mechanical half of "the docs describe the code" (`pnpm check:docs`).
 * Node built-ins only. One line per problem (`file:line: message`), exit 1; otherwise exit 0
 * with a one-line summary of what was checked.
 *
 * Checks
 *  1. Docs (README.md, CONTRIBUTING.md, docs/*.md): every inline-code
 *     token that starts with `packages/ apps/ tools/ e2e/ docs/ .github/` (or is one of the named
 *     root files below) and every relative markdown/HTML link target exists, case-exactly (CI is
 *     Linux). `path:line`, `#anchor`, trailing punctuation are stripped; globs and placeholders
 *     (`* < { [ …`) only need their leading directory to exist.
 *  2. Every `pnpm <script>` / `pnpm run <script>` in inline code or fenced blocks is a root
 *     package.json script or a pnpm built-in; `pnpm --filter <pkg> <script>` needs a workspace
 *     package of that name that has the script.
 *  3. Each Turkish site page and its English page (paired by the hreflang alternates the pages
 *     declare) have the same number of h1/h2/h3/li/details/section/img/a[href].
 *  4. Every relative href/src in the site pages resolves to a file of apps/site, the repo
 *     `public/` directory (assemble-dist copies it to the root; the site build has
 *     `publicDir: false`), or a path pinned in tools/asset-pins.json (fonts and engines are
 *     fetched, not committed, so they are absent from a fresh checkout).
 *
 * Deliberately not checked: whether prose is true, `#anchor` targets, fenced-block paths, bare
 * file names (`tr.ts`) other than the root files listed here, build output (`dist`, `coverage`,
 * ...), `public/` paths in docs, absolute URLs, and `/editor/...` (served by the app).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = 'apps/site';
const problems = [];
const stats = { docs: 0, paths: 0, links: 0, pnpm: 0, pages: 0, pairs: 0, siteLinks: 0 };
const report = (file, line, message) => problems.push(`${file}:${line}: ${message}`);
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const countLines = (s) => (s.match(/\n/g) ?? []).length;

// Case-exact existence (Windows and macOS would accept `Readme.md`; the Linux CI would not).
const listings = new Map();
function names(dir) {
  if (!listings.has(dir)) listings.set(dir, new Set(existsSync(dir) ? readdirSync(dir) : []));
  return listings.get(dir);
}
function exists(abs) {
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.split(sep)[0] === '..') return false;
  let cur = root;
  for (const part of rel.split(sep)) {
    if (part === '' || part === '.') continue;
    if (!names(cur).has(part)) return false;
    cur = join(cur, part);
  }
  return true;
}
const isFile = (abs) => exists(abs) && statSync(abs).isFile();

// ---- workspace facts ---------------------------------------------------------------------------
const rootScripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts ?? {}));
const packages = new Map(); // name -> Set(script)
for (const [, glob] of read('pnpm-workspace.yaml').matchAll(/^\s*-\s*['"]?([^'"\s#]+)/gm)) {
  const dirs = glob.endsWith('/*')
    ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'node_modules')
        .map((d) => `${glob.slice(0, -2)}/${d.name}`)
    : [glob];
  for (const dir of dirs) {
    if (!existsSync(join(root, dir, 'package.json'))) continue;
    const pkg = JSON.parse(read(`${dir}/package.json`));
    packages.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
  }
}
const pinned = new Set(); // public/-relative paths listed in tools/asset-pins.json
(function collect(node) {
  if (node === null || typeof node !== 'object') return;
  if (typeof node.path === 'string') pinned.add(node.path);
  for (const value of Object.values(node)) collect(value);
})(JSON.parse(read('tools/asset-pins.json')));

// ---- 1 + 2: docs ---------------------------------------------------------------------------------
const PATH_PREFIX = /^(?:\.github\/|(?:packages|apps|tools|e2e|docs)\/)/;
const ROOT_FILES = new Set([
  'playwright.config.ts',
  'vitest.config.ts',
  'vitest.measure.config.ts',
  'vitest.setup.ts',
  'wrangler.jsonc',
  'package.json',
  'pnpm-workspace.yaml',
  'biome.json',
  'tsconfig.json',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
]); // explicit: a bare `tr.ts` is a module name, not a root file
const BUILD_OUTPUT = new Set(['dist', 'node_modules', 'coverage', 'test-results', 'playwright-report']);
const PLACEHOLDER = /[*<{[…]|\.\.\./;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PNPM_BUILTINS = new Set(
  (
    'add audit bin cache config create dedupe deploy dlx doctor env exec fetch i import init install ' +
    'install-test it licenses link list ln ls outdated pack patch patch-commit prune publish rebuild ' +
    'remove rm root run run-script sbom self-update setup store unlink up update upgrade view why'
  ).split(' '),
); // `test`/`start`/`stop`/`restart` are deliberately absent: they need a script
const NAME = /^[a-z][\w:.-]*$/i;

function checkPath(file, line, raw) {
  let token = raw.replace(/^["'([]+/, '');
  if (!PATH_PREFIX.test(token) && !ROOT_FILES.has(token.replace(/["'),.;:!?\]\\]+$/, ''))) return;
  const glob = token.search(PLACEHOLDER);
  if (glob >= 0) {
    const dir = token.slice(0, token.lastIndexOf('/', glob) + 1);
    stats.paths++;
    if (dir !== '' && !exists(join(root, dir)))
      report(file, line, `\`${raw}\`: directory ${dir} does not exist`);
    return;
  }
  token = token
    .replace(/["'),.;:!?\]\\]+$/, '')
    .replace(/[#?].*$/, '')
    .replace(/:.*$/, '');
  if (token.split('/').some((part) => BUILD_OUTPUT.has(part))) return;
  stats.paths++;
  if (!exists(join(root, token))) report(file, line, `\`${raw}\`: ${token} does not exist`);
}

function checkLink(file, line, target, docDir) {
  if (target.startsWith('#') || target.startsWith('//') || SCHEME.test(target)) return;
  let path = target.replace(/[#?].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw text */
  }
  if (path === '' || path.split('/').some((part) => BUILD_OUTPUT.has(part))) return;
  stats.links++;
  const abs = path.startsWith('/') ? join(root, path) : resolve(docDir, path);
  if (!exists(abs)) report(file, line, `link target ${target} does not exist`);
}

function checkPnpm(file, line, args) {
  let filter;
  let recursive = false;
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '--filter' || args[i] === '-F') filter = args[++i];
    else if (args[i].startsWith('--filter=')) filter = args[i].slice('--filter='.length);
    else if (args[i] === '-r' || args[i] === '--recursive') recursive = true;
  }
  let name = args[i];
  if (name === 'run' || name === 'run-script') name = args[i + 1];
  else if (PNPM_BUILTINS.has(name ?? '')) name = undefined;
  let scripts = rootScripts;
  let where = 'the root package.json';
  if (filter !== undefined) {
    filter = filter.replace(/^["']|["']$/g, '');
    if (!/^[\w@][\w@/.-]*$/.test(filter) || filter.includes('...')) return; // placeholder or selector
    stats.pnpm++;
    scripts = packages.get(filter);
    if (scripts === undefined)
      return report(file, line, `pnpm --filter ${filter}: no workspace package has that name`);
    where = `package ${filter}`;
  }
  if (name === undefined || !NAME.test(name) || recursive) return;
  stats.pnpm++;
  if (!scripts.has(name)) report(file, line, `pnpm ${name}: no such script in ${where}`);
}

function checkCommands(file, line, text) {
  for (const segment of text.split(/&&|\|\||;|\|/)) {
    const command = segment
      .trim()
      .replace(/^\$\s+/, '')
      .replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
    if (/^pnpm\s/.test(command)) checkPnpm(file, line, command.split(/\s+/).slice(1));
  }
}

function scanDoc(file) {
  stats.docs++;
  const docDir = dirname(join(root, file));
  let fence = null; // the opening fence marker while inside a fenced block
  let paragraph = null;
  const flush = () => {
    if (paragraph === null) return;
    const { start, lines } = paragraph;
    paragraph = null;
    const text = lines.join('\n');
    const lineAt = (index) => start + countLines(text.slice(0, index));
    for (const m of text.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
      const span = m[2].replace(/\s+/g, ' ').trim();
      const line = lineAt(m.index);
      checkCommands(file, line, span);
      for (const token of span.split(' ')) checkPath(file, line, token);
    }
    const prose = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m0) => m0.replace(/[^\n]/g, ' '));
    const link = /\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|\b(?:src|href)=["']([^"']+)["']/g;
    for (const m of prose.matchAll(link)) checkLink(file, lineAt(m.index), m[1] ?? m[2], docDir);
  };
  for (const [index, text] of read(file).split(/\r?\n/).entries()) {
    const line = index + 1;
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence !== null) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^\s*[`~]+\s*$/.test(text)
      )
        fence = null;
      else checkCommands(file, line, text.replace(/(^|\s)#.*$/, '$1'));
    } else if (marker !== undefined) {
      flush();
      fence = marker;
    } else if (text.trim() === '') flush();
    else if (paragraph === null) paragraph = { start: line, lines: [text] };
    else paragraph.lines.push(text);
  }
  flush();
}

const docs = ['README.md', 'CONTRIBUTING.md'].filter((f) => existsSync(join(root, f)));
if (existsSync(join(root, 'docs'))) {
  docs.push(
    ...readdirSync(join(root, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `docs/${f}`),
  );
}
for (const file of docs) scanDoc(file);

// ---- 3 + 4: site pages ---------------------------------------------------------------------------
const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
const COUNTED = ['h1', 'h2', 'h3', 'li', 'details', 'section', 'img', 'a[href]'];

function parsePage(file) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const source = read(file)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi,
      (_, open, _tag, body, close) => open + blank(body) + close,
    );
  const tags = [];
  let line = 1;
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    line += countLines(source.slice(last, m.index));
    last = m.index;
    const attrs = {};
    for (const a of m[2].matchAll(ATTR))
      attrs[a[1].toLowerCase()] = (a[2] ?? a[3] ?? a[4] ?? '').replaceAll('&amp;', '&');
    tags.push({ name: m[1].toLowerCase(), attrs, line });
  }
  const counts = Object.fromEntries(COUNTED.map((key) => [key, 0]));
  for (const { name, attrs } of tags) {
    if (Object.hasOwn(counts, name)) counts[name]++;
    if (name === 'a' && attrs.href !== undefined) counts['a[href]']++;
  }
  const alternates = {};
  for (const t of tags)
    if (t.name === 'link' && t.attrs.rel === 'alternate' && t.attrs.hreflang)
      alternates[t.attrs.hreflang] = t;
  const canonical = tags.find((t) => t.name === 'link' && t.attrs.rel === 'canonical');
  return { file, tags, counts, alternates, canonical, lang: tags.find((t) => t.name === 'html')?.attrs.lang };
}

// A root-absolute URL path -> the file that serves it, as the built site does (clean URLs).
function resolveSite(urlPath) {
  let path = urlPath;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw text */
  }
  const base = path.replace(/^\/+/, '');
  const tries =
    base === '' || base.endsWith('/') ? [`${base}index.html`] : [base, `${base}.html`, `${base}/index.html`];
  for (const t of tries) if (isFile(join(root, SITE, t))) return `${SITE}/${t}`;
  for (const t of tries) if (isFile(join(root, 'public', t)) || pinned.has(t)) return `public/${t}`;
  return null;
}

function htmlFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory())
      return ['node_modules', 'dist', 'src', 'public'].includes(e.name) ? [] : htmlFiles(`${dir}/${e.name}`);
    return e.name.endsWith('.html') ? [`${dir}/${e.name}`] : [];
  });
}

const pages = new Map(
  htmlFiles(SITE)
    .sort()
    .map((file) => [file, parsePage(file)]),
);
stats.pages = pages.size;
const urlFile = (href, page) => {
  const base = page.canonical?.attrs.href ?? 'https://invalid.example/';
  const url = new URL(href, base);
  return url.host === new URL(base).host ? resolveSite(url.pathname) : null;
};
const paired = new Set();

for (const page of pages.values()) {
  if (page.lang !== 'tr') continue;
  const english = page.alternates.en;
  if (english === undefined) {
    report(page.file, 1, 'no <link rel="alternate" hreflang="en">');
    continue;
  }
  const partnerFile = urlFile(english.attrs.href, page);
  const partner = pages.get(partnerFile);
  if (partner === undefined) {
    report(page.file, english.line, `hreflang="en" ${english.attrs.href} is not a page of ${SITE}`);
    continue;
  }
  paired.add(page.file).add(partner.file);
  stats.pairs++;
  const back = partner.alternates.tr;
  if (partner.lang !== 'en')
    report(partner.file, 1, `paired with ${page.file} but lang is ${partner.lang ?? 'missing'}, not en`);
  if (back === undefined || urlFile(back.attrs.href, partner) !== page.file)
    report(partner.file, back?.line ?? 1, `hreflang="tr" does not lead back to ${page.file}`);
  for (const p of [page, partner]) {
    const own = p.canonical === undefined ? null : urlFile(p.canonical.attrs.href, p);
    if (own !== p.file)
      report(p.file, p.canonical?.line ?? 1, `canonical does not resolve to this page (resolves to ${own})`);
  }
  for (const key of COUNTED) {
    if (page.counts[key] !== partner.counts[key]) {
      report(
        page.file,
        1,
        `<${key}> count ${page.counts[key]} here, ${partner.counts[key]} in ${partner.file}`,
      );
    }
  }
}
for (const page of pages.values()) {
  if (!paired.has(page.file))
    report(
      page.file,
      1,
      `not paired: lang ${page.lang ?? 'missing'} page without a tr/en counterpart via hreflang`,
    );
  const dir = posix.dirname(page.file.slice(SITE.length + 1));
  for (const tag of page.tags) {
    for (const attr of ['href', 'src']) {
      const value = tag.attrs[attr];
      if (value === undefined || value.startsWith('#') || value.startsWith('//') || SCHEME.test(value))
        continue;
      const path = value.replace(/[?#].*$/, '');
      if (path === '') continue;
      const urlPath = path.startsWith('/') ? path : posix.join('/', dir, path);
      if (urlPath === '/editor' || urlPath.startsWith('/editor/')) continue;
      stats.siteLinks++;
      if (resolveSite(urlPath) === null)
        report(
          page.file,
          tag.line,
          `${attr}="${value}" matches no file in ${SITE}, public/ or tools/asset-pins.json`,
        );
    }
  }
}

// ---- result ----------------------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`docs-sync: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `docs-sync: ${stats.docs} docs (${stats.paths} paths, ${stats.links} links, ${stats.pnpm} pnpm commands), ` +
    `${stats.pages} site pages in ${stats.pairs} tr/en pairs (structure counts, ${stats.siteLinks} links) - OK`,
);
