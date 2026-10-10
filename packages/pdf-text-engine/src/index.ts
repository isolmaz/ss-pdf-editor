/**
 * `pdf-text-engine` — the text model and block-local reflow engine.
 *
 *   - text model — `buildTextPage`, `lineOrientation`, `blockOrientation`;
 *   - editability — `measureEditability`;
 *   - block-local reflow — `reflowBlock`, `measureLineWidth`;
 *   - font engine — `createFontCatalog`, `matchFont`, `metricsFor`, `readFontHeader`,
 *     `describeFontName`, `DEFAULT_FONT_CANDIDATES`;
 *   - the writer's request — `planTextEdit`.
 *
 * Pure by construction: plain data in, plain data out. No pdf.js, MuPDF or
 * React import, no file or network access, no DOM. Font metrics take the glyph lookups
 * as an argument (`GlyphSource`, the shape of MuPDF's `Font`) and read only the font
 * header from the bytes they are given, not a path. Geometry is always unrotated PDF
 * user space with a top-left origin — see `types.ts`.
 */
export * from './editability';
export * from './fonts';
export * from './model';
export * from './plan';
export * from './reflow';
export * from './types';
