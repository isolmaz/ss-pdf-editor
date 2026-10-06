/**
 * Field rendering for the operation dialogs (`PLAN.md §4.1`, §5/Phase 2).
 *
 * Every capability declares its inputs as `FieldSpec`s and gets the same
 * renderer, so the eighteen dialogs cannot drift apart in layout, labelling or
 * validation. The component is presentational in the strict sense: it renders
 * `values` and reports edits through `onChange`, and the dialog host owns the
 * state that survives a second run.
 *
 * ### The `pageScope` wire format
 *
 * A page scope is one string in exactly one of four forms:
 *
 * | value | meaning |
 * |---|---|
 * | `'all'` | every page of the document |
 * | `'current'` | the page the viewer is on |
 * | `'selection'` | the pages selected in the pages panel |
 * | `'range:<text>'` | the raw expression the user typed (`"1-3, 5"`), untrimmed |
 *
 * The prefix, rather than a bare string, is what keeps a typed range from ever
 * colliding with the three keywords — a capability's `run` therefore only has to
 * check four cases and hand the text to `parsePageRanges` (`pdf-core`).
 *
 * ### Validation
 *
 * `fieldErrors` is pure and shared: the field list renders what it returns and
 * the dialog disables the confirm button while it is non-empty, so an
 * unparsable range can never reach an engine. The message is the `ToolError`'s
 * own `messageKey` and `hintKey` translated — the same pair every other error
 * surface in the product shows — which is why an invalid range reads in Turkish
 * without this file authoring a sentence.
 */

import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Input } from '@cloudflare/kumo/components/input';
import { Radio } from '@cloudflare/kumo/components/radio';
import { Select } from '@cloudflare/kumo/components/select';
import { parsePageRanges } from 'pdf-core/ops/page-ranges';
import { type Translator, toToolError } from 'pdf-shared';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { DialogParams, FieldSpec, FieldValue } from './types';

/** Marks a page-scope value as the raw text the user typed. */
const RANGE_PREFIX = 'range:';
/** The three keyword scopes; any other value is a typed range. */
const KEYWORD_SCOPES = ['all', 'current', 'selection'] as const;
type KeywordScope = (typeof KEYWORD_SCOPES)[number];

export interface FieldListProps {
  readonly t: Translator;
  readonly fields: readonly FieldSpec[];
  readonly values: DialogParams;
  readonly onChange: (id: string, value: FieldValue) => void;
  /**
   * Options for every `choice` field, keyed by field id. The host resolves them once
   * from the frozen run context (`spec.fields` + the context), because a document-derived
   * list must not be re-read while the dialog is open.
   */
  readonly choices?: Readonly<Record<string, readonly { readonly value: string; readonly label: string }[]>>;
  /**
   * Pages in the document. Required rather than optional: the "all pages" choice
   * states the count, and `parsePageRanges` needs the bound to call a range out
   * of bounds. A page scope that could say neither would be a lying control.
   */
  readonly pageCount: number;
  /** 0-based current page. Without it the "current page" choice is not offered. */
  readonly currentPage?: number;
  /** Pages selected in the panel; 0 disables the selection choice. */
  readonly selectedCount?: number;
}

/**
 * The params a spec opens with: every field's declared default, so a dialog
 * starts from a complete record instead of a partial one each capability has to
 * guard against.
 */
export function initialParams(fields: readonly FieldSpec[]): DialogParams {
  const params: Record<string, FieldValue> = {};
  for (const field of fields) {
    switch (field.kind) {
      case 'pageScope':
        params[field.id] = field.default ?? 'all';
        break;
      case 'radio':
      case 'select':
      case 'choice':
      case 'text':
      case 'multiline':
      case 'color':
      case 'number':
        params[field.id] = field.defaultValue;
        break;
      case 'checkbox':
        params[field.id] = field.defaultValue;
        break;
      case 'checkboxList':
        params[field.id] = field.defaultValue;
        break;
      case 'password':
        // Never seeded from the spec: a default password would be a secret in the
        // command table, and an empty string is how the engine reads "not given".
        params[field.id] = '';
        break;
      case 'image':
      case 'files':
        params[field.id] = [];
        break;
      case 'readOnlyText':
        // Derived from the dictionary, not from user input — it carries no value.
        break;
    }
  }
  return params;
}

/** Field values are read-only arrays as often as scalars, so equality is by content. */
function sameValue(left: FieldValue, right: FieldValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    const a = left as readonly unknown[];
    const b = right as readonly unknown[];
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return left === right;
}

/** A field is shown unless its condition names another field that disagrees. */
export function isVisible(field: FieldSpec, values: DialogParams): boolean {
  const condition = field.visibleWhen;
  if (condition === undefined) return true;
  const current = values[condition.field];
  if (current === undefined) return false;
  return condition.equals.some((expected) => sameValue(expected, current));
}

/** The typed range inside a `'range:<text>'` value, or the value itself. */
function scopeText(value: FieldValue | undefined): string {
  const text = typeof value === 'string' ? value : '';
  return text.startsWith(RANGE_PREFIX) ? text.slice(RANGE_PREFIX.length) : text;
}

/** Whether a page-scope value is one of the three keywords rather than a range. */
function isKeywordScope(value: string): value is KeywordScope {
  return KEYWORD_SCOPES.some((scope) => scope === value);
}

/**
 * Validate the visible fields, keyed by field id; an empty record means the
 * dialog may run. Only two kinds can be wrong before an engine is involved — a
 * page scope and a number outside its declared range — because every other
 * field's legality belongs to the capability, which reports it from `run` as a
 * `ToolError`.
 */
export function fieldErrors(
  t: Translator,
  fields: readonly FieldSpec[],
  values: DialogParams,
  pageCount: number,
  selectedCount: number,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!isVisible(field, values)) continue;

    if (field.kind === 'pageScope') {
      const value = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';
      if (value === 'selection' && selectedCount === 0) {
        errors[field.id] = t('op.scope.empty');
        continue;
      }
      if (!value.startsWith(RANGE_PREFIX)) continue;
      try {
        parsePageRanges(scopeText(value), pageCount);
      } catch (cause) {
        // Both halves of the shared error vocabulary — what happened and what to
        // type instead. The parser owns the wording, so a new parser rule cannot
        // leave this message behind.
        const failure = toToolError(cause, 'ui');
        errors[field.id] = `${t(failure.messageKey)} ${t(failure.hintKey)}`;
      }
      continue;
    }

    if (field.kind === 'choice') {
      // A document-derived list starts empty when the document has nothing to offer;
      // the run would then have no target at all, so it is refused here.
      const value = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';
      if (value === '') errors[field.id] = t('dialog.field.choiceEmpty');
      continue;
    }

    if (field.kind === 'number') {
      const value = values[field.id];
      if (typeof value !== 'number' || Number.isNaN(value) || value < field.min || value > field.max) {
        errors[field.id] = t('dialog.field.numberRange', { min: field.min, max: field.max });
      }
    }
  }
  return errors;
}

export function FieldList({
  t,
  fields,
  values,
  onChange,
  pageCount,
  currentPage,
  selectedCount = 0,
  choices,
}: FieldListProps) {
  const errors = fieldErrors(t, fields, values, pageCount, selectedCount);
  const fileInputBase = useId();
  /** Last typed range per field, so switching the choice away and back loses nothing. */
  const [rangeDrafts, setRangeDrafts] = useState<Readonly<Record<string, string>>>({});
  /** Text inputs that can take a token, by field id — a caret needs the element. */
  const textInputs = useRef(new Map<string, HTMLInputElement>());
  /** Where the caret belongs once a token insertion has rendered. */
  const pendingCaret = useRef<{ readonly fieldId: string; readonly at: number } | null>(null);

  useEffect(() => {
    const pending = pendingCaret.current;
    const input = pending === null ? undefined : textInputs.current.get(pending.fieldId);
    if (pending === null || input === undefined) return;
    pendingCaret.current = null;
    input.focus();
    input.setSelectionRange(pending.at, pending.at);
  });

  const set = (id: string, value: FieldValue) => onChange(id, value);

  const insertToken = (fieldId: string, token: string) => {
    const input = textInputs.current.get(fieldId);
    const current = String(values[fieldId] ?? '');
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    set(fieldId, `${current.slice(0, start)}${token}${current.slice(end)}`);
    pendingCaret.current = { fieldId, at: start + token.length };
  };

  /** One field's control. A plain function, not a nested component: it owns no state. */
  const renderField = (field: FieldSpec): ReactNode => {
    if (!isVisible(field, values)) return null;
    const label = t(field.labelKey);
    const hint = field.hintKey === undefined ? undefined : t(field.hintKey);
    const error = errors[field.id];

    switch (field.kind) {
      case 'pageScope': {
        const raw = values[field.id];
        const value = typeof raw === 'string' ? raw : 'all';
        const mode: KeywordScope | 'custom' = isKeywordScope(value) ? value : 'custom';
        const text = rangeDrafts[field.id] ?? scopeText(value);
        return (
          <Radio.Group<string>
            key={field.id}
            legend={label}
            value={mode}
            description={hint ?? (selectedCount === 0 ? t('op.scope.empty') : undefined)}
            onValueChange={(next) => {
              set(field.id, next === 'custom' ? `${RANGE_PREFIX}${text}` : next);
            }}
          >
            <Radio.Item label={t('op.scope.all', { count: pageCount })} value="all" />
            {currentPage === undefined ? null : (
              <Radio.Item label={t('op.scope.current', { page: currentPage + 1 })} value="current" />
            )}
            <Radio.Item
              label={t('op.scope.selection', { count: selectedCount })}
              value="selection"
              disabled={selectedCount === 0}
            />
            <Radio.Item label={t('op.scope.custom')} value="custom" />
            {mode === 'custom' ? (
              <Input
                size="sm"
                autoFocus
                value={text}
                // The legend names the field; the placeholder is an example, never
                // a label, so the input is named after what it asks for.
                aria-label={t('op.scope.custom')}
                placeholder={t('op.scope.placeholder')}
                error={error}
                onChange={(event) => {
                  setRangeDrafts((previous) => ({ ...previous, [field.id]: event.target.value }));
                  set(field.id, `${RANGE_PREFIX}${event.target.value}`);
                }}
              />
            ) : null}
          </Radio.Group>
        );
      }

      case 'radio': {
        const items = field.options.map((option) => (
          <Radio.Item key={option.value} label={t(option.labelKey)} value={option.value} />
        ));
        return (
          <Radio.Group<string>
            key={field.id}
            legend={label}
            value={String(values[field.id] ?? field.defaultValue)}
            description={hint}
            error={error}
            onValueChange={(next) => set(field.id, next)}
          >
            {field.columns === undefined || field.columns <= 1 ? (
              items
            ) : (
              // A wrapper element rather than a class on the group: Kumo's group
              // renders its own flex column, and the column count is data, so it
              // cannot be a Tailwind class name.
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${field.columns}, minmax(0, 1fr))` }}
              >
                {items}
              </div>
            )}
          </Radio.Group>
        );
      }

      case 'choice':
        return (
          <Select<string>
            key={field.id}
            size="sm"
            label={label}
            description={hint}
            error={error}
            value={String(values[field.id] ?? field.defaultValue)}
            // Kumo's trigger prints the raw value unless it is told the label.
            renderValue={(value) =>
              (choices?.[field.id] ?? []).find((option) => option.value === value)?.label ?? value
            }
            onValueChange={(next) => set(field.id, next ?? '')}
          >
            {(choices?.[field.id] ?? []).map((option) => (
              <Select.Option key={option.value} value={option.value}>
                {option.label}
              </Select.Option>
            ))}
          </Select>
        );

      case 'select':
        return (
          <Select<string>
            key={field.id}
            size="sm"
            label={label}
            description={hint}
            error={error}
            value={String(values[field.id] ?? field.defaultValue)}
            // Kumo's trigger prints the raw value unless it is told the label: a stamp
            // position read "bottom-right" instead of "Sağ alt".
            renderValue={(value) => {
              const option = field.options.find((candidate) => candidate.value === value);
              return option === undefined ? value : t(option.labelKey);
            }}
            onValueChange={(next) => {
              // Kumo reports `null` for a cleared selection, and `FieldValue`
              // has no "unset" member: a capability's `run` reads this record as
              // complete, so the field falls back to its declared default in the
              // same way a cleared number field falls back to its minimum.
              set(field.id, next ?? field.defaultValue);
            }}
          >
            {field.options.map((option) => (
              <Select.Option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </Select.Option>
            ))}
          </Select>
        );

      case 'number':
        return (
          <Input
            key={field.id}
            type="number"
            size="sm"
            label={label}
            description={hint}
            error={error}
            min={field.min}
            max={field.max}
            step={field.step}
            value={String(values[field.id] ?? field.defaultValue)}
            onChange={(event) => {
              // A cleared number field falls back to its minimum: `FieldValue`
              // has no "unset" member, and `min` is the range's own answer.
              const next = event.target.value === '' ? field.min : Number(event.target.value);
              set(field.id, next);
            }}
          />
        );

      case 'text':
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <Input
              size="sm"
              label={label}
              description={hint}
              error={error}
              maxLength={field.maxLength}
              placeholder={field.placeholderKey === undefined ? undefined : t(field.placeholderKey)}
              value={String(values[field.id] ?? field.defaultValue)}
              ref={(element) => {
                if (element === null) textInputs.current.delete(field.id);
                else textInputs.current.set(field.id, element);
              }}
              onChange={(event) => set(field.id, event.target.value)}
            />
            {field.tokens === undefined ? null : (
              <div className="flex flex-wrap gap-1">
                {field.tokens.map((token) => (
                  <button
                    key={token.token}
                    type="button"
                    onClick={() => insertToken(field.id, token.token)}
                    className="rounded-sm border border-kumo-line px-1.5 py-0.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                  >
                    {t(token.labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );

      case 'multiline':
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <label className="text-xs text-kumo-subtle" htmlFor={`field-${field.id}`}>
              {label}
            </label>
            <textarea
              id={`field-${field.id}`}
              rows={field.rows ?? 6}
              maxLength={field.maxLength}
              placeholder={field.placeholderKey === undefined ? undefined : t(field.placeholderKey)}
              value={String(values[field.id] ?? field.defaultValue)}
              onChange={(event) => set(field.id, event.target.value)}
              className="w-full rounded-sm border border-kumo-line bg-kumo-base p-1.5 text-xs text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
            />
            {hint === undefined ? null : <p className="text-[11px] text-kumo-subtle">{hint}</p>}
          </div>
        );

      case 'password':
        return (
          <Input
            key={field.id}
            type="password"
            size="sm"
            label={label}
            description={hint}
            error={error}
            placeholder={field.placeholderKey === undefined ? undefined : t(field.placeholderKey)}
            value={String(values[field.id] ?? '')}
            onChange={(event) => set(field.id, event.target.value)}
          />
        );

      case 'checkbox':
        return (
          <Checkbox
            key={field.id}
            checked={values[field.id] === true}
            label={label}
            // Kumo's single checkbox has no description slot, and a hint the user
            // cannot reach would be a hidden caveat — the label tooltip carries it.
            labelTooltip={hint}
            onCheckedChange={(checked) => set(field.id, checked)}
          />
        );

      case 'checkboxList': {
        const current = values[field.id];
        return (
          <Checkbox.Group
            key={field.id}
            legend={label}
            description={hint}
            error={error}
            value={Array.isArray(current) ? (current as readonly string[]).slice() : []}
            onValueChange={(next) => set(field.id, next)}
          >
            {field.options.map((option) => (
              <Checkbox.Item key={option.value} label={t(option.labelKey)} value={option.value} />
            ))}
          </Checkbox.Group>
        );
      }

      case 'color':
        return (
          <Input
            key={field.id}
            type="color"
            size="sm"
            label={label}
            description={hint}
            error={error}
            // The colour well is the control; it needs no padding of its own.
            className="w-14 p-0"
            value={String(values[field.id] ?? field.defaultValue)}
            onChange={(event) => set(field.id, event.target.value)}
          />
        );

      case 'image':
      case 'files': {
        // The browser's own file control reads "Choose File — No file chosen" in the
        // browser's language, not the product's; a labelled button over a hidden input
        // says what to pick in the dialog's own words and lists what was picked.
        const inputId = `${fileInputBase}-${field.id}`;
        const picked = Array.isArray(values[field.id]) ? (values[field.id] as readonly File[]) : [];
        const multiple = field.kind === 'files' && field.multiple;
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-kumo-default">{label}</span>
            <label
              htmlFor={inputId}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-kumo-line bg-kumo-recessed/40 px-3 py-2 text-xs text-kumo-default transition-colors hover:border-kumo-focus hover:bg-kumo-tint focus-within:ring-1 focus-within:ring-kumo-focus"
            >
              <span className="shrink-0 rounded-sm border border-kumo-line bg-kumo-base px-2 py-0.5 font-medium">
                {t(multiple ? 'dialog.field.chooseFiles' : 'dialog.field.chooseFile')}
              </span>
              <span className="min-w-0 truncate text-kumo-subtle">
                {picked.length === 0
                  ? t('dialog.field.noFile')
                  : picked.length === 1
                    ? (picked[0]?.name ?? '')
                    : t('dialog.field.filesChosen', { count: picked.length })}
              </span>
              <input
                id={inputId}
                type="file"
                className="sr-only"
                accept={field.accept}
                multiple={multiple}
                // A file input cannot be controlled: the browser owns its value, so
                // the picked files are read out of the event and never written back.
                onChange={(event) => set(field.id, Array.from(event.target.files ?? []))}
              />
            </label>
            {error === undefined ? null : <p className="text-[11px] text-kumo-danger">{error}</p>}
            {hint === undefined ? null : <p className="text-[11px] text-kumo-subtle">{hint}</p>}
          </div>
        );
      }

      case 'readOnlyText':
        return (
          <Input
            key={field.id}
            size="sm"
            readOnly
            label={label}
            description={hint}
            error={error}
            value={t(field.valueKey)}
          />
        );
    }
  };

  /**
   * One grid for every dialog: a field spans the full width, except the short controls
   * (a number, a colour, a select), which share a row two by two once the container is
   * wide enough. The container query — not the viewport — decides, because the same list
   * renders in a modal and in the narrow tools panel.
   */
  const cell = (field: FieldSpec, node: ReactNode): ReactNode =>
    node === null ? null : (
      <div
        key={field.id}
        className={
          field.kind === 'number' ||
          field.kind === 'color' ||
          field.kind === 'select' ||
          field.kind === 'choice'
            ? 'col-span-2 @md:col-span-1'
            : 'col-span-2'
        }
      >
        {node}
      </div>
    );

  const essential = fields.filter((field) => field.advanced !== true);
  const advanced = fields.filter((field) => field.advanced === true && isVisible(field, values));
  // An error inside the closed section would be a confirm button disabled for no
  // visible reason: the section opens itself while one of its fields is wrong.
  const advancedError = advanced.some((field) => errors[field.id] !== undefined);

  return (
    <div className="@container flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        {essential.map((field) => cell(field, renderField(field)))}
      </div>
      {advanced.length === 0 ? null : (
        <details
          open={advancedError || undefined}
          className="group rounded-md border border-kumo-line bg-kumo-base"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-kumo-default select-none hover:bg-kumo-tint">
            {t('dialog.advanced', { count: advanced.length })}
            <span aria-hidden="true" className="text-kumo-subtle transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-kumo-line px-3 py-3">
            {advanced.map((field) => cell(field, renderField(field)))}
          </div>
        </details>
      )}
    </div>
  );
}
