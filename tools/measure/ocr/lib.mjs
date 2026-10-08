// Shared paths for the OCR benchmark. Nothing here touches the repo's dependency graph:
// every dependency and every downloaded model lives in WORK (default <tmpdir>/ocrbench).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
export const WORK = process.env.OCRBENCH_DIR ?? path.join(tmpdir(), 'ocrbench');
export const MODELS_DIR = path.join(WORK, 'models');
export const TESTSET_DIR = path.join(WORK, 'testset');
export const RESULTS_DIR = path.join(WORK, 'results');
export const CV_PDF = path.join(REPO, 'e2e/fixtures/local/owner-cv.pdf');
export const CV_GT = path.join(REPO, 'e2e/fixtures/local/owner-cv.gt.txt');

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Import a package that `setup.mjs` installed into WORK (not into the repo). */
export async function importFromWork(relativeFile) {
  const file = path.join(WORK, 'node_modules', relativeFile);
  if (!existsSync(file))
    throw new Error(`${file} is missing — run \`node tools/measure/ocr/setup.mjs\` first`);
  return await import(pathToFileURL(file).href);
}

export function modelPath(model) {
  return path.join(MODELS_DIR, `${model.id}${path.extname(model.file)}`);
}
