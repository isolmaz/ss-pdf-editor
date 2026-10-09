/** The offline-readiness commands: what the worker's cache holds, and filling it. */

import type { Translator } from 'pdf-shared';
import { noticeLine } from '../../notices';
import {
  incompleteCapabilities,
  prepareOffline,
  requestOfflineReadiness,
  requiredCapabilities,
} from '../../offline';
import { showNotice } from '../core/core-store';

/**
 * Offline readiness: what the worker's cache actually holds for **this build**, said as it is.
 *
 * `null` is not "nothing is ready": it is "there is no service worker to ask", and the
 * two are different problems with different answers — the previous readiness path could
 * only answer the second one, by looking for a substring in whatever URLs it found.
 * The names `incompleteCapabilities` returns are capability ids (`mupdf`, `tesseract`),
 * joined into the sentence as identifiers, like the engine step ids in a report.
 */
export async function checkOffline(t: Translator): Promise<void> {
  const readiness = await requestOfflineReadiness();
  if (readiness === null) {
    showNotice(t('offline.unavailable'));
    return;
  }
  const missing = incompleteCapabilities(readiness, requiredCapabilities({ ocr: false }));
  showNotice(
    missing.length === 0
      ? t('offline.ready')
      : t('offline.incomplete', { count: missing.length, facts: missing.join(', ') }),
  );
}

/**
 * Fill the cache for the capabilities core editing needs.
 *
 * A preparation that was interrupted is not rounded up to success: `failed` is the
 * paths that did not arrive, and it is reported with the count that did — the failure
 * mode this command exists to make visible is the user believing a half-downloaded
 * package is ready. Readiness is re-read afterwards, so the sentence after the work
 * describes the cache as it now is rather than as the pass intended it.
 */
export async function prepareOfflinePackages(t: Translator): Promise<void> {
  const required = requiredCapabilities({ ocr: false });
  const result = await prepareOffline(required);
  if (result === null) {
    showNotice(t('offline.unavailable'));
    return;
  }
  if (result.failed.length > 0) {
    showNotice(t('offline.prepareFailed', { count: result.prepared, failed: result.failed.length }));
    return;
  }
  const readiness = await requestOfflineReadiness();
  const missing = readiness === null ? [] : incompleteCapabilities(readiness, required);
  if (missing.length === 0) {
    showNotice(t('offline.prepared', { count: result.prepared }));
    return;
  }
  showNotice(
    noticeLine(
      [
        { key: 'offline.prepared', params: { count: result.prepared } },
        { key: 'offline.incomplete', params: { count: missing.length, facts: missing.join(', ') } },
      ],
      t,
    ),
  );
}
