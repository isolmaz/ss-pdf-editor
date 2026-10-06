/**
 * The form field inventory.
 *
 * A list of what the document's AcroForm declares, in the engine's own order:
 * name, kind, current value, and whether it is locked or required. An editable
 * field carries an inline control that commits through `onFill` — the panel never
 * writes to the document itself, so the value takes the same journaled path a
 * dialog's result would (state changes go through the model).
 *
 * Read-only fields keep their value visible and their control disabled: a locked
 * field that looks editable is worse than one that looks locked, because the user
 * only learns the difference after typing.
 */

import { type FormFieldInfo, type FormFieldKind, fieldValueText as valueText } from 'pdf-core/ops/forms';
import type { Translator } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLoading, PanelMessage } from './PanelParts';

export interface FormPanelProps {
  readonly t: Translator;
  readonly fields: readonly FormFieldInfo[];
  readonly loading?: boolean;
  /** Field the shell should keep highlighted (selected elsewhere). */
  readonly selectedName?: string | null;
  /** Fires when a row is chosen; the shell walks the viewer to its page. */
  readonly onSelect?: (name: string) => void;
  /** A committed value. The panel does not apply it — the host does. */
  readonly onFill?: (name: string, value: string | boolean) => void;
  readonly disabled?: boolean;
}

/** Kind → dictionary key. `unknown` and `signature` are listed, not hidden. */
const KIND_KEYS: Record<FormFieldKind, string> = {
  text: 'form.kind.text',
  checkbox: 'form.kind.checkbox',
  dropdown: 'form.kind.dropdown',
  radio: 'form.kind.radio',
  optionlist: 'form.kind.optionlist',
  button: 'form.kind.button',
  signature: 'form.kind.signature',
  unknown: 'form.kind.unknown',
};

/** The kinds that get an inline control: what the panel can edit in place. */
function isEditableKind(kind: FormFieldKind): boolean {
  return kind === 'text' || kind === 'dropdown' || kind === 'optionlist' || kind === 'radio';
}

export function FormPanel({ t, fields, loading, selectedName, onSelect, onFill, disabled }: FormPanelProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const changedFields = useRef(new Set<string>());

  // A draft that matched the document's value used to be dropped here, on every
  // `fields` change. Every draft *starts* matching — the seed below takes the
  // document's own value — so the only thing this effect ever did was remove the
  // draft of a field nobody was editing, i.e. close the inline control as soon as
  // any reload landed. That is why the panel was editable on a quiet document and
  // not after a fill, and why stopping the redundant writes made no field editable
  // at all: the editor's life depended on nothing
  // reloading. Keeping a draft that equals its field is harmless — it renders the
  // document's own value — and an edit in progress is kept by the seed effect below
  // because it differs from the field. A value that changes under an open draft is
  // handled the way it always was: the difference is treated as the user's edit.

  // Selecting a text-ish field starts its draft from the document's own value: the
  // inline control renders only while a draft exists, and nothing else ever created
  // one — so no field was editable at all. A draft
  // that is already open is left alone, or typing would be overwritten by a re-render.
  useEffect(() => {
    if (selectedName === undefined || selectedName === null) return;
    const field = fields.find((entry) => entry.name === selectedName);
    if (field === undefined) return;
    if (!isEditableKind(field.kind)) return;
    setDrafts((current) =>
      !changedFields.current.has(selectedName) && current[selectedName] !== valueText(field.value)
        ? { ...current, [selectedName]: valueText(field.value) }
        : current,
    );
  }, [fields, selectedName]);

  const commit = useCallback(
    (name: string, value: string | boolean) => {
      // Clear synchronously: submitting can also blur the input in the same turn.
      const changed = typeof value === 'boolean' || changedFields.current.delete(name);
      setDrafts((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      if (changed) onFill?.(name, value);
    },
    [onFill],
  );

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (fields.length === 0 || !(event.target instanceof HTMLButtonElement)) return;
      const move = (next: number) => {
        const clamped = Math.min(Math.max(next, 0), fields.length - 1);
        setFocusIndex(clamped);
        const target = listRef.current?.querySelectorAll<HTMLElement>('[data-field-row]')[clamped];
        target?.querySelector<HTMLButtonElement>('button')?.focus();
        event.preventDefault();
      };
      if (event.key === 'ArrowDown') move(focusIndex + 1);
      else if (event.key === 'ArrowUp') move(focusIndex - 1);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(fields.length - 1);
      else if (event.key === 'Enter') {
        const field = fields[focusIndex];
        if (field !== undefined) onSelect?.(field.name);
      }
    },
    [fields, focusIndex, onSelect],
  );

  if (loading === true) return <PanelLoading />;
  if (fields.length === 0) return <PanelMessage text={t('form.panel.empty')} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p aria-live="polite" className="sr-only">
        {t('form.panel.count', { count: fields.length })}
      </p>
      <ul
        ref={listRef}
        aria-label={t('panel.forms')}
        className="min-h-0 flex-1 overflow-y-auto p-1"
        onKeyDown={onListKeyDown}
      >
        {fields.map((field, index) => {
          const isSelected = selectedName === field.name;
          const draft = drafts[field.name];
          const editable =
            disabled !== true &&
            !field.readOnly &&
            (field.kind === 'text' ||
              field.kind === 'dropdown' ||
              field.kind === 'optionlist' ||
              field.kind === 'radio');
          return (
            <li key={field.name} data-field-row className="mb-0.5">
              <div
                className={`rounded-sm px-1.5 py-1 ${
                  isSelected ? 'bg-kumo-tint outline outline-1 outline-kumo-focus' : 'hover:bg-kumo-tint'
                }`}
              >
                <button
                  type="button"
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-current={isSelected ? 'true' : undefined}
                  onFocus={() => setFocusIndex(index)}
                  onClick={() => {
                    /**
                     * The row seeds its own draft, not only the effect on `selectedName`: a
                     * click on the row that is *already* selected changes nothing the effect
                     * watches, so re-opening a field after a write left it uneditable —
                     * measured in the acceptance driver's own order, where
                     * the first open works and the open after the fill does not.
                     */
                    if (isEditableKind(field.kind)) {
                      setDrafts((current) =>
                        current[field.name] === undefined
                          ? { ...current, [field.name]: valueText(field.value) }
                          : current,
                      );
                    }
                    onSelect?.(field.name);
                  }}
                  className="flex w-full items-center gap-1.5 text-start"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-kumo-default">{field.name}</span>
                  {field.readOnly ? (
                    <span className="shrink-0 text-[10px] text-kumo-subtle" title={t('form.field.readOnly')}>
                      🔒
                    </span>
                  ) : null}
                  {field.required ? (
                    <span className="shrink-0 text-[10px] text-kumo-danger" title={t('form.field.required')}>
                      *
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-kumo-subtle">
                    {t(KIND_KEYS[field.kind] as Parameters<typeof t>[0])}
                  </span>
                </button>

                <div className="mt-0.5">
                  {field.kind === 'checkbox' ? (
                    <label className="flex items-center gap-1.5 text-[11px] text-kumo-subtle">
                      <input
                        type="checkbox"
                        disabled={disabled === true || field.readOnly}
                        checked={field.value === true}
                        onChange={(event) => commit(field.name, event.target.checked)}
                        className="size-3 rounded-sm border border-kumo-line accent-kumo-focus"
                      />
                      {t(field.value === true ? 'form.field.checked' : 'form.field.unchecked')}
                    </label>
                  ) : editable && draft !== undefined ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        commit(field.name, draft);
                      }}
                    >
                      <label className="sr-only" htmlFor={`form-${field.name}`}>
                        {field.name}
                      </label>
                      <input
                        id={`form-${field.name}`}
                        // biome-ignore lint/a11y/noAutofocus: the field was just activated by the user.
                        autoFocus
                        type="text"
                        value={draft}
                        list={field.options === null ? undefined : `form-options-${field.name}`}
                        onChange={(event) => {
                          changedFields.current.add(field.name);
                          setDrafts((current) => ({ ...current, [field.name]: event.target.value }));
                        }}
                        onBlur={() => commit(field.name, draft)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            changedFields.current.delete(field.name);
                            setDrafts((current) => {
                              const next = { ...current };
                              delete next[field.name];
                              return next;
                            });
                          }
                        }}
                        className="mt-0.5 w-full rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-[11px] text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
                      />
                      {field.options === null ? null : (
                        <datalist id={`form-options-${field.name}`}>
                          {field.options.map((option) => (
                            <option key={option} value={option} />
                          ))}
                        </datalist>
                      )}
                    </form>
                  ) : editable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDrafts((current) => ({ ...current, [field.name]: valueText(field.value) }))
                      }
                      className="mt-0.5 w-full truncate rounded-sm border border-kumo-line px-1 py-0.5 text-start text-[11px] text-kumo-default hover:bg-kumo-base"
                    >
                      {valueText(field.value).length === 0 ? t('form.field.empty') : valueText(field.value)}
                    </button>
                  ) : (
                    <span className="mt-0.5 block truncate px-1 text-[11px] text-kumo-subtle">
                      {valueText(field.value).length === 0 ? t('form.field.empty') : valueText(field.value)}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
