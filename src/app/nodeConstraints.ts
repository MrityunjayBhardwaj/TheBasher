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
import { readCurveSampleAt } from './curveSampleSource';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
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
  return node?.type === 'TrackTo' || node?.type === 'FollowPath';
}

/** One member of an object's constraint stack, BEFORE any band-specific coercion:
 *  the node's identity, its slot, and its raw params. This is what the ONE scan
 *  produces; each band derives its own typed view from it (see below). */
export interface PoseStackMember {
  readonly nodeId: string;
  readonly type: string;
  readonly order: number;
  readonly muted: boolean;
  readonly params: Record<string, unknown>;
}

/**
 * THE ONE SCAN — every relational pose operator targeting `nodeId`, muted-filtered and
 * sorted bottom → top by `order`. Type-AGNOSTIC: it selects members and orders them, and
 * says nothing about what any of them writes.
 *
 * WHY THIS EXISTS (#339, and it is the whole shape of the slice): until Follow-Path there
 * was one band, so the scan could hand back a Track-To-shaped value and nobody noticed the
 * conflation. A second band made it load-bearing: enumerating and ordering the stack is
 * SHARED (an object has ONE constraint stack, and the panel, the ordering rule and both
 * folds must agree on its membership and its order), while COERCING a member into aim
 * params is Track-To's private business. Fusing the two meant a Follow-Path enumerated
 * into the aim view would come out as `aimNode: ''` → `aimPoint: [0,0,0]` and the rotation
 * fold would silently aim the object at the world origin.
 *
 * So: ONE scan here; each band filters it by type and coerces its own members. Adding a
 * third pose operator costs a view + a fold, never another scan — which is precisely the
 * property that makes the stack an abstraction rather than a convention.
 */
export function relationalPoseStackForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  includeMuted = false,
): PoseStackMember[] {
  if (!nodeId) return [];
  const stack: PoseStackMember[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRelationalPoseNode(node)) continue;
    const p = (node.params ?? {}) as Record<string, unknown>;
    if (p.target !== nodeId) continue;
    const isMuted = p.mute === true;
    if (isMuted && !includeMuted) continue;
    stack.push({
      nodeId: id,
      type: node.type,
      order: typeof p.order === 'number' ? p.order : 0,
      muted: isMuted,
      params: p,
    });
  }
  // Stable → equal `order` keeps node-table order (the pre-stack first-wins order).
  stack.sort((a, b) => a.order - b.order);
  return stack;
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
   *  bypassed row and let the user re-enable it. Both views come from THE one scan +
   *  sort, so the order the panel shows is always the order the fold applies. */
  includeMuted = false,
): ActiveConstraint[] {
  return relationalPoseStackForTarget(nodes, nodeId, includeMuted)
    .filter((m) => m.type === 'TrackTo')
    .map((m) => {
      const p = m.params;
      return {
        target: nodeId,
        aimNode: typeof p.aimNode === 'string' ? p.aimNode : '',
        aimPoint: isVec3(p.aimPoint) ? p.aimPoint : [0, 0, 0],
        up: isVec3(p.up) ? p.up : [0, 1, 0],
        nodeId: m.nodeId,
        order: m.order,
        muted: m.muted,
      };
    });
}

/** One resolved member of an object's FOLLOW-PATH (position) band — the normalized,
 *  coerced path params. The POSITION twin of {@link ActiveConstraint}.
 *
 *  `evalTime` here is the AUTHORED param. The fold does NOT use it directly: it resolves
 *  the value through `resolveEvaluatedParam` so a keyframe or a driver on `evalTime` is
 *  honoured (see `resolveConstraintPosition`). It is carried so a caller that wants the
 *  authored number — the inspector, the agent — has it without a second read. */
export interface ActiveFollowPath {
  readonly target: string;
  /** The Curve node id. Empty → degenerate (contributes nothing to the fold). */
  readonly curve: string;
  /** The AUTHORED fraction along the path. Not the resolved one — see above. */
  readonly evalTime: number;
  readonly offset: number;
  readonly nodeId: string;
  readonly order: number;
  readonly muted: boolean;
}

/**
 * The ordered FOLLOW-PATH stack for `nodeId` — the POSITION band's view of THE one scan
 * ({@link relationalPoseStackForTarget}), bottom → top.
 *
 * The twin of `constraintStackForTarget`, and the pair of them IS the band split: same
 * membership, same order, different question. A Track-To in this object's stack simply
 * isn't in this view, and vice versa — which is why the two operators compose on one
 * object with nothing to order between them.
 */
export function followPathStackForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  includeMuted = false,
): ActiveFollowPath[] {
  return relationalPoseStackForTarget(nodes, nodeId, includeMuted)
    .filter((m) => m.type === 'FollowPath')
    .map((m) => {
      const p = m.params;
      return {
        target: nodeId,
        curve: typeof p.curve === 'string' ? p.curve : '',
        evalTime: typeof p.evalTime === 'number' ? p.evalTime : 0,
        offset: typeof p.offset === 'number' ? p.offset : 0,
        nodeId: m.nodeId,
        order: m.order,
        muted: m.muted,
      };
    });
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
 *
 * #339 — counts members of EVERY band (the type-agnostic scan), not just Track-Tos. An
 * object has ONE constraint stack and one `order` space; asking only the aim band would
 * hand a new Follow-Path the slot an existing Track-To already occupies, and the tie would
 * fall back to node-table order — the exact defect that made the old hardcoded 0 a bug.
 */
export function nextConstraintOrder(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): number {
  const stack = relationalPoseStackForTarget(nodes, nodeId, true);
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
 * The set of node ids whose POSITION is driven by at least one active Follow-Path — the
 * membership gate for the position band's followers (mirrors {@link constraintTargetSet}
 * for the aim band). `constraintTargetSet` mixes both bands, so it can't tell "is followed"
 * from "is aimed"; a light gets its per-frame position follower ONLY when it is in THIS set,
 * so a merely Track-To'd (aimed, not followed) light — and every static light — pays nothing
 * (built once, O(1) membership per light — the B13 trap). Same empty-target + mute guard.
 *
 * #343 — this is what lets a Follow-Path move a LIGHT (the 4th pose road): a light is flat in
 * `scene.lights`, never a scene child, so it needs its own follower rather than the mesh road.
 */
export function followPathTargetSet(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type !== 'FollowPath') continue;
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

  // #339 — THE AIM ORIGIN IS THE FOLLOWED POSITION WHEN THERE IS ONE.
  //
  // The two bands are orthogonal in what they WRITE, but they are NOT independent: an aim
  // is derived FROM the object's position, so the rotation band READS what the position
  // band writes. `resolveWorldTransform` deliberately composes pure TRS and applies no
  // constraints (that is what keeps it cycle-free — see its header), so its `position` is
  // where the object was AUTHORED, not where its Follow-Path put it. Aiming from there
  // would make "fly the path while locked on the hero" — the sentence this whole rig
  // exists for — compute the aim from a point the camera is not at, and be wrong by
  // exactly the distance the path moved it.
  //
  // So the position band resolves FIRST and the aim starts from its result. No cycle: the
  // followed position depends only on the CURVE's world (a different node, resolved by the
  // pure TRS walk) and never re-enters this resolver.
  const aimOrigin = resolveFollowedWorldPosition(state, nodeId, ctx, cache) ?? objWorld.position;

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
      aimOrigin,
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

/**
 * The WORLD point `nodeId`'s Follow-Path stack places it at, or null when it has no
 * active, non-degenerate Follow-Path.
 *
 * The POSITION band's fold, and the twin of `resolveConstraintRotation`'s aim fold:
 * bottom → top, LAST-WRITER-WINS, and a DEGENERATE member (no curve, or a `curve` that
 * isn't a resolvable Curve) contributes nothing — exactly as a muted one would. So a
 * single-member stack is just that member's point.
 *
 * `evalTime` is read through `resolveEvaluatedParam` — the render-identical path — NOT off
 * the raw param. That is what makes it keyframeable and driveable; reading it raw would
 * leave it a dead number and quietly falsify the whole reason the seam is arc-length
 * parameterized. `offset` IS raw: it is the constant that spreads objects along one shared
 * animation, so animating it would defeat its purpose.
 *
 * WORLD, not parent-local — the aim fold needs a world origin and the seam speaks world.
 * `resolveConstraintPosition` is the parent-local view for the transform band.
 *
 * PUBLIC for the UI surfaces that must address an object where it RENDERS rather than where
 * it was authored (box-select, #342). Such a caller reads this ON TOP of the pure
 * `resolveWorldTransform` — it must never be folded INTO that walk. The pure walk is what
 * this resolver's own inputs (the curve's world) read, so folding it in closes a cycle
 * (A follows curve C, C parented under A → ∞). The pure/applied SPLIT is the cycle guard,
 * and the renderer already embodies it: `ConstrainedR` applies the band to an object's local
 * while the band reads pure worlds for its inputs.
 */
export function resolveFollowedWorldPosition(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const stack = followPathStackForTarget(state.nodes, nodeId);
  if (stack.length === 0) return null;
  let world: Vec3 | null = null;
  for (const member of stack) {
    if (!member.curve) continue; // degenerate — unbound path
    const resolved = resolveEvaluatedParam(state, member.nodeId, 'evalTime', ctx, cache);
    const evalTime = typeof resolved?.value === 'number' ? resolved.value : member.evalTime;
    const sample = readCurveSampleAt(state, member.curve, evalTime + member.offset, ctx, cache);
    // Copied, not aliased: the seam's point is readonly (and table-owned) — this resolver
    // hands back a plain mutable Vec3 like every other band here.
    if (sample) world = [sample.point[0], sample.point[1], sample.point[2]];
  }
  return world;
}

/**
 * The derived POSITION (the node's LOCAL position param, parent-relative) for `nodeId`
 * from its active Follow-Path stack, or null when it follows nothing. Pure (a function of
 * state + ctx). The sibling of {@link resolveConstraintRotation} — one band each, and both
 * are consumed by the SAME two callers (the read-side resolver + the renderer), so what
 * the inspector reads is what the viewport draws.
 *
 * PARENT-LOCAL, mirroring the aim fold's own re-expression: the value is written as the
 * node's local position and then composed UNDER its parent by the renderer's `<group>`, so
 * a world point must be pulled back through parentWorld⁻¹ or a parented follower lands at
 * the path point double-transformed. A top-level node has no parent world → the world point
 * IS the local one.
 */
export function resolveConstraintPosition(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const world = resolveFollowedWorldPosition(state, nodeId, ctx, cache);
  if (!world) return null;
  const parentWorld = resolveParentWorldMatrix(state, nodeId, ctx, cache);
  if (!parentWorld) return world;
  const v = new THREE.Vector3(world[0], world[1], world[2]).applyMatrix4(
    parentWorld.clone().invert(),
  );
  return [v.x, v.y, v.z];
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
 *  aim). Shared by the mesh-rotation and camera-lookAt consumers.
 *
 *  #339 — the SAME position/rotation coupling as the aim ORIGIN, one node over: if the
 *  thing being aimed AT follows a path, `resolveWorldTransform` reports where it was
 *  authored, not where the path put it, so the aim would trail the subject by the whole
 *  offset. Aiming at a hero riding a path is the mirror image of flying a camera along
 *  one, and it must not need a different rule. Cycle-free for the same reason: a followed
 *  position depends only on the CURVE's pure-TRS world. */
function aimTargetWorld(
  state: DagState,
  tt: ActiveConstraint,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  if (!tt.aimNode) return tt.aimPoint;
  const followed = resolveFollowedWorldPosition(state, tt.aimNode, ctx, cache);
  if (followed) return followed;
  const targetWorld = resolveWorldTransform(state, tt.aimNode, ctx, cache);
  return targetWorld ? targetWorld.position : tt.aimPoint;
}
