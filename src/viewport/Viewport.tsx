// R3F Canvas mounted at the viewport slot. Mounts ONCE; mode switches never
// remount this — Layout flips slot visibility via display:none, the Canvas
// DOM node is unchanged (V8/K1 step 6).
//
// Performance: dpr capped to [1,2] keeps GPU cost flat across high-DPI
// displays. gl is the renderer; antialias=false because SMAA in PostFx
// runs the AA pass.
//
// REF: THESIS.md §11, §53, krama K1 step 6.

import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { ACESFilmicToneMapping, NoToneMapping } from 'three';
import { FpsMeter } from '../render/FpsMeter';
import { SceneFromDAG } from './SceneFromDAG';

export function Viewport() {
  return (
    <div
      data-testid="viewport"
      className="relative h-full w-full bg-black"
    >
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
        </Suspense>
      </Canvas>
      <FpsMeter />
    </div>
  );
}
