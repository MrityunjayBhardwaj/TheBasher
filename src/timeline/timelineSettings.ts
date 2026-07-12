// timelineSettings — the ONE source of truth for the timeline surfaces' layout
// geometry. Values live in the sibling `timelineSettings.json` (grouped by
// surface family); this module is the thin typed accessor over them: named
// exports so a call site changes only its import, derived values JSON can't
// express, and the WHY comments that keep the two families from being "fixed"
// into agreement.
//
// WHY a JSON + accessor split, not just a .ts of consts:
//   The JSON holds VALUES (a designer/agent can read + edit them without parsing
//   TypeScript). The .ts holds TYPES, DERIVATIONS, and NAMES. resolveJsonModule
//   is already true in both tsconfigs; this is the repo's first src-imported JSON
//   and sets the convention (values → .json, meaning → .ts).
//
// TWO FAMILIES, DIFFERENT BY DESIGN — do NOT reconcile them into one set:
//   • `lane`      — the compositor + NLA outline lanes: a left header column of
//                   names/toggles beside horizontal bars. Row 28 / ruler 22.
//   • `dopesheet` — the keyframe grid (TimelineCanvas): a DENSE multi-channel
//                   grid of diamonds. Row 24 / ruler 17 / gutter 84. Tighter on
//                   purpose. These values are MIRRORED by the drag/position e2e
//                   (the H95 trap: change a constant and N specs silently target
//                   the wrong pixel), so a value change here is a visual change
//                   that must move the e2e baselines in lockstep — never a
//                   "cleanup" to match the lane family.
//
// SCOPE (slice 1): the `lane` family is wired — `videoTimelineGeometry.ts` and
// `nlaLaneGeometry.ts` import the LANE_* names below, retiring the hand-copied
// literals that used to cite each other by file:line. The `dopesheet` group is
// the SOT of record for those values but is NOT yet wired into TimelineCanvas
// (that is slice 3); until then TimelineCanvas keeps its own literals and they
// must equal the DOPESHEET_* values here.
//
// REF: hetvabhasa H95 (e2e mirror geometry constants); vyapti V50 (shared
//      dopesheet/curve view model); project_timeline-geometry-consolidation.

// `with { type: 'json' }` is required so the module loads under BOTH consumers:
// Vite/Vitest (browser + unit) AND Playwright's native-ESM Node loader, which
// (Node 20.10+) rejects an attribute-less JSON import. esbuild passes the
// attribute through; Vite's json plugin resolves the import regardless.
import settings from './timelineSettings.json' with { type: 'json' };

/** The frozen settings object, shape-checked at compile time. */
export const timelineSettings = settings satisfies {
  readonly lane: {
    readonly rowHeightPx: number;
    readonly rulerHeightPx: number;
    readonly headerWidthPx: number;
    readonly trimHandlePx: number;
    readonly dragThresholdPx: number;
  };
  readonly dopesheet: {
    readonly rowHeightPx: number;
    readonly rulerHeightPx: number;
    readonly gutterWidthPx: number;
    readonly diamondPx: number;
    readonly gutterGlyphBoxPx: number;
  };
};

// ── Lane family (compositor layer timeline + NLA lane) ───────────────────────

/** Width of the left outline/header column (names + toggles), in CSS px. */
export const LANE_HEADER_WIDTH_PX = timelineSettings.lane.headerWidthPx;
/** Height of one lane row, in CSS px. */
export const LANE_ROW_HEIGHT_PX = timelineSettings.lane.rowHeightPx;
/** Height of the time ruler atop the lane area, in CSS px. */
export const LANE_RULER_HEIGHT_PX = timelineSettings.lane.rulerHeightPx;
/** Width (CSS px) of the trim/resize-handle hit zone at each end of a bar. The
 *  body between the two handles is the slide zone. */
export const LANE_TRIM_HANDLE_PX = timelineSettings.lane.trimHandlePx;
/** Pointer travel (CSS px) that turns a click into a drag on a lane. */
export const LANE_DRAG_THRESHOLD_PX = timelineSettings.lane.dragThresholdPx;

// ── Dopesheet family (keyframe grid) — NOT yet wired (slice 3) ────────────────
// These are the SOT of record for the dopesheet metrics. TimelineCanvas.tsx
// still owns its own literals for now; keep the two in sync until slice 3 wires
// TimelineCanvas to import these. Do NOT change these to match the lane family.

/** Height of one dopesheet channel row, in CSS px (dense grid, by design). */
export const DOPESHEET_ROW_HEIGHT_PX = timelineSettings.dopesheet.rowHeightPx;
/** Height of the dopesheet frame ruler, in CSS px. */
export const DOPESHEET_RULER_HEIGHT_PX = timelineSettings.dopesheet.rulerHeightPx;
/** Left gutter (CSS px) for channel labels — wider than a reze value gutter
 *  because Basher's dopesheet is multi-channel and shows channel NAMES. Baked
 *  into the dopesheet's frameToX (the V50 default-view === keyframeToRect
 *  parity invariant), so it must NOT change. */
export const DOPESHEET_GUTTER_WIDTH_PX = timelineSettings.dopesheet.gutterWidthPx;
/** Diamond box (CSS px) — the 45° keyframe diamond. */
export const DOPESHEET_DIAMOND_PX = timelineSettings.dopesheet.diamondPx;
/** Mute/solo glyph hit-box (CSS px) seated in the label gutter (#263). */
export const DOPESHEET_GUTTER_GLYPH_BOX_PX = timelineSettings.dopesheet.gutterGlyphBoxPx;

/** Edge inset (CSS px) reserved each side of the track so a terminal keyframe
 *  lands flush — `max(4, diamondPx/2)`. Baked into frameToX so the default-view
 *  geometry === keyframeToRect (the V50 e2e-safety parity invariant). */
export const DOPESHEET_DIAMOND_INSET_PX = Math.max(4, DOPESHEET_DIAMOND_PX / 2);
