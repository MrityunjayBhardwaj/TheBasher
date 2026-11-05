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
import { aimEulerDeg, trackToQuaternion, trackToUpIn } from './resolveTrackTo';
import {
  resolveWorldTransform,
  resolveParentWorldMatrix,
  type WorldTransform,
} from './resolveWorldTransform';
import { readCurveSampleAt } from './curveSampleSource';
import { isDriverMuted } from './paramDrivers';
import { gltfNodeWorldPosition } from './gltfNodeWorld';
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
  /** #1284 — a node inside the `aimNode` character to aim at (a bone); '' = the node itself. */
  readonly aimBone: string;
  readonly aimPoint: Vec3;
  /** #1759 — the space `aimPoint` is in: the world, or the constrained object's parent. */
  readonly aimSpace: 'world' | 'parent';
  readonly up: Vec3;
  /** #1759 — degrees of roll about the aim axis, after aiming. */
  readonly roll: number;
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
const poseStackIndexMemo = new WeakMap<object, ReadonlyMap<string, readonly PoseStackMember[]>>();

/**
 * The whole node table's constraint stacks, keyed by the id each one is aimed AT.
 *
 * ── WHY THIS EXISTS (#990) ───────────────────────────────────────────────────────────
 *
 * `relationalPoseStackForTarget` answered "who constrains me?" by scanning the whole
 * node table, and every band goes through it — rotation, position, the pose stack, the
 * authoring panel. The render band recomputes every constrained object whenever `state`
 * changes, so ONE scan per object over ALL objects is O(n²) in the number of constrained
 * objects: measured at 20 µs per object at 10 objects and 51 µs at 200, i.e. 20× the
 * objects costing 51× the time. A camera rig plus a crowd reaches that without being an
 * unusual scene.
 *
 * The stacks are a pure function of the node table, so they are derived ONCE per table
 * and read O(1) thereafter.
 *
 * ── WHY A WeakMap ON THE TABLE'S IDENTITY, AND NOT A CACHE TO INVALIDATE ─────────────
 *
 * `applyOp` rebuilds `state.nodes` on every write (`{...state, nodes: {...}}`), so the
 * table's IDENTITY is already an exact change signal — a new table means new stacks, and
 * an unchanged table cannot have different ones. Keying on it makes the entry derived and
 * never maintained: there is no invalidation call to forget, and a stale read is not
 * expressible rather than merely unlikely. That is the shape every memo in this repo
 * already has (`paramsHashMemo`, `historyCache`, `tableCache`, `narrowedSections`), and
 * it is why this is a memo rather than a threaded-through index parameter: an index the
 * callers pass is one a new call site silently omits, and the omission reads as correct.
 *
 * ⚠️ MUTED MEMBERS ARE KEPT, and the sort happens HERE. Filtering per call is what lets
 * one index serve both views — the "ONE scan, many views" property this file is built
 * around, now "ONE index, many views". Sorting before the filter is equivalent to the
 * per-call sort it replaces: a stable sort followed by a filter and a filter followed by
 * a stable sort agree, because filtering preserves relative order.
 */
function poseStackIndex(
  nodes: Readonly<Record<string, NodeLike>>,
): ReadonlyMap<string, readonly PoseStackMember[]> {
  const hit = poseStackIndexMemo.get(nodes);
  if (hit) return hit;

  const index = new Map<string, PoseStackMember[]>();
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRelationalPoseNode(node)) continue;
    const p = (node.params ?? {}) as Record<string, unknown>;
    const target = p.target;
    // A constraint with no target aims at nothing and belongs to no stack. The old scan
    // expressed this as `p.target !== nodeId`, which excluded it for every caller; an
    // index has to say so once, or `''` becomes a bucket every unset constraint shares.
    if (typeof target !== 'string' || target === '') continue;
    const list = index.get(target);
    const member: PoseStackMember = {
      nodeId: id,
      type: node.type,
      order: typeof p.order === 'number' ? p.order : 0,
      muted: p.mute === true,
      params: p,
    };
    if (list) list.push(member);
    else index.set(target, [member]);
  }
  // Stable → equal `order` keeps node-table order (the pre-stack first-wins order).
  for (const list of index.values()) list.sort((a, b) => a.order - b.order);

  poseStackIndexMemo.set(nodes, index);
  return index;
}

export function relationalPoseStackForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  includeMuted = false,
): PoseStackMember[] {
  if (!nodeId) return [];
  const all = poseStackIndex(nodes).get(nodeId);
  if (!all) return [];
  // Copied on the way out, both arms. The scan this replaced handed back a fresh array
  // every call; returning the index's own would make a caller's `.sort()` or `.push()`
  // rewrite the stack every OTHER caller then reads, which is a far worse bug than the
  // one being fixed and would show up somewhere else entirely.
  return includeMuted ? all.slice() : all.filter((m) => !m.muted);
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
        aimBone: typeof p.aimBone === 'string' ? p.aimBone : '',
        aimPoint: isVec3(p.aimPoint) ? p.aimPoint : [0, 0, 0],
        aimSpace: p.aimSpace === 'parent' ? 'parent' : 'world',
        up: isVec3(p.up) ? p.up : [0, 1, 0],
        roll: typeof p.roll === 'number' && Number.isFinite(p.roll) ? p.roll : 0,
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
 * ⚠️ #317 — do NOT use this to answer "what is this object's aim?". The aim band folds bottom
 * → top, so at full influence the member that actually aims the object is the TOP one:
 * {@link activeConstraintForTarget} (below full influence they blend, #1783). The two
 * coincide only while an object carries exactly one constraint — which stopped being
 * guaranteed when the Constraints panel (#312) shipped.
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
 * The aim band folds bottom → top, so the top member is the one `resolveConstraintRotation`
 * folds last and `resolveTrackToTarget` resolves: at full influence it is what the object
 * ACTUALLY does. #1783 — below full influence the members blend, so this is the member that
 * folds LAST, not the whole answer: a reader of the drawn result reads the fold
 * (`resolveConstraintRotation`, `cameraLocalOrientation`), and this names the constraint. Any
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

/** #1776 — what a constraint controls on `nodeId`'s transform row `paramPath`, or null. */
export interface TransformController {
  /** The constraint node, so the row can name it and select it. */
  readonly nodeId: string;
  readonly type: 'TrackTo' | 'FollowPath';
  /** #1795 — the constraint decides the row outright, so an edit there would change nothing on
   *  screen: the row shows the drawn value, locked. False when it only partly decides it (a
   *  Follow Path, whose result adds the own position as an offset, #1791; Track-Tos none of which
   *  is at full influence, #1783): the row shows the own value, editable, as Blender does. */
  readonly locks: boolean;
}

/** #1795 — the influence a constraint is authored at, when nothing animates it; null when
 *  something can (a key channel or live driver on `influence`, or any strip placed on the
 *  constraint, whose clip may carry it): it can then be anything over time. A muted driver
 *  animates nothing; a key channel counts muted or not, the side that leaves the row editable. */
function fixedInfluence(
  nodes: Readonly<Record<string, NodeLike>>,
  constraintId: string,
): number | null {
  for (const [id, n] of Object.entries(nodes)) {
    const p = n.params as { target?: unknown; paramPath?: unknown } | undefined;
    if (p?.target !== constraintId) continue;
    if (n.type === 'Strip') return null;
    if (p.paramPath !== 'influence') continue;
    if (n.type.startsWith('KeyframeChannel')) return null;
    if (n.type === 'ParamDriver' && !isDriverMuted({ ...n, id })) return null;
  }
  const raw = (nodes[constraintId]?.params as { influence?: unknown } | undefined)?.influence;
  return typeof raw === 'number' && !Number.isNaN(raw) ? Math.min(1, Math.max(0, raw)) : 1;
}

/** #1795 — the top live Track-To on `nodeId` that can aim it: muted members and members at a
 *  fixed influence of 0 are skipped (they aim nothing). The camera's aim reticle edits this one. */
export function topContributingTrackTo(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
): ActiveConstraint | null {
  const live = constraintStackForTarget(nodes, nodeId).filter(
    (m) => fixedInfluence(nodes, m.nodeId) !== 0,
  );
  return live[live.length - 1] ?? null;
}

/**
 * #1776 — the constraint that decides what `nodeId`'s `paramPath` is drawn with: the top live
 * Track-To for `rotation` / `quaternion`, the top live Follow-Path for `position`. Muted members,
 * and members at a fixed influence of 0, control nothing. Every other param → null.
 *
 * #1795 (the user's call, 2026-11-04) — `locks` says whether it decides the row OUTRIGHT. A
 * Track-To at a fixed full influence does: everything below it, the own rotation included, is
 * replaced, so the row shows the drawn value, locked (#1776's rule: an edit there would change
 * nothing on screen). A Follow Path never does (the own position is its offset, #1791), nor do
 * Track-Tos none of which is at full influence (#1783): the row shows the own value, editable,
 * with the constraint named beside it.
 */
export function transformControllerOf(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  paramPath: string,
): TransformController | null {
  const live = (ids: { nodeId: string }[]) =>
    ids.map((m) => ({ id: m.nodeId, f: fixedInfluence(nodes, m.nodeId) })).filter((m) => m.f !== 0);
  if (paramPath === 'rotation' || paramPath === 'quaternion') {
    const members = live(constraintStackForTarget(nodes, nodeId));
    const top = members[members.length - 1];
    if (!top) return null;
    return { nodeId: top.id, type: 'TrackTo', locks: members.some((m) => m.f === 1) };
  }
  if (paramPath === 'position') {
    const members = live(followPathStackForTarget(nodes, nodeId));
    const top = members[members.length - 1];
    return top ? { nodeId: top.id, type: 'FollowPath', locks: false } : null;
  }
  return null;
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

  // #311 — FOLD the stack bottom → top on the ROTATION band. A DEGENERATE member
  // (unresolvable target / zero-distance aim) contributes nothing — exactly as a muted member
  // would. A single member at full influence returns its aim unchanged: the byte-identity pin
  // (this is why the fold blends whole rotations as quaternions, never Euler angles).
  //
  // Members writing ORTHOGONAL bands need no ordering at all — a Follow-Path writes POSITION
  // while this writes ROTATION, so they commute.
  // #1770 — read before the fold: a member's up is in its own space, and this fold aims in the world.
  const parentWorld = resolveParentWorldMatrix(state, nodeId, ctx, cache);
  // #1783 — each member's aim blends over the result of the members below it by its influence,
  // by slerp, as Blender 5.1.1's constraint Influence does (measured: 0.5 over the own rotation is
  // slerp(own, aim, 0.5) to 6 places; two stacked Track-Tos slerp in order). Influence 1 takes the
  // aim exactly (the slerp's t = 1 is a copy), so a stack at full influence is the last-writer-wins
  // fold it was, byte for byte. Below the first member is the object's own world rotation.
  let aimQ: THREE.Quaternion | null = null;
  for (const typed of stack) {
    const member = evaluatedTrackTo(state, typed, ctx, cache);
    const influence = constraintInfluence(state, member.nodeId, ctx, cache);
    if (influence <= 0) continue;
    const q = trackToQuaternion(
      aimOrigin,
      aimTargetWorld(state, member, ctx, cache),
      trackToUpIn(member.up, member.aimSpace, 'world', parentWorld),
      member.roll,
    );
    if (!q) continue; // degenerate — contributes nothing
    if (influence >= 1) aimQ = q;
    else aimQ = (aimQ ?? new THREE.Quaternion(...objWorld.quaternion)).clone().slerp(q, influence);
  }
  if (!aimQ) return null;
  const aimWorld = aimEulerDeg(aimQ);
  // #267 (V45 #1 / I2 / C5) — the aim is derived in WORLD space, but the value we
  // return is written as the node's LOCAL rotation param, which then composes UNDER
  // the node's parent in the render (GroupR/TransformR `<group>`). Re-express the
  // world aim into the node's PARENT-LOCAL frame — parentWorld⁻¹ · aimWorld — so the
  // rendered WORLD orientation equals the aim, not aim double-rotated by the parent.
  // resolveParentWorldMatrix returns null for a TOP-LEVEL node (identity parent) →
  // aim stays world == local, byte-identical to the pre-#267 top-level path.
  if (!parentWorld) return aimWorld;
  return worldAimToParentLocal(aimWorld, parentWorld);
}

/**
 * The WORLD point `nodeId`'s Follow-Path stack places it at, or null when it has no
 * active, non-degenerate Follow-Path.
 *
 * #1791 — THE OBJECT'S OWN POSITION IS AN OFFSET FROM THE PATH, as in Blender 5.1.1, whose
 * `followpath_evaluate` (constraint.cc) is `owner = curveWorld · T(point) · owner`: the path acts
 * like a parent. So the result is the point on the path plus the object's own WORLD position (its
 * keys, drivers, held edits and parent included: the pure `resolveWorldTransform`), carried
 * through the curve object's rotation and scale. Measured in 5.1.1: an empty at (0, 4, 0) on a
 * path from the origin to (10, 0, 0), at its end, draws at (10, 4, 0); with the curve object turned
 * 90° about Z, at (−4, 10, 0); scaled 2, at (20, 8, 0); parented under an empty at (0, 0, 5), at
 * (10, 4, 5). Before, the point REPLACED the own position, so it could not be nudged off the path.
 *
 * Only the position is taken. Blender also turns the object by the curve object's rotation (and by
 * the tangent with Follow Curve); this band writes position only, so neither is applied here.
 *
 * The stack folds bottom → top, each member placing the result of the one below, as Blender
 * applies constraints in order. A DEGENERATE member (no curve, or a `curve` that isn't a
 * resolvable Curve) contributes nothing, exactly as a muted one would.
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
 * this resolver's own inputs (the curve's world, and the object's own world) read, so folding
 * it in closes a cycle (A follows curve C, C parented under A → ∞). The pure/applied SPLIT is
 * the cycle guard, and the renderer already embodies it: `ConstrainedR` applies the band to an
 * object's local while the band reads pure worlds for its inputs.
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
  let own: Vec3 | null = null;
  let contributed = false;
  for (const member of stack) {
    if (!member.curve) continue; // degenerate — unbound path
    const influence = constraintInfluence(state, member.nodeId, ctx, cache);
    if (influence <= 0) continue;
    const resolved = resolveEvaluatedParam(state, member.nodeId, 'evalTime', ctx, cache);
    const evalTime = typeof resolved?.value === 'number' ? resolved.value : member.evalTime;
    const sample = readCurveSampleAt(state, member.curve, evalTime + member.offset, ctx, cache);
    if (!sample) continue;
    contributed = true;
    // What this member places: the result of the members below, else the object's own world.
    if (!world) {
      own ??= resolveWorldTransform(state, nodeId, ctx, cache)?.position ?? [0, 0, 0];
      world = own;
    }
    // The offset goes through the curve object's rotation and scale; its translation is already
    // in the sampled point.
    const curveWorld = resolveWorldTransform(state, member.curve, ctx, cache)?.matrix;
    const off: THREE.Vector3 = new THREE.Vector3(world[0], world[1], world[2]);
    const lin = curveWorld
      ? new THREE.Matrix4().fromArray(curveWorld).setPosition(0, 0, 0)
      : new THREE.Matrix4();
    off.applyMatrix4(lin);
    const full: Vec3 = [sample.point[0] + off.x, sample.point[1] + off.y, sample.point[2] + off.z];
    // #1783 — blended over what is below by its influence, by lerp (Blender 5.1.1: an empty at
    // (0, 4, 0) at influence 0.5 on a path to (10, 0, 0) draws at (5, 4, 0)). 1 is the path's
    // result exactly.
    world =
      influence >= 1
        ? full
        : [
            world[0] + (full[0] - world[0]) * influence,
            world[1] + (full[1] - world[1]) * influence,
            world[2] + (full[2] - world[2]) * influence,
          ];
  }
  return contributed ? world : null;
}

/**
 * #1794 — how the drawn position of `nodeId` answers its own world position, as a 3×3 matrix A:
 * the Follow Path fold is `drawn = A · own + b` (each live member contributes
 * `(1 − f)·I + f·L`, L its curve object's rotation and scale, f its influence). Null when no
 * live Follow Path places it (drawn = own).
 *
 * A drag that moves the drawn point by `d` moves the own position by `A⁻¹ · d`, so the object
 * follows the cursor however the curve object is turned or scaled. Blender 5.1.1's grab does the
 * same: for a Follow Path `constraints_list_needinv` holds, and `ObjectToTransData` converts the
 * drag through the inverse of the constrained world matrix (transform_convert_object.cc).
 */
export function followPathLinear(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): THREE.Matrix3 | null {
  const stack = followPathStackForTarget(state.nodes, nodeId);
  let a: THREE.Matrix3 | null = null;
  for (const member of stack) {
    if (!member.curve) continue;
    const f = constraintInfluence(state, member.nodeId, ctx, cache);
    if (f <= 0) continue;
    const resolved = resolveEvaluatedParam(state, member.nodeId, 'evalTime', ctx, cache);
    const evalTime = typeof resolved?.value === 'number' ? resolved.value : member.evalTime;
    if (!readCurveSampleAt(state, member.curve, evalTime + member.offset, ctx, cache)) continue;
    const curveWorld = resolveWorldTransform(state, member.curve, ctx, cache)?.matrix;
    const l = curveWorld
      ? new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().fromArray(curveWorld))
      : new THREE.Matrix3();
    // (1 − f)·I + f·L
    const e = l.elements.map((v, i) => f * v + (i % 4 === 0 ? 1 - f : 0));
    const m = new THREE.Matrix3().fromArray(e);
    a = a ? m.multiply(a) : m;
  }
  return a;
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
  // #311 — the TOP of the stack owns the aim point, matching the member
  // `resolveConstraintRotation` folds last (#1783: at full influence it alone decides the aim;
  // below it this is the last member's point, and the drawn aim is the fold's). A single-member
  // stack is `[0]` either way → byte-identical to the pre-stack first-wins path.
  // #317 — "the top member" now has ONE name (`activeConstraintForTarget`), so the
  // authoring surfaces display/edit exactly the member this resolves.
  const winner = resolveActiveTrackTo(state, nodeId, ctx, cache);
  if (!winner) return null;
  return aimTargetWorld(state, winner, ctx, cache);
}

/** The winning Track-To on `nodeId` at `ctx`, its animatable settings evaluated (#1767): the
 *  member `resolveTrackToTarget` aims by, for a reader that also needs its roll or up. */
export function resolveActiveTrackTo(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): ActiveConstraint | null {
  const winner = activeConstraintForTarget(state.nodes, nodeId);
  return winner ? evaluatedTrackTo(state, winner, ctx, cache) : null;
}

/**
 * #1767 — a Track-To member with its animatable settings read at `ctx` through the render's own
 * param read, so keys, strips and drivers on its aim point, up and roll are honoured, as
 * Follow-Path's `evalTime` is. The stack itself stays a typed scan (`constraintStackForTarget`
 * takes no ctx), so this is applied where a member is resolved. A setting with nothing on it
 * reads back as typed.
 */
/**
 * #1783 — how much constraint `constraintId` counts at `ctx`: its `influence`, keys and drivers
 * applied, clamped to 0–1. A constraint saved before influence existed counts fully (1).
 */
export function constraintInfluence(
  state: DagState,
  constraintId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): number {
  const raw =
    resolveEvaluatedParam(state, constraintId, 'influence', ctx, cache)?.value ??
    (state.nodes[constraintId]?.params as { influence?: unknown } | undefined)?.influence;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

/** One live Track-To of an object's stack at `ctx`, bottom → top: its animatable settings
 *  evaluated, its influence, and the WORLD point it aims at. For a road that aims in its own
 *  space (the camera's, in its parent's), so it blends the same members the mesh road does. */
export interface EvaluatedTrackTo extends ActiveConstraint {
  readonly influence: number;
  readonly targetWorld: Vec3;
}

export function resolveTrackToStack(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): EvaluatedTrackTo[] {
  return constraintStackForTarget(state.nodes, nodeId).map((typed) => {
    const member = evaluatedTrackTo(state, typed, ctx, cache);
    return {
      ...member,
      influence: constraintInfluence(state, member.nodeId, ctx, cache),
      targetWorld: aimTargetWorld(state, member, ctx, cache),
    };
  });
}

function evaluatedTrackTo(
  state: DagState,
  member: ActiveConstraint,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): ActiveConstraint {
  const read = (path: 'aimPoint' | 'up' | 'roll') =>
    resolveEvaluatedParam(state, member.nodeId, path, ctx, cache)?.value;
  const aimPoint = read('aimPoint');
  const up = read('up');
  const roll = read('roll');
  return {
    ...member,
    aimPoint: isVec3(aimPoint) ? aimPoint : member.aimPoint,
    up: isVec3(up) ? up : member.up,
    roll: typeof roll === 'number' && Number.isFinite(roll) ? roll : member.roll,
  };
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
  if (!tt.aimNode) return aimPointWorld(state, tt, ctx, cache);
  // #1284 — a bone of a character: its posed world position (the walk moves the Hips, not the
  // Group). An unresolvable bone falls through to the node itself, never to a blank aim.
  if (tt.aimBone) {
    const bone = gltfNodeWorldPosition(state, tt.aimNode, tt.aimBone, ctx, cache);
    if (bone) return bone;
  }
  const followed = resolveFollowedWorldPosition(state, tt.aimNode, ctx, cache);
  if (followed) return followed;
  const targetWorld = resolveWorldTransform(state, tt.aimNode, ctx, cache);
  return targetWorld ? targetWorld.position : aimPointWorld(state, tt, ctx, cache);
}

/** #1759 — the fixed `aimPoint` in the world: as authored in `world` space, or lifted by the
 *  constrained object's parent in `parent` space (a top-level object's parent is the world). */
function aimPointWorld(
  state: DagState,
  tt: ActiveConstraint,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  if (tt.aimSpace !== 'parent') return tt.aimPoint;
  const parentWorld = resolveParentWorldMatrix(state, tt.target, ctx, cache);
  if (!parentWorld) return tt.aimPoint;
  const p = new THREE.Vector3(...tt.aimPoint).applyMatrix4(parentWorld);
  return [p.x, p.y, p.z];
}
