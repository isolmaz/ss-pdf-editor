import type { CommentsPanelProps } from 'pdf-ui/panels';
import { lazy, Suspense } from 'react';

/**
 * The comments panel is not on the first-paint path: it is fetched with the panels chunk
 * the first time the comments tab opens. Static imports cannot express that split.
 */
const CommentsPanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.CommentsPanel };
});

/** The comments tab of the right dock: the panel, with its own name standing in while it loads. */
export function CommentsDock(props: CommentsPanelProps) {
  return (
    <Suspense
      fallback={
        <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
          {props.t('panel.comments')}
        </p>
      }
    >
      <CommentsPanel {...props} />
    </Suspense>
  );
}
