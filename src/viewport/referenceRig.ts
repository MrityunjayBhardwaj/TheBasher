// referenceRig — where to stand the SOURCE rig so it can be compared with the
// character it drives (#977).
//
// WHY THIS EXISTS. The obvious way to judge a retarget is to put our armature
// next to Blender's and look. That was tried (#968) and it does not work: the
// two rigs differ, the two framings differ, and — fatally — "front view" means
// front of the WORLD in each application, not front of the CHARACTER, so a
// limb-angle comparison across them measures the angle between two cameras.
//
// Drawing both rigs in ONE viewport removes all three confounds at once: same
// projection, same time base, same frame. What is left is the placement problem
// this module solves — the source rig is authored at its own scale (bone lengths
// 0.1 … 100 on our BVH, against a metre-scale glTF character), so it must be
// normalised before it can stand beside anything.
//
// Pure + unit-testable; no THREE scene objects, no store, no DAG.

import * as THREE from 'three';
import { buildClipBoneSamplers } from '../nodes/AnimationClip';
import type { AnimationClipValue, BoneSpec } from '../nodes/types';
import type { BoneFrame } from './boneShape';

/** An armature's extent in world space. */
export interface ArmatureBounds {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly size: THREE.Vector3;
  readonly center: THREE.Vector3;
  /** Y extent. The normalising dimension: rigs differ in build, but both are
   *  humanoids standing up, so height is the one comparable scalar. */
  readonly height: number;
  readonly empty: boolean;
}

/** Padding between the two rigs, as a fraction of the target's height. */
export const REFERENCE_GAP_RATIO = 0.35;

/** Guard for a rig with no vertical extent (a single bone, or all-degenerate). */
const MIN_HEIGHT = 1e-6;

/**
 * The world extent of a set of placed bones, taken over heads AND tails — a
 * bone's tail is as much part of the drawing as its head, and using heads alone
 * would clip the topmost bone of every rig.
 *
 * 🔴 ROOT BONES ARE EXCLUDED, and that is a measurement decision, not tidying.
 * A parentless bone's tail is manufactured from its child, and on a BVH rig
 * whose transport node sits at the world origin while the body walks away, that
 * one bone spans from the origin to the pelvis. Measured on our own clip: it
 * grew the rig's Z extent from 25 to 238 units across 1.5 s while the body
 * itself never changed size. Including it makes the "height" of a rig a
 * function of how far it has walked, so the normalising scale drifts every
 * frame and the figure slides out of frame.
 *
 * Falls back to all frames when every bone is a root, so a one-bone rig still
 * reports a real extent instead of an empty one.
 */
export function armatureBounds(frames: readonly BoneFrame[]): ArmatureBounds {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const anatomy = frames.filter((f) => f.parent >= 0);
  for (const f of anatomy.length > 0 ? anatomy : frames) {
    for (const p of [f.head, f.tail]) {
      min.x = Math.min(min.x, p[0]);
      min.y = Math.min(min.y, p[1]);
      min.z = Math.min(min.z, p[2]);
      max.x = Math.max(max.x, p[0]);
      max.y = Math.max(max.y, p[1]);
      max.z = Math.max(max.z, p[2]);
    }
  }
  if (frames.length === 0 || !Number.isFinite(min.x)) {
    const zero = new THREE.Vector3();
    return {
      min: zero.clone(),
      max: zero.clone(),
      size: zero.clone(),
      center: zero.clone(),
      height: 0,
      empty: true,
    };
  }
  const size = max.clone().sub(min);
  const center = min.clone().add(max).multiplyScalar(0.5);
  return { min, max, size, center, height: size.y, empty: false };
}

/**
 * The transform that stands `source` beside `target`, same height, feet level,
 * offset along +X.
 *
 * 🔑 THE SCALE IS PART OF THE MEASUREMENT, NOT COSMETIC. Limb ANGLES are what a
 * retarget is judged on, and angles are scale-invariant — but only if the eye
 * can see both rigs at once. A source rig drawn at its authored scale is either
 * a speck or fills the screen, and in both cases nothing is comparable. Matching
 * heights is what makes the two poses legible in one glance.
 *
 * Anchored at the FEET (min.y), not the centre: two humanoids of the same height
 * with different proportions share a ground plane, and comparing a stride is
 * meaningless if one figure floats.
 *
 * Returns identity when either rig is empty, so a scene mid-load draws the
 * reference rig at its own scale rather than collapsing it to a point.
 */
export function referencePlacement(
  source: ArmatureBounds,
  target: ArmatureBounds,
  gapRatio: number = REFERENCE_GAP_RATIO,
): THREE.Matrix4 {
  if (source.empty || target.empty || source.height < MIN_HEIGHT) {
    return new THREE.Matrix4();
  }
  const scale = target.height / source.height;

  // Where the source rig's ground-centre currently is, and where we want it.
  const from = new THREE.Vector3(source.center.x, source.min.y, source.center.z);
  const gap = Math.max(target.height * gapRatio, MIN_HEIGHT);
  const dx = target.size.x / 2 + (source.size.x * scale) / 2 + gap;
  const to = new THREE.Vector3(target.center.x + dx, target.min.y, target.center.z);

  // p → (p - from) * scale + to, as one matrix.
  const m = new THREE.Matrix4().makeScale(scale, scale, scale);
  m.premultiply(new THREE.Matrix4().makeTranslation(to.x, to.y, to.z));
  m.multiply(new THREE.Matrix4().makeTranslation(-from.x, -from.y, -from.z));
  return m;
}

/**
 * The source clip's own skeleton, posed at `seconds`.
 *
 * Sampling goes through `buildClipBoneSamplers` — the SAME factory the
 * locomotion pose path and the baked render band already use. A second
 * interpolator here would be a second answer to "where is this bone at t", and
 * it would drift from the retarget's answer silently, which is precisely the
 * comparison this rig is drawn to make. A bone the clip does not touch holds
 * its rest pose.
 */
export function posedSourceBones(clip: AnimationClipValue, seconds: number): BoneSpec[] {
  const bones = clip.skeleton.bones;
  const samplers = buildClipBoneSamplers(clip);
  const out: BoneSpec[] = [];
  for (let i = 0; i < bones.length; i++) {
    const sampler = samplers.get(i);
    if (!sampler) {
      out.push(bones[i]);
      continue;
    }
    const { position, rotation } = sampler(seconds);
    out.push({ ...bones[i], position, rotation });
  }
  return out;
}
