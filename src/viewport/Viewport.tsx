// R3F Canvas mounted at the viewport slot. Mounts ONCE; mode switches never
// remount this — Layout flips slot visibility via display:none, the Canvas
// DOM node is unchanged (V8/K1 step 6).
//
// Performance: dpr capped to [1,2] keeps GPU cost flat across high-DPI
// displays. gl is the renderer; antialias=false because SMAA in PostFx
// runs the AA pass.
//
// REF: THESIS.md §11, §53, krama K1 step 6.

import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense, useCallback } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { ACESFilmicToneMapping, NoToneMapping } from 'three';
import { GroundClick } from '../app/character/GroundClick';
import { ThreeBridge } from '../app/character/ThreeBridge';
import { Gizmo } from '../app/Gizmo';
import { useGizmoStore } from '../app/stores/gizmoStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { cameraDistanceToZoomPercent, useViewportStore } from '../app/stores/viewportStore';
import { useSelectionSummary } from '../app/hooks/useSelectionSummary';
import { FloatingViewportToolbar } from '../app/FloatingViewportToolbar';
import { FpsMeter } from '../render/FpsMeter';
import { GpuProbe, PerfBoundary } from '../perf/PerfProbe';
import { EditorLights } from './EditorLights';
import { EditorViewCamera } from './EditorViewCamera';
import { ModeBadge } from './ModeBadge';
import { SceneBgTestSeam } from './SceneBgTestSeam';
import { SceneFromDAG } from './SceneFromDAG';

function EditorOrbit() {
  // Disable orbit while a TransformControls handle is being dragged
  // (gizmoStore.dragging). Without this, gizmo + orbit fire simultaneously.
  // Reading via subscription so the prop flips at the right frame.
  const dragging = useGizmoStore((s) => s.dragging);
  // #165: while looking THROUGH the scene camera, the editor view mirrors the
  // DAG camera pose — orbit must be off so the user can't drift the preview.
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);

  // c-1 (P6 W10 UIR): the real camera-zoom signal. OrbitControls fires
  // `onChange` on every dolly/rotate/pan tick; we read the live
  // camera→target distance and derive a zoom % via the PURE
  // `cameraDistanceToZoomPercent` helper (no THREE math here — that's
  // unit-tested in the store). The result lands in `viewportStore`,
  // which the R3 TopToolbar zoom readout consumes (§5.3 anatomy).
  //
  // V8: writing `viewportStore` (a UI-projection store) from
  // `src/viewport/` is V8-clean — V8's file-rooted ban covers only
  // `dispatch`/`useDagStore.setState`/`applyOp`; a projection-store
  // setter is the SAME in-viewport write class as the long-standing
  // `useSelectionStore.getState().clear()` at onPointerMissed below.
  // Camera zoom is the editor-session projection class the
  // viewportStore header explicitly names ("like the camera orbit
  // pose") — never persisted, never in the DAG.
  const handleChange = useCallback((e?: { target: OrbitControlsImpl }) => {
    const controls = e?.target;
    if (!controls) return;
    const distance = controls.object.position.distanceTo(controls.target);
    useViewportStore.getState().setCameraZoom(cameraDistanceToZoomPercent(distance));
  }, []);

  return (
    <OrbitControls
      makeDefault
      enabled={!dragging && !lookThrough}
      enableDamping
      dampingFactor={0.08}
      onChange={handleChange}
      // Default mouse map: rotate (LMB), zoom (wheel), pan (RMB / two-finger).
    />
  );
}

export function Viewport() {
  // Editor-only viewport projections — show/hide grid + axis widget. These
  // do not affect the DAG (V8 read-only on this side).
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const axisWidgetVisible = useViewportStore((s) => s.axisWidgetVisible);

  // R6 aria-label: selection summary, debounced 200ms so rapid marquee
  // selects don't spam SR announcements. P6 W10 UIR F-4 — promoted to the
  // shared useSelectionSummary hook so the <main> region label (§8.3) and
  // this aria-live span derive from one source and never diverge.
  const debouncedSummary = useSelectionSummary();

  return (
    <div
      data-testid="viewport"
      role="region"
      aria-label="3D viewport"
      className="relative h-full w-full bg-black"
    >
      {/* SR-only live region for selection-change announcements.
          Self-review fold-in (D-W8-2 / §8.3): re-rendering an aria-label
          string does NOT trigger an SR announcement — SRs only re-announce
          a region's name on focus/structure change. Selection summary is
          declarative content that the user wants narrated on change, so it
          belongs inside an aria-live region. Kept sr-only (visual surface
          unchanged) and polite (announce when SR idle; don't interrupt). */}
      <span
        data-testid="viewport-selection-summary"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {debouncedSummary}
      </span>
      <Canvas
        data-testid="viewport-canvas"
        dpr={[1, 2]}
        gl={{
          antialias: false,
          alpha: false,
          // PostFx's ToneMapping effect handles tonemapping. The renderer
          // path is intentionally NoToneMapping; @react-three/postprocessing
          // forces this on mount but explicit is clearer.
          toneMapping: NoToneMapping,
        }}
        onCreated={({ gl }) => {
          // Pre-set so the ACES path matches whether or not PostFx mounts
          // (e.g. in a test that disables effects).
          gl.toneMapping = NoToneMapping;
          gl.toneMappingExposure = 1;
          void ACESFilmicToneMapping; // re-export to avoid tree-shake
        }}
        // Click-on-empty-space → clear selection. R3F fires onPointerMissed
        // when a pointer event in the canvas didn't hit any handler-bearing
        // mesh. selectionStore is a UI projection, not the DAG (V1 stays
        // clean).
        onPointerMissed={() => {
          useSelectionStore.getState().clear();
        }}
      >
        <Suspense fallback={null}>
          <color attach="background" args={['#0a0a0a']} />
          {/* Subtle floor grid — gives the world weight so the user can
              orient drags and place objects relative to a stable reference.
              cellSize/sectionSize follow Blender's "grid + sub-grid" idiom. */}
          {gridVisible ? (
            <Grid
              args={[40, 40]}
              cellSize={1}
              cellThickness={0.6}
              cellColor="#2a2a2a"
              sectionSize={5}
              sectionThickness={1.2}
              sectionColor="#3a3a4a"
              fadeDistance={40}
              fadeStrength={1.5}
              infiniteGrid={false}
              position={[0, -0.001, 0]}
            />
          ) : null}
          {/* Editor-only fill rig — gated on viewportStore.shading. Does
              NOT enter the DAG; production renders bypass it. */}
          <EditorLights />
          {/* DEV-only #57 seam: exposes window.__basher_setSceneBackground
              so the bright-scene contrast e2e can drive the REAL canvas
              bright and pixel-sample R8/ModeBadge over it. The mount is
              gated on import.meta.env.DEV so Rollup eliminates both the
              component and its import from production builds. */}
          {import.meta.env.DEV ? <SceneBgTestSeam /> : null}
          <PerfBoundary>
            <SceneFromDAG />
          </PerfBoundary>
          <GpuProbe />
          <GroundClick />
          <Gizmo />
          {/* #165: the editor owns a free orbit view camera (decoupled from
              the DAG scene cameras) so cameras render as selectable frustum
              objects. EditorOrbit drives whatever is the default camera. */}
          <EditorViewCamera />
          <EditorOrbit />
          <ThreeBridge />
          {/* Blender-style axis-orientation widget in the bottom-right.
              Click an axis label to snap the camera to that view. */}
          {axisWidgetVisible ? (
            <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
              <GizmoViewport axisColors={['#ff3653', '#8adb00', '#2c8fff']} labelColor="white" />
            </GizmoHelper>
          ) : null}
        </Suspense>
      </Canvas>
      <FpsMeter />
      <ModeBadge />
      <FloatingViewportToolbar />
    </div>
  );
}
