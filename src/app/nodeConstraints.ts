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
import { resolveWorldTransform, resolveParentWorldMatrix } from './resolveWorldTransform';
import { curveSamplerFor, readCurveSampleAt } from './curveSampleSource';
import { gltfNodeWorldPosition } from './gltfNodeWorld';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { readChain } from '../core/dag/chainEdit';
import { getNodeType } from '../core/dag/registry';

type Vec3 = [number, number, number];

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
  // #1813 — on a chain, the wires are the order. A step not on it, which draws nothing, sorts last.
  for (const [target, list] of index) {
    const steps = readChain({ nodes } as unknown as DagState, target)?.steps;
    if (!steps?.length) continue;
    const place = new Map(steps.map((step, i) => [step.id, i]));
    list.sort((a, b) => (place.get(a.nodeId) ?? Infinity) - (place.get(b.nodeId) ?? Infinity));
  }

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

/** #1776 — what a constraint controls on `nodeId`'s transform row `paramPath`, or null. */
export interface TransformController {
  /** The constraint node, so the row can name it and select it. */
  readonly nodeId: string;
  readonly type: 'TrackTo' | 'FollowPath';
}

/**
 * #1776 — the constraint that decides what `nodeId`'s `paramPath` is drawn with: the winning
 * Track-To for `rotation` / `quaternion`, the top Follow-Path for `position`. The inspector shows
 * the drawn value on such a row and locks it, naming this constraint (the user's call over
 * Blender, which shows the own value under a constraint): an edit there would change nothing on
 * screen. Muted members control nothing. Every other param → null.
 */
export function transformControllerOf(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string,
  paramPath: string,
): TransformController | null {
  if (paramPath === 'rotation' || paramPath === 'quaternion') {
    const aim = activeConstraintForTarget(nodes, nodeId);
    return aim ? { nodeId: aim.nodeId, type: 'TrackTo' } : null;
  }
  if (paramPath === 'position') {
    const stack = followPathStackForTarget(nodes, nodeId);
    const top = stack[stack.length - 1];
    return top ? { nodeId: top.nodeId, type: 'FollowPath' } : null;
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

// #1813 — THE CHAIN IS THE ANSWER. An object's constraints are wired steps ending at its `constraints`
// input, and its `world` output is where they end, so every read below takes that one value.
//
// A driver on a step's setting can read an aimed object below that step through the evaluated
// transform, which comes back here while the first read is still running. `reading` answers any
// such re-entry with the object as it is without its constraints, which is what that driver has
// always read: the walk it would start is the one already running.
let reading = false;

/** `read` under that guard, or null when it is already held. */
function whileReading<T>(read: () => T | null): T | null {
  if (reading) return null;
  reading = true;
  try {
    return read();
  } finally {
    reading = false;
  }
}

function chainEnd(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): { world: THREE.Matrix4; own: THREE.Matrix4 } | null {
  const node = state.nodes[nodeId];
  if (!node || getNodeType(node.type)?.outputs.world?.world !== true) return null;
  const read = (id: string) =>
    new THREE.Matrix4().fromArray(
      evaluate(state, id, { socket: 'world', ctx, cache }).value as number[],
    );
  try {
    const chain = readChain(state, nodeId);
    const world = read(nodeId);
    return { world, own: chain?.own ? read(chain.own) : world };
  } catch {
    return null;
  }
}

/** The world the object's local transform composes under, as the renderer nests it. */
function chainParentWorld(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): THREE.Matrix4 | null {
  const node = state.nodes[nodeId];
  const ref = node?.inputs.parent;
  const bone = (node?.params as { parentBone?: unknown } | undefined)?.parentBone;
  if (!ref || Array.isArray(ref) || bone)
    return resolveParentWorldMatrix(state, nodeId, ctx, cache);
  try {
    return new THREE.Matrix4().fromArray(
      evaluate(state, ref.node, { socket: ref.socket, ctx, cache }).value as number[],
    );
  } catch {
    return null;
  }
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
  if (constraintStackForTarget(state.nodes, nodeId).length === 0) return null;
  return whileReading(() => aimedRotation(state, nodeId, ctx, cache));
}

function aimedRotation(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): Vec3 | null {
  const end = chainEnd(state, nodeId, ctx, cache);
  if (!end) return null;
  // A degenerate aim (nothing to aim at, standing on the target) left the rotation as it was, and
  // "no aim" is what a caller reads that as. The step's own result says where it aimed from.
  const onChain = new Set(readChain(state, nodeId)?.steps.map((step) => step.id));
  const aims = constraintStackForTarget(state.nodes, nodeId).some((member) => {
    const from = onChain.has(member.nodeId) ? chainEnd(state, member.nodeId, ctx, cache) : null;
    if (!from) return false;
    const target = aimTargetWorld(state, evaluatedTrackTo(state, member, ctx, cache), ctx, cache);
    return (
      new THREE.Vector3()
        .setFromMatrixPosition(from.world)
        .distanceToSquared(new THREE.Vector3(...target)) > 1e-18
    );
  });
  if (!aims) return null;
  const q = new THREE.Quaternion();
  end.world.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  const parent = chainParentWorld(state, nodeId, ctx, cache);
  if (parent) {
    const qParent = new THREE.Quaternion();
    parent.decompose(new THREE.Vector3(), qParent, new THREE.Vector3());
    q.premultiply(qParent.invert());
  }
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [
    THREE.MathUtils.radToDeg(e.x),
    THREE.MathUtils.radToDeg(e.y),
    THREE.MathUtils.radToDeg(e.z),
  ];
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
  const members = followPathStackForTarget(state.nodes, nodeId);
  if (members.length === 0) return null;
  return whileReading(() => {
    const onChain = new Set(readChain(state, nodeId)?.steps.map((step) => step.id));
    const live = members.some(
      (member) =>
        onChain.has(member.nodeId) &&
        member.curve &&
        readCurveSampleAt(state, member.curve, 0, ctx, cache),
    );
    const end = live ? chainEnd(state, nodeId, ctx, cache) : null;
    if (!end) return null;
    const p = new THREE.Vector3().setFromMatrixPosition(end.world);
    return [p.x, p.y, p.z] as Vec3;
  });
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
  const parentWorld = chainParentWorld(state, nodeId, ctx, cache);
  if (!parentWorld) return world;
  const v = new THREE.Vector3(world[0], world[1], world[2]).applyMatrix4(
    parentWorld.clone().invert(),
  );
  return [v.x, v.y, v.z];
}

/**
 * #1813 — what the renderer must multiply over `drawnLocal`, the transform it composes from a
 * position, a rotation and a scale, for the object to land where its chain ends. Null when they
 * agree. They part under an unevenly scaled or mirrored parent: an aim keeps its axes square in the
 * world, as Blender's does, and that is not a shape position, rotation and scale can hold under
 * such a parent.
 */
/**
 * #1794 — how the object's drawn WORLD position answers a change of its own world position: the
 * product, bottom step first, of each live Follow Path's curve turn and scale, `L`, mixed by its
 * blend's factor as `(1 − f)·I + f·L`. A Follow Path draws `point + L · below`
 * (`followPathStep`), a Track-To leaves the position alone, and a blend mixes the positions, so
 * the drawn position is affine in the own one and this is its linear part. A drag of the drawn
 * point carried through its inverse moves the own position so the object lands under the cursor,
 * as Blender's grab does for a Follow Path (`constraints_list_needinv`). Null when no step moves
 * the position, or a blend's factor has no single source to read.
 */
export function chainPositionLinear(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): THREE.Matrix3 | null {
  const chain = readChain(state, nodeId);
  if (!chain?.own) return null;
  const read = (ref: { node: string; socket: string }) =>
    evaluate(state, ref.node, { socket: ref.socket, ctx, cache }).value;
  let a: THREE.Matrix3 | null = null;
  try {
    for (const step of chain.steps) {
      const node = state.nodes[step.id];
      if (node?.type !== 'FollowPath' || (node.params as { mute?: boolean }).mute === true)
        continue;
      // The curve object: wired, or named by the step's setting (`worldRefs`), as the evaluator
      // reads it.
      const wired = node.inputs.curve;
      const named = (node.params as { curve?: unknown }).curve;
      const curveRef =
        wired && !Array.isArray(wired)
          ? wired
          : typeof named === 'string' && state.nodes[named]
            ? { node: named, socket: 'world' }
            : null;
      if (!curveRef) continue;
      const curveWorld = new THREE.Matrix4().fromArray(read(curveRef) as number[]);
      // A curve with nothing to sample leaves the position as it came (`followPathStep`).
      if (!curveSamplerFor(state, curveRef.node, ctx, cache, curveWorld.toArray())) continue;
      let f = 1;
      if (step.blend) {
        if (!step.blend.factor) return null;
        const v = read(step.blend.factor);
        if (typeof v !== 'number') return null;
        f = v;
      }
      const l = new THREE.Matrix3().setFromMatrix4(curveWorld);
      const m = new THREE.Matrix3().fromArray(
        l.elements.map((v, i) => f * v + (i % 4 === 0 ? 1 - f : 0)),
      );
      a = a ? m.multiply(a) : m;
    }
  } catch {
    return null;
  }
  return a;
}

export function chainDrawCorrection(
  state: DagState,
  nodeId: string,
  drawnLocal: THREE.Matrix4,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): THREE.Matrix4 | null {
  if (relationalPoseStackForTarget(state.nodes, nodeId).length === 0) return null;
  return whileReading(() => {
    const end = chainEnd(state, nodeId, ctx, cache);
    if (!end) return null;
    const parent = chainParentWorld(state, nodeId, ctx, cache);
    const local = parent ? parent.clone().invert().multiply(end.world) : end.world.clone();
    const correction = local.multiply(drawnLocal.clone().invert());
    const identity = new THREE.Matrix4().elements;
    return correction.elements.every((v, i) => Math.abs(v - identity[i]) < 1e-7)
      ? null
      : correction;
  });
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
  const end = reading
    ? chainEnd(state, tt.aimNode, ctx, cache)
    : whileReading(() => chainEnd(state, tt.aimNode, ctx, cache));
  if (end) {
    const p = new THREE.Vector3().setFromMatrixPosition(end.world);
    return [p.x, p.y, p.z];
  }
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
