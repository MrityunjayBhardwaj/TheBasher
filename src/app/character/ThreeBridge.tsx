// ThreeBridge — pushes the active camera + OrbitControls target into the
// `threeRef` store on every frame so out-of-Canvas code (keyboard
// shortcuts, menu actions) can read them.
//
// File-rooted V8: lives in src/app/, mounted INSIDE the Canvas.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';
import { useThreeRef } from './threeRef';

export function ThreeBridge() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // #168: push the live renderer + scene root once so the out-of-Canvas
  // "Render Image" action can render offscreen. Not per-frame — these
  // identities are stable for the Canvas lifetime.
  useEffect(() => {
    useThreeRef.getState().setRenderRefs(gl, scene);
    return () => useThreeRef.getState().setRenderRefs(null, null);
  }, [gl, scene]);
  useFrame(() => {
    useThreeRef.getState().set(camera, controls?.target ?? null);
  });
  return null;
}
