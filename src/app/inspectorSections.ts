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

import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';

export type SectionId =
  | 'transform'
  | 'mesh'
  | 'material'
  | 'render'
  | 'animate'
  | 'channel'
  | 'constraint'
  | 'driver'
  | 'curve'
  | 'light'
  | 'modifier'
  | 'effect'
  | 'environment'
  | 'camera'
  | 'layout'
  | 'slots';

export const SECTION_IDS: readonly SectionId[] = [
  'transform',
  'mesh',
  'material',
  'render',
  'animate',
  'channel',
  // Operator substrate — CHOP/constraints (epic #201, V58). The TrackTo node
  // declares this section; param-routing predicates land here in a later slice.
  'constraint',
  // Operator substrate — CHOP/drivers (#316, V98/V99). The PARAM-writing half of the
  // same relational species the 'constraint' section covers for POSE. Declared by every
  // node that declares 'constraint' (a scene object whose params can be driven) plus the
  // ParamDriver itself, so selecting a driver row keeps its stack on screen.
  'driver',
  // The path itself (#321) — a Curve's control points, closed flag and resolution. Its TRS
  // stays in 'transform' (a curve is posed like any object); this section owns the SHAPE.
  'curve',
  // The light's shading (#386) — a LightData's kind + intensity/colour/falloff/aim. Its
  // pose (position/rotation/scale) stays on the Object's 'transform'; this section owns the
  // SHADING. The H189 parity the split's linked-data inspector needs.
  'light',
  // Operator substrate — SOP/modifiers (epic #201, #209, V58). The geometry
  // operator stack (ArrayModifier et al.) declares this section.
  'modifier',
  // Operator substrate — video effects (epic #235, V58 lift to Image). The effect
  // stack (ColorCorrect et al.) declares this section.
  'effect',
  'environment',
  'camera',
  'layout',
  // The OBJECT's per-slot material overrides (#645). Deliberately NOT 'material': that
  // section is the DATA's, and the panel already draws it in the linked-data block. This
  // one answers the other half of the reference's per-slot question — which slots does
  // THIS object re-point, leaving the shared datablock untouched.
  'slots',
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
  return SECTION_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Sections whose card title is not their id title-cased.
 *
 * Deliberately a lookup with ONE entry rather than a renamed id. 'Material Slots' is two
 * words and the id is a key — used in persistence, in `home` declarations and in the frozen
 * golden — so spelling the display name into the id would put a presentation choice
 * everywhere the key travels. #645: a card reading 'Slots' in a panel that already says
 * 'Submesh' one control over names the wrong dimension.
 */
const SECTION_LABELS: Partial<Record<SectionId, string>> = {
  slots: 'Material Slots',
};

/** D-10 A — multi-select Inspector resolution: show Transform + Layout
 *  (the two foundational sections common to every node type that has
 *  any). 'Metadata' from §7.2 is not in the v0.5 catalog; Layout is
 *  the closest "foundational positioning hints" substitute. */
export const MULTI_SELECT_SECTIONS: readonly SectionId[] = ['transform', 'layout'];

/** Route a param path to its owning section, from the node type's own `home`
 *  declaration (`NodeDefinition.home`, #394 PLAN-3 P6).
 *
 *  Returns null when the param has no home — it renders in the raw fallback
 *  bucket, which is visible, not hidden.
 *
 *  ── WHY THIS IS A LOOKUP AND NOT A PREDICATE CHAIN ─────────────────────────
 *
 *  Until P6 this was ~190 lines of `declaredSections.includes(s) && (path ===
 *  'a' || path === 'b' || …)`, one arm per section. Every arm was gated on the
 *  declared sections for one reason: three param keys mean different things on
 *  different nodes — `color` (light vs material), `lookAt` (transform vs camera
 *  vs light), `roll` (transform vs camera). The chain resolved those by ARM
 *  ORDER, so adding a param meant editing a shared file and hoping no earlier
 *  arm claimed the key first. A per-node table resolves them by construction.
 *
 *  `declaredSections` is still consulted, and it is load-bearing: a home naming
 *  a section this node does not declare is treated as unrouted. `rowsForNode`
 *  emits rows by walking the DECLARED sections, so a row grouped under an
 *  undeclared one is never emitted at all — honouring such a home would make the
 *  param VANISH, where falling through to the raw bucket keeps it on screen.
 *  That is the same degradation the old chain gave, preserved deliberately.
 *  `paramHome.gate.test.ts` fails on such an entry, so this is a backstop.
 */
export function paramToSection(
  paramPath: string,
  declaredSections: readonly SectionId[],
  nodeType: string | undefined,
): SectionId | null {
  const home = nodeType ? getNodeType(nodeType)?.home?.[paramPath] : undefined;
  if (home === undefined || !isSectionId(home)) return null;
  return declaredSections.includes(home) ? home : null;
}

/** The sections a NODE declares, narrowed to known ids.
 *
 *  The single read seam for "which sections does this node show?". Today it
 *  resolves the node's TYPE and returns that type's static `inspectorSections`
 *  — byte-identical to the two inline lookups it replaces. It takes a node id
 *  rather than a type because the declaration is a property of the node, and
 *  only incidentally a property of its type: a template/subgraph instance
 *  (Milestone 2) has one type for every instance, and its sections must come
 *  from its promoted parameters. Resolving through one call keeps that a new
 *  implementation behind this function instead of a rework of both call sites.
 *
 *  Unknown strings are filtered out (the same narrowing the call sites did),
 *  so a stale/renamed section id in a registry entry degrades to "not shown"
 *  rather than rendering an untitled card.
 *
 *  REF: docs/UNIFICATION-PRINCIPLES.md §2 ("the one thing that genuinely would
 *  not hold"); #458.
 */
export function sectionsOf(
  state: DagState,
  nodeId: string | null | undefined,
): readonly SectionId[] {
  const node = nodeId ? state.nodes[nodeId] : undefined;
  if (!node) return NO_SECTIONS;
  const declared = getNodeType(node.type)?.inspectorSections;
  if (!declared || declared.length === 0) return NO_SECTIONS;
  // The narrowed array is cached against the registry's own (module-constant)
  // array so this returns a STABLE reference for a given node type. Call sites
  // subscribe through a `useDagStore` selector, and zustand compares with
  // Object.is — a fresh `.filter()` result every call would re-render the
  // inspector on every unrelated store change.
  let narrowed = narrowedSections.get(declared);
  if (!narrowed) {
    narrowed = declared.filter(isSectionId);
    narrowedSections.set(declared, narrowed);
  }
  return narrowed;
}

const NO_SECTIONS: readonly SectionId[] = [];
const narrowedSections = new WeakMap<readonly string[], SectionId[]>();

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
