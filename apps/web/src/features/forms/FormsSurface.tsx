/**
 * The forms feature's pieces of the shell's markup: the XFA banner, the review frames drawn on
 * the pages, the forms tab of the right dock, and the dialog that fills a dynamic XFA form.
 */

import type { OperationOutcome } from 'pdf-core';
import type { SessionTab } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { FieldCandidateLayer, type FieldCandidateLayerProps } from 'pdf-ui/tools';
import { Button } from 'pdf-ui/ui';
import { lazy, Suspense } from 'react';
import { downloadFiles } from '../../operations';
import { useCore } from '../core/core-store';
import {
  candidateRemoved,
  candidateSelected,
  candidatesRestored,
  detectCancelled,
  fieldSelected,
  retryInspection,
  toggleXfaDetails,
  useCurrentDetect,
  useCurrentForms,
  useForms,
  xfaFormClosed,
} from './forms-store';

// Dynamic chunks: the shell's first paint must not carry the panels and dialogs (the entry
// budget is locked).
const FormPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.FormPanel };
});
const FormDetectPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.FormDetectPanel };
});
/** Fills a dynamic XFA form in pdf.js's XFA renderer (`XfaFormDialog`). */
const XfaFormDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.XfaFormDialog };
});

/** The operation dialogs the banner opens. */
export type XfaDialogId = 'xfa-flatten' | 'xfa-remove' | 'xfa-data';

/**
 * A form with XFA: said once, plainly, with what can be done. Its own row, shown when the
 * document opens, so arming a tool never moves the pages. Nothing for a form without XFA.
 */
export function XfaBanner({
  t,
  tab,
  canEdit,
  onFill,
  onOpenDialog,
}: {
  readonly t: Translator;
  readonly tab: SessionTab | null;
  readonly canEdit: boolean;
  readonly onFill: () => void;
  readonly onOpenDialog: (id: XfaDialogId) => void;
}) {
  const xfaInfo = useCurrentForms(tab)?.xfa ?? null;
  const detailsOpen = useForms((state) => state.xfaDetailsOpen);
  const busy = useCore((state) => state.busy);
  if (xfaInfo === null) return null;
  return (
    <div
      role="status"
      data-testid="xfa-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-line bg-kumo-tint px-3 py-1 text-[11px] text-kumo-default"
    >
      <span className="min-w-0 flex-1">
        {t(xfaInfo.kind === 'dynamic' ? 'xfa.banner.dynamic' : 'xfa.banner.static')}{' '}
        <button
          type="button"
          aria-expanded={detailsOpen}
          className="underline underline-offset-2 hover:text-kumo-strong"
          onClick={toggleXfaDetails}
        >
          {t('xfa.banner.more')}
        </button>
      </span>
      {xfaInfo.kind === 'dynamic' ? (
        <>
          <Button size="sm" shape="base" disabled={busy} onClick={onFill}>
            {t('xfa.banner.fill')}
          </Button>
          <Button size="sm" shape="base" disabled={!canEdit} onClick={() => onOpenDialog('xfa-flatten')}>
            {t('xfa.banner.flatten')}
          </Button>
        </>
      ) : (
        <Button size="sm" shape="base" disabled={!canEdit} onClick={() => onOpenDialog('xfa-remove')}>
          {t('xfa.banner.remove')}
        </Button>
      )}
      <Button size="sm" shape="base" disabled={!canEdit} onClick={() => onOpenDialog('xfa-data')}>
        {t('xfa.banner.data')}
      </Button>
      {detailsOpen ? (
        <p className="basis-full text-[11px] text-kumo-subtle">{t('xfa.banner.supported')}</p>
      ) : null}
    </div>
  );
}

/** The frames over the pages while the detector's candidates are under review. */
export function FieldCandidateHost({
  t,
  tab,
  viewer,
  canEdit,
}: {
  readonly t: Translator;
  readonly tab: SessionTab | null;
  readonly viewer: FieldCandidateLayerProps['viewer'] | null;
  readonly canEdit: boolean;
}) {
  const review = useCurrentDetect(tab);
  if (viewer === null || !canEdit || review?.phase !== 'review' || review.detection === null) return null;
  return (
    <FieldCandidateLayer
      t={t}
      viewer={viewer}
      candidates={review.detection.candidates.filter((candidate) => !review.removed.has(candidate.id))}
      selectedId={review.selectedId}
      onSelect={candidateSelected}
      onRemove={candidateRemoved}
    />
  );
}

/**
 * The forms tab of the right dock: detect fields on a flat page, review what was found, and
 * fill the fields the document has. `tab` is the document on screen.
 */
export function FormsPanel({
  t,
  tab,
  canEdit,
  goToPage,
  onDetect,
  onApply,
  onFill,
}: {
  readonly t: Translator;
  readonly tab: SessionTab;
  readonly canEdit: boolean;
  /** Scroll the viewer to a page (0-based). */
  readonly goToPage: (pageIndex: number) => void;
  readonly onDetect: () => void;
  readonly onApply: () => void;
  readonly onFill: (name: string, value: string | boolean) => void;
}) {
  const forms = useCurrentForms(tab);
  const review = useCurrentDetect(tab);
  const selectedField = useForms((state) => state.selectedField);
  const formFields = forms?.fields ?? null;
  return (
    <Suspense
      fallback={
        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
          {t('panel.forms')}
        </p>
      }
    >
      <FormDetectPanel
        t={t}
        phase={review?.phase ?? 'idle'}
        detection={review?.detection ?? null}
        removed={review?.removed ?? new Set<string>()}
        selectedId={review?.selectedId ?? null}
        disabled={!canEdit}
        onDetect={onDetect}
        onCancel={detectCancelled}
        onApply={onApply}
        onRemove={candidateRemoved}
        onRestore={candidatesRestored}
        onSelect={(id) => {
          candidateSelected(id);
          const candidate = review?.detection?.candidates.find((entry) => entry.id === id);
          if (candidate !== undefined) goToPage(candidate.pageIndex);
        }}
      />
      {forms?.error !== undefined ? (
        <div role="alert" className="flex flex-col gap-2 p-2 text-xs text-kumo-danger">
          <p>
            {t(forms.error.messageKey)} {t(forms.error.hintKey)}
          </p>
          <Button variant="outline" onClick={retryInspection}>
            {t('inspection.retry')}
          </Button>
        </div>
      ) : (
        <FormPanel
          key={tab.id}
          t={t}
          fields={formFields ?? []}
          loading={formFields === null}
          selectedName={selectedField}
          onSelect={(name) => {
            fieldSelected(name);
            const field = formFields?.find((entry) => entry.name === name);
            if (field?.pageIndex != null) goToPage(field.pageIndex);
          }}
          onFill={onFill}
          disabled={!canEdit}
        />
      )}
    </Suspense>
  );
}

/** The dialog that fills a dynamic XFA form, while one is open. */
export function XfaFormDialogHost({
  t,
  onSave,
}: {
  readonly t: Translator;
  /** Make the verified bytes the tab's next working version (`saveXfaForm`). */
  readonly onSave: (outcome: OperationOutcome & { readonly changed: number }) => Promise<void>;
}) {
  const form = useForms((state) => state.xfaForm);
  if (form === null) return null;
  return (
    <Suspense fallback={null}>
      <XfaFormDialog
        t={t}
        bytes={form.bytes}
        onClose={xfaFormClosed}
        onSave={onSave}
        onExport={(file) => {
          downloadFiles([{ name: file.name, bytes: file.bytes, mime: file.mime }]);
        }}
      />
    </Suspense>
  );
}
