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
  | 'constraint'
  | 'driver'
  | 'curve'
  | 'modifier'
  | 'effect'
  | 'environment'
  | 'camera'
  | 'layout';

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
  // Operator substrate — SOP/modifiers (epic #201, #209, V58). The geometry
  // operator stack (ArrayModifier et al.) declares this section.
  'modifier',
  // Operator substrate — video effects (epic #235, V58 lift to Image). The effect
  // stack (ColorCorrect et al.) declares this section.
  'effect',
  'environment',
  'camera',
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

/** Route a param path to its owning section. Predicate-based — no
 *  parallel mapping table to drift from the catalog. Returns null when
 *  the param doesn't belong to any declared section (renders in raw
 *  fallback area). Caller passes the node's declared sections so the
 *  router can degrade gracefully (e.g. a 'material' param on a node
 *  that doesn't declare 'material' falls through to the raw bucket).
 */
export function paramToSection(
  paramPath: string,
  declaredSections: readonly SectionId[],
): SectionId | null {
  // Transform params — position / rotation / scale. lookAt (camera aim target)
  // is positional, so it groups with Transform too (UX #12). pivot (a Group's
  // origin, #222/#228) is the rotation/scale centre → also Transform. roll (a
  // camera's bank about the view axis, #229) is an orientation property → also
  // Transform, beside its position/lookAt. All first-class labeled rows instead
  // of stray raw-fallback rows.
  if (
    declaredSections.includes('transform') &&
    (paramPath === 'position' ||
      paramPath === 'rotation' ||
      paramPath === 'scale' ||
      paramPath === 'pivot' ||
      paramPath === 'lookAt' ||
      paramPath === 'roll')
  ) {
    return 'transform';
  }
  // Curve params (#321) — the path's SHAPE. `points` renders through a dedicated rows
  // control (a variable-length vec3 list has no generic param row); `closed` and
  // `resolution` are ordinary rows that land here beside it.
  if (
    declaredSections.includes('curve') &&
    (paramPath === 'points' || paramPath === 'closed' || paramPath === 'resolution')
  ) {
    return 'curve';
  }
  // Mesh params — size / radius / segments / topology hints.
  if (
    declaredSections.includes('mesh') &&
    (paramPath === 'size' ||
      paramPath === 'radius' ||
      paramPath === 'widthSegments' ||
      paramPath === 'heightSegments' ||
      paramPath === 'assetRef')
  ) {
    return 'mesh';
  }
  // Material params — color / material / opacity / metalness / roughness / emissive.
  if (
    declaredSections.includes('material') &&
    (paramPath === 'material' ||
      paramPath === 'color' ||
      paramPath === 'opacity' ||
      paramPath === 'metalness' ||
      paramPath === 'roughness' ||
      paramPath === 'emissive' ||
      paramPath === 'emissiveIntensity')
  ) {
    return 'material';
  }
  // Render params — paths, settings, codec, fps, frame ranges, presets.
  if (
    declaredSections.includes('render') &&
    (paramPath === 'outputPath' ||
      paramPath === 'frameStart' ||
      paramPath === 'frameEnd' ||
      paramPath === 'fps' ||
      paramPath === 'codec' ||
      paramPath === 'presetId' ||
      paramPath === 'promptText' ||
      paramPath === 'settings' ||
      paramPath === 'jobId')
  ) {
    return 'render';
  }
  // Animate params — playback / weight / time / clipId. extendBefore/extendAfter
  // (#270, D1 per-side extrapolation) are the channel's playback ENVELOPE — what
  // the animation does before it starts / after it ends — so they group with
  // weight here. Routing them out of the raw-fallback bucket lets the animate
  // section author them via the dedicated ChannelExtendControls (NPanel), mirroring
  // how Environment/Camera params route here only to leave the raw bucket.
  if (
    declaredSections.includes('animate') &&
    (paramPath === 'weight' ||
      paramPath === 'playing' ||
      paramPath === 'startFrame' ||
      paramPath === 'endFrame' ||
      paramPath === 'clipId' ||
      paramPath === 'targetPath' ||
      paramPath === 'extendBefore' ||
      paramPath === 'extendAfter' ||
      // #274 (D2) / #275 — the F-Modifier stack (Noise, Cycles …) is authored by the
      // dedicated ChannelModifierControls in the animate section; route it out of the
      // raw bucket (mirrors extendBefore/After). The #270 cycle counts live in the
      // Cycles modifier now, so no separate cyclesBefore/After params to route.
      paramPath === 'modifiers')
  ) {
    return 'animate';
  }
  // Channel params — interpolation / loop / keyframes themselves.
  if (
    declaredSections.includes('channel') &&
    (paramPath === 'interpolation' ||
      paramPath === 'loop' ||
      paramPath === 'keyframes' ||
      paramPath === 'easing' ||
      paramPath === 'paramPath')
  ) {
    return 'channel';
  }
  // Environment params (UX #9) — the scene-level HDRI/IBL config. Routed here so
  // they group under the Environment section's custom control instead of landing
  // in the raw-fallback bucket; the custom control (SceneEnvironmentControls)
  // authors them, so the generic ParamRows for this section are suppressed.
  if (
    declaredSections.includes('environment') &&
    (paramPath === 'envSource' ||
      paramPath === 'envIntensity' ||
      paramPath === 'envRotationY' ||
      paramPath === 'envBackground')
  ) {
    return 'environment';
  }
  // Camera params (UX #12) — fov / sensorSize / near / far / zoom (ortho). Routed
  // here so they group under the Camera section's custom control instead of the
  // raw-fallback bucket; the custom control (CameraLensControls) authors them, so
  // the generic ParamRows for this section are suppressed (mirrors Environment).
  if (
    declaredSections.includes('camera') &&
    (paramPath === 'fov' ||
      paramPath === 'sensorSize' ||
      paramPath === 'near' ||
      paramPath === 'far' ||
      paramPath === 'zoom' ||
      paramPath === 'dofEnabled' ||
      paramPath === 'focusDistance' ||
      paramPath === 'fStop' ||
      // #247 (fix #257): focusOnTarget is authored by CameraLensControls' DoF
      // block; without routing it here it ALSO leaked into the raw unrouted-params
      // bucket as a second, duplicate toggle.
      paramPath === 'focusOnTarget')
  ) {
    return 'camera';
  }
  // Modifier params (epic #201, #209) — the geometry operator's params (Array's
  // count/offset, mute). Routed here so they group under the Modifier section.
  if (
    declaredSections.includes('modifier') &&
    (paramPath === 'count' || paramPath === 'offset' || paramPath === 'muted')
  ) {
    return 'modifier';
  }
  // Layout params — name / labels / cosmetic positioning.
  if (
    declaredSections.includes('layout') &&
    (paramPath === 'name' || paramPath === 'label' || paramPath === 'notes')
  ) {
    return 'layout';
  }
  return null;
}

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
