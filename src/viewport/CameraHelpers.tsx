// CameraHelpers — wireframe frustum gizmos that make DAG camera nodes
// VISIBLE and SELECTABLE in the viewport (#165). Before #165 the camera was
// the render camera (makeDefault), so it had no body; now the editor owns the
// view (EditorViewCamera) and every camera node draws as a Blender-style
// frustum: a pyramid from the apex (camera origin) out to a rectangular base,
// a small body box at the apex, and an "up" triangle on the base's top edge.
//
// Mirrors LightHelpers.tsx exactly: wireframe lines + an invisible click
// hitbox + `selectOnClick(pickId)`, lives in src/viewport/, writes selection
// through the UI projection (V1/V8 clean — no DAG mutation). The frustum shape
// is DERIVED from the camera's fov/aspect like SpotLightHelper derives its
// cone from angle/distance.
//
// REF: THESIS.md §11; vyapti V1, V8; sibling of LightHelpers.tsx.

import { useMemo } from 'react';
import * as THREE from 'three';
import type { CameraPose } from '../app/activeCamera';
import { useSelectionStore } from '../app/stores/selectionStore';

// Display constants — the frustum is an editor indicator at a FIXED size, not
// the real far plane (Blender's camera "display size"). Aspect is the common
// 16:9 render frame; a future render-resolution setting can feed it later.
const FRUSTUM_DEPTH = 0.9;
const FRUSTUM_ASPECT = 16 / 9;
const BODY = 0.12; // half-size of the little camera body box at the apex

const COLOR_SELECTED = '#e2e8f0'; // bright — the camera you clicked
const COLOR_ACTIVE = '#4ea1ff'; // the scene's active camera (wired to scene.camera)
const COLOR_INACTIVE = '#64748b'; // any other camera node

/** Flat [x,y,z, x,y,z, ...] LineSegments point pairs for a perspective camera
 *  frustum in LOCAL space (apex at origin, looking down -Z, three.js camera
 *  convention). Pure + unit-testable. */
export function perspectiveFrustumSegments(
  fovDeg: number,
  aspect: number,
  depth: number,
): number[] {
  const halfV = (THREE.MathUtils.degToRad(fovDeg) || 0) / 2;
  const hh = Math.tan(halfV) * depth; // base half-height
  const hw = hh * aspect; // base half-width
  const z = -depth; // base plane (forward is -Z)
  const apex: [number, number, number] = [0, 0, 0];
  const tl: [number, number, number] = [-hw, hh, z];
  const tr: [number, number, number] = [hw, hh, z];
  const br: [number, number, number] = [hw, -hh, z];
  const bl: [number, number, number] = [-hw, -hh, z];
  // "Up" triangle apex, centered above the base's top edge.
  const up: [number, number, number] = [0, hh * 1.5, z];
  const utL: [number, number, number] = [-hw * 0.5, hh, z];
  const utR: [number, number, number] = [hw * 0.5, hh, z];

  const out: number[] = [];
  const seg = (a: number[], b: number[]) => out.push(...a, ...b);
  // apex → 4 corners
  seg(apex, tl);
  seg(apex, tr);
  seg(apex, br);
  seg(apex, bl);
  // base rectangle
  seg(tl, tr);
  seg(tr, br);
  seg(br, bl);
  seg(bl, tl);
  // up triangle (top edge is already drawn by the base rect)
  seg(utL, up);
  seg(utR, up);
  return out;
}

/** Ortho cameras draw a box (no convergence) of fixed display size. Width
 *  shrinks with zoom so a "more zoomed" ortho cam reads smaller, matching the
 *  perspective frustum's visual language. Pure + unit-testable. */
export function orthoFrustumSegments(zoom: number, aspect: number, depth: number): number[] {
  const hh = depth / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const hw = hh * aspect;
  const fr: Array<[number, number, number]> = [
    [-hw, hh, 0],
    [hw, hh, 0],
    [hw, -hh, 0],
    [-hw, -hh, 0],
  ];
  const bk: Array<[number, number, number]> = fr.map(([x, y]) => [x, y, -depth]);
  const out: number[] = [];
  const seg = (a: number[], b: number[]) => out.push(...a, ...b);
  for (let i = 0; i < 4; i++) {
    seg(fr[i], fr[(i + 1) % 4]); // front rect
    seg(bk[i], bk[(i + 1) % 4]); // back rect
    seg(fr[i], bk[i]); // connecting edges
  }
  return out;
}

/** Quaternion that rotates the camera's local -Z (three.js forward) onto the
 *  world-space direction from position → lookAt. Pure. */
export function frustumQuaternion(
  position: readonly [number, number, number],
  lookAt: readonly [number, number, number],
): THREE.Quaternion {
  const dir = new THREE.Vector3(
    lookAt[0] - position[0],
    lookAt[1] - position[1],
    lookAt[2] - position[2],
  );
  if (dir.lengthSq() === 0) dir.set(0, 0, -1);
  dir.normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
}

export interface CameraHelperProps {
  pose: CameraPose;
  /** Producing DAG node id; null when selection routing is unavailable. */
  pickId: string | null;
  /** True for the camera wired into scene.camera (rendered brighter). */
  active: boolean;
}

export function CameraHelper({ pose, pickId, active }: CameraHelperProps) {
  const selectedId = useSelectionStore((s) => s.primaryNodeId);
  const selected = pickId != null && pickId === selectedId;
  const color = selected ? COLOR_SELECTED : active ? COLOR_ACTIVE : COLOR_INACTIVE;

  const quat = useMemo(
    () => frustumQuaternion(pose.position, pose.lookAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      pose.position[0],
      pose.position[1],
      pose.position[2],
      pose.lookAt[0],
      pose.lookAt[1],
      pose.lookAt[2],
    ],
  );

  const segs = useMemo(
    () =>
      pose.kind === 'OrthographicCamera'
        ? orthoFrustumSegments(pose.fov, FRUSTUM_ASPECT, FRUSTUM_DEPTH)
        : perspectiveFrustumSegments(pose.fov, FRUSTUM_ASPECT, FRUSTUM_DEPTH),
    [pose.kind, pose.fov],
  );

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    return g;
  }, [segs]);

  // Approx base half-extents for the invisible hitbox (perspective only; the
  // ortho box hitbox uses the same shape, close enough for picking).
  const halfH = Math.tan((THREE.MathUtils.degToRad(pose.fov) || 0) / 2) * FRUSTUM_DEPTH;

  const onClick = (e: { stopPropagation: () => void; shiftKey: boolean }) => {
    if (!pickId) return;
    e.stopPropagation();
    const sel = useSelectionStore.getState();
    if (e.shiftKey) sel.selectAdditive(pickId);
    else sel.select(pickId);
  };

  return (
    <group position={pose.position as [number, number, number]} quaternion={quat} onClick={onClick}>
      <lineSegments>
        <primitive object={geom} attach="geometry" />
        <lineBasicMaterial color={color} />
      </lineSegments>
      {/* Small body box at the apex so the camera reads as an object. */}
      <mesh>
        <boxGeometry args={[BODY * 2, BODY * 2, BODY * 2]} />
        <meshBasicMaterial color={color} wireframe />
      </mesh>
      {/* Invisible click hitbox spanning the frustum volume — the thin lines
          alone are nearly impossible to click (same trick as LightHelper). */}
      <mesh position={[0, 0, -FRUSTUM_DEPTH / 2]}>
        <boxGeometry args={[halfH * FRUSTUM_ASPECT * 2 || 0.4, halfH * 2 || 0.4, FRUSTUM_DEPTH]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
