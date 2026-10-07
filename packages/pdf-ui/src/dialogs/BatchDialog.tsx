/**
 * The batch surface: many files, one rule set, one per-file report.
 *
 * This is a **bespoke dialog, not an `OperationDialogSpec`** — deliberately, and
 * for the same reason `printing/PrintDialog.tsx` is: the spec contract
 * (`dialogs/types.ts`) describes *one* run over *one* frozen document (`bytes`,
 * `pageCount`, `currentPage`, `selectedPages`), while a batch has no document of
 * its own: it has a queue of files, a rule set, a per-file progress line and a
 * per-file report. Forcing that into `OperationDialogSpec` would have meant a
 * second, bigger contract inside the first one.
 *
 * What it reuses instead of re-inventing:
 *  - the field widgets (`dialogs/fields.tsx`) for every step parameter, rendered
 *    with a per-step `FieldSpec[]` table — the same shape the ops descriptors use,
 *    so a widget fix lands here too;
 *  - `OperationReportPanel` for each step's own notes, which is where "what
 *    changed" and "what was lost" are already grouped and translated;
 *  - the operation's own label keys (`optimize.*`, `ocr.*`, `stamp.*`, …) for the
 *    step names and the running progress sentence — a batch step *is* that
 *    operation, so calling it anything else would be a second vocabulary;
 *  - `parsePageRange` (`printing/pageRange.ts`) for the page fields, and
 *    `useOperationRun`'s discipline (one `AbortController` owned by the surface,
 *    aborted on unmount) without its single-document state machine.
 *
 * A rule set can also be saved and loaded as the JSON template `ops/batch.ts`
 * defines. A loaded template runs **verbatim** — the form is disabled while one is
 * loaded, because showing default field values next to a run that ignores them is
 * exactly the kind of lie the report layer exists to prevent.
 */

import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Meter } from '@cloudflare/kumo/components/meter';
import { FolderOpen, Play, Stop, X } from '@phosphor-icons/react';
import {
  BATCH_STEP_KINDS,
  BATCH_TEMPLATE_VERSION,
  type BatchPageSelection,
  type BatchReport,
  type BatchRuleSet,
  type BatchStep,
  type BatchStepKind,
  MAX_BATCH_ITEMS,
  type BatchPageSelection as PageSelection,
  parseRuleSet,
  runBatch,
  serializeRuleSet,
} from 'pdf-core/ops/batch';
import type { OutputFile } from 'pdf-core/ops/types';
import { type MessageKey, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { parsePageRange } from '../printing/pageRange';
import { FieldList, initialParams } from './fields';
import { OperationReportPanel } from './ReportPanel';
import type { DialogParams, FieldSpec, FieldValue } from './types';

/* ------------------------------------------------------------------ *
 * The batch chrome's own sentences
 * ------------------------------------------------------------------ */

/**
 * The sentence ids of this surface, declared in `packages/shared/src/i18n/parts/batch.ts`
 * (Turkish) and `en-parts/batch.ts` (English). The lookup below is the single bridge:
 * every read goes through `Translator`, and a key missing from the dictionary renders
 * **its own id** — visible in the surface, never a hardcoded English string.
 */
type BatchMessageKey =
  | 'batch.title'
  | 'batch.intro'
  | 'batch.queue'
  | 'batch.queue.hint'
  | 'batch.name'
  | 'batch.steps'
  | 'batch.steps.hint'
  | 'batch.template.save'
  | 'batch.template.load'
  | 'batch.template.loaded'
  | 'batch.template.clear'
  | 'batch.run'
  | 'batch.cancel'
  | 'batch.close'
  | 'batch.download'
  | 'batch.progress'
  | 'batch.report'
  | 'batch.report.completed'
  | 'batch.report.failed'
  | 'batch.report.skipped'
  | 'batch.report.cancelled'
  | 'batch.report.summary'
  | 'batch.report.unchanged'
  | 'batch.error.queue'
  | 'batch.error.steps'
  | 'batch.error.template'
  | 'batch.folder.watch'
  | 'batch.folder.watching'
  | 'batch.folder.stop'
  | 'batch.folder.unsupported'
  | 'batch.folder.scanned';

/** The step a report entry names, in the vocabulary the *operations* already have. */
const STEP_LABEL_KEYS: Readonly<Record<BatchStepKind, MessageKey>> = {
  pages: 'pages.extract.title',
  compress: 'optimize.title',
  ocr: 'ocr.title',
  'page-labels': 'labels.dialog.title',
  stamp: 'stamp.title',
  image: 'image.title',
  metadata: 'properties.title',
  'text-export': 'export.text.title',
  protect: 'security.title',
};

/* ------------------------------------------------------------------ *
 * The step parameter tables
 * ------------------------------------------------------------------ */

/** Anchor options, in the order the stamp dialog offers them. */
const ANCHORS: readonly { readonly value: string; readonly labelKey: MessageKey }[] = [
  { value: 'top-left', labelKey: 'stamp.position.topLeft' },
  { value: 'top-center', labelKey: 'stamp.position.topCenter' },
  { value: 'top-right', labelKey: 'stamp.position.topRight' },
  { value: 'bottom-left', labelKey: 'stamp.position.bottomLeft' },
  { value: 'bottom-center', labelKey: 'stamp.position.bottomCenter' },
  { value: 'bottom-right', labelKey: 'stamp.position.bottomRight' },
  { value: 'center', labelKey: 'stamp.position.center' },
];

/** The page field every page-scoped step shares. */
const PAGE_FIELD: FieldSpec = {
  id: 'pages',
  kind: 'text',
  labelKey: 'op.scope',
  placeholderKey: 'print.rangePlaceholder',
  defaultValue: '',
};

const STEP_FIELDS: Readonly<Record<BatchStepKind, readonly FieldSpec[]>> = {
  pages: [PAGE_FIELD],
  compress: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'optimize.mode',
      defaultValue: 'structure',
      options: [
        { value: 'structure', labelKey: 'optimize.mode.structure' },
        { value: 'raster', labelKey: 'optimize.mode.rasterize' },
      ],
    },
    {
      id: 'stripMetadata',
      kind: 'checkbox',
      labelKey: 'optimize.stripMetadata',
      hintKey: 'optimize.producerKept',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['structure'] },
    },
    { ...PAGE_FIELD, visibleWhen: { field: 'mode', equals: ['raster'] } },
    {
      id: 'dpi',
      kind: 'number',
      labelKey: 'optimize.dpi',
      defaultValue: 150,
      min: 72,
      max: 300,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
    {
      id: 'quality',
      kind: 'number',
      labelKey: 'optimize.imageQuality',
      hintKey: 'optimize.qualityHint',
      defaultValue: 0.7,
      min: 0.3,
      max: 0.95,
      step: 0.05,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
    {
      id: 'greyscale',
      kind: 'checkbox',
      labelKey: 'optimize.greyscale',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
  ],
  ocr: [
    {
      id: 'languages',
      kind: 'checkboxList',
      labelKey: 'ocr.languages',
      hintKey: 'ocr.languagesHint',
      defaultValue: ['tur'],
      options: [
        { value: 'tur', labelKey: 'ocr.language.tr' },
        { value: 'eng', labelKey: 'ocr.language.en' },
      ],
    },
    {
      id: 'quality',
      kind: 'radio',
      labelKey: 'ocr.quality',
      defaultValue: 'fast',
      options: [
        { value: 'fast', labelKey: 'ocr.quality.fast' },
        { value: 'best', labelKey: 'ocr.quality.best' },
      ],
    },
    {
      id: 'dpi',
      kind: 'number',
      labelKey: 'ocr.dpi',
      hintKey: 'ocr.dpiHint',
      defaultValue: 200,
      min: 150,
      max: 300,
      step: 1,
    },
    {
      id: 'existingText',
      kind: 'radio',
      labelKey: 'ocr.textPresent.mode',
      hintKey: 'ocr.textPresentModeHint',
      defaultValue: 'skip',
      options: [
        { value: 'skip', labelKey: 'ocr.textPresent.skip' },
        { value: 'overwrite', labelKey: 'ocr.textPresent.overwrite' },
      ],
    },
    PAGE_FIELD,
  ],
  'page-labels': [
    {
      id: 'startAt',
      kind: 'number',
      labelKey: 'labels.dialog.range',
      hintKey: 'labels.dialog.rangeHint',
      defaultValue: 1,
      min: 1,
      max: 2000,
      step: 1,
    },
    {
      id: 'style',
      kind: 'select',
      labelKey: 'labels.dialog.style',
      defaultValue: 'decimal',
      options: [
        { value: 'decimal', labelKey: 'labels.style.decimal' },
        { value: 'roman-upper', labelKey: 'labels.style.romanUpper' },
        { value: 'roman-lower', labelKey: 'labels.style.romanLower' },
        { value: 'none', labelKey: 'labels.style.none' },
      ],
    },
    {
      id: 'prefix',
      kind: 'text',
      labelKey: 'labels.dialog.prefix',
      hintKey: 'labels.dialog.prefixHint',
      defaultValue: '',
      maxLength: 40,
    },
    {
      id: 'start',
      kind: 'number',
      labelKey: 'labels.dialog.start',
      hintKey: 'labels.dialog.startHint',
      defaultValue: 1,
      min: 1,
      max: 99999,
      step: 1,
    },
  ],
  stamp: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'stamp.format',
      hintKey: 'stamp.formatHint',
      defaultValue: 'header-footer',
      options: [
        { value: 'header-footer', labelKey: 'stamp.title' },
        { value: 'bates', labelKey: 'stamp.bates.title' },
      ],
    },
    {
      id: 'template',
      kind: 'text',
      labelKey: 'stamp.format',
      hintKey: 'stamp.formatHint',
      defaultValue: '{page} / {total}',
      tokens: [
        { token: '{page}', labelKey: 'stamp.token.page' },
        { token: '{total}', labelKey: 'stamp.token.total' },
        { token: '{date}', labelKey: 'stamp.token.date' },
        { token: '{file}', labelKey: 'stamp.token.file' },
      ],
      visibleWhen: { field: 'mode', equals: ['header-footer'] },
    },
    {
      id: 'anchor',
      kind: 'select',
      labelKey: 'stamp.position',
      defaultValue: 'bottom-center',
      options: ANCHORS,
    },
    {
      id: 'fontSize',
      kind: 'number',
      labelKey: 'stamp.fontSize',
      defaultValue: 10,
      min: 4,
      max: 72,
      step: 1,
    },
    {
      id: 'marginMm',
      kind: 'number',
      labelKey: 'stamp.margin',
      defaultValue: 12,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      id: 'startAt',
      kind: 'number',
      labelKey: 'stamp.startAt',
      defaultValue: 1,
      min: 1,
      max: 99999,
      step: 1,
    },
    {
      id: 'skipFirst',
      kind: 'checkbox',
      labelKey: 'stamp.skipFirst',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['header-footer'] },
    },
    {
      id: 'prefix',
      kind: 'text',
      labelKey: 'stamp.bates.prefix',
      defaultValue: '',
      maxLength: 40,
      visibleWhen: { field: 'mode', equals: ['bates'] },
    },
    {
      id: 'digits',
      kind: 'number',
      labelKey: 'stamp.bates.digits',
      defaultValue: 6,
      min: 1,
      max: 12,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['bates'] },
    },
    PAGE_FIELD,
  ],
  image: [],
  metadata: [
    {
      id: 'title',
      kind: 'text',
      labelKey: 'properties.field.title',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'author',
      kind: 'text',
      labelKey: 'properties.field.author',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'subject',
      kind: 'text',
      labelKey: 'properties.field.subject',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'writeXmp',
      kind: 'checkbox',
      labelKey: 'properties.writeXmp',
      hintKey: 'properties.writeXmpHint',
      defaultValue: false,
    },
    {
      id: 'clean',
      kind: 'checkbox',
      labelKey: 'properties.clean.info',
      hintKey: 'properties.clean.warning',
      defaultValue: false,
    },
    { id: 'cleanXmp', kind: 'checkbox', labelKey: 'properties.clean.xmp', defaultValue: false },
  ],
  'text-export': [
    {
      id: 'format',
      kind: 'radio',
      labelKey: 'export.text.format',
      defaultValue: 'text',
      options: [
        { value: 'text', labelKey: 'export.text.format.text' },
        { value: 'markdown', labelKey: 'export.text.format.markdown' },
      ],
    },
    PAGE_FIELD,
  ],
  protect: [
    {
      id: 'userPassword',
      kind: 'password',
      labelKey: 'security.openPassword',
      hintKey: 'security.userPasswordHint',
      placeholderKey: 'security.openPassword',
    },
    {
      id: 'ownerPassword',
      kind: 'password',
      labelKey: 'security.ownerPassword',
      hintKey: 'security.ownerPasswordHint',
      placeholderKey: 'security.ownerPassword',
    },
    {
      id: 'permissions',
      kind: 'checkboxList',
      labelKey: 'security.permissions',
      hintKey: 'security.permissionsHint',
      defaultValue: ['print', 'copy'],
      options: [
        { value: 'print', labelKey: 'security.permission.print' },
        { value: 'printHighQuality', labelKey: 'security.permission.printHq' },
        { value: 'copy', labelKey: 'security.permission.copy' },
        { value: 'modify', labelKey: 'security.permission.modify' },
        { value: 'annotate', labelKey: 'security.permission.annotate' },
        { value: 'form', labelKey: 'security.permission.form' },
        { value: 'assemble', labelKey: 'security.permission.assemble' },
        { value: 'accessibility', labelKey: 'security.permission.accessibility' },
      ],
    },
  ],
};

/**
 * The product's own page ceiling bounds a typed range (`pdf-shared` `LIMITS`): a
 * queue holds documents of different lengths, so the **item's** own count cannot
 * be the bound here — the engine validates every resolved page against the item
 * it is running on and fails that item alone with `range-invalid`.
 */
const RANGE_CEILING = 2000;

/** A page field value (`''`, `all`, or typed range text) as a batch page selection. */
function pageSelection(value: FieldValue | undefined, path: string): BatchPageSelection {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '' || raw === 'all') return 'all';
  const parsed = parsePageRange(raw, RANGE_CEILING);
  if (!parsed.ok) {
    throw new Error(`${path}: ${raw}`);
  }
  return parsed.pages.map((page) => page - 1);
}

function text(value: FieldValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function flag(value: FieldValue | undefined): boolean {
  return value === true;
}

function number(value: FieldValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** One step's field values as the operation's own params. */
function stepParams(kind: BatchStepKind, values: DialogParams): BatchStep['params'] {
  switch (kind) {
    case 'pages':
      return { pages: pageSelection(values.pages, 'pages') };
    case 'compress':
      return values.mode === 'raster'
        ? {
            mode: 'raster',
            pages: pageSelection(values.pages, 'compress'),
            dpi: number(values.dpi, 150),
            quality: number(values.quality, 0.7),
            greyscale: flag(values.greyscale),
          }
        : { mode: 'structure', stripMetadata: flag(values.stripMetadata), keepProducer: true };
    case 'ocr':
      return {
        pages: pageSelection(values.pages, 'ocr'),
        languages: (Array.isArray(values.languages) ? values.languages : ['tur']) as readonly 'tur'[],
        quality: values.quality === 'best' ? 'best' : 'fast',
        dpi: number(values.dpi, 200),
        existingText: values.existingText === 'overwrite' ? 'overwrite' : 'skip',
      };
    case 'page-labels':
      return {
        ranges: [
          {
            startPage: Math.max(0, number(values.startAt, 1) - 1),
            style: text(values.style) as 'decimal',
            prefix: text(values.prefix),
            start: number(values.start, 1),
          },
        ],
      };
    case 'stamp': {
      const pages = pageSelection(values.pages, 'stamp');
      const anchor = text(values.anchor) as 'bottom-center';
      const fontSize = number(values.fontSize, 10);
      const marginMm = number(values.marginMm, 12);
      const startAt = number(values.startAt, 1);
      return values.mode === 'bates'
        ? {
            kind: 'bates',
            pages,
            anchor,
            prefix: text(values.prefix),
            startAt,
            digits: number(values.digits, 6),
            fontSize,
            marginMm,
          }
        : {
            kind: 'header-footer',
            pages,
            anchor,
            template: text(values.template),
            startAt,
            fontSize,
            marginMm,
            skipFirst: flag(values.skipFirst),
          };
    }
    case 'image':
      // The engine carries a full image step; this surface does not offer one, and
      // the reason is in the intro: an image step names a `/Resources /XObject` entry
      // of *one* document, which a rule set for a queue cannot know before it opens
      // the file (`ops/batch.ts` documents the same boundary).
      throw new Error('image');
    case 'metadata':
      return {
        patch: {
          ...(text(values.title) === '' ? {} : { title: text(values.title) }),
          ...(text(values.author) === '' ? {} : { author: text(values.author) }),
          ...(text(values.subject) === '' ? {} : { subject: text(values.subject) }),
          writeXmp: flag(values.writeXmp),
        },
        clean: flag(values.clean),
        cleanXmp: flag(values.cleanXmp),
      };
    case 'text-export':
      return {
        pages: pageSelection(values.pages, 'export'),
        format: values.format === 'markdown' ? 'markdown' : 'text',
        // The rule set's own name becomes the file's stem; `runBatch` prefixes the
        // item's name, so two files never collide in the download.
        baseName: 'batch',
      };
    case 'protect': {
      const chosen = Array.isArray(values.permissions) ? values.permissions : [];
      const allowed = (permission: string) => chosen.includes(permission);
      return {
        userPassword: text(values.userPassword),
        ownerPassword: text(values.ownerPassword),
        permissions: {
          print: allowed('print'),
          printHighQuality: allowed('printHighQuality'),
          copy: allowed('copy'),
          modify: allowed('modify'),
          annotate: allowed('annotate'),
          form: allowed('form'),
          assemble: allowed('assemble'),
          accessibility: allowed('accessibility'),
        },
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * The dialog
 * ------------------------------------------------------------------ */

export interface BatchDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The interface language's translator: the dialog's words follow the shell's locale. */
  readonly t: Translator;
  /** The shell owns downloads (`apps/web/src/operations.ts` `downloadFiles`). */
  readonly onDownload: (files: readonly OutputFile[]) => void;
  readonly onNotice?: (message: string) => void;
}

type Status = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

interface FailureText {
  readonly message: string;
  readonly hint: string;
}

const DEFAULT_STEPS: Readonly<Record<BatchStepKind, boolean>> = {
  pages: false,
  compress: true,
  ocr: false,
  'page-labels': false,
  stamp: false,
  image: false,
  metadata: true,
  'text-export': false,
  protect: false,
};

/** The steps this surface can edit; `image` is engine-only (see `stepParams`). */
const OFFERED_STEPS: readonly BatchStepKind[] = BATCH_STEP_KINDS.filter((kind) => kind !== 'image');

export function BatchDialog({ open, onClose, t, onDownload, onNotice }: BatchDialogProps) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [enabled, setEnabled] = useState<Readonly<Record<BatchStepKind, boolean>>>(DEFAULT_STEPS);
  const [values, setValues] = useState<Readonly<Record<BatchStepKind, DialogParams>>>(initialValues);
  const [name, setName] = useState('toplu');
  const [loaded, setLoaded] = useState<BatchRuleSet | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<{
    item: string;
    done: number;
    total: number;
    label: MessageKey | null;
  } | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [failure, setFailure] = useState<FailureText | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const templateInput = useRef<HTMLInputElement | null>(null);
  const [watchedDirName, setWatchedDirName] = useState<string | null>(null);
  const [isWatching, setIsWatching] = useState(false);
  const watchedDirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const watchIntervalRef = useRef<number | null>(null);

  /** Every sentence goes through this one bridge (see `BatchMessageKey`). */
  const text_ = useCallback(
    (id: BatchMessageKey, params?: Readonly<Record<string, string | number>>): string => {
      const translated: string | undefined = t(id as unknown as MessageKey);
      if (translated === undefined) return id;
      return params === undefined ? translated : t(id as unknown as MessageKey, params);
    },
    [t],
  );

  // Clean up controller and watch interval on unmount
  useEffect(() => {
    return () => {
      controller.current?.abort();
      clearInterval(watchIntervalRef.current ?? undefined);
    };
  }, []);

  const scanDirectory = useCallback(async (dirHandle: FileSystemDirectoryHandle): Promise<File[]> => {
    const found: File[] = [];
    interface AsyncIterableDir {
      values(): AsyncIterable<FileSystemHandle>;
    }
    const iterableDir = dirHandle as unknown as AsyncIterableDir;
    for await (const entry of iterableDir.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
        const file = await (entry as FileSystemFileHandle).getFile();
        found.push(file);
      }
    }
    return found;
  }, []);

  const stopFolderWatch = useCallback(() => {
    clearInterval(watchIntervalRef.current ?? undefined);
    watchIntervalRef.current = null;
    watchedDirHandleRef.current = null;
    setIsWatching(false);
    setWatchedDirName(null);
  }, []);

  const startFolderWatch = useCallback(async () => {
    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
      setFailure({
        message: text_('batch.folder.unsupported'),
        hint: 'File System Access API gerekli (Chromium/Edge).',
      });
      return;
    }
    try {
      interface WindowWithDirPicker {
        showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
      }
      const win = window as unknown as WindowWithDirPicker;
      const dirHandle = await win.showDirectoryPicker();
      watchedDirHandleRef.current = dirHandle;
      setWatchedDirName(dirHandle.name);
      setIsWatching(true);

      const initialFiles = await scanDirectory(dirHandle);
      if (initialFiles.length > 0) {
        setFiles(initialFiles.slice(0, MAX_BATCH_ITEMS));
        setLoaded(null);
        onNotice?.(text_('batch.folder.scanned', { count: initialFiles.length }));
      }

      clearInterval(watchIntervalRef.current ?? undefined);
      watchIntervalRef.current = window.setInterval(async () => {
        try {
          if (!watchedDirHandleRef.current) return;
          const currentFiles = await scanDirectory(watchedDirHandleRef.current);
          setFiles((prev) => {
            const prevIds = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
            const changed =
              currentFiles.length !== prev.length ||
              currentFiles.some((f) => !prevIds.has(`${f.name}:${f.size}:${f.lastModified}`));
            if (changed) {
              onNotice?.(text_('batch.folder.scanned', { count: currentFiles.length }));
              return currentFiles.slice(0, MAX_BATCH_ITEMS);
            }
            return prev;
          });
        } catch {
          // Folder access revoked or disconnected
        }
      }, 4000);
    } catch {
      // User cancelled picker
    }
  }, [onNotice, scanDirectory, text_]);

  const running = status === 'running';
  const chosen = OFFERED_STEPS.filter((kind) => enabled[kind] === true);
  const usable = chosen.length > 0 && (loaded !== null || files.length > 0);

  const change = (kind: BatchStepKind) => (id: string, value: FieldValue) => {
    setValues((previous) => ({ ...previous, [kind]: { ...previous[kind], [id]: value } }));
    setLoaded(null);
  };

  const ruleSet = useCallback((): BatchRuleSet => {
    if (loaded !== null) return loaded;
    return {
      version: BATCH_TEMPLATE_VERSION,
      name: name.trim() === '' ? 'toplu' : name.trim(),
      steps: chosen.map((kind) => ({ kind, params: stepParams(kind, values[kind]) }) as BatchStep),
    };
  }, [chosen, loaded, name, values]);

  const start = useCallback(async () => {
    setFailure(null);
    setReport(null);
    let built: BatchRuleSet;
    try {
      built = ruleSet();
    } catch (error) {
      // A page field that does not parse is the one thing the field table cannot
      // refuse on its own (it is text, and the bound is the item's own count).
      const detail = String((error as Error)?.message ?? error);
      setFailure({ message: text_('batch.error.queue'), hint: detail });
      setStatus('error');
      return;
    }
    const queue = await Promise.all(
      files.slice(0, MAX_BATCH_ITEMS).map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const abort = new AbortController();
    controller.current = abort;
    setStatus('running');
    setProgress({ item: '', done: 0, total: queue.length, label: null });
    try {
      const result = await runBatch(queue, built, {
        signal: abort.signal,
        onProgress: (entry) =>
          setProgress({
            item: entry.itemName,
            done: entry.doneItems,
            total: entry.totalItems,
            label: entry.operation?.labelKey ?? null,
          }),
      });
      setReport(result);
      setStatus(result.cancelled ? 'cancelled' : 'done');
      onNotice?.(
        text_('batch.report.summary', {
          completed: result.completed.length,
          failed: result.failed.length,
          skipped: result.skipped.length,
        }),
      );
    } catch (error) {
      const mapped = toToolError(error, 'ui');
      setFailure({ message: t(mapped.messageKey), hint: t(mapped.hintKey) });
      setStatus('error');
    } finally {
      controller.current = null;
    }
  }, [files, onNotice, ruleSet, t, text_]);

  const cancel = useCallback(() => controller.current?.abort(), []);

  const saveTemplate = useCallback(() => {
    try {
      const json = serializeRuleSet(ruleSet());
      onDownload([
        {
          name: `${name.trim() === '' ? 'toplu' : name.trim()}.batch.json`,
          bytes: new TextEncoder().encode(json),
          mime: 'application/json',
        },
      ]);
    } catch (error) {
      const mapped = toToolError(error, 'ui');
      setFailure({ message: t(mapped.messageKey), hint: t(mapped.hintKey) });
    }
  }, [name, onDownload, ruleSet, t]);

  const download = useCallback(() => {
    if (report === null) return;
    const produced: OutputFile[] = [];
    for (const result of report.results) {
      if (result.status !== 'done') continue;
      produced.push({ name: result.name, bytes: result.bytes, mime: 'application/pdf' });
      produced.push(...result.extras);
    }
    onDownload(produced);
  }, [onDownload, report]);

  const loadTemplate = useCallback(
    async (file: File) => {
      try {
        const parsed = parseRuleSet(await file.text());
        setLoaded(parsed);
        setName(parsed.name);
        setFailure(null);
      } catch (error) {
        const mapped = toToolError(error, 'ui');
        setFailure({
          message: t(mapped.messageKey),
          hint: `${t(mapped.hintKey)} ${mapped.details.engineMessage ?? ''}`,
        });
      }
    },
    [t],
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // A run in flight has no half-finished file worth showing; cancelling has
        // its own button (`OperationForm.tsx` follows the same rule).
        if (running) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <Dialog
        size="base"
        className="flex max-w-xl w-full max-h-[75vh] flex-col gap-3.5 p-5 pdf-floating-shadow"
      >
        <div className="shrink-0">
          <Dialog.Title className="text-sm font-semibold text-kumo-strong">
            {text_('batch.title')}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mt-0.5">
            {text_('batch.intro')}
          </Dialog.Description>
        </div>

        <div className="overflow-y-auto min-h-0 flex-1 pe-1 flex flex-col gap-3">
          <section className="flex flex-col gap-2 border border-kumo-line p-2">
            <h3 className="text-xs font-semibold text-kumo-strong">{text_('batch.queue')}</h3>
            <p className="text-xs text-kumo-subtle">{text_('batch.queue.hint')}</p>
            <div className="flex items-center gap-2">
              <Button
                icon={FolderOpen}
                variant="outline"
                disabled={running}
                onClick={() => fileInput.current?.click()}
              >
                {t('shell.open')}
              </Button>
              {typeof window !== 'undefined' && 'showDirectoryPicker' in window ? (
                isWatching ? (
                  <Button icon={Stop} variant="destructive" disabled={running} onClick={stopFolderWatch}>
                    {text_('batch.folder.stop')}
                  </Button>
                ) : (
                  <Button icon={FolderOpen} variant="outline" disabled={running} onClick={startFolderWatch}>
                    {text_('batch.folder.watch')}
                  </Button>
                )
              ) : null}
              <span className="text-xs tabular-nums text-kumo-subtle">
                {files.length}/{MAX_BATCH_ITEMS}
              </span>
            </div>
            {isWatching && watchedDirName ? (
              <div className="flex items-center gap-2 rounded border border-kumo-line bg-kumo-tint px-2 py-1 text-xs text-kumo-strong font-medium">
                <span className="size-2 rounded-full bg-kumo-success shrink-0" />
                <span>
                  {text_('batch.folder.watching')}: {watchedDirName}
                </span>
              </div>
            ) : null}
            {files.length === 0 ? null : (
              <ul className="flex flex-col gap-0.5 text-xs text-kumo-subtle">
                {files.map((file) => (
                  <li key={file.name} className="truncate">
                    {file.name}
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                if (picked.length > 0) {
                  setFiles(picked);
                  setLoaded(null);
                }
                event.target.value = '';
              }}
            />
          </section>

          <section className="flex flex-col gap-2 border border-kumo-line p-2">
            <h3 className="text-xs font-semibold text-kumo-strong">{text_('batch.steps')}</h3>
            <p className="text-xs text-kumo-subtle">{text_('batch.steps.hint')}</p>

            {OFFERED_STEPS.map((kind) => (
              <div key={kind} className="flex flex-col gap-2">
                <Checkbox
                  checked={enabled[kind] === true}
                  disabled={loaded !== null}
                  label={t(STEP_LABEL_KEYS[kind])}
                  onCheckedChange={(checked) => {
                    setEnabled((previous) => ({ ...previous, [kind]: checked }));
                    setLoaded(null);
                  }}
                />
                {enabled[kind] === true ? (
                  <div className="ps-4">
                    <FieldList
                      t={t}
                      fields={STEP_FIELDS[kind]}
                      values={values[kind]}
                      onChange={change(kind)}
                      choices={{}}
                      pageCount={RANGE_CEILING}
                      currentPage={0}
                      selectedCount={0}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2 border border-kumo-line p-2">
            <label className="flex flex-col gap-1 text-xs text-kumo-subtle">
              {text_('batch.name')}
              <input
                className="border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default"
                value={name}
                disabled={running || loaded !== null}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {loaded === null ? null : (
              <p role="status" className="text-xs text-kumo-subtle">
                {text_('batch.template.loaded', { count: loaded.steps.length })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={running} onClick={saveTemplate}>
                {text_('batch.template.save')}
              </Button>
              <Button variant="outline" disabled={running} onClick={() => templateInput.current?.click()}>
                {text_('batch.template.load')}
              </Button>
              {loaded === null ? null : (
                <Button variant="outline" disabled={running} onClick={() => setLoaded(null)}>
                  {text_('batch.template.clear')}
                </Button>
              )}
            </div>
            <input
              ref={templateInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.item(0);
                if (picked != null) void loadTemplate(picked);
                event.target.value = '';
              }}
            />
          </section>

          {progress === null ? null : (
            <div className="flex flex-col gap-1.5">
              <p role="status" aria-live="polite" className="text-xs text-kumo-subtle">
                {progress.label === null ? text_('batch.progress') : t(progress.label)}
              </p>
              <Meter
                label={text_('batch.progress')}
                value={progress.done}
                max={progress.total === 0 ? 1 : progress.total}
                customValue={`${progress.done}/${progress.total}`}
                indicatorClassName="transition-none"
              />
              <p className="truncate text-xs text-kumo-subtle">{progress.item}</p>
            </div>
          )}

          {failure === null ? null : (
            <div
              role="alert"
              className="flex flex-col gap-0.5 border border-kumo-line bg-kumo-tint px-2 py-1.5"
            >
              <p className="text-xs text-kumo-danger">{failure.message}</p>
              <p className="text-xs text-kumo-subtle">{failure.hint}</p>
            </div>
          )}

          {report === null ? null : <BatchReportList t={t} text={text_} report={report} />}
        </div>

        <div className="shrink-0 pt-2 border-t border-kumo-line/40 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} icon={X}>
            {running ? text_('batch.cancel') : text_('batch.close')}
          </Button>
          {report === null || running ? null : (
            <Button variant="outline" onClick={download}>
              {text_('batch.download')}
            </Button>
          )}
          {running ? (
            <Button variant="outline" icon={Stop} onClick={cancel}>
              {text_('batch.cancel')}
            </Button>
          ) : (
            <Button variant="primary" icon={Play} disabled={!usable} onClick={() => void start()}>
              {text_('batch.run')}
            </Button>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

/** One row per file: what happened, the numbers, and the operation's own notes. */
function BatchReportList({
  t,
  text,
  report,
}: {
  readonly t: Translator;
  readonly text: (id: BatchMessageKey, params?: Readonly<Record<string, string | number>>) => string;
  readonly report: BatchReport;
}) {
  return (
    <section className="flex flex-col gap-2 border border-kumo-line p-2">
      <h3 className="text-xs font-semibold text-kumo-strong">{text('batch.report')}</h3>
      <p role="status" className="text-xs tabular-nums text-kumo-subtle">
        {text('batch.report.summary', {
          completed: report.completed.length,
          failed: report.failed.length,
          skipped: report.skipped.length,
        })}
      </p>
      {report.cancelled ? (
        <p className="text-xs text-kumo-subtle">
          {text('batch.report.cancelled', { names: report.completed.join(', ') })}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {report.results.map((result) => (
          <li key={result.name} className="flex flex-col gap-1">
            <p className="text-xs text-kumo-default">
              {result.name} — {t(STEP_LABEL_KEYS[report.order[0] ?? 'metadata'])}
              {result.status === 'done'
                ? ` · ${text('batch.report.completed', {
                    before: result.inputBytes,
                    after: result.outputBytes,
                    pages: result.pageCount,
                  })}`
                : null}
            </p>
            {result.status === 'failed' ? (
              <div role="alert" className="flex flex-col gap-0.5">
                <p className="text-xs text-kumo-danger">
                  {text('batch.report.failed', { step: t(STEP_LABEL_KEYS[result.step ?? 'metadata']) })}{' '}
                  {t(result.messageKey)}
                </p>
                <p className="text-xs text-kumo-subtle">{t(result.hintKey)}</p>
                {result.detail === null ? null : (
                  <p className="max-w-[60ch] break-words text-[11px] text-kumo-subtle/70">{result.detail}</p>
                )}
              </div>
            ) : null}
            {result.status === 'skipped' ? (
              <p className="text-xs text-kumo-subtle">{text('batch.report.skipped')}</p>
            ) : null}
            {result.status === 'done'
              ? result.steps.map((step) => (
                  <OperationReportPanel
                    key={`${result.name}-${step.kind}-${step.report.steps.join('|')}`}
                    t={t}
                    report={step.report}
                  />
                ))
              : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every step's declared defaults, so the form starts from a complete record. */
function initialValues(): Readonly<Record<BatchStepKind, DialogParams>> {
  const built = {} as Record<BatchStepKind, DialogParams>;
  for (const kind of BATCH_STEP_KINDS) built[kind] = initialParams(STEP_FIELDS[kind]);
  return built;
}

/** Re-exported so a host can name the same selection type the engine speaks. */
export type { BatchPageSelection as BatchPageSelectionType, BatchRuleSet, PageSelection };
