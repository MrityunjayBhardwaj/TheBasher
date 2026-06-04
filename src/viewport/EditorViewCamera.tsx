// EditorViewCamera — the editor's free orbit view camera (#165).
//
// Why this exists: before #165 the DAG `PerspectiveCamera` node mounted with
// `makeDefault`, so the viewport rendered THROUGH the scene camera — you were
// always inside it and could never see or select it as an object. This camera
// decouples the view: it is the ONE always-default render camera, driven by
// OrbitControls, so DAG cameras become ordinary scene objects we can draw as
// selectable frustums (CameraHelpers, Wave C).
//
// Two responsibilities:
//   1. Boot the orbit view at the active scene camera's pose so first-paint
//      framing is byte-identical to the old makeDefault behavior.
//   2. "Look through camera" (Blender Numpad 0): adopt the active DAG camera's
//      pose + projection so the user previews the exact production framing.
//      Orbit is disabled in this mode (gated in Viewport.tsx), so this camera
//      simply mirrors the DAG camera — no makeDefault arbitration race (drei's
//      makeDefault restores its captured oldCam on flag-flip, so two competing
//      makeDefault cameras would fight; one always-default camera avoids it).
//      This is architecturally consistent: the viewport is a PROJECTION of the
//      DAG, not the scene camera itself. Production render (a future pipeline)
//      uses the DAG camera directly, independent of this preview.
//
// File-rooted V8: lives in src/viewport/, reads the camera pose from a pure
// helper + the threeRef projection. Never mutates the DAG.
//
// REF: THESIS.md §11; vyapti V1, V8; drei PerspectiveCamera makeDefault
// (node_modules/@react-three/drei/core/PerspectiveCamera.js:52-64).

import { PerspectiveCamera } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  cameraPoseFromNode,
  DEFAULT_CAMERA_POSE,
  selectActiveCameraNode,
  type CameraPose,
} from '../app/activeCamera';
import { useThreeRef } from '../app/character/threeRef';
import { useDagStore } from '../core/dag/store';
import { useViewportStore } from '../app/stores/viewportStore';

/** Apply a camera pose to a THREE camera + move the OrbitControls target to
 *  its lookAt so orbiting pivots around the right point. */
function applyPose(cam: THREE.PerspectiveCamera, pose: CameraPose): void {
  cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
  cam.lookAt(new THREE.Vector3(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]));
  cam.updateMatrixWorld();
  // controlsTarget is the OrbitControls .target Vector3 (ThreeBridge mirrors
  // it here every frame). Mutate in place — framing.ts uses the same path.
  // Null for the first frame before ThreeBridge runs; the default target is
  // the origin, which matches the seed camera's lookAt, so boot is unaffected.
  const target = useThreeRef.getState().controlsTarget;
  if (target) target.set(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
}

export function EditorViewCamera() {
  const ref = useRef<THREE.PerspectiveCamera | null>(null);
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);
  // Subscribe to the active camera NODE (stable identity → re-render only on
  // a camera change, not every store tick), derive its pose via useMemo.
  const camNode = useDagStore((s) => selectActiveCameraNode(s.state));
  const pose = useMemo(() => cameraPoseFromNode(camNode) ?? DEFAULT_CAMERA_POSE, [camNode]);
  // Boot-once guard: after the first placement, OrbitControls owns the camera
  // in free mode (mirrors the old DAG-camera comment "let OrbitControls own
  // it"). We re-apply the pose only on the look-through transition / sync.
  const didInit = useRef(false);

  useEffect(() => {
    const cam = ref.current;
    if (!cam) return;
    if (lookThrough) {
      // Camera view: continuously adopt the DAG camera's pose. Re-runs when
      // the camera node changes (e.g. gizmo moves it while looking through).
      applyPose(cam, pose);
    } else if (!didInit.current) {
      // First mount in free mode: place the orbit view at the active camera's
      // framing so first paint matches the pre-#165 makeDefault behavior.
      applyPose(cam, pose);
      didInit.current = true;
    }
    // Free mode after init: OrbitControls owns position — do not fight it.
  }, [lookThrough, pose]);

  // Projection: free mode uses the seed camera's fov (captured via `pose` at
  // boot so framing is identical); look-through uses the live DAG fov/near/far.
  // OrthographicCamera look-through keeps a perspective editor camera (v1
  // limitation — ortho cameras are rare; pose still adopted).
  const fov = pose.fov;
  const near = lookThrough ? pose.near : 0.1;
  const far = lookThrough ? pose.far : 1000;

  // DEV-only observation seam for the #165 e2e: read the live view camera so
  // the test can assert (a) boot framing and (b) look-through adopts the DAG
  // pose, without poking THREE internals. Gated on DEV so prod tree-shakes it.
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_view_camera = () => {
      const cam = ref.current;
      if (!cam) return null;
      return {
        position: [cam.position.x, cam.position.y, cam.position.z],
        fov: cam.fov,
        near: cam.near,
        far: cam.far,
        lookThrough: useViewportStore.getState().lookThroughCamera,
      };
    };
  }

  return (
    <PerspectiveCamera
      ref={ref as React.MutableRefObject<THREE.PerspectiveCamera>}
      makeDefault
      fov={fov}
      near={near}
      far={far}
    />
  );
}
