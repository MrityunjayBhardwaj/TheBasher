// nodeConstraints — enumerate the CHOP/constraint nodes driving a node and
// resolve their effect at the scene-resolution layer (epic #201, slice #204).
// The constraint analogue of nodeChannels.ts: constraints are EDGE-LESS nodes
// (they carry `target` + an aim), enumerated by a flat scan of the node table,
// and RESOLVED here — where world transforms (resolveWorldTransform, #202) are
// available, which a bare node `evaluate` cannot reach.
//
// resolveConstraintRotation is resolveWorldTransform's FIRST real consumer (the
// point of #202): the aim derives from the constrained object's world position →
// the target's world position, via the ONE pure aim resolver (resolveTrackTo).
//
// NO recursion / cycle risk: resolveWorldTransform composes pure TRS only — it
// does NOT apply constraints — so reading the constrained node's own world (aim
// origin) and the target node's world (aim point) never re-enters this resolver.
// A → tracks B, B → tracks A therefore resolves each off the OTHER's un-aimed
// TRS world (well-defined), not an infinite loop.
//
// DEPTH (#267, V45 #1): the aim is derived in WORLD space and re-expressed into the
// node's PARENT-LOCAL frame (parentWorld⁻¹·aimWorld) so it composes to the correct
// world orientation under a non-identity parent Group/Transform. A top-level node has
// an identity parent → world == local (byte-identical to the pre-#267 path). The
// nested overlay only RENDERS once the render mount lands (#266, B1–B3) — before that
// a nested ConstrainedR never mounts, so this math is render-invisible.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1; vyapti V58/V56/V37/V45.

import * as THREE from 'three';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { resolveTrackTo } from './resolveTrackTo';
import {
  resolveWorldTransform,
  resolveParentWorldMatrix,
  type WorldTransform,
} from './resolveWorldTransform';
import type { EvaluatorCache } from '../core/dag/evaluator';

type Vec3 = [number, number, number];

const DEG2RAD = Math.PI / 180;

/** Minimal node shape the enumerator reads (a DagState node subset). */
interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/** The resolved aim parameters of a Track-To constraint. */
export interface ActiveTrackTo {
  readonly target: string;
  readonly aimNode: string;
  readonly aimPoint: Vec3;
  readonly up: Vec3;
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/**
 * The first ACTIVE (non-muted, non-empty-target) Track-To constraint whose
 * `target` is `nodeId`, or null. v1 is one constraint per node — the
 * OperatorStack (a chain of constraints) is a later slice; first-wins keeps this
 * deterministic until then.
 */
export function trackToForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): ActiveTrackTo | null {
  if (!nodeId) return null;
  for (const node of Object.values(nodes)) {
    if (node.type !== 'TrackTo') continue;
    const p = node.params as {
      target?: unknown;
      aimNode?: unknown;
      aimPoint?: unknown;
      up?: unknown;
      mute?: unknown;
    };
    if (p.target !== nodeId) continue;
    if (p.mute === true) continue;
    return {
      target: nodeId,
      aimNode: typeof p.aimNode === 'string' ? p.aimNode : '',
      aimPoint: isVec3(p.aimPoint) ? p.aimPoint : [0, 0, 0],
      up: isVec3(p.up) ? p.up : [0, 1, 0],
    };
  }
  return null;
}

/**
 * The set of node ids constrained by at least one active Track-To. Built in ONE
 * pass — the renderer computes it once and tests membership per child, so the
 * child map stays O(N), never O(N²) (the B13 trap).
 */
export function constraintTargetSet(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type !== 'TrackTo') continue;
    const p = node.params as { target?: unknown; mute?: unknown };
    if (typeof p.target !== 'string' || !p.target) continue;
    if (p.mute === true) continue;
    targets.add(p.target);
  }
  return targets;
}

/**
 * The derived aim rotation (Euler XYZ, DEGREES) for `nodeId` from its active
 * Track-To, or null when the node is unconstrained / the aim is undefined
 * (degenerate distance, unresolvable target). Pure (a function of state + ctx).
 *
 * Consumes resolveWorldTransform (#202) for BOTH the constrained object's world
 * position (aim origin) and a node-ref target's world position (aim point). A
 * point target (`aimNode === ''`) uses `aimPoint` directly. The shared evaluator
 * `cache` is threaded so the render-root evaluate hits the renderer's cache.
 */
export function resolveConstraintRotation(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const tt = trackToForTarget(state.nodes, nodeId);
  if (!tt) return null;
  const objWorld: WorldTransform | null = resolveWorldTransform(state, nodeId, ctx, cache);
  if (!objWorld) return null;
  const aimWorld = resolveTrackTo(objWorld.position, aimTargetWorld(state, tt, ctx, cache), tt.up);
  if (!aimWorld) return null;
  // #267 (V45 #1 / I2 / C5) — the aim is derived in WORLD space, but the value we
  // return is written as the node's LOCAL rotation param, which then composes UNDER
  // the node's parent in the render (GroupR/TransformR `<group>`). Re-express the
  // world aim into the node's PARENT-LOCAL frame — parentWorld⁻¹ · aimWorld — so the
  // rendered WORLD orientation equals the aim, not aim double-rotated by the parent.
  // resolveParentWorldMatrix returns null for a TOP-LEVEL node (identity parent) →
  // aim stays world == local, byte-identical to the pre-#267 top-level path.
  const parentWorld = resolveParentWorldMatrix(state, nodeId, ctx, cache);
  if (!parentWorld) return aimWorld;
  return worldAimToParentLocal(aimWorld, parentWorld);
}

/** Re-express a WORLD aim rotation (Euler XYZ, degrees) into the parent-local frame:
 *  localR = parentWorldR⁻¹ · aimWorldR, returned as Euler XYZ degrees. The parent's
 *  rotation is taken from its world matrix (scale/translation dropped — a constraint
 *  drives orientation only). 'XYZ' order + degrees match resolveTrackTo and the
 *  renderer's `rotation={degVec3ToRad(...)}`, so the local rotation composes back to
 *  the intended world aim (V37/H40). */
function worldAimToParentLocal(aimWorldDeg: Vec3, parentWorld: THREE.Matrix4): Vec3 {
  const qAim = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      aimWorldDeg[0] * DEG2RAD,
      aimWorldDeg[1] * DEG2RAD,
      aimWorldDeg[2] * DEG2RAD,
      'XYZ',
    ),
  );
  const qParent = new THREE.Quaternion();
  parentWorld.decompose(new THREE.Vector3(), qParent, new THREE.Vector3());
  const qLocal = qParent.invert().multiply(qAim);
  const e = new THREE.Euler().setFromQuaternion(qLocal, 'XYZ');
  return [
    THREE.MathUtils.radToDeg(e.x),
    THREE.MathUtils.radToDeg(e.y),
    THREE.MathUtils.radToDeg(e.z),
  ];
}

/**
 * The WORLD aim-target POSITION of a node's active Track-To, or null when the
 * node is unconstrained. This is the aim point the constraint resolves to — a
 * node-ref's world position (via #202) or the fixed `aimPoint`. The CAMERA
 * migration (#204) consumes this directly: a camera aims by `lookAt` (a point),
 * and Object3D.lookAt is the SAME Matrix4.lookAt math resolveTrackTo uses, so a
 * camera Track-To feeds its target world position straight in as `lookAt` —
 * one constraint system, one aim math, expressed in each consumer's native form.
 */
export function resolveTrackToTarget(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const tt = trackToForTarget(state.nodes, nodeId);
  if (!tt) return null;
  return aimTargetWorld(state, tt, ctx, cache);
}

/** The world aim-target position for a resolved Track-To: the aim node's world
 *  position (via #202) when set, else the fixed `aimPoint`. Unresolvable node-ref
 *  → fall back to `aimPoint` (never throw; a deleted target must not blank the
 *  aim). Shared by the mesh-rotation and camera-lookAt consumers. */
function aimTargetWorld(
  state: DagState,
  tt: ActiveTrackTo,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  if (!tt.aimNode) return tt.aimPoint;
  const targetWorld = resolveWorldTransform(state, tt.aimNode, ctx, cache);
  return targetWorld ? targetWorld.position : tt.aimPoint;
}
