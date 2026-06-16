// Viewport store — UI projections that govern editor-only behaviors of the
// 3D viewport: floor grid visibility, axis-widget visibility, transform
// snapping, and the active pivot point.
//
// Discipline: this is a UI projection, NOT the DAG. None of these settings
// are persisted with the project (they belong to the editor session, like
// the camera orbit pose). Mutations never go through the Op dispatcher.
//
// File-rooted V8: this store is mutated by src/app/* (NPanel, menu bar,
// keyboard shortcuts) and read by src/viewport/Viewport.tsx + src/app/Gizmo.tsx
// + src/app/character/GroundClick.tsx. The dispatch surface stays in
// src/app/, the renderer stays in src/viewport/.
//
// `currentFrameRef.current` is written by `timeStore` (the frame chokepoint)
// and read by `src/timeline/TimelineCanvas.tsx`'s rAF loop — a React-bypass
// escape hatch so the 60fps playhead does not re-render every seconds-
// subscriber. Both stores are src/app/stores/* projection stores; neither
// touches the DAG, so this cross-store mirror is V8-clean. See D-W9-1/9.
//
// REF: THESIS.md §11; vyapti V1, V8.

import { create } from 'zustand';
import { capturePendingEditorView } from '../editorViewCapture';

/** Median is the only pivot mode shipped in v0.5 (dharana §3 default). The
 *  type stays open so future modes (individual / 3d-cursor / active) can land
 *  without a store rewrite. */
export type Pivot = 'median' | 'individual' | 'cursor' | 'active';

/** Editor shading mode — Blender-style "Solid / Material / Rendered" plus
 *  Wireframe. v0.5 ships:
 *   - `studio`: editor-only fill rig + shaded materials. Always-visible
 *     geometry regardless of DAG lights.
 *   - `rendered`: DAG lights only. Matches what production renders see.
 *   - `wireframe`: every material renders as wireframe. Editor fill rig
 *     stays so the wires read against background; light helpers also
 *     stay so the user can position lights in this mode.
 *
 *  IMPORTANT: studio lights are a viewport projection. They MUST NOT leak
 *  into the DAG (V8) and MUST NOT influence render-mode evaluation. */
export type ShadingMode = 'studio' | 'rendered' | 'wireframe';

/** Editor-view projection — whether the free orbit view renders with a
 *  perspective or orthographic camera (Spline's bottom-right ortho|persp
 *  pill, Blender's Numpad 5).
 *
 *  IMPORTANT: this is which camera the EDITOR looks through, NOT a DAG
 *  camera's `.type` — mutating a DAG camera node here would be the [[H67]]
 *  view-IS-scene-object conflation. It is the same editor-session class as
 *  `cameraZoom` / `gridVisible`: never persisted with the project, never in
 *  the DAG (V8/V34). `EditorViewCamera` swaps the ONE always-default editor
 *  camera between projections (no 2nd camera path → no makeDefault race). */
export type CameraProjection = 'perspective' | 'orthographic';

export interface ViewportStore {
  /** Currently-active pivot. v0.5 ships median-only. */
  pivot: Pivot;
  /** World-space step size used by snap(). 0 disables snapping. */
  snapStep: number;
  /** True when snap is on (snapStep > 0 alone is not enough — the user may
   *  want to keep their step value while toggling snap off). */
  snapEnabled: boolean;
  /** Whether the floor Grid renders. */
  gridVisible: boolean;
  /** Whether the bottom-right axis widget renders. */
  axisWidgetVisible: boolean;
  /** Editor shading mode — see ShadingMode for semantics. */
  shading: ShadingMode;
  /** Whether the viewport renders THROUGH the active DAG scene camera
   *  (Blender's "camera view", Numpad 0) instead of the free editor orbit
   *  camera.
   *
   *  Default false: the editor owns a free orbit view so DAG cameras can be
   *  drawn as selectable frustum objects (#165). When true the viewport flips
   *  the active scene camera to `makeDefault` so the user previews the exact
   *  production framing.
   *
   *  Editor-session projection — like the orbit pose named in this file's
   *  header it is NOT persisted with the project and NEVER enters the DAG
   *  (V8). It is which camera you're looking through, not scene data. */
  lookThroughCamera: boolean;
  /** Editor-view projection — perspective vs orthographic free orbit view.
   *
   *  Editor-session projection like `cameraZoom`/`lookThroughCamera`: NOT
   *  persisted with the project, NEVER in the DAG (V8/V34). Read by
   *  `EditorViewCamera` to pick which drei camera to mount as the ONE
   *  always-default editor camera. Look-through always uses perspective
   *  (v1 limit — it mirrors the DAG camera, which is perspective). */
  cameraProjection: CameraProjection;
  /** Whether the timeline drawer (dopesheet + curve editor) is expanded. */
  timelineDrawerOpen: boolean;
  /** Viewport camera zoom as a percentage (100 = default framing).
   *
   *  This is an editor-session projection exactly like the camera orbit
   *  pose named in this file's header — it is NOT persisted with the
   *  project and NEVER enters the DAG (V8). It is derived from the
   *  OrbitControls camera→target distance: 100% at the R3F default
   *  camera distance (5 world units from origin), scaling inversely
   *  (dolly closer → higher %, dolly out → lower %).
   *
   *  Written by `setCameraZoom`, called from the OrbitControls
   *  `onChange`/`onEnd` listener in `src/viewport/Viewport.tsx`. That
   *  write is V8-clean: `viewportStore` is a UI-projection store, NOT
   *  the DAG; V8's file-rooted ban covers only `dispatch`/
   *  `useDagStore.setState`/`applyOp` inside `src/viewport/`. A
   *  projection-store setter is the SAME class of in-viewport write as
   *  the long-standing `useSelectionStore.getState().clear()` at
   *  Viewport.tsx onPointerMissed. Read by R3 TopToolbar's zoom readout
   *  (§5.3 anatomy). See P6 W10 UIR c-1. */
  cameraZoom: number;
  /** Manual override for the FREE editor-view clip planes (#192). `null` =
   *  AUTO: the planes derive from the scene bounds every load (#186/#191). A
   *  non-null `{ near, far }` overrides that — the user's explicit Clip
   *  Start/End from the View menu.
   *
   *  Viewport-ONLY: this never touches the scene camera node's near/far (that
   *  drives the render + look-through). It is an editor-session projection like
   *  `cameraZoom`, NOT in the DAG (V8/V34) — but UNLIKE cameraZoom it IS
   *  persisted per-project to localStorage (`viewportClipPersistence`, the same
   *  class as the editor-view pose), hydrated on project change. */
  viewportClipOverride: { near: number; far: number } | null;
  /** Live readout of the FREE view's EFFECTIVE clip planes (override ?? the
   *  auto-derived planes), published each frame by `EditorViewCamera`. Lets the
   *  View-menu Clipping items DISPLAY and SEED the current numbers without
   *  reaching into the camera component's local state (mirrors the `cameraZoom`
   *  readout pattern). Not persisted — recomputed live. */
  viewportClipReadout: { near: number; far: number };
  /** React-bypass escape hatch for the 60fps timeline playhead.
   *
   *  The OBJECT is created once at store init and is stable for the store's
   *  entire lifetime — consumers (TimelineCanvas's rAF loop) hold this exact
   *  reference. ONLY `.current` mutates; the object is NEVER reassigned. A
   *  reassignment would leave every consumer holding a dead ref that silently
   *  stops tracking (context memo §3 silent-failure mode).
   *
   *  There is intentionally NO setter: `.current` is written by direct field
   *  write exclusively from `timeStore`'s three frame setters (the single
   *  chokepoint where `frame` mutates), and read by TimelineCanvas via
   *  `getState()`. Single-writer is what makes the
   *  `currentFrameRef.current === useTimeStore.getState().frame`
   *  invariant hold by construction. See D-W9-1, D-W9-9. */
  currentFrameRef: { current: number };

  setPivot(pivot: Pivot): void;
  setSnapStep(step: number): void;
  setSnapEnabled(enabled: boolean): void;
  setGridVisible(visible: boolean): void;
  setAxisWidgetVisible(visible: boolean): void;
  setShading(shading: ShadingMode): void;
  setLookThroughCamera(on: boolean): void;
  setCameraProjection(projection: CameraProjection): void;
  setTimelineDrawerOpen(open: boolean): void;
  setCameraZoom(zoom: number): void;
  /** Set (or clear, with `null`) the manual viewport clip override. Validated
   *  via `normalizeViewportClip` — invalid input falls back to `null` (auto).
   *  PURE state only; persistence is the caller's job (the View-menu handler
   *  calls `saveViewportClip`; hydration calls this without saving). */
  setViewportClipOverride(clip: { near: number; far: number } | null): void;
  /** Publish the live effective clip planes (called by `EditorViewCamera`). */
  setViewportClipReadout(clip: { near: number; far: number }): void;
  toggleGridVisible(): void;
  toggleAxisWidgetVisible(): void;
  toggleSnapEnabled(): void;
  toggleTimelineDrawer(): void;
  toggleLookThroughCamera(): void;
  toggleCameraProjection(): void;
}

export const useViewportStore = create<ViewportStore>((set, get) => ({
  pivot: 'median',
  snapStep: 0.25,
  snapEnabled: false,
  gridVisible: true,
  axisWidgetVisible: true,
  // Default 'studio' so a fresh seed scene with one DirectionalLight still
  // looks lit. Production renders (P4) read 'rendered' to match.
  shading: 'studio',
  // Default false — the editor owns a free orbit view so DAG cameras render
  // as selectable frustum objects (#165). Numpad 0 / the toolbar toggles it.
  lookThroughCamera: false,
  // Default perspective — the conventional 3D editor view. The bottom-right
  // ortho|persp pill / M toggle swaps it; EditorViewCamera honors it.
  cameraProjection: 'perspective',
  // Default closed — preserves the existing acceptance baselines. Users
  // open the drawer when they want to author keyframes; pixel-diff tests
  // run with the drawer closed so the canvas DIV dimensions don't shift.
  timelineDrawerOpen: false,
  // 100 = the R3F default camera framing (distance 5 from origin). The
  // OrbitControls onChange listener recomputes this from the live
  // camera→target distance; nothing persists it.
  cameraZoom: 100,
  // Default null — AUTO clip planes (bounds-fit, #186/#191). Hydrated from
  // localStorage per project on load (viewportClipPersistence).
  viewportClipOverride: null,
  // Seeded with three's historical defaults; EditorViewCamera overwrites it
  // each frame with the live effective planes.
  viewportClipReadout: { near: 0.1, far: 1000 },
  // Created once here; the object reference is stable for the store lifetime.
  // `.current` is mutated only by timeStore's frame chokepoint — never
  // reassign this object. See D-W9-1, D-W9-9.
  currentFrameRef: { current: 0 },

  setPivot: (pivot) => set({ pivot }),
  setSnapStep: (snapStep) => set({ snapStep: Math.max(0, snapStep) }),
  setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
  setGridVisible: (gridVisible) => set({ gridVisible }),
  setAxisWidgetVisible: (axisWidgetVisible) => set({ axisWidgetVisible }),
  setShading: (shading) => set({ shading }),
  setLookThroughCamera: (lookThroughCamera) => set({ lookThroughCamera }),
  setCameraProjection: (cameraProjection) => {
    const cur = get();
    // Snapshot the live free view before the swap so EditorViewCamera re-poses
    // the new camera exactly where the view already is (skip while looking
    // through — that pose is the DAG camera's, not the user's free view).
    if (cur.cameraProjection !== cameraProjection && !cur.lookThroughCamera) {
      capturePendingEditorView();
    }
    set({ cameraProjection });
  },
  setTimelineDrawerOpen: (timelineDrawerOpen) => set({ timelineDrawerOpen }),
  setCameraZoom: (zoom) =>
    set({ cameraZoom: Number.isFinite(zoom) ? Math.max(1, Math.round(zoom)) : 100 }),
  setViewportClipOverride: (clip) => set({ viewportClipOverride: normalizeViewportClip(clip) }),
  setViewportClipReadout: (clip) => {
    const next = normalizeViewportClip(clip);
    if (next) set({ viewportClipReadout: next });
  },
  toggleGridVisible: () => set({ gridVisible: !get().gridVisible }),
  toggleAxisWidgetVisible: () => set({ axisWidgetVisible: !get().axisWidgetVisible }),
  toggleSnapEnabled: () => set({ snapEnabled: !get().snapEnabled }),
  toggleTimelineDrawer: () => set({ timelineDrawerOpen: !get().timelineDrawerOpen }),
  toggleLookThroughCamera: () => set({ lookThroughCamera: !get().lookThroughCamera }),
  toggleCameraProjection: () => {
    const cur = get();
    if (!cur.lookThroughCamera) capturePendingEditorView();
    set({
      cameraProjection: cur.cameraProjection === 'perspective' ? 'orthographic' : 'perspective',
    });
  },
}));

/** Validate a viewport clip override (#192). Returns a sane `{ near, far }` or
 *  `null` (= AUTO / invalid). A valid frustum needs near > 0 and far > near; a
 *  non-finite or mis-ordered pair falls back to `null` rather than producing a
 *  degenerate camera. Pure + exported for unit tests and the persistence layer. */
export function normalizeViewportClip(
  clip: { near: number; far: number } | null | undefined,
): { near: number; far: number } | null {
  if (!clip) return null;
  const { near, far } = clip;
  if (!Number.isFinite(near) || !Number.isFinite(far)) return null;
  if (near <= 0 || far <= near) return null;
  return { near, far };
}

/** Round `value` to the nearest multiple of `step`. Returns `value` unchanged
 *  when step ≤ 0 (snap disabled). */
export function snap(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Snap a 3-vector component-wise. The shape is preserved so callers can
 *  feed it directly to setParam Ops. */
export function snapVec3(
  value: readonly [number, number, number],
  step: number,
): [number, number, number] {
  return [snap(value[0], step), snap(value[1], step), snap(value[2], step)];
}

/** R3F's default PerspectiveCamera sits at distance 5 from the origin
 *  target. We define that framing as 100% zoom. Dollying closer (smaller
 *  distance) reads as a HIGHER percentage; dollying out reads lower —
 *  the same mental model as a 2D canvas zoom control (§5.3 anatomy).
 *
 *  Pure + unit-testable (no THREE import, no DOM). The OrbitControls
 *  listener feeds it the live camera→target distance. */
export const DEFAULT_CAMERA_DISTANCE = 5;

export function cameraDistanceToZoomPercent(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 100;
  return Math.max(1, Math.round((DEFAULT_CAMERA_DISTANCE / distance) * 100));
}

/** Convenience: read-once helper for non-React callers (Gizmo, GroundClick). */
export function maybeSnapVec3(value: readonly [number, number, number]): [number, number, number] {
  const { snapEnabled, snapStep } = useViewportStore.getState();
  return snapEnabled && snapStep > 0 ? snapVec3(value, snapStep) : [value[0], value[1], value[2]];
}
