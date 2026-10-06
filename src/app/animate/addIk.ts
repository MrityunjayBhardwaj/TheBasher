// Add › IK on a selected bone (#1510): one gesture sets up a two-bone chain, its goal and its pole.
//
// The selected bone is the chain's TIP joint; its parent is the mid joint and its grandparent the root
// (a Basher bone is a joint, so "the forearm's IK" is the hand's head reaching a goal). What is made:
//
//   - a GOAL control bone, a root, where the tip is DRAWN at the playhead, turned as the tip is drawn
//     — or an existing bone the caller names (Blender's "To Active Bone");
//   - a POLE control bone, a root, in front of the mid joint on the bend's side;
//   - an `ik` pose layer on top of the Object's chain (the solve reads every FK layer under it), with
//     root / mid / tip / goal / pole filled in and blend 1.
//
// Both control bones are roots, so the chain's FK never carries them, and neither has a vertex group,
// so the skin ignores them. A new goal starts where the tip is drawn, as Blender's new target starts at
// the tip's `pose_tail` (`object_constraint.cc` `get_new_constraint_target`, `:2324`), so adding the IK
// is not itself a pose: the solve reproduces the drawn chain.
//
// THE POLE. Rigify's limb places it at the elbow plus `compute_elbow_vector` (`limb_rigs.py:118-122,
// 404`): the part of the lower bone at right angles to the root→tip line, pointed away from that line
// and as long as it. Rigify then picks the pole angle from its rig's fixed bone axes (±90°,
// `compute_pole_angle`); a Basher joint can face any way, so the angle is solved instead: the one that
// makes the solver's aim (`twoBoneIk.ts`, Blender's `ConstrainPoleVector`) the identity on the drawn
// pose, so the elbow does not move on creation.
//
// THE CHAIN LENGTH is two, always: the solver is two-bone. Blender's Shift+I defaults to 0, "to the
// root" (`pose_ik_add_invoke`, `:2618`), which on a character bends the spine; not copied.
//
// REF: ref/sources/blender-pose-ik-v5.1.1/editors_object_object_constraint.cc (pose_ik_add_invoke,
//      get_new_constraint_target); scripts_addons_core_rigify_rigs_limbs_limb_rigs.py
//      (compute_elbow_vector); src/nodes/twoBoneIk.ts (the solve); issue #1510.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { evaluate } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { eulerXYZFromQuat, quatFromEulerXYZ } from '../../nodes/bonePose';
import { poseLayerIkProblem, type PoseLayerIk, type PoseLayerParams } from '../../nodes/PoseLayer';
import type { BonePose, BoneSpec, PosedSkeletonValue } from '../../nodes/types';
import { posedWorldMatrices } from '../../viewport/boneShape';
import { applySkeletonEdit } from './editSkeleton';
import { poseLayerChain } from './poseChain';
import { rigReach } from './renameBone';

export interface AddIkRequest {
  /** The armature Object. */
  readonly object: string;
  /** The tip joint: the bone whose head reaches the goal. */
  readonly bone: string;
  /** An existing bone to reach for; absent, a new goal bone is made where the tip is drawn. */
  readonly goal?: string;
  /** The playhead: the drawn pose the new control bones are placed against. */
  readonly seconds: number;
}

export type AddIkPlan =
  | {
      readonly ok: true;
      readonly skeletonId: string;
      /** The skeleton's bones with the new control bones at the end. */
      readonly bones: BoneSpec[];
      readonly layerId: string;
      readonly layer: Pick<PoseLayerParams, 'name' | 'mode' | 'weight'> & { ik: PoseLayerIk };
      /** The new bones' names, in the order made. */
      readonly added: readonly string[];
      /** What feeds the Object's pose now, which the new layer reads. */
      readonly feed: { readonly node: string; readonly socket: string } | null;
    }
  | { readonly ok: false; readonly reason: string };

const FRAME_0 = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;
const EPS = 1e-9;

/** The id of the ik layer Add › IK makes for `tip` on `objectId`. */
export function ikLayerIdFor(objectId: string, tip: string): string {
  return `${objectId}_ik_${tip}`;
}

const head = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const column = (m: Matrix4, i: 0 | 2) => {
  const e = m.elements;
  return new Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]).normalize();
};

/**
 * The pole angle (degrees) that makes the solver's aim the identity: the root's `X·cos a + Z·sin a`
 * points, across the root→tip line `dir`, the way the pole does (`u`, at right angles to `dir`). The
 * solver's look-at frame keeps only that across-the-line part of its up vector, so this is the whole
 * condition. Null when the root's X and Z both lie along `dir`'s plane with `u` (cannot happen for an
 * orthonormal root, kept for a degenerate scale).
 */
export function poleAngleFacing(root: Matrix4, dir: Vector3, u: Vector3): number | null {
  const x = column(root, 0);
  const z = column(root, 2);
  // (up × u)·dir = 0 picks the angle up to a half turn; up·u > 0 picks the half.
  const px = new Vector3().crossVectors(x, u).dot(dir);
  const pz = new Vector3().crossVectors(z, u).dot(dir);
  const len = Math.hypot(px, pz);
  if (len < EPS) return null;
  let c = pz / len;
  let s = -px / len;
  if (c * x.dot(u) + s * z.dot(u) < 0) {
    c = -c;
    s = -s;
  }
  return (Math.atan2(s, c) * 180) / Math.PI;
}

/** The pose the Object draws at `seconds`, by bone name — what feeds its `pose` input. */
function drawnPose(
  state: DagState,
  feed: { node: string; socket: string } | null,
  seconds: number,
): { bones: readonly BoneSpec[]; pose: readonly BonePose[] } | null {
  if (!feed) return null;
  const value = evaluate(state, feed.node, { ctx: FRAME_0, socket: feed.socket }).value as
    | PosedSkeletonValue
    | undefined;
  if (!value || value.kind !== 'PosedSkeleton') return null;
  return { bones: value.skeleton.bones, pose: value.sample(seconds) };
}

/** Plan Add › IK, or say by name why it cannot be added. Pure over `state`. */
export function planAddIk(state: DagState, req: AddIkRequest): AddIkPlan {
  const reach = rigReach(state, req.object);
  if (!reach) {
    return {
      ok: false,
      reason: `"${req.object}" is not an armature Object (an Object whose data is a Skeleton).`,
    };
  }
  const skeletonId = reach.skeleton;
  const bones = ((state.nodes[skeletonId].params as { bones?: BoneSpec[] }).bones ??
    []) as BoneSpec[];
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const t = index.get(req.bone);
  if (t === undefined) return { ok: false, reason: `this armature has no bone "${req.bone}".` };
  const m = bones[t].parent;
  if (m < 0) {
    return {
      ok: false,
      reason: `"${req.bone}" has no parent, so there is no chain for an IK to bend: select the joint the chain reaches with (a hand, not a shoulder).`,
    };
  }
  const r = bones[m].parent;
  if (r < 0) {
    return {
      ok: false,
      reason: `"${bones[m].name}", the parent of "${req.bone}", has no parent: a two-bone IK needs two bones above the tip.`,
    };
  }
  const [root, mid, tip] = [bones[r].name, bones[m].name, req.bone];

  // One solve per joint: a second ik layer over the same joints would fight the first.
  const { layers } = poseLayerChain(state.nodes, req.object);
  for (const id of layers) {
    const params = state.nodes[id].params as Partial<PoseLayerParams>;
    const ik = params.mode === 'ik' ? params.ik : undefined;
    if (!ik) continue;
    const name = params.name ?? id;
    if (ik.tip === tip)
      return { ok: false, reason: `"${tip}" already has an IK (layer "${name}").` };
    const shared = [root, mid].find((j) => j === ik.root || j === ik.mid);
    if (shared) {
      return {
        ok: false,
        reason: `"${shared}" is already solved by the IK layer "${name}"; a second IK over it would fight the first.`,
      };
    }
  }
  const layerId = ikLayerIdFor(req.object, tip);
  if (state.nodes[layerId]) {
    return {
      ok: false,
      reason: `the node "${layerId}" already exists; remove it to add the IK again.`,
    };
  }
  if (req.goal !== undefined) {
    if (!index.has(req.goal))
      return { ok: false, reason: `this armature has no bone "${req.goal}".` };
    if ([root, mid, tip].includes(req.goal)) {
      return {
        ok: false,
        reason: `the goal "${req.goal}" is a joint of the chain it would steer.`,
      };
    }
  }

  // The chain as drawn at the playhead, in the armature's space.
  const feed =
    (state.nodes[req.object].inputs?.pose as { node: string; socket?: string } | undefined) ?? null;
  const feedEnd = feed ? { node: feed.node, socket: feed.socket ?? 'out' } : null;
  const drawn = drawnPose(state, feedEnd, req.seconds);
  const byName = new Map<string, BonePose>();
  if (drawn) drawn.bones.forEach((b, i) => drawn.pose[i] && byName.set(b.name, drawn.pose[i]));
  const pose: BonePose[] = bones.map(
    (b) =>
      byName.get(b.name) ?? {
        name: b.name,
        position: b.position,
        quaternion: quatFromEulerXYZ(b.rotation),
        scale: b.scale ?? [1, 1, 1],
      },
  );
  let world = posedWorldMatrices(bones, pose);
  const C = head(world[t]);
  const tipTurn = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(world[t]));

  // The bend's side. A straight chain has none; the solver bends it by the mid joint's preferred
  // angle (#1340), and so does this.
  const elbowOf = () => {
    const [A, B, Ct] = [head(world[r]), head(world[m]), head(world[t])];
    const lo = Ct.clone().sub(B);
    const tot = Ct.clone().sub(A);
    const across = lo.clone().projectOnVector(tot).sub(lo);
    return { A, B, tot, across, lo };
  };
  let elbow = elbowOf();
  const straight = () => elbow.across.length() <= 1e-6 * Math.max(elbow.lo.length(), EPS);
  if (straight() && bones[m].preferredAngle) {
    const bent = pose.slice();
    bent[m] = { ...pose[m], quaternion: quatFromEulerXYZ(bones[m].preferredAngle!) };
    world = posedWorldMatrices(bones, bent);
    elbow = elbowOf();
  }
  if (elbow.tot.length() < EPS || elbow.lo.length() < EPS) {
    return { ok: false, reason: `the chain ${root} → ${mid} → ${tip} has a bone of no length.` };
  }
  if (straight()) {
    return {
      ok: false,
      reason: `the chain ${root} → ${mid} → ${tip} is straight, so it has no side to bend toward: give "${mid}" a preferred angle (Edit mode) first.`,
    };
  }
  const across = elbow.across.normalize();
  const P = elbow.B.clone().add(across.clone().multiplyScalar(elbow.tot.length()));
  const poleAngle = poleAngleFacing(world[r], elbow.tot.clone().normalize(), across);
  if (poleAngle === null) {
    return { ok: false, reason: `"${root}" has no axis across the chain to face the pole with.` };
  }

  // The control bones, through Edit mode's own operations.
  const added: string[] = [];
  let next = bones;
  let goal = req.goal;
  if (goal === undefined) {
    const made = applySkeletonEdit(next, {
      op: 'add',
      parent: null,
      position: [C.x, C.y, C.z],
      name: `${tip}_ik_goal`,
    });
    if (!made.ok) return made;
    goal = made.added[0];
    const turned = applySkeletonEdit(made.bones, {
      op: 'transform',
      bone: goal,
      rotation: eulerXYZFromQuat([tipTurn.x, tipTurn.y, tipTurn.z, tipTurn.w]),
      children: 'follow',
    });
    if (!turned.ok) return turned;
    next = turned.bones;
    added.push(goal);
  }
  const pole = applySkeletonEdit(next, {
    op: 'add',
    parent: null,
    position: [P.x, P.y, P.z],
    name: `${tip}_ik_pole`,
  });
  if (!pole.ok) return pole;
  next = pole.bones;
  added.push(pole.added[0]);

  const ik: PoseLayerIk = {
    root,
    mid,
    tip,
    goal,
    pole: pole.added[0],
    poleAngle,
    stretch: false,
    orientTip: false,
  };
  // The existing-goal road can name a bone the chain carries; say so here, not by a silent layer.
  const problem = poseLayerIkProblem({ mode: 'ik', ik }, { kind: 'Skeleton', bones: next });
  if (problem) return { ok: false, reason: problem };
  return {
    ok: true,
    skeletonId,
    bones: next,
    layerId,
    layer: { name: `${tip} IK`, mode: 'ik', weight: 1, ik },
    added,
    feed: feedEnd,
  };
}

/** The ops of a plan: the skeleton's bones, then the ik layer spliced in under the Object. */
export function addIkOps(objectId: string, plan: Extract<AddIkPlan, { ok: true }>): Op[] {
  return [
    { type: 'setParam', nodeId: plan.skeletonId, paramPath: 'bones', value: plan.bones },
    { type: 'addNode', nodeId: plan.layerId, nodeType: 'PoseLayer', params: plan.layer },
    ...(plan.feed
      ? [{ type: 'connect' as const, from: plan.feed, to: { node: plan.layerId, socket: 'pose' } }]
      : []),
    {
      type: 'connect',
      from: { node: plan.layerId, socket: 'out' },
      to: { node: objectId, socket: 'pose' },
      replace: true,
    },
  ];
}
