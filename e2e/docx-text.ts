/**
 * The text of each paragraph in a WordprocessingML part, as Word shows it.
 *
 * A paragraph's words can be split over many runs (the exact layout gives the letters of a
 * word their own character spacing), so the runs' `w:t` pieces are joined without a
 * separator; a tab or a line break inside the paragraph reads as a space.
 */
export function paragraphTexts(xml: string): string[] {
  return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((paragraph) =>
    (paragraph.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
      .map((piece) =>
        piece.startsWith('<w:t') && piece.endsWith('</w:t>') ? piece.replace(/<[^>]+>/g, '') : ' ',
      )
      .join(''),
  );
}
