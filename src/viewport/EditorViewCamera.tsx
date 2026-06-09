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

import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  cameraPoseFromNode,
  DEFAULT_CAMERA_POSE,
  selectActiveCameraNode,
} from '../app/activeCamera';
import { useThreeRef } from '../app/character/threeRef';
import { useDagStore } from '../core/dag/store';
import { useProjectStore } from '../core/project/store';
import { useViewportStore } from '../app/stores/viewportStore';
import { loadEditorView } from '../app/editorViewPersistence';
import { takePendingEditorView } from '../app/editorViewCapture';

/** Orthographic zoom that makes the ortho framing match the perspective
 *  framing at the orbit pivot — Blender's Numpad-5 behavior: apparent scale
 *  is preserved at the focal distance.
 *
 *  drei's OrthographicCamera sets its frustum in PIXELS (left=-w/2 … top=h/2),
 *  so the visible world-height at zoom z is `viewportHeight / z`. A perspective
 *  camera shows `2·d·tan(fov/2)` of world-height at distance d. Equate the two
 *  and solve for z. Pure + testable (no THREE, no DOM). */
export function orthoZoomForView(distance: number, fovDeg: number, viewportHeight: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  const worldHeight = 2 * distance * Math.tan((fovDeg * Math.PI) / 180 / 2);
  if (worldHeight <= 0) return 1;
  return viewportHeight / worldHeight;
}

/** Point a THREE camera from `position` toward `lookAt` + move the
 *  OrbitControls target to `lookAt` so orbiting pivots around the right point.
 *
 *  For an orthographic camera, also set `.zoom` so the ortho framing matches
 *  the perspective view at the pivot (`orthoZoomForView`) — position alone does
 *  not frame an ortho camera, its frustum extent is governed by zoom. */
function applyView(
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  position: readonly [number, number, number],
  lookAt: readonly [number, number, number],
  ortho?: { fovDeg: number; viewportHeight: number },
): void {
  cam.position.set(position[0], position[1], position[2]);
  cam.lookAt(new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]));
  if (ortho && (cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const distance = cam.position.distanceTo(new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]));
    cam.zoom = orthoZoomForView(distance, ortho.fovDeg, ortho.viewportHeight);
    cam.updateProjectionMatrix();
  }
  cam.updateMatrixWorld();
  // controlsTarget is the OrbitControls .target Vector3 (ThreeBridge mirrors
  // it here every frame). Mutate in place — framing.ts uses the same path.
  // Null for the first frame before ThreeBridge runs; the default target is
  // the origin, which matches the seed camera's lookAt, so boot is unaffected.
  const target = useThreeRef.getState().controlsTarget;
  if (target) target.set(lookAt[0], lookAt[1], lookAt[2]);
}

export function EditorViewCamera() {
  const ref = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);
  const projection = useViewportStore((s) => s.cameraProjection);
  // Look-through always mirrors the (perspective) DAG camera, so ortho only
  // applies to the FREE orbit view. One editor camera, swapped between
  // projections — never two default cameras at once ([[H67]]/V34: a single
  // makeDefault camera, no oldCam-restore race).
  const useOrtho = !lookThrough && projection === 'orthographic';
  // Canvas pixel size — drei's OrthographicCamera frustum is in pixels, so the
  // ortho zoom that matches the perspective framing depends on viewport height.
  const viewportHeight = useThree((s) => s.size.height);
  // Subscribe to the active camera NODE (stable identity → re-render only on
  // a camera change, not every store tick), derive its pose via useMemo.
  const camNode = useDagStore((s) => selectActiveCameraNode(s.state));
  const pose = useMemo(() => cameraPoseFromNode(camNode) ?? DEFAULT_CAMERA_POSE, [camNode]);
  // The Canvas (and this component) mounts ONCE for the app lifetime, but the
  // boot-framing guard's true scope is the PROJECT, not the component: each
  // project has its own saved view / active camera, and switching projects
  // in-session must re-frame to the new one (#167). So we latch the project id
  // we last booted, not a plain boolean — a boolean would stay `true` after the
  // first project and silently strand the view at the old project's pose. After
  // the per-project boot, OrbitControls owns the camera in free mode (mirrors
  // the old DAG-camera comment "let OrbitControls own it").
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  // The boot/re-frame latch is keyed to (project, projection), NOT the
  // component lifetime. Two distinct events must re-frame the editor camera:
  //   - an in-session PROJECT switch (#167 — a lifetime boolean would strand
  //     the view at the old project's pose);
  //   - a PROJECTION toggle (persp↔ortho), which unmounts the old drei camera
  //     and mounts a fresh one at the origin → it must be re-posed, and an
  //     ortho camera additionally needs its zoom set ([[H67]] sibling: the new
  //     camera is a different object, not the same one re-projected).
  // After the latched re-frame, OrbitControls owns the camera in free mode.
  const bootedKey = useRef<string | null>(null);

  useEffect(() => {
    const cam = ref.current;
    if (!cam) return;
    if (lookThrough) {
      // Camera view: continuously adopt the DAG camera's pose. Re-runs when
      // the camera node changes (e.g. gizmo moves it while looking through).
      applyView(cam, pose.position, pose.lookAt);
      return;
    }
    const key = `${projectId ?? ''}|${useOrtho ? 'ortho' : 'persp'}`;
    if (bootedKey.current !== key) {
      // First free-mode frame for THIS (project, projection): restore the
      // user's saved orbit view for the project (Wave E); fall back to the
      // active camera's framing so first paint matches the pre-#165
      // makeDefault behavior when nothing is saved. switchProject() updates
      // the project store and hydrates the DAG store synchronously back-to-back
      // (boot.ts), so `projectId` and `pose` are consistent here. The ortho
      // arg sets `.zoom` so the swapped-in ortho camera frames the scene
      // (position alone does not frame an ortho camera).
      const orthoArg = useOrtho ? { fovDeg: pose.fov, viewportHeight } : undefined;
      // A projection toggle captured the LIVE pose (editorViewCapture) — re-pose
      // the swapped-in camera exactly there so the framing is preserved across
      // persp↔ortho (Blender Numpad 5). Falls through to the saved orbit view
      // (project switch / reload) then the active-camera framing (first boot).
      const pendingPose = takePendingEditorView();
      if (pendingPose) applyView(cam, pendingPose.position, pendingPose.target, orthoArg);
      else {
        const saved = loadEditorView(projectId);
        if (saved) applyView(cam, saved.position, saved.target, orthoArg);
        else applyView(cam, pose.position, pose.lookAt, orthoArg);
      }
      bootedKey.current = key;
    }
    // Free mode, same (project, projection) after boot: OrbitControls owns
    // position — do not fight it.
  }, [lookThrough, pose, projectId, useOrtho, viewportHeight]);

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
      const isOrthographic = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
      return {
        position: [cam.position.x, cam.position.y, cam.position.z],
        // fov is perspective-only — null for the ortho view camera.
        fov: isOrthographic ? null : (cam as THREE.PerspectiveCamera).fov,
        near: cam.near,
        far: cam.far,
        zoom: cam.zoom,
        isOrthographic,
        lookThrough: useViewportStore.getState().lookThroughCamera,
        projection: useViewportStore.getState().cameraProjection,
      };
    };
    // Project a world point through the REAL view camera to NDC ([-1,1], with
    // z<1 meaning in front). The #165 frustum-click e2e uses this to find a
    // camera node's on-screen position deterministically, then clicks it.
    w.__basher_project_ndc = (xyz: [number, number, number]) => {
      const cam = ref.current;
      if (!cam) return null;
      const v = new THREE.Vector3(xyz[0], xyz[1], xyz[2]).project(cam);
      return [v.x, v.y, v.z];
    };
  }

  // ONE editor camera, mounted as perspective OR orthographic — never both at
  // once, so there is exactly one `makeDefault` camera and no oldCam-restore
  // race ([[H67]]/V34). The boot effect above re-poses (and, for ortho, zooms)
  // whichever camera mounts when `useOrtho` flips. drei's OrthographicCamera
  // derives its pixel-space frustum from the canvas size automatically.
  if (useOrtho) {
    return (
      <OrthographicCamera
        ref={ref as React.MutableRefObject<THREE.OrthographicCamera>}
        makeDefault
        near={0.1}
        far={1000}
      />
    );
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
