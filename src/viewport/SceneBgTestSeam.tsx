// SceneBgTestSeam — DEV-only observation seam (#57).
//
// WHY THIS EXISTS
// ==============
// The contrast-audit matrix (src/a11y/contrastMatrix.test.ts, D-W8-1)
// composites every chrome surface against the worst-case FIXED page bg
// `#0a0a0a`. R8 (FloatingViewportToolbar) and ModeBadge are the two
// surfaces that physically sit over the GL canvas — a VARIABLE-color
// backdrop. The opaque-only audit cannot see that variable bg, so its
// PASS for those two surfaces was an inference, not an observation (#57).
//
// To OBSERVE the truth (Lokayata) we must drive the REAL scene bright and
// pixel-sample the actually-composited overlay — including how
// `backdrop-filter: blur` samples real WebGL pixels. The scene background
// is otherwise hardcoded (`<color attach="background" args={['#0a0a0a']}/>`
// in Viewport.tsx) with no runtime control. This seam exposes a setter so
// the p57 e2e can make the canvas bright, screenshot the overlay, and
// assert WCAG AA on real pixels.
//
// Mirrors the established DEV-only window-seam pattern already used inside
// the Canvas for e2e observation (`__basher_gltf_skin` /
// `__basher_gltf_meshes` in SceneFromDAG.tsx). Read/observe-only intent:
// it mutates `scene.background` (a renderer property, not the DAG and not
// any UI projection store), so V1/V8 stay clean. DEV-gated, so it is
// tree-shaken out of production builds entirely.
//
// REF: src/a11y/contrastMatrix.test.ts (D-W8-1 matrix);
//      tests/e2e/p57-bright-scene-contrast.spec.ts; issue #57.

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';

export function SceneBgTestSeam(): null {
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    // Setter: paint the scene background to `hex`. The declarative
    // `<color attach="background">` in Viewport.tsx sets the initial
    // value; this overrides it imperatively for the duration of a test.
    // `invalidate()` requests a repaint so the change lands even if the
    // frameloop is on-demand.
    w.__basher_setSceneBackground = (hex: string): void => {
      scene.background = new THREE.Color(hex);
      invalidate();
    };
    return () => {
      delete w.__basher_setSceneBackground;
    };
  }, [scene, invalidate]);

  return null;
}
