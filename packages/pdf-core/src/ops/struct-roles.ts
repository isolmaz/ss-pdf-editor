/**
 * The structure types a tagged PDF may use and how a role name resolves to one. Kept apart
 * from the readers and writers so the tagger (`accessibility.ts`) and the tree editor
 * (`structure-model.ts`) share one table without importing each other.
 */

/**
 * The structure types of ISO 32000-1 §14.8.4 (Tables 333–340) — the set PDF/UA-1 allows
 * without a role map. `Artifact` is **not** here: it is a marked-content tag, not a
 * structure type, and the editor treats it separately.
 */
export const STANDARD_ROLES: ReadonlySet<string> = new Set([
  'Document',
  'Part',
  'Art',
  'Sect',
  'Div',
  'BlockQuote',
  'Caption',
  'TOC',
  'TOCI',
  'Index',
  'NonStruct',
  'Private',
  'P',
  'H',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'L',
  'LI',
  'Lbl',
  'LBody',
  'Table',
  'TR',
  'TH',
  'TD',
  'THead',
  'TBody',
  'TFoot',
  'Span',
  'Quote',
  'Note',
  'Reference',
  'BibEntry',
  'Code',
  'Link',
  'Annot',
  'Ruby',
  'RB',
  'RT',
  'RP',
  'Warichu',
  'WT',
  'WP',
  'Figure',
  'Formula',
  'Form',
]);

/** The types the editor lets a block be changed to, in the order its list shows them. */
export const EDITOR_ROLES: readonly string[] = [
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'Figure',
  'Formula',
  'Table',
  'TR',
  'TH',
  'TD',
  'THead',
  'TBody',
  'TFoot',
  'Caption',
  'L',
  'LI',
  'Lbl',
  'LBody',
  'Link',
  'Span',
  'Quote',
  'BlockQuote',
  'Note',
  'Code',
  'Sect',
  'Div',
  'Part',
  'Art',
  'TOC',
  'TOCI',
  'NonStruct',
];

/**
 * A role name resolved through `/RoleMap` to the standard type it ends in. A standard
 * type resolves to itself (a role map must not remap one; the PDF/UA check reports it),
 * and a chain that loops or never reaches a standard type resolves to `null`.
 */
export function resolveRole(role: string, roleMap: Readonly<Record<string, string>>): string | null {
  const seen = new Set<string>();
  let current = role;
  for (let hop = 0; hop < 32; hop += 1) {
    if (STANDARD_ROLES.has(current)) return current;
    if (seen.has(current)) return null;
    seen.add(current);
    const next = roleMap[current];
    if (next === undefined) return null;
    current = next;
  }
  return null;
}
