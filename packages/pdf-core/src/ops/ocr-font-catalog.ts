/**
 * The open fonts a scanned page can be set in. A scan's words are measured against a face and
 * exported to Word under that face's name; the more faces the app ships, the likelier one matches
 * the scan. Every family here is SIL OFL-1.1 (the licence file of each `@expo-google-fonts/*`
 * package ends up in `dist/licenses/`), static TrueType, and covers the Turkish letters
 * (`ğ Ğ ı İ ş Ş ç Ç ö Ö ü Ü`) — a family that lacked one was left out (Lato).
 *
 * The files are fetched by `pnpm fetch:engines` into `public/fonts/<dir>/` (`tools/fetch-engines.mjs`
 * names each one, `tools/asset-pins.json` pins its size and hash) and served from our own origin,
 * like the Noto Sans every other writer loads (`engines/noto.ts`). {@link loadOpenFace} is the one
 * way to read one: a missing file or no network is `null`, never a throw, so a caller can fall
 * back to the stand-in fonts.
 */

/** A face of a family: the keys of {@link OpenFamily.files}. */
export type OpenFaceStyle = 'regular' | 'italic' | 'bold' | 'boldItalic';

export interface OpenFamily {
  /** Stable key (also the name of the family's package). */
  id: string;
  /** The font name Word is given. */
  name: string;
  kind: 'sans' | 'serif' | 'mono';
  /** Asset paths under `/fonts/`, one per face the family ships. */
  files: {
    regular: string;
    italic?: string;
    bold?: string;
    boldItalic?: string;
  };
}

/** The four faces every family ships (the semi-bold and medium cuts are not offered: a bold run is set in the Bold). */
function faces(dir: string, file: string): OpenFamily['files'] {
  const path = (style: string): string => `/fonts/${dir}/${file}-${style}.ttf`;
  return {
    regular: path('Regular'),
    italic: path('Italic'),
    bold: path('Bold'),
    boldItalic: path('BoldItalic'),
  };
}

/** Every family the app ships, Noto Sans first (the one the writers already embed). */
export const OPEN_FAMILIES: readonly OpenFamily[] = [
  { id: 'noto-sans', name: 'Noto Sans', kind: 'sans', files: faces('noto', 'NotoSans') },
  { id: 'roboto', name: 'Roboto', kind: 'sans', files: faces('roboto', 'Roboto') },
  { id: 'open-sans', name: 'Open Sans', kind: 'sans', files: faces('open-sans', 'OpenSans') },
  { id: 'montserrat', name: 'Montserrat', kind: 'sans', files: faces('montserrat', 'Montserrat') },
  { id: 'inter', name: 'Inter', kind: 'sans', files: faces('inter', 'Inter') },
  {
    id: 'source-sans-3',
    name: 'Source Sans 3',
    kind: 'sans',
    files: faces('source-sans-3', 'SourceSans3'),
  },
  { id: 'poppins', name: 'Poppins', kind: 'sans', files: faces('poppins', 'Poppins') },
  {
    id: 'merriweather',
    name: 'Merriweather',
    kind: 'serif',
    files: faces('merriweather', 'Merriweather'),
  },
  { id: 'noto-serif', name: 'Noto Serif', kind: 'serif', files: faces('noto-serif', 'NotoSerif') },
  {
    id: 'roboto-mono',
    name: 'Roboto Mono',
    kind: 'mono',
    files: faces('roboto-mono', 'RobotoMono'),
  },
];

/** Bytes by asset path. A **failed** fetch is dropped (while it is still the entry), so a later call retries. */
const faceCache = new Map<string, Promise<Uint8Array | null>>();

/**
 * The bytes of one face, fetched from our own origin once and kept for the session; `null` when
 * the family ships no such face, the asset is missing (any non-2xx answer) or the fetch fails
 * (offline) — the caller then sets the page in the stand-ins, as before.
 */
export function loadOpenFace(family: OpenFamily, style: OpenFaceStyle): Promise<Uint8Array | null> {
  const url = family.files[style];
  if (url === undefined) return Promise.resolve(null);
  const cached = faceCache.get(url);
  if (cached !== undefined) return cached;
  const request: Promise<Uint8Array | null> = fetch(url).then(
    async (response) => (response.ok ? new Uint8Array(await response.arrayBuffer()) : null),
    () => null,
  );
  faceCache.set(url, request);
  // Only a successful read stays: a missing file or a blip must not stick for the session.
  void request.then((bytes) => {
    if (bytes === null && faceCache.get(url) === request) faceCache.delete(url);
  });
  return request;
}
