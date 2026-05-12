// Inspector section convention (P6 W4 — UI-SPEC §5.8 + §7.2).
//
// Each Inspector section is a collapsible card. Sections are declared
// per-node-type in the node registry (NodeDefinition.inspectorSections);
// the Inspector renders them in the declared order. The first declared
// section is the *primary domain* for that node type; non-primary
// sections default to collapsed (§5.8: "sections that aren't the primary
// domain of the selected node type are collapsed by default").
//
// D-07 — section IDs are string literals (Mode / LeftSidebarTab pattern).
// tsc catches typos at the call site. A SECTION_IDS array exists for
// registry-snapshot validation + persistence-key narrowing.
//
// REF: docs/UI-SPEC.md §5.8 (section convention), §7.2 (sectionsByNodeType),
// §7.3 (per-node-type collapse persistence); D-06, D-07, D-08, D-10
// locked W4.

export type SectionId =
  | 'transform'
  | 'mesh'
  | 'material'
  | 'render'
  | 'animate'
  | 'channel'
  | 'layout';

export const SECTION_IDS: readonly SectionId[] = [
  'transform',
  'mesh',
  'material',
  'render',
  'animate',
  'channel',
  'layout',
];

/** Type-narrow at the persistence boundary — unknown strings (legacy
 *  values, malformed JSON) fall back to defaults rather than corrupt
 *  the store. */
export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);
}

/** Display label for a section. Title-case the literal id. Kept pure
 *  so future i18n drops in as a substitution layer above this fn. */
export function formatSectionLabel(id: SectionId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** D-10 A — multi-select Inspector resolution: show Transform + Layout
 *  (the two foundational sections common to every node type that has
 *  any). 'Metadata' from §7.2 is not in the v0.5 catalog; Layout is
 *  the closest "foundational positioning hints" substitute. */
export const MULTI_SELECT_SECTIONS: readonly SectionId[] = ['transform', 'layout'];

/** Default-collapsed convention (§5.8). A section is default-collapsed
 *  iff it is NOT the primary domain of the selected node type.
 *
 *  @param sections  The node type's declared inspectorSections, in order.
 *  @param id        The section being rendered.
 *  @returns true when the section should start collapsed.
 */
export function isDefaultCollapsed(sections: readonly SectionId[], id: SectionId): boolean {
  if (sections.length === 0) return false;
  return sections[0] !== id;
}
