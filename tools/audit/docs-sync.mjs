#!/usr/bin/env node
/**
 * docs-sync: the mechanical half of "the docs describe the code" (`pnpm check:docs`).
 * Node built-ins only. One line per problem (`file:line: message`), exit 1; otherwise exit 0
 * with a one-line summary of what was checked.
 *
 * Checks
 *  1. Docs (the root .md files, .github/PULL_REQUEST_TEMPLATE.md, docs/*.md and
 *     tools/measure/ocr/README.md): every inline-code
 *     token that starts with `packages/ apps/ tools/ e2e/ docs/ .github/` (or is one of the named
 *     root files below) and every relative markdown/HTML link target exists, case-exactly (CI is
 *     Linux). `path:line`, `#anchor`, trailing punctuation are stripped; globs and placeholders
 *     (`* < { [ …`) only need their leading directory to exist.
 *  2. Every `pnpm <script>` / `pnpm run <script>` in inline code or fenced blocks is a root
 *     package.json script or a pnpm built-in; `pnpm --filter <pkg> <script>` needs a workspace
 *     package of that name that has the script.
 *
 * Deliberately not checked: whether prose is true, `#anchor` targets, fenced-block paths, bare
 * file names (`tr.ts`) other than the root files listed here, build output (`dist`, `coverage`,
 * ...), `public/` paths in docs, absolute URLs, and `/editor/...` (served by the app).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems = [];
const stats = { docs: 0, paths: 0, links: 0, pnpm: 0 };
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
  'AGENTS.md',
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

const docs = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'AGENTS.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'tools/measure/ocr/README.md',
].filter((f) => existsSync(join(root, f)));
if (existsSync(join(root, 'docs'))) {
  docs.push(
    ...readdirSync(join(root, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `docs/${f}`),
  );
}
for (const file of docs) scanDoc(file);

// ---- result ----------------------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`docs-sync: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `docs-sync: ${stats.docs} docs (${stats.paths} paths, ${stats.links} links, ${stats.pnpm} pnpm commands) - OK`,
);
