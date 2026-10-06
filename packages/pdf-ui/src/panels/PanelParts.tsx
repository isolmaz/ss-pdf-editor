/**
 * The two body states the reader panels share. They live in
 * one file because four panels would otherwise carry four copies of the same markup;
 * both states are product surface, not leftovers.
 */

/** A line of text where a list would be — the panels' empty and fallback states. */
export function PanelMessage({ text }: { readonly text: string }) {
  return <p className="p-3 text-xs text-kumo-subtle">{text}</p>;
}

/**
 * The body before the engine has answered. A skeleton rather than a sentence: the
 * panels carry no dictionary key for "loading" (the outline tab is the one view with
 * one), and a bar cannot say the wrong thing in the wrong language.
 */
export function PanelLoading() {
  return (
    <div className="space-y-2 p-3" aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-2.5 rounded-sm bg-kumo-recessed" />
      ))}
    </div>
  );
}
