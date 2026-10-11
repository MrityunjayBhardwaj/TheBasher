// Two-bone IK over a posed skeleton (#1343): the solve an `ik` pose layer runs.
//
// The chain is three joints — root, mid, tip — each the parent of the next, and the tip reaches the
// GOAL, a bone of the same skeleton (a control bone). Everything happens in armature space on the
// pose that arrives under the layer, so a goal animated by the layers below moves the solve, and
// nothing outside the skeleton is read.
//
// It follows Blender's standard IK solver for a chain of two (`chain_count` 2, `use_tail`), in its
// two phases (`IK_QJacobianSolver.cpp` `Solve`: `ConstrainPoleVector` ONCE, before iterating, `:305`,
// its turn then prepended to the root's basis, `:362-364`; the function's comment says "before and
// after", but its second call, `:226`, runs only while it measures a pole angle):
//
//   1. aim (with a pole only): turn the chain rigidly about its root so the "look-at" frame built from the
//      root→tip direction and the root bone's up axis matches the one built from the root→goal
//      direction and the root→pole direction (`polemat^T · mat`, `:191-245`). The up axis is the
//      root bone's `X·cos a + Z·sin a` for pole angle `a`.
//      Without a pole nothing turns here. Houdini's rule decides the bend instead: the mid joint's
//      arriving position is the pole ("If you leave this blank, the solver uses the position of the
//      joint specified in Mid Name as the pole vector", IK Chains / Two Bone IK). Blender has no rule
//      to match — its solver iterates from the arriving pose and its answer depends on that path
//      (measured: its no-pole elbow is 0.29 off the root–goal–elbow plane).
//   2. bend: in the aimed triangle's plane (with a pole) or the root–goal–arriving-elbow plane
//      (without), turn the root about the plane's normal and the mid joint by the shortest turn that
//      puts the tip on the goal — both the least twist that reaches (measured: turning the whole chain
//      about the goal line to face the elbow instead twisted a skinned bar's root 162° and showed its
//      back face). Out of
//      reach, the chain points straight at it; with stretch, both bones scale uniformly by the ratio
//      instead, as Blender scales a stretching bone's whole basis (`iksolver_plugin.cc:543-561`).
//
// Blender's solver is iterative and stops about 1e-4 short of the goal; this one is closed-form and
// exact. A straight chain has no bend plane: the mid joint's `preferredAngle` (Maya's joint
// preferred angle, #1340) bends it first, when it has one.
//
// #1344 — a joint with limits stops at them (`heldAtLimits`, below), and the tip falls short.
//
// REF: ref/sources/blender-pose-ik-v5.1.1/intern_iksolver_IK_QJacobianSolver.cpp (pole);
//      ikplugin_intern_iksolver_plugin.cc (chain, stretch); issue #1343.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { posedWorldMatrices } from '../viewport/boneShape';
import { quatFromEulerXYZ } from './bonePose';
import { clampToLimits } from './jointLimits';
import type { BonePose, BoneSpec, Quat, Vec3 } from './types';

/** One chain: joint names in the skeleton, and how it reaches. */
export interface IkChain {
  readonly root: string;
  readonly mid: string;
  readonly tip: string;
  /** The control bone the tip reaches. */
  readonly goal: string;
  /** The control bone the bend faces, or absent: the bend plane the pose arrives in. */
  readonly pole?: string;
  /** Degrees. Turns which root axis faces the pole: X at 0, Z at 90 (Blender's pole angle). */
  readonly poleAngle: number;
  /** Scale both bones to reach a goal past the chain's length. */
  readonly stretch: boolean;
  /** Give the tip the goal's rotation (Houdini's Orient Tip, Blender's IK Rotation). */
  readonly orientTip: boolean;
}

const EPS = 1e-9;
const DEG = Math.PI / 180;

/** Why `chain` cannot solve on `bones`, or null when it can. */
export function ikChainProblem(bones: readonly BoneSpec[], chain: IkChain): string | null {
  const index = new Map(bones.map((b, i) => [b.name, i]));
  for (const [role, name] of [
    ['root', chain.root],
    ['mid', chain.mid],
    ['tip', chain.tip],
    ['goal', chain.goal],
    ...(chain.pole !== undefined ? [['pole', chain.pole]] : []),
  ] as const) {
    if (!index.has(name)) return `the ${role} bone "${name}" is not on this skeleton`;
  }
  const r = index.get(chain.root)!;
  const m = index.get(chain.mid)!;
  const t = index.get(chain.tip)!;
  if (bones[m].parent !== r) return `"${chain.mid}" is not a child of "${chain.root}"`;
  if (bones[t].parent !== m) return `"${chain.tip}" is not a child of "${chain.mid}"`;
  // A control the chain carries would chase itself: it moves with the solve it steers.
  const underRoot = (i: number) => {
    for (let at = i, hops = 0; at >= 0 && hops <= bones.length; at = bones[at].parent, hops++) {
      if (at === r) return true;
    }
    return false;
  };
  if (underRoot(index.get(chain.goal)!)) {
    return `the goal "${chain.goal}" moves with the chain (it is "${chain.root}" or under it)`;
  }
  if (chain.pole !== undefined && underRoot(index.get(chain.pole)!)) {
    return `the pole "${chain.pole}" moves with the chain (it is "${chain.root}" or under it)`;
  }
  return null;
}

const head = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const axis = (m: Matrix4, i: 0 | 2) => {
  const e = m.elements;
  return new Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]).normalize();
};
/** A turn about `point`, as a matrix applied on the left of a world matrix. */
const about = (point: Vector3, turn: Matrix4) =>
  new Matrix4()
    .makeTranslation(point.x, point.y, point.z)
    .multiply(turn)
    .multiply(new Matrix4().makeTranslation(-point.x, -point.y, -point.z));
/** The signed angle from `u` to `v` about `n`. */
const signedAngle = (u: Vector3, v: Vector3, n: Vector3) =>
  Math.atan2(n.dot(new Vector3().crossVectors(u, v)), u.dot(v));

/** Blender's look-at frame (`ConstrainPoleVector`): rows x = dir × up, y = x × dir, z = −dir. */
function lookAt(dir: Vector3, up: Vector3): Matrix4 | null {
  const x = new Vector3().crossVectors(dir, up);
  if (x.lengthSq() < EPS) return null;
  x.normalize();
  const y = new Vector3().crossVectors(x, dir);
  const z = dir.clone().negate();
  // Rows of the frame = columns of its transpose.
  return new Matrix4().makeBasis(x, y, z).transpose();
}

/** The turn taking the frame (dirA, upA) onto (dirB, upB), or null when either is degenerate. */
function frameTurn(dirA: Vector3, upA: Vector3, dirB: Vector3, upB: Vector3): Matrix4 | null {
  const a = lookAt(dirA, upA);
  const b = lookAt(dirB, upB);
  return a && b ? b.transpose().multiply(a) : null;
}

/**
 * The pose with the chain solved toward its goal: the root's and mid's local transforms replaced
 * (and the tip's, with `orientTip`), every other bone as it arrived. Null when the chain cannot
 * solve (`ikChainProblem`) or a bone has no length.
 */
export function solveTwoBoneIk(
  bones: readonly BoneSpec[],
  pose: readonly BonePose[],
  chain: IkChain,
): BonePose[] | null {
  if (ikChainProblem(bones, chain) !== null) return null;
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const r = index.get(chain.root)!;
  const m = index.get(chain.mid)!;
  const t = index.get(chain.tip)!;
  let start = pose;
  let world = posedWorldMatrices(bones, start);

  const A = head(world[r]);
  const l1 = head(world[m]).distanceTo(A);
  const l2 = head(world[t]).distanceTo(head(world[m]));
  if (l1 < EPS || l2 < EPS) return null;

  // A straight chain has no plane to bend in: start from the mid joint's preferred angle.
  const bent = () =>
    new Vector3().crossVectors(head(world[m]).sub(A), head(world[t]).sub(head(world[m]))).length() >
    1e-7 * l1 * l2;
  const preferred = bones[m].preferredAngle;
  if (!bent() && preferred) {
    const bentStart = pose.slice();
    bentStart[m] = { ...pose[m], quaternion: quatFromEulerXYZ(preferred) };
    start = bentStart;
    world = posedWorldMatrices(bones, start);
  }

  const G = head(world[index.get(chain.goal)!]);
  const P = chain.pole !== undefined ? head(world[index.get(chain.pole)!]) : null;
  const toGoal = G.clone().sub(A);
  const d = toGoal.length();
  if (d < EPS) return null;
  const e = toGoal.clone().normalize();
  const a = chain.poleAngle * DEG;
  const upOf = (root: Matrix4) =>
    axis(root, 0)
      .multiplyScalar(Math.cos(a))
      .add(axis(root, 2).multiplyScalar(Math.sin(a)));

  // The three joints' world matrices, moved together.
  const W = [world[r].clone(), world[m].clone(), world[t].clone()];
  const apply = (delta: Matrix4, from: number) => {
    for (let k = from; k < 3; k++) W[k] = delta.clone().multiply(W[k]);
  };

  // 1. Aim, with a pole only (Blender's frame turn). Without one nothing turns yet: the bend below
  //    happens in the plane of root, goal and arriving elbow, which keeps the root's twist.
  if (P) {
    const tipDir = head(W[2]).sub(A).normalize();
    const aim = frameTurn(tipDir, upOf(W[0]), e, P.clone().sub(A).normalize());
    if (aim) apply(about(A, aim), 0);
  }

  // 2. Bend. The plane: with a pole, the aimed triangle's, which holds the goal line; without one,
  //    root–goal–arriving elbow (the elbow is the pole, Houdini). The root turns about its normal —
  //    the shortest turn, since the elbow already lies in it — and the mid joint by the shortest turn
  //    that puts the tip on the goal.
  const B1 = head(W[1]);
  const C1 = head(W[2]);
  let n = P
    ? new Vector3().crossVectors(B1.clone().sub(A), C1.clone().sub(A))
    : new Vector3().crossVectors(B1.clone().sub(A), e);
  // The elbow on the goal line: fall back to the chain's own plane.
  if (!P && n.lengthSq() < EPS * l1 * l1) {
    n = new Vector3().crossVectors(B1.clone().sub(A), C1.clone().sub(A));
  }
  if (n.lengthSq() < EPS * l1 * l1) {
    // Still straight (no preferred angle): bend about the root's X axis, kept off the goal line.
    n = axis(W[0], 0).sub(e.clone().multiplyScalar(axis(W[0], 0).dot(e)));
    if (n.lengthSq() < EPS) n = axis(W[0], 2).sub(e.clone().multiplyScalar(axis(W[0], 2).dot(e)));
  }
  n.normalize();
  // Out of reach (or inside the chain's fold), the clamped cosine straightens (or folds) the chain
  // along the goal line; the mid turn below then points the tip at the goal.
  const s = chain.stretch && d > l1 + l2 ? d / (l1 + l2) : 1;
  const L1 = l1 * s;
  const L2 = l2 * s;
  const cosA = Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const now = signedAngle(e, B1.clone().sub(A), n);
  // The elbow bends to the side it is on; on the goal line (a straight chain the preferred angle bent
  // at the mid joint), to the side away from the tip.
  const side =
    Math.abs(now) > 1e-9 ? Math.sign(now) : -Math.sign(signedAngle(e, C1.clone().sub(A), n)) || 1;
  const want = side * Math.acos(cosA);
  apply(
    about(
      A,
      new Matrix4().makeRotationAxis(n, want - now).multiply(new Matrix4().makeScale(s, s, s)),
    ),
    0,
  );
  const B2 = head(W[1]);
  const target = A.clone().add(e.clone().multiplyScalar(d));
  const shortest = new Quaternion().setFromUnitVectors(
    head(W[2]).sub(B2).normalize(),
    target.clone().sub(B2).normalize(),
  );
  apply(about(B2, new Matrix4().makeRotationFromQuaternion(shortest)), 1);

  // The tip takes the goal's rotation, keeping its own place and size.
  if (chain.orientTip) {
    const at = head(W[2]);
    const size = new Vector3().setFromMatrixScale(W[2]);
    const turn = new Quaternion().setFromRotationMatrix(
      new Matrix4().extractRotation(world[index.get(chain.goal)!]),
    );
    W[2] = new Matrix4().compose(at, turn, size);
  }

  // Back to local transforms, each under its (solved) parent.
  const parentOf = (i: number, k: number): Matrix4 =>
    k > 0 ? W[k - 1] : bones[i].parent >= 0 ? world[bones[i].parent] : new Matrix4();
  const out = start.slice();
  const joints: [number, number][] = chain.orientTip
    ? [
        [r, 0],
        [m, 1],
        [t, 2],
      ]
    : [
        [r, 0],
        [m, 1],
      ];
  for (const [i, k] of joints) {
    const local = parentOf(i, k).clone().invert().multiply(W[k]);
    const p = new Vector3();
    const q = new Quaternion();
    const sc = new Vector3();
    local.decompose(p, q, sc);
    out[i] = {
      name: start[i]?.name ?? bones[i].name,
      position: [p.x, p.y, p.z] as Vec3,
      quaternion: [q.x, q.y, q.z, q.w] as Quat,
      scale: [sc.x, sc.y, sc.z] as Vec3,
    };
  }
  return heldAtLimits(bones, out, { r, m, t }, A, e, n, chain.orientTip ? W[2] : null);
}

/**
 * #1344 — the solved chain stopped at its joints' limits. The mid joint first: held at its limit, the
 * chain is a rigid shape that cannot reach, so the root turns it (the short way, which stays in the
 * bend plane) until the tip lies on the line to the goal — the nearest it gets, and where Blender's
 * solver leaves it (measured: forearm limited to -10°, tip 0.015 off that line after 500
 * iterations). Then the root's own limits, which the tip simply falls short by. The side of the bend
 * never flips to dodge a limit: a pole on the forbidden side leaves the joint at the limit (measured
 * in Blender: limit [0°, 150°], pole behind, the forearm stays at 0°).
 */
function heldAtLimits(
  bones: readonly BoneSpec[],
  solved: BonePose[],
  at: { r: number; m: number; t: number },
  A: Vector3,
  e: Vector3,
  n: Vector3,
  tipWorld: Matrix4 | null,
): BonePose[] {
  const { r, m, t } = at;
  if (!bones[r].limits && !bones[m].limits) return solved;
  const out = solved;
  let moved = false;
  const mid = clampToLimits(bones[m], out[m].quaternion);
  if (mid !== out[m].quaternion) {
    moved = true;
    out[m] = { ...out[m], quaternion: mid };
    const world = posedWorldMatrices(bones, out);
    const reach = head(world[t]).sub(A);
    if (reach.lengthSq() > EPS) {
      reach.normalize();
      // Pointing straight away from the goal there is no shortest turn: go round in the bend plane.
      const turn =
        reach.dot(e) < -1 + 1e-9
          ? new Quaternion().setFromAxisAngle(n, Math.PI)
          : new Quaternion().setFromUnitVectors(reach, e);
      const aimed = about(A, new Matrix4().makeRotationFromQuaternion(turn)).multiply(world[r]);
      const parent = bones[r].parent >= 0 ? world[bones[r].parent] : new Matrix4();
      const p = new Vector3();
      const q = new Quaternion();
      const sc = new Vector3();
      parent.clone().invert().multiply(aimed).decompose(p, q, sc);
      out[r] = { ...out[r], quaternion: [q.x, q.y, q.z, q.w] as Quat };
    }
  }
  const root = clampToLimits(bones[r], out[r].quaternion);
  if (root !== out[r].quaternion) {
    moved = true;
    out[r] = { ...out[r], quaternion: root };
  }
  // The tip keeps the goal's rotation under the parent it now has.
  if (moved && tipWorld) {
    const world = posedWorldMatrices(bones, out);
    const turn = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(tipWorld));
    const under = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(world[m]));
    const q = under.invert().multiply(turn);
    out[t] = { ...out[t], quaternion: [q.x, q.y, q.z, q.w] as Quat };
  }
  return out;
}
