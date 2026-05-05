// R3F Canvas mounted at the viewport slot. Mounts ONCE; mode switches never
// remount this — Layout flips slot visibility via display:none, the Canvas
// DOM node is unchanged (V8/K1 step 6).
//
// Performance: dpr capped to [1,2] keeps GPU cost flat across high-DPI
// displays. gl is the renderer; antialias=false because SMAA in PostFx
// runs the AA pass.
//
// REF: THESIS.md §11, §53, krama K1 step 6.

import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { ACESFilmicToneMapping, NoToneMapping } from 'three';
import { GroundClick } from '../app/character/GroundClick';
import { Gizmo } from '../app/Gizmo';
import { useGizmoStore } from '../app/stores/gizmoStore';
import { FpsMeter } from '../render/FpsMeter';
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
      >
        <Suspense fallback={null}>
          <color attach="background" args={['#0a0a0a']} />
          <SceneFromDAG />
          <GroundClick />
          <Gizmo />
          <EditorOrbit />
          {/* Blender-style axis-orientation widget in the bottom-right.
              Click an axis label to snap the camera to that view. */}
          <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
            <GizmoViewport axisColors={['#ff3653', '#8adb00', '#2c8fff']} labelColor="white" />
          </GizmoHelper>
        </Suspense>
      </Canvas>
      <FpsMeter />
    </div>
  );
}
