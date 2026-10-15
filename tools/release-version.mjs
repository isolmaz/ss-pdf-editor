/**
 * The release identity: one string for the service worker's cache name, the offline manifest
 * and the stamped `sw.js` (`tools/assemble-dist.mjs`).
 *
 * It is `<package version>-<12 hex digits>`, the digest taken over everything a cached copy
 * can go stale against:
 *
 *  - the pinned engine and font bytes (path + SHA-256, in path order);
 *  - the editor's entry page (`dist/editor/index.html`, which names the entry chunks);
 *  - the manifest body (every capability's URLs — the hashed names of every file of the editor
 *    build — and the interface catalogues).
 *
 * The package version alone is `0.0.0` for every release, and the pins change only when an
 * engine does, so a deploy that changed nothing but code used to keep the worker's bytes —
 * and the browser never saw an update. Hashed chunk names change with their content, so a
 * code change reaches the identity through the manifest and the entry page.
 */
import { createHash } from 'node:crypto';

/**
 * @param {{
 *   stamp: string,
 *   pins: { path: string, sha256: string }[],
 *   editorHtml: string | Uint8Array,
 *   manifest: object,
 * }} input
 * @returns {string}
 */
export function releaseVersion({ stamp, pins, editorHtml, manifest }) {
  const digest = createHash('sha256');
  const feed = (label, value) => {
    digest.update(label);
    digest.update('\0');
    digest.update(value);
    digest.update('\0');
  };
  feed('stamp', stamp);
  for (const pin of [...pins].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    feed(pin.path, pin.sha256);
  }
  feed('editor-html', editorHtml);
  feed('manifest', JSON.stringify(manifest));
  return `${stamp}-${digest.digest('hex').slice(0, 12)}`;
}
