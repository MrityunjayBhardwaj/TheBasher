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
// SCOPE (slice #204 increment 1): the aim is written as the node's LOCAL rotation,
// which equals its WORLD rotation only for a TOP-LEVEL node (the SceneChildNode
// wrapper is identity). A constrained node nested under a non-identity parent
// would need parentWorld⁻¹·aimWorld — out of scope here, documented (follow-up).
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1; vyapti V58/V56/V37.

import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { resolveTrackTo } from './resolveTrackTo';
import { resolveWorldTransform, type WorldTransform } from './resolveWorldTransform';
import type { EvaluatorCache } from '../core/dag/evaluator';

type Vec3 = [number, number, number];

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
  let targetPos: Vec3;
  if (tt.aimNode) {
    const targetWorld = resolveWorldTransform(state, tt.aimNode, ctx, cache);
    // Unresolvable node-ref target → fall back to the fixed aimPoint (never throw;
    // a deleted/unreachable target should not blank the object's orientation).
    targetPos = targetWorld ? targetWorld.position : tt.aimPoint;
  } else {
    targetPos = tt.aimPoint;
  }
  return resolveTrackTo(objWorld.position, targetPos, tt.up);
}
