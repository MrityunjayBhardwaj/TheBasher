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
import { selectNodeOnClick } from './selectNodeOnClick';
import { cameraOrientationQuat } from '../app/cameraOrientation';

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

/** Quaternion orienting the camera frustum: local -Z onto (position → lookAt),
 *  banked by `roll`° about the view axis (#229). Delegates to the ONE shared
 *  `cameraOrientationQuat` so the drawn frustum matches the look-through + render
 *  exactly (V37). Pure. */
export function frustumQuaternion(
  position: readonly [number, number, number],
  lookAt: readonly [number, number, number],
  roll = 0,
): THREE.Quaternion {
  return cameraOrientationQuat(position, lookAt, roll);
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

  const [px, py, pz] = pose.position;
  const [lx, ly, lz] = pose.lookAt;
  const quat = useMemo(
    () => frustumQuaternion([px, py, pz], [lx, ly, lz], pose.roll),
    [px, py, pz, lx, ly, lz, pose.roll],
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

  // #231 Inc 3.2 — the ACTIVE camera draws a SOLID FILLED triangle on the top of
  // its frustum (Blender's filled-triangle active-camera indicator), over the wire
  // "up" triangle. Built from the same hh/hw/z the segments use so it sits exactly
  // on the wire triangle. null (no fill) for any non-active camera.
  const activeTriGeom = useMemo(() => {
    if (!active) return null;
    const hh =
      pose.kind === 'OrthographicCamera'
        ? FRUSTUM_DEPTH / (Number.isFinite(pose.fov) && pose.fov > 0 ? pose.fov : 1)
        : Math.tan((THREE.MathUtils.degToRad(pose.fov) || 0) / 2) * FRUSTUM_DEPTH;
    const hw = hh * FRUSTUM_ASPECT;
    const z = pose.kind === 'OrthographicCamera' ? 0 : -FRUSTUM_DEPTH;
    const tri = [-hw * 0.5, hh, z, hw * 0.5, hh, z, 0, hh * 1.5, z];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    return g;
  }, [active, pose.kind, pose.fov]);

  // Approx base half-extents for the invisible hitbox (perspective only; the
  // ortho box hitbox uses the same shape, close enough for picking).
  const halfH = Math.tan((THREE.MathUtils.degToRad(pose.fov) || 0) / 2) * FRUSTUM_DEPTH;

  // #211 — the one shared viewport selection handler (was duplicated here).
  const onClick = selectNodeOnClick(pickId);

  // DEV observation seam ([[V85]]/[[H132]] #240): record the EVALUATED pose this
  // frustum renders with, keyed by node id, so an e2e can assert the frustum
  // follows the playhead (not the static frame-0 read).
  if (import.meta.env.DEV && pickId) {
    const w = window as unknown as { __basher_frustum_pose?: Record<string, CameraPose> };
    (w.__basher_frustum_pose ??= {})[pickId] = pose;
  }

  return (
    <group
      position={pose.position as [number, number, number]}
      quaternion={quat}
      onClick={onClick}
      userData={{ editorChrome: true }}
    >
      <lineSegments>
        <primitive object={geom} attach="geometry" />
        <lineBasicMaterial color={color} />
      </lineSegments>
      {/* #231 Inc 3.2 — solid filled triangle marking the ACTIVE camera. */}
      {activeTriGeom ? (
        <mesh>
          <primitive object={activeTriGeom} attach="geometry" />
          <meshBasicMaterial color={COLOR_ACTIVE} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
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
