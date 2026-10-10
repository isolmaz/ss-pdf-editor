/**
 * The app's identity marker, kept out of what pdf.js shows.
 *
 * This app names its annotations `pdf-editor-ann:<id>` (`/NM`). Files written before the
 * name carried it have the marker at the head of `/Contents` instead, and pdf.js renders
 * `/Contents` verbatim into the hover popup it builds for a markup annotation, so the
 * reader saw an opaque id above their own words. The page shows `commentText`, the same
 * reading `readAnnotations` gives the comments panel.
 *
 * pdf.js builds a popup when it is first shown, long after the annotation layer was
 * rendered, so the popups are watched for rather than patched once.
 */

import { commentText } from 'pdf-core/ops/annotations';

const MARKER = 'pdf-editor-ann:';

/** Strip the marker from every text node under `node` that carries one. */
function cleanTree(node: Node): void {
  if (node instanceof Text) {
    if (node.data.includes(MARKER)) node.data = commentText(node.data);
    return;
  }
  if (!(node instanceof Element) || !node.textContent.includes(MARKER)) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if ((current as Text).data.includes(MARKER)) hits.push(current as Text);
  }
  for (const text of hits) text.data = commentText(text.data);
}

/** Watch `root` for popups and clean each one as it appears; returns the disconnect. */
export function hideEditorMarkers(root: HTMLElement): () => void {
  cleanTree(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') cleanTree(record.target);
      for (const added of record.addedNodes) cleanTree(added);
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
