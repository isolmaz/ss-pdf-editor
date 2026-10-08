// One-time setup: installs the benchmark's own dependencies into WORK (never into the repo)
// and downloads + verifies every model listed in models.json.
//
//   node tools/measure/ocr/setup.mjs [--no-models]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, HERE, MODELS_DIR, modelPath, sha256, WORK } from './lib.mjs';

ensureDir(WORK);
const pkg = path.join(WORK, 'package.json');
if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'ocrbench', private: true, type: 'module' }));
const manifest = JSON.parse(readFileSync(path.join(HERE, 'models.json'), 'utf8'));

const need = ['onnxruntime-web@1.30.0', 'mupdf@1.28.1', 'yaml@2'];
if (
  !existsSync(path.join(WORK, 'node_modules/onnxruntime-web')) ||
  !existsSync(path.join(WORK, 'node_modules/mupdf')) ||
  !existsSync(path.join(WORK, 'node_modules/yaml'))
) {
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...need], {
    cwd: WORK,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.argv.includes('--no-models')) {
  ensureDir(MODELS_DIR);
  for (const model of manifest.models) {
    const dest = modelPath(model);
    if (existsSync(dest) && sha256(readFileSync(dest)) === model.sha256) {
      console.log(`ok       ${model.id}`);
    } else {
      console.log(`download ${model.id} (${(model.bytes / 1e6).toFixed(1)} MB)`);
      const response = await fetch(model.url);
      if (!response.ok) throw new Error(`${model.url}: HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== model.bytes)
        throw new Error(`${model.id}: ${body.length} bytes, expected ${model.bytes}`);
      if (sha256(body) !== model.sha256) throw new Error(`${model.id}: sha256 mismatch`);
      writeFileSync(dest, body);
    }
    for (const side of model.sideFiles ?? []) {
      const sideDest = path.join(MODELS_DIR, `${model.id}.${side.file}`);
      if (!existsSync(sideDest)) {
        const response = await fetch(side.url);
        if (!response.ok) throw new Error(`${side.url}: HTTP ${response.status}`);
        writeFileSync(sideDest, Buffer.from(await response.arrayBuffer()));
      }
    }
  }
}
console.log(`setup complete in ${WORK}`);
