import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { listPdfLayers, type PdfLayerNode, setPdfLayerVisibility } from 'pdf-core/layers';
import type { LayerWriteRequest } from 'pdf-core/ops/layer-write';
import { type ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

/**
 * The optional content groups of the document ("Katmanlar"):
 * the layer tree with a checkbox per group. A checkbox goes through pdf.js's public
 * `setVisibility` (`pdf-core/layers.ts`) — never through the rendering stack — and
 * changes **the view only**; the page repaints, the file does not change.
 *
 * Writing that view state into the file is a separate, explicit act: the
 * "Katman durumunu belgeye yaz" button hands the state the panel is showing up as a
 * `LayerWriteRequest` (`onWriteDocument`). The panel owns the view and no bytes; the
 * shell owns the bytes and runs `ops/layer-write.ts`, so the produced document comes
 * back through the session as one journal step.
 *
 * The tree is always the state the engine just reported: a click waits for the write
 * and applies what came back, so a checkbox can neither run ahead of the document nor
 * drift away from it after a failure.
 */

export interface LayersPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** The shell's notice line (`App.tsx` state) — receives already-translated text. */
  readonly onNotice?: (message: string) => void;
  /**
   * Fired after the engine accepted a visibility change. The engine alone does not
   * repaint: pdf.js only re-renders when its `optionalContentConfigPromise` is
   * re-assigned, so the shell wires this to the viewer. Measured before it existed:
   * the checkbox flipped while the canvas stayed byte-identical.
   */
  readonly onLayersChanged?: () => void;
  /**
   * Write the state the panel shows into the file (`ops/layer-write.ts`). The panel
   * owns the view state and the shell owns the bytes, so the request travels up and the
   * produced document returns through the session — the panel never touches a writer.
   * Absent in a host that only reads.
   */
  readonly onWriteDocument?: (request: LayerWriteRequest) => void;
  /**
   * The host is not taking writes right now — no document, viewing tier, or an
   * operation already running. The button stays visible and stops responding, which is
   * the same rule the sibling writer panels follow.
   */
  readonly disabled?: boolean;
}

/**
 * The group nodes of the tree in reading order. Labels (a heading the document's order
 * carries without a group of its own) are not layers and are skipped; the writer's own
 * report names any group whose name it could not find.
 */
function flattenGroups(
  nodes: readonly PdfLayerNode[],
): { readonly name: string; readonly visible: boolean }[] {
  const groups: { name: string; visible: boolean }[] = [];
  for (const node of nodes) {
    if (node.kind === 'label') {
      groups.push(...flattenGroups(node.children));
      continue;
    }
    groups.push({ name: node.name, visible: node.visible });
    groups.push(...flattenGroups(node.children));
  }
  return groups;
}

interface LayersState {
  /** `null` while the engine has not answered yet. */
  readonly layers: readonly PdfLayerNode[] | null;
  readonly failure: ToolError | null;
}

const INITIAL: LayersState = { layers: null, failure: null };

export function LayersPanel({
  document,
  t,
  onNotice,
  onLayersChanged,
  onWriteDocument,
  disabled,
}: LayersPanelProps) {
  const [state, setState] = useState<LayersState>(INITIAL);
  /** Groups whose write is in flight — one toggle at a time, per group. */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const handlers = useRef({ onNotice, t });
  useEffect(() => {
    handlers.current = { onNotice, t };
  });
  // A ref, not a dependency: the panel must not re-subscribe when the shell re-renders.
  const onLayersChangedRef = useRef(onLayersChanged);
  useEffect(() => {
    onLayersChangedRef.current = onLayersChanged;
  });

  const report = useCallback((error: ToolError) => {
    const { onNotice: notify, t: translate } = handlers.current;
    notify?.(translate(error.messageKey));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL);
    setPending(new Set());

    void (async () => {
      try {
        const layers = await listPdfLayers(document);
        if (controller.signal.aborted) return;
        setState({ layers, failure: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = toToolError(error, 'ui');
        setState({ layers: [], failure });
        report(failure);
      }
    })();

    return () => controller.abort();
  }, [document, report]);

  const toggle = useCallback(
    async (id: string, visible: boolean) => {
      setPending((previous) => new Set(previous).add(id));
      try {
        const layers = await setPdfLayerVisibility(document, id, visible);
        setState({ layers, failure: null });
        // The engine holds the new visibility, but pdf.js repaints only when its
        // config promise is re-assigned — the shell does that through the viewer.
        onLayersChangedRef.current?.();
      } catch (error) {
        report(toToolError(error, 'ui'));
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
      }
    },
    [document, report],
  );

  if (state.failure !== null) return <PanelMessage text={t(state.failure.messageKey)} />;
  if (state.layers === null) return <PanelLoading />;
  if (state.layers.length === 0) return <PanelMessage text={t('panel.layers.empty')} />;

  // Captured after the guard: the click handler is a closure, and TypeScript keeps no
  // narrowing inside one.
  const layers = state.layers;

  return (
    <fieldset className="m-0 flex min-h-0 flex-1 flex-col border-0 p-2" aria-label={t('panel.layers')}>
      {onWriteDocument === undefined ? null : (
        <Button
          variant="outline"
          className="mb-2 w-full"
          disabled={disabled === true || pending.size > 0}
          title={t('panel.layers.writeHint')}
          onClick={() => {
            const groups = flattenGroups(layers);
            onWriteDocument({ states: groups, order: groups.map((group) => group.name) });
          }}
        >
          {t('panel.layers.write')}
        </Button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LayerLevel
          t={t}
          nodes={layers}
          depth={0}
          pending={pending}
          onToggle={(id, visible) => void toggle(id, visible)}
        />
      </div>
    </fieldset>
  );
}

function LayerLevel({
  t,
  nodes,
  depth,
  pending,
  onToggle,
}: {
  t: Translator;
  nodes: readonly PdfLayerNode[];
  depth: number;
  pending: ReadonlySet<string>;
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <ul className={depth === 0 ? '' : 'ml-3 border-l border-kumo-line pl-2'}>
      {nodes.map((node) =>
        node.kind === 'group' ? (
          <li key={node.id}>
            <label className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs text-kumo-default hover:bg-kumo-tint">
              <input
                type="checkbox"
                checked={node.visible}
                disabled={pending.has(node.id)}
                onChange={(event) => onToggle(node.id, event.target.checked)}
                className="size-3.5 shrink-0 accent-kumo-brand"
              />
              <span className="truncate" title={node.name}>
                {node.name}
              </span>
            </label>
            {node.children.length === 0 ? null : (
              <LayerLevel
                t={t}
                nodes={node.children}
                depth={depth + 1}
                pending={pending}
                onToggle={onToggle}
              />
            )}
          </li>
        ) : (
          // A level of the document's own order that carries no group: groups the
          // order left out arrive here under a `null` heading.
          <li key={`label-${node.name ?? ''}-${depth}`}>
            {node.name === null ? null : (
              <p className="px-1 py-0.5 text-[11px] text-kumo-subtle" title={node.name}>
                {node.name}
              </p>
            )}
            <LayerLevel t={t} nodes={node.children} depth={depth + 1} pending={pending} onToggle={onToggle} />
          </li>
        ),
      )}
    </ul>
  );
}
