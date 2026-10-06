/**
 * The tags view of the accessibility panel: the document's structure tree — or, for a file
 * with no tags, the order its content is drawn in — as a list the user can reorder, retag
 * and describe, with the order shown as numbered boxes on the page itself
 * (`ReadingOrderLayer`).
 *
 * ## A draft, then one write
 *
 * Nothing is written while the user works. Every change is a `StructEdit` appended to a
 * draft list; the tree on screen is `applyStructureEdits(base, edits)` — the same pure
 * function the writer verifies its output against — so what the draft shows is what the file
 * will read back as. **Apply** hands the whole list to `editStructure` (tagged files) or the
 * plan to `tagDocument` (untagged files) and the produced bytes go to the shell like any
 * other result. A change the draft cannot make (a cycle, an element that owns an annotation
 * turned into an artifact) is refused when it is attempted, with the reason, not when the
 * file is written.
 *
 * ## Two honest limits
 *
 * An untagged file has no reading order to *edit*: it has the order the content is drawn
 * in, which is what a reader falls back to. The view says so and shows that order. And the
 * boxes on the page are placed from the page's glyphs and the geometry of its pictures; a
 * block this reader could not bound has a row but no box.
 *
 * Every sentence is a dictionary key (`tags.*`); `key()` is the accessibility views' seam.
 */

import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Prohibit,
  TextIndent,
  TextOutdent,
} from '@phosphor-icons/react';
import { tagDocument } from 'pdf-core/ops/accessibility';
import { fixPdfUa } from 'pdf-core/ops/pdfua';
import type { PageLayout, StructureView, TagCandidate, TagCandidates } from 'pdf-core/ops/structure';
import { editStructure, readPageLayout, readStructure, readTagCandidates } from 'pdf-core/ops/structure';
import type { StructEdit, StructNode, StructureModel, TableScope } from 'pdf-core/ops/structure-model';
import {
  applyStructureEdits,
  EDITOR_ROLES,
  elementKids,
  findNode,
  nodePages,
  readingOrder,
  StructEditError,
} from 'pdf-core/ops/structure-model';
import type { OperationContext, OperationNote } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { toToolError } from 'pdf-shared';
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';
import type { WrittenOutcome } from './PdfUaView';
import {
  type OverlayItem,
  type OverlayPage,
  type OverlayRect,
  readingOrderStore,
  useReadingOrder,
} from './reading-order-store';

const key = (value: string): MessageKey => value as MessageKey;

export interface TagsViewProps {
  readonly t: Translator;
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /** Written as `/Lang` when an untagged file is tagged and has none. */
  readonly language?: string;
  /** 0-based page the viewer shows. */
  readonly currentPage: number;
  readonly canEdit: boolean;
  readonly onGoToPage?: (pageIndex: number) => void;
  readonly onWritten?: (outcome: WrittenOutcome) => void;
  readonly onNotice?: (message: string) => void;
}

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: MessageKey }
  | { readonly status: 'tagged'; readonly bytes: Uint8Array; readonly view: StructureView }
  | {
      readonly status: 'untagged';
      readonly bytes: Uint8Array;
      readonly pageCount: number;
      readonly candidates: TagCandidates;
    };

export function TagsView(props: TagsViewProps) {
  const { t, read, onNotice } = props;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const handlers = useRef({ onNotice, t });
  handlers.current = { onNotice, t };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const context: OperationContext = { signal: controller.signal };
    void (async () => {
      try {
        const bytes = await read(context);
        const view = await readStructure(bytes, context);
        if (cancelled) return;
        if (view.model.present && view.model.readable) {
          setLoaded({ status: 'tagged', bytes, view });
          return;
        }
        const candidates = await readTagCandidates(bytes, context);
        if (cancelled) return;
        setLoaded({ status: 'untagged', bytes, pageCount: view.pageCount, candidates });
      } catch (error) {
        if (cancelled) return;
        const mapped = toToolError(error, 'ui');
        setLoaded({ status: 'failed', message: mapped.messageKey });
        handlers.current.onNotice?.(handlers.current.t(mapped.messageKey));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      readingOrderStore.setPages([]);
    };
  }, [read]);

  if (loaded.status === 'loading') return <PanelLoading />;
  if (loaded.status === 'failed') return <PanelMessage text={t(loaded.message)} />;
  if (loaded.status === 'tagged') {
    return <TaggedEditor {...props} bytes={loaded.bytes} view={loaded.view} />;
  }
  return (
    <UntaggedEditor
      {...props}
      bytes={loaded.bytes}
      pageCount={loaded.pageCount}
      candidates={loaded.candidates}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Page layouts, loaded for the pages around the one on screen
 * ------------------------------------------------------------------ */

function usePageLayouts(bytes: Uint8Array, wanted: readonly number[]): ReadonlyMap<number, PageLayout> {
  const [layouts, setLayouts] = useState<ReadonlyMap<number, PageLayout>>(new Map());
  const have = useRef(new Set<number>());
  const wantedKey = wanted.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wantedKey` stands for `wanted`.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      for (const pageIndex of wanted) {
        if (have.current.has(pageIndex)) continue;
        try {
          const layout = await readPageLayout(bytes, pageIndex, { signal: controller.signal });
          if (cancelled) return;
          have.current.add(pageIndex);
          setLayouts((current) => new Map(current).set(pageIndex, layout));
        } catch {
          // A page whose layout cannot be read has no boxes; its rows are still listed.
          if (cancelled) return;
          have.current.add(pageIndex);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bytes, wantedKey]);
  return layouts;
}

function pagesAround(current: number, count: number, extra: readonly number[] = []): readonly number[] {
  const pages = new Set<number>(extra);
  for (const page of [current, current + 1, current - 1]) if (page >= 0 && page < count) pages.add(page);
  return [...pages].sort((left, right) => left - right);
}

function union(current: OverlayRect | null, next: OverlayRect): OverlayRect {
  if (current === null) return next;
  return [
    Math.min(current[0], next[0]),
    Math.min(current[1], next[1]),
    Math.max(current[2], next[2]),
    Math.max(current[3], next[3]),
  ];
}

/* ------------------------------------------------------------------ *
 * Tagged files
 * ------------------------------------------------------------------ */

interface TaggedEditorProps extends TagsViewProps {
  readonly bytes: Uint8Array;
  readonly view: StructureView;
}

interface Row {
  readonly node: StructNode;
  readonly parent: StructNode | null;
  readonly depth: number;
}

/** Rows shown at most; a bigger tree is cut here and says so. */
const ROW_LIMIT = 800;

function elementKidsOf(model: StructureModel, parent: StructNode | null): readonly StructNode[] {
  return parent === null ? model.roots : elementKids(parent);
}

function errorKey(error: unknown): MessageKey | null {
  return error instanceof StructEditError ? key(`tags.err.${error.reason}`) : null;
}

function TaggedEditor({
  t,
  bytes,
  view,
  currentPage,
  canEdit,
  onGoToPage,
  onWritten,
  onNotice,
}: TaggedEditorProps) {
  const base = view.model;
  const [edits, setEdits] = useState<readonly StructEdit[]>([]);
  const [scope, setScope] = useState<'page' | 'all'>(view.pageCount > 1 ? 'page' : 'all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => initialCollapsed(base));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [altDraft, setAltDraft] = useState<Readonly<Record<string, string>>>({});
  const [dropTarget, setDropTarget] = useState<{
    readonly key: string;
    readonly zone: 'before' | 'into' | 'after';
  } | null>(null);
  const [groupRole, setGroupRole] = useState('Sect');
  const counter = useRef(1);
  const alive = useRef(true);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const { selectedKeys } = useReadingOrder();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const draft = useMemo(() => {
    try {
      return applyStructureEdits(base, edits);
    } catch {
      return base;
    }
  }, [base, edits]);

  const select = useCallback((keys: readonly string[]) => readingOrderStore.setSelected(keys), []);

  // A request from the PDF/UA view to open one element: select it, show its path, go to its page.
  useEffect(() => {
    const focus = readingOrderStore.takeFocus();
    if (focus === null) return;
    readingOrderStore.setSelected([focus.key]);
    setScope('all');
    setCollapsed((current) => {
      const next = new Set(current);
      const found = findNode(base, focus.key);
      if (found !== null) {
        let cursor: StructNode | null = found.parent;
        while (cursor !== null) {
          next.delete(cursor.key);
          cursor = findNode(base, cursor.key)?.parent ?? null;
        }
      }
      return next;
    });
    if (focus.pageIndex !== null) onGoToPage?.(focus.pageIndex);
  }, [base, onGoToPage]);

  const selectedNodes = useMemo(
    () =>
      selectedKeys.flatMap((selectedKey) => {
        const found = findNode(draft, selectedKey);
        return found === null ? [] : [found];
      }),
    [draft, selectedKeys],
  );
  const single = selectedNodes.length === 1 ? (selectedNodes[0] ?? null) : null;

  const layouts = usePageLayouts(
    bytes,
    pagesAround(currentPage, view.pageCount, single?.node.pageIndex == null ? [] : [single.node.pageIndex]),
  );

  const order = useMemo(() => readingOrder(draft), [draft]);
  const numberOnPage = useMemo(() => {
    const numbers = new Map<string, number>();
    let count = 0;
    for (const entry of order) {
      if (!entry.mcids.has(currentPage)) continue;
      count += 1;
      numbers.set(entry.key, count);
    }
    return numbers;
  }, [order, currentPage]);

  // The numbered boxes: the draft's order, with each element's box from the page's layout.
  useEffect(() => {
    const pages: OverlayPage[] = [];
    for (const [pageIndex, layout] of layouts) {
      const byMcid = new Map(layout.items.map((item) => [item.mcid, item]));
      const items: OverlayItem[] = [];
      let number = 0;
      for (const entry of order) {
        const mcids = entry.mcids.get(pageIndex);
        if (mcids === undefined) continue;
        number += 1;
        let rect: OverlayRect | null = null;
        for (const mcid of mcids) {
          const box = byMcid.get(mcid)?.rect;
          if (box != null) rect = union(rect, box);
        }
        if (rect !== null) items.push({ key: entry.key, number, role: entry.role, rect });
      }
      pages.push({
        pageIndex,
        width: layout.width,
        height: layout.height,
        rotation: layout.rotation,
        items,
      });
    }
    readingOrderStore.setPages(pages);
  }, [layouts, order]);

  const labelOf = useCallback(
    (node: StructNode): string => {
      for (const kid of node.kids) {
        if (kid.kind !== 'content' || kid.item.kind !== 'mcid' || kid.item.pageIndex === null) continue;
        const text = layouts
          .get(kid.item.pageIndex)
          ?.items.find((item) => item.mcid === (kid.item as { mcid: number }).mcid)?.text;
        if (text !== undefined && text !== '') return text;
      }
      return node.alt ?? '';
    },
    [layouts],
  );

  /* ---- the visible rows ---- */
  const rows = useMemo(() => {
    const list: Row[] = [];
    const walk = (node: StructNode, parent: StructNode | null, depth: number): void => {
      if (scope === 'page') {
        const pages = nodePages(node);
        if (pages.length > 0 && !pages.includes(currentPage)) return;
      }
      list.push({ node, parent, depth });
      if (collapsed.has(node.key)) return;
      for (const child of elementKids(node)) walk(child, node, depth + 1);
    };
    for (const root of draft.roots) walk(root, null, 0);
    return list;
  }, [draft, scope, currentPage, collapsed]);

  /* ---- editing ---- */
  const attempt = useCallback(
    (next: readonly StructEdit[]): boolean => {
      try {
        applyStructureEdits(base, [...edits, ...next]);
      } catch (error) {
        const message = errorKey(error);
        onNotice?.(t(message ?? key('tags.err.generic')));
        return false;
      }
      setEdits((current) => [...current, ...next]);
      return true;
    },
    [base, edits, onNotice, t],
  );

  const parentKeyOf = (parent: StructNode | null): string => (parent === null ? '<root>' : parent.key);

  const moveBy = (target: { node: StructNode; parent: StructNode | null }, delta: -1 | 1) => {
    const siblings = elementKidsOf(draft, target.parent);
    const index = siblings.findIndex((entry) => entry.key === target.node.key);
    const to = index + delta;
    if (index < 0 || to < 0 || to >= siblings.length) return;
    attempt([{ op: 'move', key: target.node.key, parentKey: parentKeyOf(target.parent), index: to }]);
  };

  const indent = (target: { node: StructNode; parent: StructNode | null }) => {
    const siblings = elementKidsOf(draft, target.parent);
    const index = siblings.findIndex((entry) => entry.key === target.node.key);
    const previous = siblings[index - 1];
    if (previous === undefined) return;
    attempt([
      { op: 'move', key: target.node.key, parentKey: previous.key, index: elementKids(previous).length },
    ]);
  };

  const outdent = (target: { node: StructNode; parent: StructNode | null }) => {
    const parent = target.parent;
    if (parent === null) return;
    const holder = findNode(draft, parent.key);
    if (holder === null) return;
    const aunts = elementKidsOf(draft, holder.parent);
    const at = aunts.findIndex((entry) => entry.key === parent.key);
    attempt([{ op: 'move', key: target.node.key, parentKey: parentKeyOf(holder.parent), index: at + 1 }]);
  };

  const canMove = (target: { node: StructNode; parent: StructNode | null }, delta: -1 | 1): boolean => {
    const siblings = elementKidsOf(draft, target.parent);
    const index = siblings.findIndex((entry) => entry.key === target.node.key);
    return target.node.editable && index + delta >= 0 && index + delta < siblings.length;
  };

  const onDrop = (event: DragEvent<HTMLElement>, over: Row, zone: 'before' | 'into' | 'after') => {
    event.preventDefault();
    setDropTarget(null);
    const moving = event.dataTransfer.getData('text/x-tag-key');
    if (moving === '' || moving === over.node.key) return;
    if (zone === 'into') {
      attempt([{ op: 'move', key: moving, parentKey: over.node.key, index: elementKids(over.node).length }]);
      return;
    }
    const siblings = elementKidsOf(draft, over.parent).filter((entry) => entry.key !== moving);
    const at = siblings.findIndex((entry) => entry.key === over.node.key);
    attempt([
      {
        op: 'move',
        key: moving,
        parentKey: parentKeyOf(over.parent),
        index: zone === 'before' ? at : at + 1,
      },
    ]);
  };

  const zoneOf = (event: DragEvent<HTMLElement>): 'before' | 'into' | 'after' => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(1, box.height);
    return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into';
  };

  const newKey = (): string => {
    const value = `n${String(counter.current)}`;
    counter.current += 1;
    return value;
  };

  const groupSelected = (role: string) => {
    if (selectedNodes.length === 0) return;
    attempt([{ op: 'group', keys: selectedNodes.map((entry) => entry.node.key), role, newKey: newKey() }]);
  };

  const makeList = () => {
    if (selectedNodes.length === 0) return;
    const next: StructEdit[] = [];
    const items: string[] = [];
    for (const entry of selectedNodes) {
      const body = newKey();
      const item = newKey();
      next.push({ op: 'group', keys: [entry.node.key], role: 'LBody', newKey: body });
      next.push({ op: 'group', keys: [body], role: 'LI', newKey: item });
      items.push(item);
    }
    next.push({ op: 'group', keys: items, role: 'L', newKey: newKey() });
    attempt(next);
  };

  const apply = async () => {
    if (edits.length === 0) return;
    const controller = new AbortController();
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await editStructure(bytes, edits, { signal: controller.signal });
      if (!alive.current) return;
      onWritten?.({ bytes: outcome.bytes, notes: outcome.report.notes, steps: outcome.report.steps });
    } catch (error) {
      if (!alive.current) return;
      const mapped = toToolError(error, 'ui');
      setFailure(mapped.messageKey);
      onNotice?.(t(mapped.messageKey));
    } finally {
      controller.abort();
      if (alive.current) setBusy(false);
    }
  };

  /* ---- keyboard: the tree is a roving-tabindex list ---- */
  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = rows.findIndex((row) => row.node.key === selectedKeys[0]);
    const row = rows[current];
    if (row === undefined) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (canEdit) moveBy(row, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = rows[current + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next !== undefined) select([next.node.key]);
    } else if (event.key === 'ArrowRight' && collapsed.has(row.node.key)) {
      event.preventDefault();
      setCollapsed((currentSet) => {
        const next = new Set(currentSet);
        next.delete(row.node.key);
        return next;
      });
    } else if (
      event.key === 'ArrowLeft' &&
      !collapsed.has(row.node.key) &&
      elementKids(row.node).length > 0
    ) {
      event.preventDefault();
      setCollapsed((currentSet) => new Set(currentSet).add(row.node.key));
    }
  };

  // Keep the selected row in view when the page's boxes (not the list) were clicked.
  useEffect(() => {
    const first = selectedKeys[0];
    if (first === undefined) return;
    treeRef.current
      ?.querySelector(`[data-tag-key="${CSS.escape(first)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedKeys]);

  const altValue = (node: StructNode): string => altDraft[node.key] ?? node.alt ?? '';

  const needsAlt = (node: StructNode): boolean =>
    (node.standard === 'Figure' || node.standard === 'Formula') &&
    node.alt === null &&
    node.actualText === null;

  const hiddenRows = Math.max(0, rows.length - ROW_LIMIT);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tags-mode="tagged">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <label className="flex items-center gap-1 text-[11px] text-kumo-subtle">
          <span className="sr-only">{t(key('tags.scope.label'))}</span>
          <select
            value={scope}
            aria-label={t(key('tags.scope.label'))}
            onChange={(event) => setScope(event.target.value as 'page' | 'all')}
            className="rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-xs text-kumo-default"
          >
            <option value="page">{t(key('tags.scope.page'), { page: currentPage + 1 })}</option>
            <option value="all">{t(key('tags.scope.all'))}</option>
          </select>
        </label>
        <div className="ms-auto flex items-center gap-0.5" role="toolbar" aria-label={t(key('tags.toolbar'))}>
          <IconButton
            label={t(key('tags.up'))}
            disabled={!canEdit || single === null || !canMove(single, -1)}
            onClick={() => single !== null && moveBy(single, -1)}
            icon={<ArrowUp size={14} aria-hidden="true" />}
            testId="tags-up"
          />
          <IconButton
            label={t(key('tags.down'))}
            disabled={!canEdit || single === null || !canMove(single, 1)}
            onClick={() => single !== null && moveBy(single, 1)}
            icon={<ArrowDown size={14} aria-hidden="true" />}
            testId="tags-down"
          />
          <IconButton
            label={t(key('tags.outdent'))}
            disabled={
              !canEdit ||
              single === null ||
              single.parent === null ||
              findNode(draft, single.parent.key)?.parent == null
            }
            onClick={() => single !== null && outdent(single)}
            icon={<TextOutdent size={14} aria-hidden="true" />}
            testId="tags-outdent"
          />
          <IconButton
            label={t(key('tags.indent'))}
            disabled={!canEdit || single === null || !canMove(single, -1)}
            onClick={() => single !== null && indent(single)}
            icon={<TextIndent size={14} aria-hidden="true" />}
            testId="tags-indent"
          />
        </div>
      </div>

      {failure !== null ? <PanelMessage text={t(failure)} /> : null}

      {/* The tree. */}
      <div
        ref={treeRef}
        role="tree"
        aria-label={t(key('tags.tree.label'))}
        aria-multiselectable="true"
        onKeyDown={onTreeKey}
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {rows.length === 0 ? <PanelMessage text={t(key('tags.empty'))} /> : null}
        {rows.slice(0, ROW_LIMIT).map((row) => {
          const { node, depth } = row;
          const kids = elementKids(node);
          const isSelected = selectedKeys.includes(node.key);
          const isCollapsed = collapsed.has(node.key);
          const number = numberOnPage.get(node.key);
          const label = labelOf(node);
          const drop = dropTarget?.key === node.key ? dropTarget.zone : null;
          return (
            <div
              key={node.key}
              role="treeitem"
              tabIndex={isSelected || (selectedKeys.length === 0 && row === rows[0]) ? 0 : -1}
              aria-level={depth + 1}
              aria-selected={isSelected}
              aria-expanded={kids.length > 0 ? !isCollapsed : undefined}
              data-tag-key={node.key}
              data-tag-role={node.role}
              draggable={canEdit && node.editable}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/x-tag-key', node.key);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!canEdit) return;
                event.preventDefault();
                setDropTarget({ key: node.key, zone: zoneOf(event) });
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => onDrop(event, row, zoneOf(event))}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) {
                  select(
                    isSelected
                      ? selectedKeys.filter((entry) => entry !== node.key)
                      : [...selectedKeys, node.key],
                  );
                } else if (event.shiftKey && selectedKeys[0] !== undefined) {
                  const from = rows.findIndex((entry) => entry.node.key === selectedKeys[0]);
                  const to = rows.indexOf(row);
                  const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
                  select(range.filter((entry) => entry.parent === row.parent).map((entry) => entry.node.key));
                } else {
                  select([node.key]);
                  const page = node.pageIndex ?? nodePages(node)[0];
                  if (page !== undefined && page !== currentPage) onGoToPage?.(page);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select([node.key]);
                }
              }}
              style={{ paddingLeft: `${String(depth * 12 + 2)}px` }}
              className={`flex items-center gap-1 rounded-sm py-0.5 pe-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-kumo-focus ${
                isSelected ? 'bg-pdf-accent/15 text-kumo-strong' : 'text-kumo-default hover:bg-kumo-recessed'
              } ${drop === 'into' ? 'ring-1 ring-pdf-accent' : ''} ${drop === 'before' ? 'border-t-2 border-pdf-accent' : ''} ${
                drop === 'after' ? 'border-b-2 border-pdf-accent' : ''
              }`}
            >
              {kids.length > 0 ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t(key(isCollapsed ? 'tags.expand' : 'tags.collapse'))}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(node.key)) next.delete(node.key);
                      else next.add(node.key);
                      return next;
                    });
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-kumo-recessed"
                >
                  {isCollapsed ? (
                    <CaretRight size={10} className="rtl:-scale-x-100" aria-hidden="true" />
                  ) : (
                    <CaretDown size={10} aria-hidden="true" />
                  )}
                </button>
              ) : (
                <span className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span
                className={`w-4 shrink-0 text-end text-[10px] tabular-nums ${number === undefined ? 'text-transparent' : 'text-kumo-subtle'}`}
                aria-hidden="true"
              >
                {number ?? 0}
              </span>
              <span
                className={`shrink-0 rounded-sm border px-1 text-[10px] font-semibold ${
                  node.standard === null
                    ? 'border-kumo-danger text-kumo-danger'
                    : 'border-kumo-line text-kumo-strong'
                }`}
                title={
                  node.standard !== null && node.standard !== node.role
                    ? t(key('tags.mappedTo'), { role: node.standard })
                    : undefined
                }
              >
                {node.role === '' ? '?' : node.role}
              </span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {needsAlt(node) ? (
                <span
                  className="shrink-0 text-[10px] font-semibold text-kumo-warning"
                  title={t(key('tags.noAlt'))}
                >
                  {t(key('tags.noAlt.short'))}
                </span>
              ) : null}
            </div>
          );
        })}
        {hiddenRows > 0 ? (
          <p className="p-1.5 text-[11px] text-kumo-subtle">
            {t(key('tags.moreRows'), { count: hiddenRows })}
          </p>
        ) : null}
      </div>

      {/* The selected element(s). */}
      <div className="shrink-0 border-t border-kumo-line p-2 text-xs">
        {selectedNodes.length === 0 ? (
          <p className="text-[11px] text-kumo-subtle">{t(key('tags.select.hint'))}</p>
        ) : single === null ? (
          <MultiSelection
            t={t}
            count={selectedNodes.length}
            disabled={busy || !canEdit}
            groupRole={groupRole}
            onGroupRole={setGroupRole}
            onGroup={() => groupSelected(groupRole)}
            onList={makeList}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <label className="flex min-w-0 flex-1 items-center gap-1">
                <span className="shrink-0 text-[11px] text-kumo-subtle">{t(key('tags.type'))}</span>
                <select
                  value={single.node.role}
                  disabled={busy || !canEdit || !single.node.editable}
                  aria-label={t(key('tags.type'))}
                  data-tags-role-select=""
                  onChange={(event) =>
                    attempt([{ op: 'role', key: single.node.key, role: event.target.value }])
                  }
                  className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-xs text-kumo-default"
                >
                  {(EDITOR_ROLES.includes(single.node.role)
                    ? EDITOR_ROLES
                    : [single.node.role, ...EDITOR_ROLES]
                  ).map((role) => (
                    <option key={role} value={role} disabled={!EDITOR_ROLES.includes(role)}>
                      {role === '' ? '?' : role}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                disabled={busy || !canEdit || !single.node.editable}
                onClick={() => attempt([{ op: 'artifact', key: single.node.key }])}
                aria-label={t(key('tags.artifact.help'))}
                title={t(key('tags.artifact.help'))}
              >
                <Prohibit size={12} aria-hidden="true" /> {t(key('tags.artifact'))}
              </Button>
            </div>
            {single.node.standard === 'Figure' ||
            single.node.standard === 'Formula' ||
            single.node.alt !== null ? (
              <div className="flex items-center gap-1">
                <label className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="sr-only">{t(key('tags.alt.label'))}</span>
                  <input
                    value={altValue(single.node)}
                    placeholder={t(key('tags.alt.label'))}
                    disabled={busy || !canEdit || !single.node.editable}
                    data-tags-alt=""
                    onChange={(event) => {
                      const value = event.target.value;
                      setAltDraft((current) => ({ ...current, [single.node.key]: value }));
                    }}
                    className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1.5 py-1 text-xs text-kumo-default"
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !canEdit ||
                    altValue(single.node).trim() === '' ||
                    altValue(single.node).trim() === single.node.alt
                  }
                  onClick={() => {
                    if (attempt([{ op: 'alt', key: single.node.key, alt: altValue(single.node) }])) {
                      setAltDraft((current) => {
                        const { [single.node.key]: _removed, ...rest } = current;
                        return rest;
                      });
                    }
                  }}
                >
                  {t(key('tags.alt.set'))}
                </Button>
              </div>
            ) : null}
            {single.node.standard === 'TH' ? (
              <label className="flex items-center gap-1">
                <span className="shrink-0 text-[11px] text-kumo-subtle">{t(key('tags.scope.th'))}</span>
                <select
                  value={single.node.scope ?? ''}
                  disabled={busy || !canEdit || !single.node.editable}
                  aria-label={t(key('tags.scope.th'))}
                  onChange={(event) =>
                    attempt([
                      {
                        op: 'scope',
                        key: single.node.key,
                        scope: (event.target.value === '' ? null : event.target.value) as TableScope | null,
                      },
                    ])
                  }
                  className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-xs text-kumo-default"
                >
                  <option value="">{t(key('tags.scope.none'))}</option>
                  <option value="Column">{t(key('tags.scope.column'))}</option>
                  <option value="Row">{t(key('tags.scope.row'))}</option>
                  <option value="Both">{t(key('tags.scope.both'))}</option>
                </select>
              </label>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                disabled={busy || !canEdit || !single.node.editable}
                onClick={() => groupSelected(groupRole)}
              >
                {t(key('tags.group'))}
              </Button>
              <GroupRoleSelect t={t} value={groupRole} onChange={setGroupRole} disabled={busy || !canEdit} />
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !canEdit ||
                  !single.node.editable ||
                  single.node.kids.some((kid) => kid.kind === 'content') ||
                  elementKids(single.node).length === 0
                }
                onClick={() => attempt([{ op: 'unwrap', key: single.node.key }])}
              >
                {t(key('tags.unwrap'))}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* The draft. */}
      <div className="flex shrink-0 items-center gap-1 border-t border-kumo-line px-2 py-1.5">
        <span
          className="min-w-0 flex-1 text-[11px] text-kumo-subtle"
          aria-live="polite"
          data-tags-draft={edits.length}
        >
          {edits.length === 0
            ? t(key('tags.draft.none'))
            : t(key('tags.draft.count'), { count: edits.length })}
        </span>
        <Button
          variant="outline"
          disabled={busy || edits.length === 0}
          onClick={() => setEdits((current) => current.slice(0, -1))}
        >
          {t(key('tags.undo'))}
        </Button>
        <Button variant="outline" disabled={busy || edits.length === 0} onClick={() => setEdits([])}>
          {t(key('tags.discard'))}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !canEdit || edits.length === 0}
          onClick={() => void apply()}
          data-tags-apply=""
        >
          {t(key('tags.apply'))}
        </Button>
      </div>
    </div>
  );
}

/** Roles a group can be wrapped in. */
const GROUP_ROLES: readonly string[] = [
  'Sect',
  'Div',
  'Part',
  'Art',
  'BlockQuote',
  'L',
  'Table',
  'TR',
  'TOC',
  'Note',
];

function GroupRoleSelect({
  t,
  value,
  onChange,
  disabled,
}: {
  readonly t: Translator;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={t(key('tags.group.role'))}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-xs text-kumo-default"
    >
      {GROUP_ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}

function MultiSelection({
  t,
  count,
  disabled,
  groupRole,
  onGroupRole,
  onGroup,
  onList,
}: {
  readonly t: Translator;
  readonly count: number;
  readonly disabled: boolean;
  readonly groupRole: string;
  readonly onGroupRole: (value: string) => void;
  readonly onGroup: () => void;
  readonly onList: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-kumo-subtle">{t(key('tags.multi'), { count })}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="outline" disabled={disabled} onClick={onGroup}>
          {t(key('tags.group'))}
        </Button>
        <GroupRoleSelect t={t} value={groupRole} onChange={onGroupRole} disabled={disabled} />
        <Button variant="outline" disabled={disabled} onClick={onList} data-tags-list="">
          {t(key('tags.makeList'))}
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  icon,
  testId,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-sm border border-kumo-line text-kumo-default hover:bg-kumo-recessed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

/** A big tree starts folded below its second level, so the first screen is the document's outline. */
function initialCollapsed(model: StructureModel): ReadonlySet<string> {
  if (model.nodeCount <= 300) return new Set();
  const folded = new Set<string>();
  const walk = (node: StructNode, depth: number): void => {
    if (depth >= 2 && elementKids(node).length > 0) folded.add(node.key);
    for (const child of elementKids(node)) walk(child, depth + 1);
  };
  for (const root of model.roots) walk(root, 0);
  return folded;
}

/* ------------------------------------------------------------------ *
 * Untagged files
 * ------------------------------------------------------------------ */

interface UntaggedEditorProps extends TagsViewProps {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly candidates: TagCandidates;
}

interface PagePlanState {
  order: string[];
  roles: Record<string, string>;
  alts: Record<string, string>;
}

/** Roles a block can be given in the untagged editor, with `Artifact` for decoration. */
const PLAN_ROLES: readonly string[] = [
  ...EDITOR_ROLES.slice(0, 8),
  'L',
  'LI',
  'Caption',
  'Quote',
  'Sect',
  'Artifact',
];

function UntaggedEditor({
  t,
  bytes,
  pageCount,
  candidates,
  language,
  currentPage,
  canEdit,
  onWritten,
  onNotice,
}: UntaggedEditorProps) {
  const [plan, setPlan] = useState<Readonly<Record<number, PagePlanState>>>(() => {
    const initial: Record<number, PagePlanState> = {};
    for (const page of candidates.pages) {
      initial[page.pageIndex] = {
        order: page.candidates.map((entry) => entry.id),
        roles: Object.fromEntries(page.candidates.map((entry) => [entry.id, entry.role])),
        alts: Object.fromEntries(
          page.candidates.flatMap((entry) => (entry.alt === null ? [] : [[entry.id, entry.alt]])),
        ),
      };
    }
    return initial;
  });
  const [artifactPaths, setArtifactPaths] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const alive = useRef(true);
  const { selectedKeys } = useReadingOrder();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const byPage = useMemo(() => new Map(candidates.pages.map((page) => [page.pageIndex, page])), [candidates]);
  const page = byPage.get(currentPage);
  const state = plan[currentPage];
  const lookup = useMemo(
    () => new Map((page?.candidates ?? []).map((entry) => [entry.id, entry] as const)),
    [page],
  );

  // The boxes: every planned page, in the plan's order, artifacts shown without a number.
  useEffect(() => {
    const pages: OverlayPage[] = [];
    for (const entry of candidates.pages) {
      const pagePlan = plan[entry.pageIndex];
      if (pagePlan === undefined) continue;
      const items: OverlayItem[] = [];
      let number = 0;
      for (const id of pagePlan.order) {
        const candidate = entry.candidates.find((value) => value.id === id);
        const role = pagePlan.roles[id] ?? candidate?.role ?? 'P';
        if (role === 'Artifact') continue;
        number += 1;
        if (candidate?.rect != null) items.push({ key: id, number, role, rect: candidate.rect });
      }
      pages.push({
        pageIndex: entry.pageIndex,
        width: entry.width,
        height: entry.height,
        rotation: entry.rotation,
        items,
      });
    }
    readingOrderStore.setPages(pages);
  }, [candidates, plan]);

  const update = (pageIndex: number, change: (value: PagePlanState) => PagePlanState) =>
    setPlan((current) => {
      const existing = current[pageIndex];
      if (existing === undefined) return current;
      return { ...current, [pageIndex]: change(existing) };
    });

  const move = (id: string, delta: -1 | 1) =>
    update(currentPage, (value) => {
      const index = value.order.indexOf(id);
      const to = index + delta;
      if (index < 0 || to < 0 || to >= value.order.length) return value;
      const order = [...value.order];
      order.splice(index, 1);
      order.splice(to, 0, id);
      return { ...value, order };
    });

  const dropBefore = (moving: string, target: string) =>
    update(currentPage, (value) => {
      if (moving === target) return value;
      const order = value.order.filter((id) => id !== moving);
      const at = order.indexOf(target);
      order.splice(at < 0 ? order.length : at, 0, moving);
      return { ...value, order };
    });

  const apply = async () => {
    const controller = new AbortController();
    const context: OperationContext = { signal: controller.signal };
    setBusy(true);
    setFailure(null);
    try {
      const pages: Record<
        number,
        { order: string[]; roles: Record<string, string>; alts: Record<string, string> }
      > = {};
      for (const [pageIndex, value] of Object.entries(plan)) {
        pages[Number(pageIndex)] = { order: value.order, roles: value.roles, alts: value.alts };
      }
      const tagged = await tagDocument(bytes, context, {
        ...(language === undefined ? {} : { language }),
        plan: { pages },
      });
      let outBytes = tagged.bytes;
      const notes: OperationNote[] = [...tagged.report.notes];
      const steps = [...tagged.report.steps];
      if (artifactPaths && tagged.bytes !== bytes) {
        const cleaned = await fixPdfUa(tagged.bytes, [{ kind: 'artifact-paths' }], context);
        outBytes = cleaned.bytes;
        notes.push(...cleaned.report.notes.filter((entry) => entry.kind !== 'preserved'));
        steps.push(...cleaned.report.steps.filter((step) => step.startsWith('ua.')));
      }
      if (!alive.current) return;
      onWritten?.({ bytes: outBytes, notes, steps });
    } catch (error) {
      if (!alive.current) return;
      const mapped = toToolError(error, 'ui');
      setFailure(mapped.messageKey);
      onNotice?.(t(mapped.messageKey));
    } finally {
      controller.abort();
      if (alive.current) setBusy(false);
    }
  };

  let number = 0;
  const rows = (state?.order ?? []).map((id) => {
    const candidate = lookup.get(id);
    const role = state?.roles[id] ?? candidate?.role ?? 'P';
    if (role !== 'Artifact') number += 1;
    return { id, candidate, role, number: role === 'Artifact' ? null : number };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tags-mode="untagged">
      <div className="shrink-0 border-b border-kumo-line px-2 py-1.5">
        <p className="text-[11px] text-kumo-default">{t(key('tags.untagged.title'))}</p>
        <p className="text-[10px] text-kumo-subtle">{t(key('tags.untagged.explain'))}</p>
      </div>
      {failure !== null ? <PanelMessage text={t(failure)} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <p className="px-1.5 pb-1 text-[11px] font-semibold text-kumo-strong">
          {t(key('tags.untagged.page'), { page: currentPage + 1, count: pageCount })}
        </p>
        {page === undefined || state === undefined ? (
          <PanelMessage text={t(key('tags.untagged.noBlocks'))} />
        ) : (
          <ol className="flex flex-col" aria-label={t(key('tags.untagged.list'))}>
            {rows.map((row) => {
              const isSelected = selectedKeys.includes(row.id);
              return (
                <li
                  key={row.id}
                  data-plan-id={row.id}
                  onDragOver={(event) => {
                    if (!canEdit) return;
                    event.preventDefault();
                    setDropOn(row.id);
                  }}
                  onDragLeave={() => setDropOn(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDropOn(null);
                    dropBefore(event.dataTransfer.getData('text/x-plan-id'), row.id);
                  }}
                  className={`flex flex-col gap-1 rounded-sm px-1 py-1 ${
                    isSelected ? 'bg-pdf-accent/15' : 'hover:bg-kumo-recessed'
                  } ${dropOn === row.id ? 'border-t-2 border-pdf-accent' : ''}`}
                >
                  <div className="flex items-center gap-1">
                    <span className="w-4 shrink-0 text-end text-[10px] text-kumo-subtle tabular-nums">
                      {row.number ?? '–'}
                    </span>
                    <button
                      type="button"
                      draggable={canEdit}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/x-plan-id', row.id);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => readingOrderStore.setSelected([row.id])}
                      aria-pressed={isSelected}
                      className="min-w-0 flex-1 truncate rounded-sm text-start text-xs text-kumo-default"
                    >
                      {row.candidate?.kind === 'figure'
                        ? t(key('tags.untagged.figure'))
                        : (row.candidate?.text ?? row.id)}
                    </button>
                    <select
                      value={row.role}
                      disabled={busy || !canEdit}
                      aria-label={t(key('tags.type'))}
                      onChange={(event) =>
                        update(currentPage, (value) => ({
                          ...value,
                          roles: { ...value.roles, [row.id]: event.target.value },
                        }))
                      }
                      className="w-20 shrink-0 rounded-sm border border-kumo-line bg-kumo-base px-0.5 py-0.5 text-[11px] text-kumo-default"
                    >
                      {(PLAN_ROLES.includes(row.role) ? PLAN_ROLES : [row.role, ...PLAN_ROLES]).map(
                        (role) => (
                          <option key={role} value={role}>
                            {role === 'Artifact' ? t(key('tags.artifact')) : role}
                          </option>
                        ),
                      )}
                    </select>
                    <IconButton
                      label={t(key('tags.up'))}
                      disabled={busy || !canEdit || state.order[0] === row.id}
                      onClick={() => move(row.id, -1)}
                      icon={<ArrowUp size={12} aria-hidden="true" />}
                      testId="plan-up"
                    />
                    <IconButton
                      label={t(key('tags.down'))}
                      disabled={busy || !canEdit || state.order[state.order.length - 1] === row.id}
                      onClick={() => move(row.id, 1)}
                      icon={<ArrowDown size={12} aria-hidden="true" />}
                      testId="plan-down"
                    />
                  </div>
                  {row.candidate?.kind === 'figure' && row.role === 'Figure' ? (
                    <label className="flex items-center gap-1 ps-5">
                      <span className="sr-only">{t(key('tags.alt.label'))}</span>
                      <input
                        value={state.alts[row.id] ?? ''}
                        placeholder={t(key('tags.alt.label'))}
                        disabled={busy || !canEdit}
                        onChange={(event) => {
                          const value = event.target.value;
                          update(currentPage, (current) => ({
                            ...current,
                            alts: { ...current.alts, [row.id]: value },
                          }));
                        }}
                        className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-xs text-kumo-default"
                      />
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {page !== undefined && page.skipped > 0 ? (
          <p className="px-1.5 pt-1 text-[11px] text-kumo-warning">
            {t(key('tags.untagged.skipped'), { count: page.skipped })}
          </p>
        ) : null}
        {candidates.notes.length > 0 ? (
          <ul className="px-1.5 pt-2 text-[10px] text-kumo-subtle">
            {candidates.notes.map((entry, index) => (
              <li key={`${entry.key}-${String(index)}`}>{t(entry.key, entry.params)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t border-kumo-line px-2 py-1.5">
        <label className="flex items-start gap-1.5 text-[11px] text-kumo-default">
          <input
            type="checkbox"
            checked={artifactPaths}
            disabled={busy}
            onChange={(event) => setArtifactPaths(event.target.checked)}
            className="mt-0.5"
          />
          <span>{t(key('tags.untagged.artifactPaths'))}</span>
        </label>
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 text-[10px] text-kumo-subtle">
            {language === undefined
              ? t(key('tags.untagged.noLanguage'))
              : t(key('tags.untagged.language'), { lang: language })}
          </span>
          <Button
            variant="primary"
            disabled={busy || !canEdit || candidates.pages.length === 0}
            onClick={() => void apply()}
            data-tags-apply=""
          >
            {t(key('tags.untagged.apply'))}
          </Button>
        </div>
      </div>
    </div>
  );
}

export type { TagCandidate };
