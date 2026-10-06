/**
 * Declarative operation dialogs.
 *
 * Eighteen capabilities need eighteen dialogs, and every one of them is the same
 * shape: a few fields, a page scope, a Run button, progress with cancel, then a
 * report and a decision about the output ("apply to the document", "open in a
 * new tab", "download"). Modelling that once — as a **spec** plus a `run`
 * function — keeps every capability's implementation to the part that is
 * actually about the capability, and keeps progress/cancel/report behaviour
 * identical across all of them.
 *
 * A dialog never touches an engine directly: `run` receives the frozen working
 * bytes and returns produced files plus an `OperationReport`.
 */

import type { OperationProgress, OperationReport, OutputFile, RedactRect } from 'pdf-core';
import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import type { MessageKey, Translator } from 'pdf-shared';
import type { FontCatalog, FontMetrics, TextBlock, TextPage } from 'pdf-text-engine';

export type FieldValue = string | number | boolean | readonly string[] | readonly File[];

export interface FieldOption {
  readonly value: string;
  readonly labelKey: MessageKey;
  readonly hintKey?: MessageKey;
}

/** Show a field only when another field has one of these values. */
export interface FieldCondition {
  readonly field: string;
  readonly equals: readonly FieldValue[];
}

interface FieldBase {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly hintKey?: MessageKey;
  readonly visibleWhen?: FieldCondition;
  /**
   * A setting most runs leave at its default. Every dialog shows these in one closed
   * "advanced options" section after the essential fields, so a capability with many
   * knobs opens short and asks first for what it cannot run without.
   */
  readonly advanced?: boolean;
}

export type FieldSpec =
  | ({ readonly kind: 'pageScope'; readonly default?: 'all' | 'current' | 'selection' } & FieldBase)
  | ({
      readonly kind: 'radio';
      readonly options: readonly FieldOption[];
      readonly defaultValue: string;
      readonly columns?: number;
    } & FieldBase)
  | ({
      readonly kind: 'select';
      readonly options: readonly FieldOption[];
      readonly defaultValue: string;
    } & FieldBase)
  | ({
      readonly kind: 'number';
      readonly defaultValue: number;
      readonly min: number;
      readonly max: number;
      readonly step?: number;
      readonly unitKey?: MessageKey;
    } & FieldBase)
  | ({
      readonly kind: 'text';
      readonly defaultValue: string;
      readonly placeholderKey?: MessageKey;
      readonly maxLength?: number;
      readonly tokens?: readonly { readonly token: string; readonly labelKey: MessageKey }[];
    } & FieldBase)
  | ({
      /**
       * A select whose options are **document data**, not dictionary words: the images
       * of the open document, the layers of its `/OCProperties`. `options` is a function
       * of the run context because the list can only be known once the bytes are frozen,
       * and the labels are literal (a resource name has no translation).
       */
      readonly kind: 'choice';
      readonly options: (
        context: OperationRunContext,
      ) => readonly { readonly value: string; readonly label: string }[];
      readonly defaultValue: string;
    } & FieldBase)
  | ({
      /**
       * A paragraph field. The text engine's whole point is editing a block of
       * text, and a single-line `Input` cannot show one.
       */
      readonly kind: 'multiline';
      readonly defaultValue: string;
      readonly rows?: number;
      readonly maxLength?: number;
      readonly placeholderKey?: MessageKey;
    } & FieldBase)
  | ({ readonly kind: 'password'; readonly placeholderKey?: MessageKey } & FieldBase)
  | ({ readonly kind: 'checkbox'; readonly defaultValue: boolean } & FieldBase)
  | ({
      readonly kind: 'checkboxList';
      readonly options: readonly FieldOption[];
      readonly defaultValue: readonly string[];
      readonly columns?: number;
    } & FieldBase)
  | ({ readonly kind: 'color'; readonly defaultValue: string } & FieldBase)
  | ({ readonly kind: 'image'; readonly accept: string } & FieldBase)
  | ({ readonly kind: 'files'; readonly accept: string; readonly multiple: boolean } & FieldBase)
  | ({ readonly kind: 'readOnlyText'; readonly valueKey: MessageKey } & FieldBase);

export type DialogParams = Readonly<Record<string, FieldValue>>;

/**
 * What a dialog hands `run`: the frozen input it already holds, without `signal` and
 * `onProgress` — the run hook creates both, and a caller that could pass its own
 * signal could cancel work it does not own. Defined here rather than beside the hook
 * so a spec can seed its fields from it without importing the hook (`text-edit` shows
 * the block the user pointed at).
 */
export type OperationRunContext = Omit<OpRunContext, 'signal' | 'onProgress'>;

export interface OpRunContext {
  /** Cancellation is part of the contract, not an option. */
  readonly signal: AbortSignal;
  /** The dialog host replaces this with its own reporter before calling `run`. */
  readonly onProgress: (progress: OperationProgress) => void;
  /** The frozen working document: produced bytes, engine edits applied, or the master copy. */
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly name: string;
  readonly currentPage: number;
  readonly selectedPages: readonly number[];
  readonly t: Translator;
  /** Starting values the opener chose for fields, over the spec's own defaults. */
  readonly presets?: Readonly<Record<string, FieldValue>>;
  /**
   * Redaction marks gathered by the drawing layer (`ops/RedactionLayer.tsx`), in
   * unrotated page points. Only the redaction dialog reads them, but they travel
   * with the context so the marks the user drew on the page cannot drift from the
   * marks the engine erases.
   */
  readonly redactions?: readonly RedactRect[];
  /**
   * The rectangle the link tool dragged (`ops/AnnotationLayer.tsx` → `onRegion`), in
   * the space `ops/link-edit.ts` documents. The link dialog is the only reader, and it
   * travels here for the same reason the redaction marks do: the rectangle the user
   * drew must be the rectangle the file gets.
   */
  readonly link?: LinkTargetRect;
  /**
   * The text block the text tool handed over: the block the
   * user clicked, the page model it came from, and the font catalogue + metric tables
   * the plan needs. It travels here for the same reason the redaction marks do — the
   * model the user pointed at must be the model that gets edited, and re-reading the
   * document inside `run` would edit whatever the bytes say at that moment instead.
   */
  /**
   * The images of the open document (`pdf-core/ops/image-edit.ts`), read by the shell
   * when the image dialog is opened. Same reason as `textEdit`: the list the user picks
   * from must be the list of the bytes the run will edit.
   */
  readonly images?: readonly PdfImageInfo[];
  readonly textEdit?: {
    readonly pageIndex: number;
    readonly block: TextBlock;
    readonly model: TextPage;
    readonly fonts: {
      readonly catalog: FontCatalog;
      readonly metrics: Readonly<Record<string, FontMetrics>>;
    };
  };
}

export interface OpRunResult {
  /** Produced files. `files[0]` is the new document unless `resultKind` is `download`. */
  readonly files: readonly OutputFile[];
  readonly report: OperationReport;
  readonly noticeKey?: MessageKey;
  readonly noticeParams?: Readonly<Record<string, string | number>>;
  /**
   * A run may overrule the spec's `resultKind` for this one result: `'download'` says the
   * files are data to hand over (a form-data export), not a new version of the document.
   * Without it an export in a `replace` dialog would swap the document for its own JSON.
   */
  readonly deliver?: 'download';
}

export type DialogResultKind = 'replace' | 'new-tab' | 'download';

/**
 * The one action a result offers, by kind, as the second step's primary button reads
 * (`OperationForm`). A result applies only through this button; "close" discards it.
 */
export const RESULT_ACTIONS: Readonly<Record<DialogResultKind, MessageKey>> = {
  replace: 'op.result.apply',
  'new-tab': 'op.result.newTab',
  download: 'op.result.download',
};

export interface OperationDialogSpec {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly introKey?: MessageKey;
  readonly confirmKey: MessageKey;
  /**
   * `replace` applies the result to the document (undoable journal step),
   * `new-tab` opens it beside the current one, `download` writes files.
   */
  readonly resultKind: DialogResultKind;
  /**
   * The operation starts a document instead of changing one: it runs with no document open,
   * its context carries no bytes, and its result opens in a new tab. The shell hosts it in a
   * modal over the home screen or the editor (`StartDialog`), never in the tools panel of a
   * tab it does not belong to.
   */
  readonly standalone?: boolean;
  /** Irreversible content loss: run shows a blocking confirmation. */
  readonly destructive?: boolean;
  /** Page identities/coordinates change without a pending-mark mapping. Refuse before running. */
  readonly changesPageGeometry?: boolean;
  readonly fields: readonly FieldSpec[];
  /**
   * Initial field values for this particular opening, merged over the fields' own
   * defaults. A static field table cannot carry a value only the caller knows — the
   * paragraph the text tool handed over — and without this the dialog would open on
   * its defaults instead of on the user's selection.
   */
  readonly initialValues?: (context: OperationRunContext) => DialogParams;
  readonly run: (params: DialogParams, context: OpRunContext) => Promise<OpRunResult>;
}
