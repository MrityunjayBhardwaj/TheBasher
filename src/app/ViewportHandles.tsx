// ControllerHandles — the VIEWPORT view of a promoted spare param (#295, Epic 1
// Inc 4, decision D-4). The viewport twin of the Controllers dock: a promoted spare
// gets a grabbable in-scene handle whose drag writes the SAME `node.spare` datum the
// dock row edits — two views over one source (V34), never a second store. H40 holds:
// handle drag → setSpareParam → the driven target re-renders, exactly as the dock knob.
//
// Grounded on Blender: a viewport gizmo is a pure view anchored by a world matrix
// (`Gizmo.matrix_basis`), and a Geometry-Nodes gizmo "modifies the value in the
// socket" (bidirectional, one datum). Blender's three gizmo shapes — Linear (slider),
// Dial, Transform (point) — are the exact preset set here.
//
// Shape/axis/range are resolved PURELY by controllerHandles.ts (unit-tested); this
// component only adds the two impure halves: (1) the world ANCHOR via the shared
// `resolveWorldTransform` (Blender's matrix_basis — NO parallel walk, the handoff
// discipline) and (2) the drag → `setSpareParam` commit, coalesced into ONE undo
// entry via begin/endInteraction (mirrors the Gizmo drag, Gizmo.tsx:534).
//
// The whole group is `editorChrome` (V37) so the image render's hide-pass excludes it
// — a controller handle is authoring chrome, never part of the rendered frame.
//
// v1 SCOPE (documented, not silent): scalar + vec only; a point drags on a screen-
// parallel plane (the CameraAimReticle idiom, Gizmo.tsx:838 — Z follows the view, not
// depth); handles are fixed world-size (no constant-screen-scaling yet); a non-spatial
// owner (a bare compute node) anchors at the world origin. Author-drawn custom handle
// geometry is fenced to a later increment.
//
// REF: src/app/controllerHandles.ts (pure resolver); src/app/resolveWorldTransform.ts
//      (the shared anchor); src/app/Gizmo.tsx (the transform-handle precedent it
//      generalizes); decision D-4; vyapti V34/V37/V91; issue #295.

import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDagStore } from '../core/dag/store';
import { useGizmoStore } from './stores/gizmoStore';
import { useTimeStore } from './stores/timeStore';
import { resolveWorldTransform } from './resolveWorldTransform';
import { collectHandleSpecs, type HandleAxis, type HandleSpec } from './controllerHandles';

const HANDLE_COLOR = '#ffb020';
const TRACK_COLOR = '#8a6a20';
const MARKER_R = 0.09; // grabbable marker radius (world units)
const SLIDER_LEN = 1.5; // slider track length (world units)
const DIAL_R = 0.8; // dial ring radius (world units)

const AXIS_UNIT: Record<HandleAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Write a new value for a spare param, preserving its type/promoted/handle. Reads the
 *  CURRENT param fresh (drag emits many of these) and re-sets the whole record through
 *  the ONE setSpareParam op — the single source, no second store. */
function commitSpareValue(nodeId: string, key: string, value: unknown, description: string) {
  const st = useDagStore.getState();
  const param = st.state.nodes[nodeId]?.spare?.[key];
  if (!param) return;
  st.dispatchAtomic(
    [{ type: 'setSpareParam', nodeId, key, param: { ...param, value } }],
    'user',
    description,
  );
}

/** Open/close the drag transaction: suppress orbit (gizmoStore.dragging) + coalesce the
 *  per-move commits into one undo entry (begin/endInteraction). Mirrors Gizmo's
 *  startGizmoDrag/endGizmoDrag so a handle drag reverts in one Cmd+Z. */
function beginHandleDrag() {
  useGizmoStore.getState().setDragging(true);
  useDagStore.getState().beginInteraction();
}
function endHandleDrag(description: string) {
  useGizmoStore.getState().setDragging(false);
  useDagStore.getState().endInteraction(description);
}

/** A window-captured pointer drag (the CameraAimReticle idiom, Gizmo.tsx:838): once the
 *  marker is grabbed, listen on the WINDOW so the drag continues even when the pointer
 *  leaves the small glyph. `onMove` gets each raw PointerEvent; the caller raycasts. */
function useMarkerDrag(onMove: (e: PointerEvent) => void, onStart: () => void, onEnd: () => void) {
  const active = useRef(false);
  const moveRef = useRef(onMove);
  const startRef = useRef(onStart);
  const endRef = useRef(onEnd);
  moveRef.current = onMove;
  startRef.current = onStart;
  endRef.current = onEnd;

  const winMove = useRef((e: PointerEvent) => {
    if (active.current) moveRef.current(e);
  }).current;
  const winUp = useRef(() => {
    if (!active.current) return;
    active.current = false;
    window.removeEventListener('pointermove', winMove);
    window.removeEventListener('pointerup', winUp);
    endRef.current();
  }).current;

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', winMove);
      window.removeEventListener('pointerup', winUp);
    },
    [winMove, winUp],
  );

  return (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    active.current = true;
    startRef.current();
    window.addEventListener('pointermove', winMove);
    window.addEventListener('pointerup', winUp);
  };
}

/** Build a raycaster from a raw pointer event over the GL canvas. */
function rayFromEvent(
  ev: PointerEvent,
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
): THREE.Raycaster {
  const rect = gl.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, camera);
  return rc;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The grabbable sphere marker. It draws on top (depthTest off) AND wins the pick on
 *  top — a distance-≈0 raycast — so a handle drawn over/behind scene geometry is
 *  grabbable exactly where it is seen (R3F picks by ray distance, not depth, so without
 *  this an occluded-but-visible marker is dead; the CameraAimReticle discRaycast lesson,
 *  Gizmo.tsx:862). Shared by all three shapes. */
function Marker({
  pos,
  onPointerDown,
}: {
  pos: THREE.Vector3;
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
}) {
  const topRaycast = useMemo(
    () =>
      function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
        const hits: THREE.Intersection[] = [];
        THREE.Mesh.prototype.raycast.call(this, raycaster, hits);
        if (hits.length) intersects.push({ ...hits[0], distance: 0.0001 });
      },
    [],
  );
  return (
    <mesh position={pos} onPointerDown={onPointerDown} raycast={topRaycast} renderOrder={999}>
      <sphereGeometry args={[MARKER_R, 16, 16]} />
      <meshBasicMaterial color={HANDLE_COLOR} depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Point handle — a positionable sphere at anchor + value (vec2/vec3). Drags on a
// screen-parallel plane through its current position (the reticle idiom).
// ---------------------------------------------------------------------------
function PointHandle({ spec, anchor }: { spec: HandleSpec; anchor: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const arr = Array.isArray(spec.value) ? (spec.value as unknown[]) : [];
  const vx = asNumber(arr[0]);
  const vy = asNumber(arr[1]);
  const vz = spec.type === 'vec3' ? asNumber(arr[2]) : 0;
  // vec2 → the world X/Y plane; vec3 → full offset. (v1 mapping; documented.)
  const pos = useMemo(
    () => new THREE.Vector3(anchor.x + vx, anchor.y + vy, anchor.z + vz),
    [anchor, vx, vy, vz],
  );

  const onDown = useMarkerDrag(
    (ev) => {
      const rc = rayFromEvent(ev, gl, camera);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()),
        pos,
      );
      const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      const next =
        spec.type === 'vec3'
          ? [hit.x - anchor.x, hit.y - anchor.y, hit.z - anchor.z]
          : [hit.x - anchor.x, hit.y - anchor.y];
      commitSpareValue(spec.nodeId, spec.key, next, `handle ${spec.key}`);
    },
    beginHandleDrag,
    () => endHandleDrag(`handle ${spec.key}`),
  );

  return (
    <group>
      <Segment from={anchor} to={pos} color={TRACK_COLOR} />
      <Marker pos={pos} onPointerDown={onDown} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Slider handle — a marker along a world-axis track; position maps value∈[min,max]
// to [0,LEN]. Drag = closest point on the track segment to the pointer ray.
// ---------------------------------------------------------------------------
function SliderHandle({ spec, anchor }: { spec: HandleSpec; anchor: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const axis = useMemo(() => new THREE.Vector3(...AXIS_UNIT[spec.axis]), [spec.axis]);
  const span = spec.max - spec.min || 1;
  const end = useMemo(
    () => anchor.clone().add(axis.clone().multiplyScalar(SLIDER_LEN)),
    [anchor, axis],
  );
  const t = Math.min(1, Math.max(0, (asNumber(spec.value) - spec.min) / span));
  const pos = useMemo(
    () => anchor.clone().add(axis.clone().multiplyScalar(t * SLIDER_LEN)),
    [anchor, axis, t],
  );

  const onDown = useMarkerDrag(
    (ev) => {
      const rc = rayFromEvent(ev, gl, camera);
      const onSeg = new THREE.Vector3();
      rc.ray.distanceSqToSegment(anchor, end, undefined, onSeg);
      const d = onSeg.clone().sub(anchor).dot(axis); // signed distance along the axis
      const nt = Math.min(1, Math.max(0, d / SLIDER_LEN));
      let value = spec.min + nt * span;
      if (spec.type === 'int') value = Math.round(value);
      commitSpareValue(spec.nodeId, spec.key, value, `handle ${spec.key}`);
    },
    beginHandleDrag,
    () => endHandleDrag(`handle ${spec.key}`),
  );

  return (
    <group>
      <Segment from={anchor} to={end} color={TRACK_COLOR} />
      <Marker pos={pos} onPointerDown={onDown} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Dial handle — a ring in the plane ⟂ axis; value = degrees. Drag = the angle of the
// ray∩plane point about the anchor, in the ring's (u,v) basis.
// ---------------------------------------------------------------------------
function DialHandle({ spec, anchor }: { spec: HandleSpec; anchor: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const normal = useMemo(() => new THREE.Vector3(...AXIS_UNIT[spec.axis]).normalize(), [spec.axis]);
  // A stable in-plane basis (u,v) spanning the ring plane.
  const { u, v } = useMemo(() => {
    const ref = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const uu = new THREE.Vector3().crossVectors(ref, normal).normalize();
    const vv = new THREE.Vector3().crossVectors(normal, uu).normalize();
    return { u: uu, v: vv };
  }, [normal]);
  const deg = asNumber(spec.value);
  const rad = (deg * Math.PI) / 180;
  const pos = useMemo(
    () =>
      anchor
        .clone()
        .add(u.clone().multiplyScalar(Math.cos(rad) * DIAL_R))
        .add(v.clone().multiplyScalar(Math.sin(rad) * DIAL_R)),
    [anchor, u, v, rad],
  );

  const onDown = useMarkerDrag(
    (ev) => {
      const rc = rayFromEvent(ev, gl, camera);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
      const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      const w = hit.clone().sub(anchor);
      let angle = (Math.atan2(w.dot(v), w.dot(u)) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      let value = angle;
      if (spec.type === 'int') value = Math.round(value);
      commitSpareValue(spec.nodeId, spec.key, value, `handle ${spec.key}`);
    },
    beginHandleDrag,
    () => endHandleDrag(`handle ${spec.key}`),
  );

  return (
    <group>
      <Ring anchor={anchor} u={u} v={v} radius={DIAL_R} color={TRACK_COLOR} />
      <Segment from={anchor} to={pos} color={TRACK_COLOR} />
      <Marker pos={pos} onPointerDown={onDown} />
    </group>
  );
}

/** Build a non-pickable, always-on-top THREE.Line from a flat position list. Built as
 *  a real object + rendered via <primitive> (the AimConnector idiom, Gizmo.tsx:978 —
 *  the intrinsic <line> collides with the SVG element type in TSX). */
function useLineObject(positions: number[], color: string): THREE.Line {
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const m = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    });
    const l = new THREE.Line(g, m);
    l.renderOrder = 998;
    l.raycast = () => {};
    return l;
    // positions is a fresh array each render on geometry change; join to a stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.join(','), color]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );
  return line;
}

/** A thin non-pickable line between two world points (track / connector). */
function Segment({ from, to, color }: { from: THREE.Vector3; to: THREE.Vector3; color: string }) {
  const line = useLineObject([from.x, from.y, from.z, to.x, to.y, to.z], color);
  return <primitive object={line} />;
}

/** A non-pickable ring outline in the (u,v) plane about `anchor`. */
function Ring({
  anchor,
  u,
  v,
  radius,
  color,
}: {
  anchor: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  radius: number;
  color: string;
}) {
  const positions = useMemo(() => {
    const SEG = 64;
    const pts: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const p = anchor
        .clone()
        .add(u.clone().multiplyScalar(Math.cos(a) * radius))
        .add(v.clone().multiplyScalar(Math.sin(a) * radius));
      pts.push(p.x, p.y, p.z);
    }
    return pts;
  }, [anchor, u, v, radius]);
  const line = useLineObject(positions, color);
  return <primitive object={line} />;
}

/** Resolve a spec's world anchor via the SHARED resolver (Blender's matrix_basis). A
 *  non-spatial owner (bare compute node) resolves to null → the world origin. */
function useAnchor(nodeId: string): THREE.Vector3 {
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  // Subscribe to the whole state so the anchor re-resolves when the owner's transform
  // (or any upstream driving it) changes — the resolver needs the full DagState.
  const state = useDagStore((s) => s.state);
  return useMemo(() => {
    try {
      const wt = resolveWorldTransform(state, nodeId, { time: { frame, seconds, normalized } });
      if (wt) return new THREE.Vector3(...wt.position);
    } catch {
      /* fall through to origin */
    }
    return new THREE.Vector3(0, 0, 0);
  }, [state, nodeId, seconds, frame, normalized]);
}

function OneHandle({ spec }: { spec: HandleSpec }) {
  const anchor = useAnchor(spec.nodeId);
  if (spec.kind === 'point') return <PointHandle spec={spec} anchor={anchor} />;
  if (spec.kind === 'slider') return <SliderHandle spec={spec} anchor={anchor} />;
  return <DialHandle spec={spec} anchor={anchor} />;
}

/**
 * All viewport handles for promoted spare params. Mounted inside the Canvas next to
 * <Gizmo/>. The whole group is editorChrome (V37) so an image render excludes it.
 */
export function ViewportHandles() {
  const nodes = useDagStore((s) => s.state.nodes);
  const specs = useMemo(() => collectHandleSpecs(nodes), [nodes]);

  // *** DEV observation seam — dev-guarded, NOT user chrome. Mirrors Gizmo's
  // __basher_gizmo_grab: read the resolved specs and drive the REAL commit path
  // (setSpareParam, coalesced) so a boundary-pair probe observes the handle's own
  // write without a brittle 3D drag. ***
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_controller_handles = () =>
      collectHandleSpecs(useDagStore.getState().state.nodes).map((s) => ({
        nodeId: s.nodeId,
        key: s.key,
        kind: s.kind,
        type: s.type,
        value: s.value,
      }));
    w.__basher_controller_handle_grab = (nodeId: string, key: string, value: unknown) => {
      beginHandleDrag();
      commitSpareValue(nodeId, key, value, `handle ${key}`);
      endHandleDrag(`handle ${key}`);
    };
  }

  if (specs.length === 0) return null;
  return (
    <group userData={{ editorChrome: true }}>
      {specs.map((spec) => (
        <OneHandle key={`${spec.nodeId}:${spec.key}`} spec={spec} />
      ))}
    </group>
  );
}
