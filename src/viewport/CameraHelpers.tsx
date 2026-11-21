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
// #1708 — a camera is drawn in the colour of the shots it films (`shotColors.ts`, the palette the
// Shots list uses too): the one live at the playhead solid, the others dimmer, and the live one's
// path over its shot dashed behind it (`LiveCameraPath`). Like every helper here it is editor
// chrome, hidden in rendered shading and from every render.
//
// REF: THESIS.md §11; vyapti V1, V8; sibling of LightHelpers.tsx.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { resolveCameraPoseAt, selectActiveCameraNode, type CameraPose } from '../app/activeCamera';
import { isEditorChrome } from '../app/editorChrome';
import { liveShotAt, shotColorOfCamera } from '../app/shotColors';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { uiEvaluatorCache } from '../app/uiEvaluatorCache';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { selectNodeOnClick } from './selectNodeOnClick';

// Display constants — the frustum is an editor indicator at a FIXED size, not
// the real far plane (Blender's camera "display size"). Aspect is the common
// 16:9 render frame; a future render-resolution setting can feed it later.
const FRUSTUM_DEPTH = 0.9;
const FRUSTUM_ASPECT = 16 / 9;
const BODY = 0.12; // half-size of the little camera body box at the apex

// A raycast that never registers a hit — for the frustum's pure-visual meshes so
// the single compact body hitbox owns selection (#250). Stable module-level ref
// so the visuals don't each allocate a closure per render.
const NO_RAYCAST = () => null;

const COLOR_SELECTED = '#e2e8f0'; // bright — the camera you clicked
const COLOR_ACTIVE = '#4ea1ff'; // the scene's active camera (wired to scene.camera)
const COLOR_INACTIVE = '#64748b'; // any other camera node
/** #1708 — a camera that is not the one on screen at the playhead draws at this opacity. */
const OFF_SCREEN_OPACITY = 0.45;

/** #1708 — is `cameraId` the camera on screen at the playhead (film time, the look-through's)?
 *  Re-renders only when the answer changes — at a cut or a graph edit — never per frame. */
function isLiveCamera(state: DagState, filmSeconds: number, cameraId: string | null): boolean {
  return cameraId !== null && selectActiveCameraNode(state, filmSeconds)?.id === cameraId;
}
function useIsLiveCamera(cameraId: string | null): boolean {
  useTimeStore((t) => isLiveCamera(useDagStore.getState().state, t.filmSeconds, cameraId));
  useDagStore((d) => isLiveCamera(d.state, useTimeStore.getState().filmSeconds, cameraId));
  return isLiveCamera(useDagStore.getState().state, useTimeStore.getState().filmSeconds, cameraId);
}

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

/** Ortho cameras draw a box (no convergence) the size of what they see, as Blender draws one:
 *  `orthoScale` tall (#1760), `aspect` wide, `depth` deep. Pure + unit-testable. */
export function orthoFrustumSegments(orthoScale: number, aspect: number, depth: number): number[] {
  const hh = (Number.isFinite(orthoScale) && orthoScale > 0 ? orthoScale : 6) / 2;
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
  // #1708 — the colour of the shots it films; a camera that films none keeps the old scheme.
  const shotColor = useDagStore((d) => (pickId ? shotColorOfCamera(d.state, pickId) : null));
  const live = useIsLiveCamera(pickId);
  // Selection shows on the body (bright) and keeps the frame in its shot colour, so a selected
  // camera still says which shots it films.
  const color = shotColor ?? (selected ? COLOR_SELECTED : active ? COLOR_ACTIVE : COLOR_INACTIVE);
  const bodyColor = selected ? COLOR_SELECTED : color;
  const opacity = live ? 1 : OFF_SCREEN_OPACITY;
  const lineMat = useRef<THREE.LineBasicMaterial>(null);

  // #1760 — turned by the orientation the pose carries, the one the look-through and the render
  // read (V37), so the drawn frustum points where the camera looks.
  const [qx, qy, qz, qw] = pose.quaternion;
  const quat = useMemo(() => new THREE.Quaternion(qx, qy, qz, qw), [qx, qy, qz, qw]);

  const segs = useMemo(
    () =>
      pose.kind === 'OrthographicCamera'
        ? orthoFrustumSegments(pose.orthoScale, FRUSTUM_ASPECT, FRUSTUM_DEPTH)
        : perspectiveFrustumSegments(pose.fov, FRUSTUM_ASPECT, FRUSTUM_DEPTH),
    [pose.kind, pose.fov, pose.orthoScale],
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

  // #211 — the one shared viewport selection handler (was duplicated here).
  const onClick = selectNodeOnClick(pickId);

  // DEV observation seam ([[V85]]/[[H132]] #240): record the EVALUATED pose this
  // frustum renders with, keyed by node id, so an e2e can assert the frustum
  // follows the playhead (not the static frame-0 read).
  const recorded = useRef<CameraPose | null>(null);
  if (import.meta.env.DEV && pickId) {
    const w = window as unknown as { __basher_frustum_pose?: Record<string, CameraPose> };
    (w.__basher_frustum_pose ??= {})[pickId] = pose;
    recorded.current = pose;
  }
  // #1453 — and drop it when the frustum unmounts (a hidden camera draws none), so a missing entry
  // means no frustum is drawn rather than one that once was. Only this frustum's own entry: when a
  // camera's frustum is swapped for its follower, the new one writes during its render, before the
  // old one's cleanup runs, and that entry must stand.
  useEffect(() => {
    if (!import.meta.env.DEV || !pickId) return;
    return () => {
      const w = window as unknown as { __basher_frustum_pose?: Record<string, CameraPose> };
      if (w.__basher_frustum_pose?.[pickId] === recorded.current)
        delete w.__basher_frustum_pose[pickId];
    };
  }, [pickId]);
  // #1708 DEV seam — the colour and opacity the frame's material actually carries, read off the
  // material after commit (not the props), so a spec sees what is drawn.
  useEffect(() => {
    const mat = lineMat.current;
    if (!import.meta.env.DEV || !pickId || !mat) return;
    type Styles = Record<string, { color: string; opacity: number }>;
    const w = window as unknown as { __basher_frustum_style?: Styles };
    const entry = { color: mat.color.getHexString(), opacity: mat.opacity };
    (w.__basher_frustum_style ??= {})[pickId] = entry;
    return () => {
      if (w.__basher_frustum_style?.[pickId] === entry) delete w.__basher_frustum_style[pickId];
    };
  }, [pickId, color, opacity]);

  return (
    <group
      position={pose.position as [number, number, number]}
      quaternion={quat}
      onClick={onClick}
      userData={{ editorChrome: true }}
    >
      {/* #250 — the visual meshes are PURE VISUALS: raycast disabled so the ONE
          compact body hitbox below owns selection. Critical for the wireframe:
          a LineSegments is picked via the raycaster's line
          THRESHOLD, and on the default view the editor eye sits ON this camera's
          apex→lookAt axis, so its edges registered near-zero-distance hits that
          out-picked the framed subject (clicking the cube selected the camera)
          AND blanketed "empty" screen so deselect never fired. */}
      <lineSegments raycast={NO_RAYCAST}>
        <primitive object={geom} attach="geometry" />
        <lineBasicMaterial
          ref={lineMat}
          color={color}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </lineSegments>
      {/* #231 Inc 3.2 — solid filled triangle marking the ACTIVE camera. */}
      {activeTriGeom ? (
        <mesh raycast={NO_RAYCAST}>
          <primitive object={activeTriGeom} attach="geometry" />
          <meshBasicMaterial
            color={color}
            side={THREE.DoubleSide}
            transparent={opacity < 1}
            opacity={opacity}
          />
        </mesh>
      ) : null}
      {/* Small body box at the apex so the camera reads as an object. */}
      <mesh raycast={NO_RAYCAST}>
        <boxGeometry args={[BODY * 2, BODY * 2, BODY * 2]} />
        <meshBasicMaterial
          color={bodyColor}
          wireframe={!selected}
          transparent={opacity < 1}
          opacity={opacity}
        />
      </mesh>
      {/* Invisible click hitbox — the SOLE pick surface. Sized to the camera
          BODY at the apex (not the frustum cone, which points at the lookAt and
          from front-on angles would shadow the framed subject). A small, precise
          icon: clicking it selects the camera; clicking elsewhere hits the real
          geometry or empty space. Blender picks a camera by its body/icon. */}
      <mesh>
        <boxGeometry args={[BODY * 3, BODY * 3, BODY * 3]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Samples per second of shot when drawing the live camera's path, and the cap on samples. */
const PATH_SAMPLES_PER_SECOND = 24;
const PATH_MAX_SAMPLES = 96;

/** #1708 — the shot on screen at the playhead, as a key that changes only at a cut or an edit. */
function liveShotKey(state: DagState, filmSeconds: number): string {
  const shot = liveShotAt(state, filmSeconds);
  return shot?.cameraId ? `${shot.cameraId}|${shot.start}|${shot.end}` : '';
}

/** #1708 — where the live camera travels over its shot: its evaluated position, sampled over the
 *  shot's range. Null when it does not move (nothing to draw). Pure. */
export function sampleCameraPath(
  state: DagState,
  cameraId: string,
  start: number,
  end: number,
): [number, number, number][] | null {
  const span = Math.max(0, end - start);
  const n = Math.min(PATH_MAX_SAMPLES, Math.max(2, Math.ceil(span * PATH_SAMPLES_PER_SECOND)));
  const points: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    // The last sample sits just inside the shot: at `end` the next shot's camera is on screen.
    const t = i === n ? Math.max(start, end - 1e-3) : start + (span * i) / n;
    const p = resolveCameraPoseAt(state, cameraId, t, uiEvaluatorCache).position;
    points.push([p[0], p[1], p[2]]);
  }
  const [x0, y0, z0] = points[0];
  const moves = points.some(([x, y, z]) => Math.hypot(x - x0, y - y0, z - z0) > 1e-4);
  return moves ? points : null;
}

/** #1708 — the live camera's path over its shot, dashed, in its shot colour. Sampled once per
 *  shot and graph edit (never per frame); hidden while looking through (you are in the camera). */
export function LiveCameraPath() {
  const lookThrough = useViewportStore((v) => v.lookThroughCamera);
  useTimeStore((t) => liveShotKey(useDagStore.getState().state, t.filmSeconds));
  const state = useDagStore((d) => d.state);
  const key = liveShotKey(state, useTimeStore.getState().filmSeconds);

  const drawn = useMemo(() => {
    if (!key) return null;
    const [cameraId, start, end] = key.split('|');
    const points = sampleCameraPath(state, cameraId, Number(start), Number(end));
    if (!points) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    const m = new THREE.LineDashedMaterial({
      color: shotColorOfCamera(state, cameraId) ?? COLOR_INACTIVE,
      dashSize: 0.3,
      gapSize: 0.18,
      transparent: true,
      opacity: 0.85,
    });
    const l = new THREE.Line(g, m);
    l.computeLineDistances();
    l.raycast = () => {};
    return { line: l, material: m, cameraId, points };
  }, [state, key]);

  useEffect(() => {
    if (!drawn) return;
    return () => {
      drawn.line.geometry.dispose();
      drawn.material.dispose();
    };
  }, [drawn]);

  // DEV seam: what is drawn, read off the mounted line (its material, and whether an ancestor
  // marks it editor chrome — the render's exclusion).
  const shown = drawn && !lookThrough ? drawn : null;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __basher_live_camera_path?: unknown };
    if (!shown) {
      w.__basher_live_camera_path = null;
      return;
    }
    let chrome = false;
    for (let o: THREE.Object3D | null = shown.line; o; o = o.parent) chrome ||= isEditorChrome(o);
    w.__basher_live_camera_path = {
      cameraId: shown.cameraId,
      points: shown.points,
      dashed: shown.material.isLineDashedMaterial === true,
      color: shown.material.color.getHexString(),
      chrome,
    };
    return () => {
      w.__basher_live_camera_path = null;
    };
  }, [shown]);

  if (!shown) return null;
  return (
    <group userData={{ editorChrome: true }}>
      <primitive object={shown.line} />
    </group>
  );
}
