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
import { Suspense } from 'react';
import { ACESFilmicToneMapping, NoToneMapping } from 'three';
import { GroundClick } from '../app/character/GroundClick';
import { ThreeBridge } from '../app/character/ThreeBridge';
import { Gizmo } from '../app/Gizmo';
import { useGizmoStore } from '../app/stores/gizmoStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { FloatingViewportToolbar } from '../app/FloatingViewportToolbar';
import { FpsMeter } from '../render/FpsMeter';
import { EditorLights } from './EditorLights';
import { ModeBadge } from './ModeBadge';
import { SceneFromDAG } from './SceneFromDAG';

function EditorOrbit() {
  // Disable orbit while a TransformControls handle is being dragged
  // (gizmoStore.dragging). Without this, gizmo + orbit fire simultaneously.
  // Reading via subscription so the prop flips at the right frame.
  const dragging = useGizmoStore((s) => s.dragging);
  return (
    <OrbitControls
      makeDefault
      enabled={!dragging}
      enableDamping
      dampingFactor={0.08}
      // Default mouse map: rotate (LMB), zoom (wheel), pan (RMB / two-finger).
    />
  );
}

export function Viewport() {
  // Editor-only viewport projections — show/hide grid + axis widget. These
  // do not affect the DAG (V8 read-only on this side).
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const axisWidgetVisible = useViewportStore((s) => s.axisWidgetVisible);
  return (
    <div data-testid="viewport" className="relative h-full w-full bg-black">
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
          <SceneFromDAG />
          <GroundClick />
          <Gizmo />
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
