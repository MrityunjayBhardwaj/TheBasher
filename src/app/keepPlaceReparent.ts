// keepPlaceReparent — move a scene object to a new parent without moving it on screen (#1516).
//
// Parenting in Basher is a wire: a child's parent input reading its parent's world (#1824), a
// Group's or an Object's `children` for a child with no parent input, or the scene's own lists.
// `detachOp` and `attachOp` are the one place that knows which, so every writer that moves a child
// writes the same edge the readers (`sceneHierarchy.ts`) read.
// Rewiring alone changes what the child hangs from, so it jumps to wherever its own transform puts
// it under the new parent. Houdini's "Keep Position When Parenting" rewrites the child's own
// translate / rotate / scale so its world transform is unchanged (`ObjNode.setWorldTransform`,
// `W = L·P·O`), with no hidden extra matrix. That fits a wire, so it is the model here:
//
//     own T·R·S after  =  inverse(new parent world) · old parent world · own T·R·S before
//
// A Group child's pivot sits to the right of its T·R·S (`localMatrix`), so it is untouched.
// Blender's Ctrl+P "Object (Keep Transform)" and Alt+P "Clear and Keep Transformation" give the
// same world (measured on 5.1.1: 6e-8 and 1.2e-7), Blender holding the difference in a
// parent-inverse matrix that Basher does not have.
//
// THREE CASES IT CANNOT KEEP EXACTLY, each stated rather than hidden:
//
//   - SHEAR. Under a parent with a non-uniform scale and a turn, the product is not a T·R·S. The
//     nearest T·R·S is written and the leftover (`residual`, the largest world-matrix entry it
//     misses by) comes back for the caller to report. Blender does the same on Alt+P (measured
//     0.435 on a 2×1×1 parent over a 45° child) and Houdini documents the same limit.
//   - ANIMATION. A keyed or driven transform is read relative to its parent. Rewriting the stored
//     values does not move the keys, so the object would still jump on the next frame, and
//     rewriting the keys would silently change an animation. The move is refused by name, as
//     Apply Transform refuses an animated child (#489, `childCompensation`). When the parent's
//     world does not change (moving between two parents at the same place), nothing needs keeping
//     and nothing is refused. Delete does not refuse: its parent is going, so there is nothing to
//     stay under. The child moves with its keys as they are, as Blender's does, and is reported
//     (`MoveResult.unkept`) because Blender says nothing.
//
// A CONSTRAINT ABOVE IT is kept like any other parent (#1854): both worlds are read as they are
// DRAWN (`resolveDrawnParentWorldMatrix`), every holder with its Track-To aim and Follow Path point
// applied, so a child leaving or joining an aimed or following object stays where it is drawn.
// Blender does the same (measured on 5.1.1, a parent posed 1.75 by a Track-To and 4.48 by a Follow
// Path: Ctrl+P and Alt+P "Clear and Keep Transformation" each keep the child where it is drawn, 0
// drift). The child's own Track-To is fine too: its position is kept, and the aim overrides its
// rotation. Until #1854 the read left the constraint out (#1829), so such a move was refused.
//
// DELETE keeps the children in place by default, for the reasons written at `planDeleteNodes`
// (#1861); Alt+Delete keeps their own values instead (`keepTransform: false`). Blender's Delete
// drops a child onto its own values, which its parent-inverse matrix usually hides.
//
// Only the world the parent has at `ctx` is kept: under an animated parent, as in Blender, the
// child is in place at the frame the gesture was made at.
//
// REF: issues #1516, #1517, #1854; src/app/animate/dispatchApplyTransform.ts (`childCompensation`,
//      the same compensation for Apply); src/app/drawnWorldTransform.ts
//      (`resolveDrawnParentWorldMatrix`).

import * as THREE from 'three';
import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { applyOps } from '../core/dag/ops';
import {
  attachOp,
  attachesByParentInput,
  parentSocketOf,
  worldParentOf,
} from '../core/dag/worldChildren';

export { attachOp };
import { getNodeType, paramFieldsOf } from '../core/dag/registry';
import { quaternionToEulerVec3 } from '../core/import/threeAdapter';
import { isKeyframeChannelNode } from './animate/paramAnimationState';
import { isCameraNode } from './cameraNode';
import { isLightNode } from './lightNode';
import { resolveDrawnParentWorldMatrix } from './drawnWorldTransform';
import { rotationWriteOf } from './resolvedRotation';
import { hierarchySocketsOf, parentIdsOf } from './sceneHierarchy';
import { isInScene } from './sceneMembership';
import { nodeDisplayName } from './sceneTreeWalk';
import { liveCtx, type ClockedCtx } from './subjectClock';
import type { Quat, RotationModeFields } from '../nodes/types';

type Vec3 = [number, number, number];

/** A wire that holds a child in the scene tree: the holder and the socket. */
export interface HolderEdge {
  readonly node: NodeId;
  readonly socket: string;
  /** #1824 — the child holds the holder, through its own parent input reading the holder's world,
   *  rather than sitting in the holder's `socket` list. */
  readonly byParentInput?: true;
}

/** The op that takes `childId` off `edge`. */
export function detachOp(childId: NodeId, edge: HolderEdge, state: DagState): Op {
  if (edge.byParentInput) {
    const socket = parentSocketOf(state.nodes[childId]?.type ?? '') ?? 'parent';
    return {
      type: 'disconnect',
      from: { node: edge.node, socket: 'world' },
      to: { node: childId, socket },
    };
  }
  return {
    type: 'disconnect',
    from: { node: childId, socket: 'out' },
    to: { node: edge.node, socket: edge.socket },
  };
}

/** #1823 — whether `edge` lists its child as a member rather than holding it as a parent: the
 *  scene's own `children`, a collection's `members`. */
function isMembershipEdge(state: DagState, edge: HolderEdge): boolean {
  if (edge.byParentInput) return false;
  const type = state.nodes[edge.node]?.type;
  return (
    (type === 'Scene' && edge.socket === 'children') ||
    (type === 'Collection' && edge.socket === 'members')
  );
}

/** The transform params a keep-position rewrite reads and writes. */
const TRANSFORM_PATHS: ReadonlySet<string> = new Set([
  'position',
  'rotation',
  'scale',
  'quaternion',
]);

/** Above this, a world-matrix entry missed is reported as a change the user can see. */
const RESIDUAL_TOLERANCE = 1e-5;

const D2R = Math.PI / 180;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}

function refsOf(binding: unknown): { node?: string; socket?: string }[] {
  const list = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return list as { node?: string; socket?: string }[];
}

/** The scene node, or null when the project has none bound. */
export function sceneIdOf(state: DagState): NodeId | null {
  const id = state.outputs.scene?.node;
  return id && state.nodes[id] ? id : null;
}

/**
 * The wires that place `childId` in the scene tree and that a reparent moves: a Group's, an
 * Object's or the scene's `children`, and the scene's `lights`. A wrapper's chain input
 * (Transform / MaterialOverride) and the scene's `camera` are not on it: a wrapped node moves with
 * its wrapper, and the active camera is a separate choice (#231).
 */
export function movableHolderEdges(state: DagState, childId: NodeId): HolderEdge[] {
  const sceneId = sceneIdOf(state);
  const out: HolderEdge[] = [];
  for (const [holderId, holder] of Object.entries(state.nodes)) {
    for (const [socket, binding] of Object.entries(holder.inputs ?? {})) {
      const parents =
        hierarchySocketsOf(holder).includes(socket) && socket === 'children'
          ? true
          : holderId === sceneId && socket === 'lights';
      if (!parents) continue;
      if (refsOf(binding).some((r) => r?.node === childId && r.socket === 'out'))
        out.push({ node: holderId, socket });
    }
  }
  const parent = worldParentOf(state, childId);
  if (parent && !out.some((e) => e.node === parent))
    out.push({ node: parent, socket: 'children', byParentInput: true });
  return out;
}

/** True when `id` is `ancestorId` or hangs somewhere below it. */
export function isAtOrBelow(state: DagState, id: NodeId, ancestorId: NodeId): boolean {
  const seen = new Set<NodeId>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestorId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...parentIdsOf(state, cur));
  }
  return false;
}

/**
 * The socket a holder takes `childId` on: a Group or an Object holds every child in `children`;
 * the scene holds a light in `lights` and anything else in `children`, a camera included (#1518: a
 * camera at the top is in `children`, and one on no list is not in the scene). Null when `holderId`
 * cannot hold it.
 */
export function receivingSocket(state: DagState, holderId: NodeId, childId: NodeId): string | null {
  const holder = state.nodes[holderId];
  if (!holder) return null;
  if (holderId === sceneIdOf(state)) {
    return isLightNode(state.nodes, childId) ? 'lights' : 'children';
  }
  if (holder.type === 'Group') return 'children';
  // An Object holds children only when it is itself drawn through `children` (#1152): a light's or
  // a camera's Object hangs off its own band and would hold a child nothing draws.
  if (
    holder.type === 'Object' &&
    !isCameraNode(state, holderId) &&
    !isLightNode(state.nodes, holderId)
  )
    return 'children';
  return null;
}

const drivenMemo = new WeakMap<DagState['nodes'], ReadonlyMap<NodeId, string>>();

/** Every node whose transform is read from something other than its stored values, with what:
 *  a keyframe channel, a driver or an NLA strip on position, rotation or scale.
 *  One pass per node table, so a delete handing up 2,000 children does not read the graph for each. */
function drivenTransforms(state: DagState): ReadonlyMap<NodeId, string> {
  const hit = drivenMemo.get(state.nodes);
  if (hit) return hit;
  const out = new Map<NodeId, string>();
  for (const node of Object.values(state.nodes)) {
    const p = (node.params ?? {}) as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (typeof p.target !== 'string' || out.has(p.target)) continue;
    const path = typeof p.paramPath === 'string' ? p.paramPath.split('.')[0] : '';
    if (isKeyframeChannelNode(node)) {
      if (TRANSFORM_PATHS.has(path) && Array.isArray(p.keyframes) && p.keyframes.length > 0)
        out.set(p.target, 'animated');
    } else if (node.type === 'ParamDriver') {
      if (TRANSFORM_PATHS.has(path)) out.set(p.target, 'driven');
    } else if (node.type === 'Strip') {
      out.set(p.target, 'animated');
    }
  }
  drivenMemo.set(state.nodes, out);
  return out;
}

/** The largest world-matrix entry two matrices differ by, relative to their size. */
function matrixGap(a: THREE.Matrix4, b: THREE.Matrix4): number {
  const size = Math.max(1, ...b.elements.map(Math.abs));
  let gap = 0;
  for (let i = 0; i < 16; i++) gap = Math.max(gap, Math.abs(a.elements[i] - b.elements[i]) / size);
  return gap;
}

export type KeepResult =
  | { readonly ok: true; readonly ops: Op[]; readonly residual: number }
  | { readonly ok: false; readonly reason: string; readonly driven?: string };

/**
 * The setParams that keep `childId` where it is drawn when the world it hangs from changes from
 * `fromParent` to `toParent`. Empty when the two are the same. `verb` opens a refusal.
 */
export function keepWorldOps(
  state: DagState,
  childId: NodeId,
  fromParent: THREE.Matrix4,
  toParent: THREE.Matrix4,
  verb: string,
): KeepResult {
  const change = toParent.clone().invert().multiply(fromParent);
  if (matrixGap(change, new THREE.Matrix4()) <= 1e-9) return { ok: true, ops: [], residual: 0 };
  const child = state.nodes[childId];
  if (!child) return { ok: true, ops: [], residual: 0 };
  const name = nodeDisplayName(state.nodes, childId);
  // #1848 — a constraint is not on this list. It works from the object's own world, the world this
  // keeps, so what it draws stays put too: a Follow Path adds the path to it, as Blender's does.
  const driven = drivenTransforms(state).get(childId);
  if (driven) {
    return {
      ok: false,
      driven,
      reason: `${verb}: "${name}" is ${driven}, and its keys are relative to its parent, so keeping it in place would move it again on the next frame. Alt-drag it in the outliner to move it with its values as they are.`,
    };
  }
  const def = getNodeType(child.type);
  const fields = def ? paramFieldsOf(def) : null;
  const writable = (path: string) => !!fields && path in fields;
  const p = child.params as Partial<{ position: Vec3; rotation: Vec3; scale: Vec3 }> &
    RotationModeFields;
  if (!writable('position') || !writable('rotation')) {
    return {
      ok: false,
      reason: `${verb}: "${name}" has no transform of its own to keep it in place.`,
    };
  }
  const pos0 = isVec3(p.position) ? p.position : ([0, 0, 0] as Vec3);
  const rot0 = isVec3(p.rotation) ? p.rotation : ([0, 0, 0] as Vec3);
  const scl0 = writable('scale') && isVec3(p.scale) ? p.scale : ([1, 1, 1] as Vec3);
  const q0 =
    p.rotationMode === 'quaternion' && p.quaternion
      ? new THREE.Quaternion(...(p.quaternion as Quat))
      : new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rot0[0] * D2R, rot0[1] * D2R, rot0[2] * D2R, 'XYZ'),
        );
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos0),
    q0,
    new THREE.Vector3(...scl0),
  );
  const target = change.multiply(local);
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  target.decompose(pos, rot, scl);
  // A node with no scale of its own (a camera) is drawn at scale 1; what it would need is residual.
  if (!writable('scale')) scl.set(1, 1, 1);
  const residual = matrixGap(new THREE.Matrix4().compose(pos, rot, scl), target);
  // Through the one quaternion→Euler door (#876), then the one rotation write route (#1153).
  const e = quaternionToEulerVec3(rot);
  const write = rotationWriteOf(p, [e[0] / D2R, e[1] / D2R, e[2] / D2R]);
  const ops: Op[] = [
    { type: 'setParam', nodeId: childId, paramPath: 'position', value: pos.toArray() },
    { type: 'setParam', nodeId: childId, paramPath: write.paramPath, value: write.value },
  ];
  if (writable('scale'))
    ops.push({ type: 'setParam', nodeId: childId, paramPath: 'scale', value: scl.toArray() });
  return { ok: true, ops, residual };
}

/** One child's move: the wires it leaves, and the holder it joins. */
export interface ChildMove {
  readonly childId: NodeId;
  readonly from: readonly HolderEdge[];
  readonly to: NodeId;
}

/**
 * The world a child hangs from once it joins `move.to`, read off the graph the rewire makes, by the
 * one resolver the renderer agrees with, so a holder's pivot cannot compose differently from how it
 * is drawn. The top of the scene is the identity. Solved once per holder: every child joining one
 * hangs from the same world, and each probe copies the node table. Null when the graph refuses the
 * rewire.
 */
function worldUnder(
  state: DagState,
  move: ChildMove,
  rewire: readonly Op[],
  sceneId: NodeId | null,
  solved: Map<NodeId, THREE.Matrix4>,
  parentWorldOf: (state: DagState, childId: NodeId) => THREE.Matrix4,
): THREE.Matrix4 | null {
  if (move.to === sceneId) return new THREE.Matrix4();
  const hit = solved.get(move.to);
  if (hit) return hit;
  // Appended without an index: the probe applies this one move alone, so an index counted across
  // the whole batch could point past the end of the list.
  const probe = rewire.map((op): Op => {
    return op.type === 'connect' ? { type: 'connect', from: op.from, to: op.to } : op;
  });
  let rewired: DagState;
  try {
    rewired = applyOps(state, probe).next;
  } catch {
    return null;
  }
  const world = parentWorldOf(rewired, move.childId);
  solved.set(move.to, world);
  return world;
}

export type MoveResult =
  | {
      readonly ok: true;
      readonly ops: Op[];
      /** Children a T·R·S could not keep exactly in place (shear), with how far they miss. */
      readonly residuals: ReadonlyArray<{ readonly childId: NodeId; readonly residual: number }>;
      /** Children `drivenChildren: 'move'` let move: animated, so their values were left alone. */
      readonly unkept?: ReadonlyArray<{ readonly childId: NodeId; readonly driven: string }>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The ops for every move in `moves`, as one batch: each child leaves its `from` wires, joins `to`
 * at the end of the socket that takes it, and (unless `keepTransform` is false) has its own
 * transform rewritten so it stays where it is drawn at `ctx`. Every move is solved on `state`
 * as given, so moving a parent and its child together keeps both. Refused whole when any one
 * child cannot be kept in place, except that `drivenChildren: 'move'` rewires an animated child
 * with its values as they are and lists it in `unkept`.
 */
export function buildMoveOps(
  state: DagState,
  moves: readonly ChildMove[],
  opts: {
    readonly keepTransform?: boolean;
    readonly ctx?: ClockedCtx;
    readonly verb: string;
    readonly drivenChildren?: 'refuse' | 'move';
  },
): MoveResult {
  const keep = opts.keepTransform !== false;
  const ctx = opts.ctx ?? liveCtx();
  const ops: Op[] = [];
  const residuals: { childId: NodeId; residual: number }[] = [];
  const unkept: { childId: NodeId; driven: string }[] = [];
  const appended = new Map<string, number>();
  const sceneId = sceneIdOf(state);
  const afterWorlds = new Map<NodeId, THREE.Matrix4>();
  // One gesture, one cache, and one read per holder: resolving a child means evaluating its parent,
  // whose value holds every sibling, so a read per child costs the square of a big group.
  const cache = createEvaluatorCache();
  // #1854 — as drawn: an aimed or following holder counts with its constraint.
  const parentWorldOf = (from: DagState, childId: NodeId): THREE.Matrix4 =>
    resolveDrawnParentWorldMatrix(from, childId, ctx, cache) ?? new THREE.Matrix4();
  const beforeWorlds = new Map<NodeId, THREE.Matrix4>();
  for (const move of moves) {
    const socket = receivingSocket(state, move.to, move.childId);
    if (socket === null) {
      return {
        ok: false,
        reason: `${opts.verb}: "${nodeDisplayName(state.nodes, move.to)}" cannot hold "${nodeDisplayName(state.nodes, move.childId)}".`,
      };
    }
    // #1823 — a membership wire (the scene's own list, a collection's members) is not a parent:
    // a move leaves it as it is. A light's place in the scene's `lights` band is cut, as it moves
    // into the tree.
    const rewire: Op[] = move.from
      .filter((edge) => !isMembershipEdge(state, edge))
      .map((edge) => detachOp(move.childId, edge, state));
    // #1823 — the scene's own list is membership, not a parent. Leaving every parent for the scene
    // only cuts the parent edge when the scene already lists the child.
    const sceneListed =
      move.to === sceneId &&
      socket === 'children' &&
      refsOf(state.nodes[sceneId]?.inputs?.children).some((r) => r?.node === move.childId);
    // A light going back on the scene's `lights` leaves the list it joined when it was hung: the band
    // draws what is on `lights`, the tree what the list names, and both would draw it.
    if (
      move.to === sceneId &&
      socket === 'lights' &&
      refsOf(state.nodes[sceneId]?.inputs?.children).some((r) => r?.node === move.childId)
    ) {
      rewire.push({
        type: 'disconnect',
        from: { node: move.childId, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      });
    }
    // #1842 — a light leaving its parent for the scene keeps the band that already draws it: back
    // on the scene's list as well, a rig light would be drawn twice and outlive its profile.
    const staysOnBand =
      move.to === sceneId &&
      socket === 'lights' &&
      (refsOf(state.nodes[sceneId]?.inputs?.lights).some((r) => r?.node === move.childId) ||
        Object.values(state.nodes).some(
          (n) =>
            n.type === 'LightRig' && refsOf(n.inputs.lights).some((r) => r?.node === move.childId),
        ));
    if (sceneListed || staysOnBand) {
      // Nothing to attach.
    } else if (attachesByParentInput(state, move.to, socket, move.childId)) {
      rewire.push(attachOp(state, move.childId, move.to, socket));
      // Hanging is not membership: a child that leaves the scene's lists on the way (a light out of
      // its `lights`), or was in none, joins the scene's own list so it is still drawn.
      const leavesScene = move.from.some((e) => e.node === sceneId && e.socket === 'lights');
      const listed = refsOf(state.nodes[sceneId ?? '']?.inputs?.children).some(
        (r) => r?.node === move.childId,
      );
      if (sceneId && !listed && (leavesScene || !isInScene(state, move.childId))) {
        rewire.push({
          type: 'connect',
          from: { node: move.childId, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        });
      }
    } else {
      const key = `${move.to}\u0000${socket}`;
      const list = state.nodes[move.to]?.inputs?.[socket];
      const base = Array.isArray(list) ? list.length : 0;
      const n = appended.get(key) ?? 0;
      appended.set(key, n + 1);
      rewire.push(attachOp(state, move.childId, move.to, socket, base + n));
    }
    // A bone it hung from belongs to the parent it is leaving (Blender's Clear Parent clears both).
    if ((state.nodes[move.childId]?.params as { parentBone?: unknown })?.parentBone !== undefined) {
      rewire.push({
        type: 'setParam',
        nodeId: move.childId,
        paramPath: 'parentBone',
        value: undefined,
      });
    }
    ops.push(...rewire);
    if (!keep) continue;
    // A child on a bone hangs from that bone, not from its holder alone, so it reads for itself.
    const holder = move.from[0]?.node;
    const onBone =
      (state.nodes[move.childId]?.params as { parentBone?: unknown } | undefined)?.parentBone !==
      undefined;
    let before = holder && !onBone ? beforeWorlds.get(holder) : undefined;
    if (!before) {
      before = parentWorldOf(state, move.childId);
      if (holder && !onBone) beforeWorlds.set(holder, before);
    }
    const after = worldUnder(state, move, rewire, sceneId, afterWorlds, parentWorldOf);
    if (!after) {
      return {
        ok: false,
        reason: `${opts.verb}: "${nodeDisplayName(state.nodes, move.to)}" cannot hold "${nodeDisplayName(state.nodes, move.childId)}".`,
      };
    }
    const kept = keepWorldOps(state, move.childId, before, after, opts.verb);
    if (!kept.ok) {
      if (!kept.driven || opts.drivenChildren !== 'move') return kept;
      unkept.push({ childId: move.childId, driven: kept.driven });
      continue;
    }
    ops.push(...kept.ops);
    if (kept.residual > RESIDUAL_TOLERANCE)
      residuals.push({ childId: move.childId, residual: kept.residual });
  }
  return { ok: true, ops, residuals, unkept };
}

/** A sentence for children kept in place only as nearly as a T·R·S allows, or null. */
export function residualNotice(
  state: DagState,
  residuals: ReadonlyArray<{ readonly childId: NodeId; readonly residual: number }>,
): string | null {
  if (residuals.length === 0) return null;
  const names = residuals.map((r) => `"${nodeDisplayName(state.nodes, r.childId)}"`).join(', ');
  const worst = Math.max(...residuals.map((r) => r.residual));
  return `${names} kept its place as nearly as a position, rotation and scale can: its old parent's non-uniform scale sheared it, which they cannot hold (off by up to ${worst.toPrecision(2)}).`;
}

/** What a successful move should tell the director: a shear it could not hold, a child it moved. */
export function moveNotices(state: DagState, result: Extract<MoveResult, { ok: true }>): string[] {
  const notices: string[] = [];
  const sheared = residualNotice(state, result.residuals);
  if (sheared) notices.push(sheared);
  if (result.unkept?.length) {
    const names = result.unkept
      .map((u) => `"${nodeDisplayName(state.nodes, u.childId)}" (${u.driven})`)
      .join(', ');
    notices.push(
      `Delete moved ${names}: what moves them is relative to the parent that went. Undo brings everything back.`,
    );
  }
  return notices;
}

/**
 * Ctrl+P — parent `childIds` to `parentId`, keeping each where it is drawn (Blender's Object (Keep
 * Transform)). A child already under `parentId`, `parentId` itself, and a node the scene tree does
 * not move are left out; a child that `parentId` hangs below would make a loop and is refused.
 */
export function buildParentToOps(
  state: DagState,
  childIds: readonly NodeId[],
  parentId: NodeId,
  opts: { readonly keepTransform?: boolean; readonly ctx?: ClockedCtx } = {},
): MoveResult {
  const verb = 'Parent';
  if (receivingSocket(state, parentId, parentId) === null || parentId === sceneIdOf(state)) {
    return {
      ok: false,
      reason: `${verb}: "${nodeDisplayName(state.nodes, parentId)}" cannot hold children. Make a group or a mesh object the active one.`,
    };
  }
  const moves: ChildMove[] = [];
  for (const childId of childIds) {
    if (childId === parentId) continue;
    const from = movableHolderEdges(state, childId);
    const isCamera = isCameraNode(state, childId);
    // #1823 — an object at the top of the scene has no holder (the scene's list is membership, not
    // a parent); one that is neither held nor in the scene is not something the tree moves.
    if (from.length === 0 && !isCamera && !isInScene(state, childId)) continue;
    if (from.some((e) => e.node === parentId)) continue;
    if (isAtOrBelow(state, parentId, childId)) {
      return {
        ok: false,
        reason: `${verb}: "${nodeDisplayName(state.nodes, parentId)}" is inside "${nodeDisplayName(state.nodes, childId)}", so it cannot be its parent.`,
      };
    }
    moves.push({ childId, from, to: parentId });
  }
  if (moves.length === 0) return { ok: true, ops: [], residuals: [] };
  return buildMoveOps(state, moves, { ...opts, verb });
}

/**
 * Alt+P — clear the parent of `childIds`, keeping each where it is drawn (Blender's Clear and Keep
 * Transformation). A node already at the top of the scene is left alone.
 */
export function buildClearParentOps(
  state: DagState,
  childIds: readonly NodeId[],
  opts: { readonly keepTransform?: boolean; readonly ctx?: ClockedCtx } = {},
): MoveResult {
  const sceneId = sceneIdOf(state);
  if (!sceneId) return { ok: true, ops: [], residuals: [] };
  const moves: ChildMove[] = [];
  for (const childId of childIds) {
    const from = movableHolderEdges(state, childId);
    if (from.length === 0 || from.every((e) => e.node === sceneId)) continue;
    moves.push({ childId, from: from.filter((e) => e.node !== sceneId), to: sceneId });
  }
  if (moves.length === 0) return { ok: true, ops: [], residuals: [] };
  return buildMoveOps(state, moves, { ...opts, verb: 'Clear Parent' });
}
