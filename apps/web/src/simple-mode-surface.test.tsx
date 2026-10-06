/**
 * The simple mode's surface lists, checked against the surfaces they filter.
 *
 * `SIMPLE_MODE_RAIL_GROUPS` and `SIMPLE_MODE_DOCK_TABS` are plain string lists handed to
 * the tools rail and the document dock. A list that names a group the rail does not have
 * (a typo, a renamed group) filters nothing the way it was meant to and nothing but a
 * render shows it, so these tests render the real rail with the real list.
 */

import { ToolsRailPanel } from 'pdf-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SIMPLE_MODE_RAIL_GROUPS } from './commands';

/** The translator stub renders the dictionary key, so the markup names the group it shows. */
const t = Object.assign((key: string) => key, { locale: 'en' as const }) as never;

const GROUPS = ['pages', 'export', 'sign', 'security', 'stamp'] as const;

/** A group's header is the rail's one disclosure button: the label it opens and closes. */
const GROUP_TITLE = /<button[^>]*aria-expanded="(?:true|false)"[^>]*><span[^>]*>([^<]*)<\/span>/g;

/** The group headings the rail renders, in order, read from the markup (not substring-searched). */
function shownGroups(visibleGroups?: readonly string[]): string[] {
  const markup = renderToStaticMarkup(
    <ToolsRailPanel t={t} {...(visibleGroups === undefined ? {} : { visibleGroups })} />,
  );
  return [...markup.matchAll(GROUP_TITLE)].map((match) => (match[1] ?? '').replace(/^tools\.group\./, ''));
}

describe('the tools rail in the simple mode', () => {
  it('shows every group when no filter is given — the advanced mode', () => {
    expect(shownGroups()).toEqual([...GROUPS]);
  });

  it('shows exactly the groups the simple mode names, and hides the advanced ones', () => {
    const shown = shownGroups(SIMPLE_MODE_RAIL_GROUPS);
    expect(shown).toEqual(['pages', 'export', 'sign']);
    // Every id in the list is a group the rail really has: an unknown id would be
    // dropped by the filter and the list would silently offer less than it says.
    expect(shown.length).toBe(SIMPLE_MODE_RAIL_GROUPS.length);
  });
});
