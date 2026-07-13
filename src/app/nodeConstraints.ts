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

/** One resolved member of an object's constraint stack (the normalized, coerced
 *  aim params — never a raw node: every consumer reads `aimNode`/`aimPoint`/`up`
 *  and relies on the guards below). */
export interface ActiveConstraint {
  readonly target: string;
  readonly aimNode: string;
  readonly aimPoint: Vec3;
  readonly up: Vec3;
  /** The constraint node itself — the panel needs to know which node a row
   *  edits/mutes/removes. */
  readonly nodeId: string;
  /** Its position in the stack (already applied by the sort; carried for the UI). */
  readonly order: number;
  /** Bypassed. Members are ACTIVE-only by default (a muted constraint contributes
   *  nothing to the fold); the authoring panel asks for muted ones too, so it can
   *  render a bypassed row and let the user re-enable it. */
  readonly muted: boolean;
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/**
 * The relational POSE operators — the constraint species ([[V98]]): edge-less,
 * `{node}`-ref, seam-resolved, writing an object's POSE. The CHOP analogue of
 * `OperatorPredicate` (the SOP-stack's membership test). Track-To today;
 * Follow-Path / Copy-Location join here as members, NOT as new sidecars ([[H157]]).
 */
export function isRelationalPoseNode(node: NodeLike | undefined): boolean {
  return node?.type === 'TrackTo';
}

/**
 * The ordered constraint STACK for `nodeId` — every ACTIVE (non-muted) relational
 * pose operator whose `target` is `nodeId`, sorted bottom → top by `order`.
 *
 * ORDERING (the [[V98]] decision): a constraint is EDGE-LESS, so the stack cannot be
 * a wired sub-chain like the geometry stack (`operatorStack.ts`: "modifiers are
 * [sub-chains]; constraints aren't"). It orders by the `order` FIELD instead —
 * mirroring the driver rail (`ParamDriver.order`).
 *
 * BYTE-IDENTITY PIN: `Array.prototype.sort` is stable (ES2019+), and every project
 * authored before the stack has `order === 0` on every constraint — so the sort is a
 * no-op over `Object.values` table order, and `[0]` is exactly the node the old
 * first-wins scan returned. A single-member stack therefore resolves identically.
 */
export function constraintStackForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  /** Include BYPASSED members. The resolvers want active-only (a muted constraint
   *  contributes nothing); the authoring panel wants every member, so it can render a
   *  bypassed row and let the user re-enable it. Both views come from THIS one scan +
   *  sort, so the order the panel shows is always the order the fold applies. */
  includeMuted = false,
): ActiveConstraint[] {
  if (!nodeId) return [];
  const stack: ActiveConstraint[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRelationalPoseNode(node)) continue;
    const p = node.params as {
      target?: unknown;
      aimNode?: unknown;
      aimPoint?: unknown;
      up?: unknown;
      mute?: unknown;
      order?: unknown;
    };
    if (p.target !== nodeId) continue;
    const isMuted = p.mute === true;
    if (isMuted && !includeMuted) continue;
    stack.push({
      target: nodeId,
      aimNode: typeof p.aimNode === 'string' ? p.aimNode : '',
      aimPoint: isVec3(p.aimPoint) ? p.aimPoint : [0, 0, 0],
      up: isVec3(p.up) ? p.up : [0, 1, 0],
      nodeId: id,
      order: typeof p.order === 'number' ? p.order : 0,
      muted: isMuted,
    });
  }
  // Stable → equal `order` keeps node-table order (the pre-stack first-wins order).
  stack.sort((a, b) => a.order - b.order);
  return stack;
}

/**
 * The BOTTOM member of `nodeId`'s constraint stack, or null — the old first-wins accessor.
 *
 * ⚠️ #317 — do NOT use this to answer "what is this object's aim?". The aim band is
 * LAST-WRITER-WINS, so the member that actually aims the object is the TOP one:
 * {@link activeConstraintForTarget}. The two coincide only while an object carries exactly
 * one constraint — which stopped being guaranteed when the Constraints panel (#312) shipped.
 * The camera look-at dropdown made precisely this mistake and displayed the LOSING
 * constraint (fixed in #317).
 *
 * Legitimate remaining use: as an EXISTENCE predicate ("is this light rig-aimed at all?",
 * `studioLightRig.ts:54`), where which member you get is irrelevant.
 */
export function trackToForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): ActiveConstraint | null {
  return constraintStackForTarget(nodes, nodeId)[0] ?? null;
}

/**
 * The WINNING member of `nodeId`'s constraint stack — the TOP one (#317).
 *
 * The aim band is LAST-WRITER-WINS, so the top member is the one `resolveConstraintRotation`
 * folds last and `resolveTrackToTarget` resolves: it is what the object ACTUALLY does. Any
 * surface that DISPLAYS or EDITS "the current aim" must read THIS, not `trackToForTarget`
 * (the BOTTOM member) — they coincide for a single-constraint object and DIVERGE the moment
 * the Constraints panel adds a second one, at which point a bottom-reading surface shows the
 * loser. That was the live bug in the camera look-at dropdown before #317.
 *
 * `includeMuted` is false: a bypassed constraint aims nothing, so it cannot be the winner.
 */
export function activeConstraintForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): ActiveConstraint | null {
  const stack = constraintStackForTarget(nodes, nodeId);
  return stack[stack.length - 1] ?? null;
}

/**
 * The `order` a NEW constraint on `nodeId` should take: one above the current top (#317).
 * The pose twin of `nextDriverOrder` (paramDrivers.ts) — the two halves of the species get
 * the same rule, so "newest lands on top" holds whether you author a constraint or a driver.
 *
 * BYTE-IDENTITY: an EMPTY stack → 0, exactly the value a creation site that never set `order`
 * got from the schema default. Every site that creates a constraint on a FRESH object (a new
 * studio light, an imported profile light) therefore keeps writing 0. Only a site that
 * constrains an object which may ALREADY carry one — the camera look-at dropdown — changes
 * behaviour, and there the old hardcoded 0 was the bug: it TIED with the existing member and
 * the stable sort fell back to node-table order.
 *
 * Counts MUTED members: bypassing a constraint must not make the next one collide with it.
 */
export function nextConstraintOrder(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): number {
  const stack = constraintStackForTarget(nodes, nodeId, true);
  return stack.length === 0 ? 0 : stack[stack.length - 1].order + 1;
}

/**
 * The set of node ids constrained by at least one active relational pose operator.
 * Built in ONE pass — the renderer computes it once and tests membership per child,
 * so the child map stays O(N), never O(N²) (the B13 trap).
 *
 * Keeps the empty-target guard: an unbound `TrackTo` (`target: ''`, the schema
 * default) is INERT and must not enter the set.
 */
export function constraintTargetSet(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!isRelationalPoseNode(node)) continue;
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
  const stack = constraintStackForTarget(state.nodes, nodeId);
  if (stack.length === 0) return null;
  const objWorld: WorldTransform | null = resolveWorldTransform(state, nodeId, ctx, cache);
  if (!objWorld) return null;

  // #311 — FOLD the stack bottom → top on the ROTATION band. v1 semantics are
  // LAST-WRITER-WINS: each member that resolves to a defined aim overwrites the one
  // below it, and a DEGENERATE member (unresolvable target / zero-distance aim)
  // contributes nothing — exactly as a muted member would. So a single-member stack
  // returns that member's aim unchanged: the byte-identity pin (this is why the fold
  // picks a whole resolved aim rather than blending Euler angles, which would NOT be
  // identity-preserving for one member).
  //
  // Members writing ORTHOGONAL bands need no ordering at all — a future Follow-Path
  // writes POSITION while this writes ROTATION, so they commute. Per-member influence
  // blending (two members on the SAME band) is a later phase.
  let aimWorld: Vec3 | null = null;
  for (const member of stack) {
    const memberAim = resolveTrackTo(
      objWorld.position,
      aimTargetWorld(state, member, ctx, cache),
      member.up,
    );
    if (memberAim) aimWorld = memberAim;
  }
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
  // #311 — the aim band is LAST-WRITER-WINS, so the TOP of the stack owns the aim
  // point, matching the member `resolveConstraintRotation` folds last. A single-member
  // stack is `[0]` either way → byte-identical to the pre-stack first-wins path.
  // #317 — "the top member" now has ONE name (`activeConstraintForTarget`), so the
  // authoring surfaces display/edit exactly the member this resolves.
  const winner = activeConstraintForTarget(state.nodes, nodeId);
  if (!winner) return null;
  return aimTargetWorld(state, winner, ctx, cache);
}

/** The world aim-target position for a resolved Track-To: the aim node's world
 *  position (via #202) when set, else the fixed `aimPoint`. Unresolvable node-ref
 *  → fall back to `aimPoint` (never throw; a deleted target must not blank the
 *  aim). Shared by the mesh-rotation and camera-lookAt consumers. */
function aimTargetWorld(
  state: DagState,
  tt: ActiveConstraint,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  if (!tt.aimNode) return tt.aimPoint;
  const targetWorld = resolveWorldTransform(state, tt.aimNode, ctx, cache);
  return targetWorld ? targetWorld.position : tt.aimPoint;
}
