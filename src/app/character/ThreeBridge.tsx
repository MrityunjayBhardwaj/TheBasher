// ThreeBridge — pushes the active camera + OrbitControls target into the
// `threeRef` store on every frame so out-of-Canvas code (keyboard
// shortcuts, menu actions) can read them.
//
// File-rooted V8: lives in src/app/, mounted INSIDE the Canvas.

import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useThreeRef } from './threeRef';

export function ThreeBridge() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null;
  useFrame(() => {
    useThreeRef.getState().set(camera, controls?.target ?? null);
  });
  return null;
}
