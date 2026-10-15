import { Badge } from '@cloudflare/kumo/components/badge';
import { Cpu, Info, ShieldCheck } from '@phosphor-icons/react';
import type { SignatureVerification } from 'pdf-core/ops/signature-status';
import { formatBytes, formatPercent, type LimitVerdict, type Translator } from 'pdf-shared';
import type { ReactNode } from 'react';

/**
 * Status bar: where the user is, and what the engine is doing.
 *
 * The memory/limit readout is the honest surface — a
 * viewing-only downgrade or a size warning is stated here, never applied
 * silently. The limit profile and the memory budget meter are diagnostics: they appear when
 * they matter (a limit verdict other than ok, or memory use at 75 % of the budget or more) and
 * stay out of the way otherwise.
 */

/** The share of the budget from which the memory meter is worth the user's attention. */
const MEMORY_ATTENTION_RATIO = 0.75;

type SignatureBadgeKey = 'status.signatureBroken' | 'status.signatureModified' | 'status.signatures';

export interface StatusBarProps {
  readonly t: Translator;
  readonly pageIndex: number | null;
  readonly pageCount: number | null;
  readonly zoom: number;
  readonly tier: 'desktop' | 'mobile';
  readonly limits: LimitVerdict;
  /**
   * The signature verdicts of the working version. The badge is the *summary*
   * the properties panel expands: how many signatures the document carries, whether any
   * of them failed to verify, and how many revisions were written after the newest one.
   */
  readonly signatures?: readonly SignatureVerification[];
  /**
   * Live memory usage and budget ceiling.
   */
  readonly memoryUsage?: {
    readonly usedBytes: number;
    readonly budgetBytes: number;
  };
  /** Sensitive session active indicator. */
  readonly sensitive?: boolean;
  /**
   * The page and view controls, when a document is open. They replace the plain page
   * and zoom readout: the bar is where those controls live, so they never float over
   * the page they navigate.
   */
  readonly navigation?: ReactNode;
}

const LIMIT_MESSAGE_KEY: Record<LimitVerdict['kind'], Record<string, string | undefined>> = {
  ok: {},
  warn: { pages: 'limit.warn.pages' },
  'viewing-only': { pages: 'limit.viewingOnly.pages', bytes: 'limit.viewingOnly.bytes' },
  blocked: { pages: 'limit.blocked.pages', bytes: 'limit.blocked.bytes' },
};

export function StatusBar({
  t,
  pageIndex,
  pageCount,
  zoom,
  tier,
  limits,
  signatures = [],
  memoryUsage,
  sensitive = false,
  navigation,
}: StatusBarProps) {
  // Three different facts, three different words: a signature that does not verify is not
  // “modified after signing”, and a document with no signature says nothing at all.
  const broken = signatures.some((entry) => entry.integrity === 'invalid');
  const after = signatures.reduce((most, entry) => Math.max(most, entry.changesAfterSigning), 0);
  const badge: {
    readonly key: SignatureBadgeKey;
    readonly params: Record<string, number>;
    readonly tone: string;
  } | null =
    signatures.length === 0
      ? null
      : broken
        ? { key: 'status.signatureBroken', params: {}, tone: 'text-kumo-danger' }
        : after > 0
          ? { key: 'status.signatureModified', params: { count: after }, tone: 'text-kumo-warning' }
          : { key: 'status.signatures', params: { count: signatures.length }, tone: 'text-kumo-subtle' };
  const limitKey = LIMIT_MESSAGE_KEY[limits.kind][limits.kind === 'ok' ? '' : limits.reason];
  const limitText = limitKey === undefined ? null : t(limitKey as Parameters<Translator>[0]);

  const memRatio =
    memoryUsage === undefined || memoryUsage.budgetBytes <= 0
      ? 0
      : memoryUsage.usedBytes / memoryUsage.budgetBytes;
  const memPercent = Math.min(100, Math.max(0, Math.round(memRatio * 100)));
  const diagnosticsMatter = limits.kind !== 'ok' || memRatio >= MEMORY_ATTENTION_RATIO;

  return (
    <footer className="flex h-[var(--spacing-pdf-statusbar)] items-center gap-3 overflow-hidden border-t border-kumo-line bg-kumo-base px-3 text-xs text-kumo-subtle">
      {/* The page and zoom belong to a document on screen: with none (the start screen) there is
          nothing to read, so the slot stays empty rather than showing dashes or a stale page. */}
      {navigation ??
        (pageIndex === null ? null : (
          <>
            <span className="shrink-0 tabular-nums">
              {pageCount === null
                ? '—'
                : `${t('viewer.page')} ${pageIndex + 1} ${t('viewer.of')} ${pageCount}`}
            </span>
            <span className="shrink-0 tabular-nums">{formatPercent(zoom, t.locale)}</span>
          </>
        ))}
      {/* Diagnostics yield first on a narrow viewport: the tier badge and the memory
          meter describe the session, while the privacy line states the product's
          central claim and the warnings below report something the user must act on.
          Below `md` only the claim and the warnings are allowed to spend the width. */}
      {/* The limit profile the document limits were chosen from — a device-memory fact,
          not the window width, so it is named as a limit profile. */}
      {diagnosticsMatter ? (
        <span
          className="hidden shrink-0 md:inline-flex"
          title={t(tier === 'mobile' ? 'shell.deviceTier.mobileHint' : 'shell.deviceTier.desktopHint')}
        >
          <Badge>{t(tier === 'mobile' ? 'shell.deviceTier.mobile' : 'shell.deviceTier.desktop')}</Badge>
        </span>
      ) : null}

      {/* Memory budget meter */}
      {memoryUsage === undefined || !diagnosticsMatter ? null : (
        <div
          className="hidden items-center gap-1.5 md:flex"
          title={`${t('shell.status.memory')}: ${formatBytes(memoryUsage.usedBytes, t.locale)} / ${formatBytes(memoryUsage.budgetBytes, t.locale)} (${formatPercent(memPercent / 100, t.locale)})`}
        >
          <Cpu size={12} aria-hidden="true" className="shrink-0 text-kumo-subtle" />
          {/* A measurement reads left to right in every interface direction. */}
          <span dir="ltr" className="tabular-nums font-mono text-[11px] text-kumo-subtle">
            {formatBytes(memoryUsage.usedBytes, t.locale)} / {formatBytes(memoryUsage.budgetBytes, t.locale)}
          </span>
          <div className="h-1.5 w-10 overflow-hidden rounded-full border border-kumo-line bg-kumo-recessed">
            <div
              className={`h-full transition-all ${
                memRatio >= 0.9 ? 'bg-kumo-danger' : memRatio >= 0.75 ? 'bg-kumo-warning' : 'bg-pdf-accent'
              }`}
              style={{ width: `${memPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Sensitive session active indicator */}
      {sensitive ? (
        <span
          className="flex items-center gap-1 text-kumo-warning font-medium"
          title={t('redact.sensitive.on')}
        >
          <ShieldCheck size={13} aria-hidden="true" />
          <span>{t('redact.sensitive.on')}</span>
        </span>
      ) : null}

      {limitText === null ? null : (
        <span className="flex items-center gap-1 text-kumo-warning">
          <Info size={12} aria-hidden="true" />
          {limitText}
        </span>
      )}
      {badge === null ? null : (
        <span className={`flex items-center gap-1 ${badge.tone}`}>{t(badge.key, badge.params)}</span>
      )}
      {/* The claim takes the remaining width and truncates rather than pushing the bar
          wider than the viewport; `title` keeps the full sentence reachable. */}
      <span className="ms-auto min-w-0 truncate" title={t('viewer.privacyNote')}>
        {t('viewer.privacyNote')}
      </span>
    </footer>
  );
}
