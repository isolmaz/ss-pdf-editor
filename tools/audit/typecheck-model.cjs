#!/usr/bin/env node
/**
 * Strict typecheck of the model/shared/storage subset.
 *
 * This is **not** a replacement for `pnpm typecheck`, and it is narrower than it once
 * claimed. It re-runs the root's strict compiler settings (including its `DOM` lib, which
 * the subset genuinely needs: `crypto`, `Blob`, `FileSystemFileHandle`, OPFS) over
 * `packages/pdf-model`, `packages/shared`, `packages/pdf-text-engine` and
 * `apps/web/src/drafts.ts`, with the workspace specifiers (`pdf-model`, `pdf-shared`)
 * mapped to their source entry points.
 *
 * What it does **not** prove: that the subset is free of browser globals (the DOM lib is
 * on, and the code uses them), or that it does not import the app (an import of
 * `apps/web` from the model type-checks fine, because the program follows it). Both were
 * verified by mutation; do not read a passing run as either guarantee.
 *
 * The file list is walked, not parsed out of `tsconfig.json`'s `include`: this script must
 * describe the subset it checks even when the root config grows new workspaces.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

/** Every `.ts` under a directory, minus the test files. */
function sourcesUnder(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourcesUnder(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const files = [
  ...sourcesUnder(path.join(root, 'packages/pdf-model/src')),
  ...sourcesUnder(path.join(root, 'packages/shared/src')),
  ...sourcesUnder(path.join(root, 'packages/pdf-text-engine/src')),
  path.join(root, 'apps/web/src/drafts.ts'),
];

const program = ts.createProgram(files, {
  ...parsed.options,
  // `paths` without `baseUrl` resolves relative to the config file, which is what the
  // root config means; `baseUrl` itself is deprecated in TypeScript 6 and this script
  // must not be the thing that keeps a removed option alive.
  paths: {
    'pdf-model': [path.join(root, 'packages/pdf-model/src/index.ts')],
    'pdf-shared': [path.join(root, 'packages/shared/src/index.ts')],
  },
  noEmit: true,
});

const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
for (const diagnostic of diagnostics) {
  const location =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
  const prefix = location
    ? `${path.relative(root, diagnostic.file.fileName)}:${location.line + 1}:${location.character + 1}: `
    : '';
  console.error(
    `${prefix}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}
console.log(`${files.length} source files; ${diagnostics.length} diagnostics (TypeScript ${ts.version}).`);
process.exitCode = diagnostics.length > 0 ? 1 : 0;
