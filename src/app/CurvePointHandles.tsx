// CurvePointHandles — the curve's control points, grabbable in the 3D viewport (#322).
//
// ─── THE INTERACTION ──────────────────────────────────────────────────────────────────
// Select a Curve → its control points appear as handles. Click a handle → that POINT
// becomes the selection: the object gizmo hides (one gate, in Gizmo.tsx) and a translate
// gizmo re-mounts ON the point. That is Blender's object→element gizmo swap, and it is why
// there is no bespoke drag here: the point moves with the SAME TransformControls the whole
// object does, so axis constraints, snapping and the one-drag-one-undo bracket all come for
// free. A hand-rolled screen-parallel plane drag could offer none of them.
//
// (The retired #295 viewport handles were removed because slider/dial knobs floating in 3D
// are a fake — "a controller is a real transformable object you grab with the normal
// gizmo". That objection is about NON-spatial params pretending to be spatial; a curve
// control point genuinely is a point in space, so it doesn't reach here. But the lesson
// does: don't invent a second way to move something in 3D. What survives from that file is
// its PICK technique, below.)
//
// ─── THE PICK ─────────────────────────────────────────────────────────────────────────
// A handle sitting inside geometry (a path threading through a mesh — the normal case for a
// camera move) must still win the click, or it is visible-but-dead. So the handle draws with
// depthTest off AND raycasts with a near-zero distance override, exactly as CameraAimReticle
// does (Gizmo.tsx). Handles also mount OUTSIDE the SceneChildNode subtree (a sibling of
// <Gizmo/> in Viewport.tsx) so the object-selection onClick band never sees these events —
// clicking a point must not re-select, re-drill or deselect the object it belongs to.
//
// ─── THE SPACES ───────────────────────────────────────────────────────────────────────
// Points are authored in the curve's LOCAL space; the handles must appear where the path
// RENDERS, so they are drawn at `world = M · p` with M the curve's world matrix from the ONE
// world resolver (`resolveWorldTransform` — the same one curveSampleSource.ts measures the
// arc-length table with, so handle == line == sampled path; a second walk here is exactly
// how those three would drift). The drag runs in world space and is converted straight back:
// `p = M⁻¹ · worldDrag`. So a curve that is rotated, scaled or parented under a moving Group
// is still editable in place, and the authored params stay LOCAL (V68).
//
// REF: src/app/curvePoints.ts (the op-builders) + src/app/curvePointCommands.ts (the commit
//      layer) — every edit goes through them, never a setParam here;
//      src/app/curvePointSelection.ts (the one accessor); src/app/Gizmo.tsx (the gate, the
//      undo bracket, and the pick technique this mirrors); issue #322.

import { TransformControls } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDagStore } from '../core/dag/store';
import { moveCurvePoint } from './curvePointCommands';
import { useActiveCurvePoint } from './curvePointSelection';
import { curvePointEntriesOf } from './curvePoints';
import { endGizmoDrag, startGizmoDrag } from './Gizmo';
import { resolveWorldTransform } from './resolveWorldTransform';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3 } from './stores/viewportStore';
import type { Vec3 } from '../nodes/types';

const HANDLE_COLOR = '#f0b357';
const HANDLE_SELECTED_COLOR = '#ffffff';
const HANDLE_HOVER_COLOR = '#ffd08a';
/** local→world factor giving the handle a ~constant on-screen size, so a point is as
 *  clickable on a 100-unit path as on a 1-unit one (the reticle's rule). */
const HANDLE_SCREEN_SCALE = 0.018;
/**
 * A FLOOR under that scale — because the handle is not alone at that point. CurveLine draws
 * a control-point dot of a FIXED world radius (0.07), and a purely screen-scaled handle
 * shrinks below it as the camera closes in: at ~4 units the handle disappears inside the dot,
 * and by ~1.5 the pick sphere is smaller than the dot's silhouette, so a click on the dot the
 * director can SEE lands on the dot's mesh (the object band) and picks no point at all. The
 * handle looks alive and behaves dead — precisely when the director has zoomed in to place a
 * point exactly. The floor keeps the handle (0.09) and its pick sphere (0.234) larger than the
 * dot at every distance; above ~5 units the screen scale exceeds it and this never engages.
 */
const MIN_HANDLE_SCALE = 0.09;
/** The visible dot, in the handle's own (screen-scaled) space. */
const HANDLE_RADIUS = 1;
/** The invisible hit sphere — deliberately much larger than the dot: the director aims at a
 *  few pixels, and a pick target that matches the dot exactly is a miserable one. */
const HANDLE_PICK_RADIUS = 2.6;

const _v = new THREE.Vector3();

/** One grabbable control point, drawn at a world position, constant on-screen size. */
function PointHandle({
  world,
  selected,
  onPick,
}: {
  world: Vec3;
  selected: boolean;
  onPick: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  // The pick override (the retired ViewportHandles' Marker trick, still live in
  // CameraAimReticle): the handle DRAWS on top (depthTest off), so it must also PICK on top
  // — report a near-zero distance and the nearest-hit sort puts the handle first even when
  // the path threads through a mesh. Without this the handle is visible but unclickable,
  // which reads as "the viewport is broken" rather than "the cube is in front".
  const pickRaycast = useMemo(
    () =>
      function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
        const hits: THREE.Intersection[] = [];
        THREE.Mesh.prototype.raycast.call(this, raycaster, hits);
        if (hits.length) intersects.push({ ...hits[0], distance: 0.0001 });
      },
    [],
  );

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const d = camera.position.distanceTo(g.getWorldPosition(_v)) || 1;
    g.scale.setScalar(Math.max(d * HANDLE_SCREEN_SCALE, MIN_HANDLE_SCALE));
  });

  const color = selected ? HANDLE_SELECTED_COLOR : hovered ? HANDLE_HOVER_COLOR : HANDLE_COLOR;
  return (
    <group ref={group} position={world}>
      <mesh
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          // stopPropagation: the click is the POINT's, not the object's. Without it the
          // event would continue to whatever sits behind the handle.
          e.stopPropagation();
          onPick();
        }}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        raycast={pickRaycast}
      >
        <sphereGeometry args={[HANDLE_PICK_RADIUS, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      <mesh renderOrder={999} raycast={() => null}>
        <sphereGeometry args={[HANDLE_RADIUS, 12, 10]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}

export function CurvePointHandles() {
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const state = useDagStore((s) => s.state);
  const active = useActiveCurvePoint();
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);

  const [proxy, setProxy] = useState<THREE.Group | null>(null);
  const proxyRefCb = useCallback((g: THREE.Group | null) => setProxy(g), []);
  /** The curve's world matrix captured at seed time — the drag's world→local inverse. */
  const worldRef = useRef<THREE.Matrix4>(new THREE.Matrix4());

  // Handles show for the Curve that is SELECTED (Blender shows a curve's points once you
  // are editing it, not for every curve in the scene). #385: the selection is the Object half
  // of a split curve, so gate on curvePointEntriesOf (which resolves the point-owner through
  // `data`) — a box/sphere Object has no points → null → no handles. The id stays the Object,
  // whose world transform poses the LOCAL points below.
  const curveId = primaryId && curvePointEntriesOf(state, primaryId) !== null ? primaryId : null;
  // The ENTRIES ({id,co}[]) — each handle needs its point's stable id to pick by it. The
  // world geometry below still reads coordinate-only (co's); the id rides alongside.
  const entries = curveId ? curvePointEntriesOf(state, curveId) : null;

  // The world matrix + the handles' world positions. Recomputed on any DAG or time change,
  // so handles follow a scrubbing/animated curve exactly as the drawn line does.
  const { worldMatrix, worldPoints } = useMemo(() => {
    const m = new THREE.Matrix4();
    if (!curveId || !entries) return { worldMatrix: m, worldPoints: [] as Vec3[] };
    // The ONE world resolver — never a parallel walk. Null (curve not reachable as a scene
    // child) ⇒ identity, which is exactly what the sampling seam falls back to, so the
    // handles and the sampled path agree even in that degenerate case.
    const wt = resolveWorldTransform(state, curveId, {
      time: { frame, seconds, normalized },
    });
    if (wt) m.fromArray(wt.matrix);
    const v = new THREE.Vector3();
    const out = entries.map((e) => {
      v.set(e.co[0], e.co[1], e.co[2]).applyMatrix4(m);
      return [v.x, v.y, v.z] as Vec3;
    });
    return { worldMatrix: m, worldPoints: out };
  }, [state, curveId, entries, frame, seconds, normalized]);

  // Seed the point gizmo's proxy at the selected point's WORLD position, and capture the
  // matrix the drag will invert. Re-runs on scrub/param change so the gizmo display-follows
  // (the SingleGizmo discipline).
  useEffect(() => {
    worldRef.current = worldMatrix;
    if (!proxy || !active) return;
    const w = worldPoints[active.index];
    if (!w) return;
    proxy.position.set(w[0], w[1], w[2]);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
  }, [proxy, active, worldPoints, worldMatrix]);

  const pick = useCallback((nodeId: string, pointId: string) => {
    useCurveSelectionStore.getState().selectPoint(nodeId, pointId);
  }, []);

  /** The drag write. The proxy is in WORLD space; the param is LOCAL — invert the curve's
   *  world matrix and author the local point. Snapping applies to the LOCAL value, as it
   *  does for a nested object's gizmo (Gizmo.tsx onObjectChange). */
  const onObjectChange = useCallback(() => {
    const a = active;
    if (!proxy || !a) return;
    const local = _v
      .set(proxy.position.x, proxy.position.y, proxy.position.z)
      .applyMatrix4(worldRef.current.clone().invert());
    moveCurvePoint(a.nodeId, a.index, maybeSnapVec3([local.x, local.y, local.z]));
  }, [proxy, active]);

  // *** Dev-only observation seams — NOT user chrome (the __basher_gizmo_grab shape). ***
  // 3D pointer simulation through TransformControls is fragile in headless Chromium, so e2e
  // drives the REAL code paths here rather than synthesizing raycasts: `select` calls the
  // same `pick` the handle's onPointerDown calls, and `grab` moves the proxy and invokes the
  // real onObjectChange (the same function the gizmo's drag invokes) — never a shortcut
  // dispatch that would bypass the world→local conversion under test.
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_curve_handles = () => ({
      curveId,
      // The current slot (for the e2e that still checks a position) AND the stable id (the
      // #453/#326 proof: the SAME id must survive insert/delete/reorder/undo).
      selectedIndex: active?.index ?? null,
      selectedId: active?.pointId ?? null,
      // The WORLD positions the handles are actually mounted at — the observable side of
      // the handle/renderer boundary.
      world: worldPoints,
    });
    // Kept INDEX-addressed for e2e ergonomics (a spec knows a point by its slot, not its
    // minted id) — it resolves the slot to the point's stable id and picks by that, so the
    // selection the seam creates is the same id-addressed selection a real handle click makes.
    w.__basher_curve_select_point = (nodeId: string, index: number) => {
      const id = entries?.[index]?.id;
      if (id) pick(nodeId, id);
    };
    w.__basher_curve_clear_point = () => useCurveSelectionStore.getState().clear();
    w.__basher_curve_point_grab = (target: [number, number, number]) => {
      if (!proxy || !active) return;
      startGizmoDrag();
      proxy.position.set(...target);
      onObjectChange();
      endGizmoDrag('curve point');
    };
  }

  if (!curveId || !entries) return null;

  return (
    <>
      {worldPoints.map((w, i) => (
        <PointHandle
          key={entries[i].id}
          world={w}
          selected={active?.index === i}
          onPick={() => pick(curveId, entries[i].id)}
        />
      ))}
      {/* The element gizmo. Translate only: a point has a position and nothing else — there
          is no rotation or scale of a point to author (the CURVE's rotation/scale live on
          the object gizmo, which returns the moment the point selection clears). */}
      <group ref={proxyRefCb} />
      {active && proxy ? (
        <TransformControls
          object={proxy}
          mode="translate"
          enabled={!playing}
          onObjectChange={onObjectChange}
          onMouseDown={startGizmoDrag}
          onMouseUp={() => endGizmoDrag('curve point')}
        />
      ) : null}
    </>
  );
}
