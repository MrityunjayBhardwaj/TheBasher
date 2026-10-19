// Fit a generated walk's path to the character that walks it (#1285).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE REQUEST IS SCALED AND NOT THE WALK
// ─────────────────────────────────────────────────────────────────────────────
// The retarget multiplies the root's travel by the two rigs' leg ratio
// (`rootTravelScale`, SkeletonUtils.js:139-141). That is what keeps a shorter
// character's feet planted, and it means a path drawn in the character's metres
// is walked at the ratio: measured, the stand-in covered 0.625 of a drawn 6.25 m
// path while the generator's rig walked all of it. Undoing the ratio on the walk
// would put the feet back to skating. Asking the generator for the path divided
// by the ratio does not: the generator's rig walks a longer path with its own
// stride, and the retarget brings it back to the drawn one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS DERIVED AT THE COOK AND STORED ON THE PRODUCER
// ─────────────────────────────────────────────────────────────────────────────
// The ratio is a property of the rigs, and the character is DOWNSTREAM of the
// producer (MotionGenerate → AnimationClip → RetargetClip → the character's rig),
// so it cannot arrive on an input edge without a cycle. It is still part of the
// request — two characters of different sizes are two different requests — so it
// lives in the producer's params, where the hash sees it, and the cook writes it
// from the graph immediately before it asks. A value nobody re-derived would be
// right until the character changed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT CANNOT DO, SAID RATHER THAN GUESSED
// ─────────────────────────────────────────────────────────────────────────────
// One clip driving two characters whose ratios differ cannot land both on the
// path — one request, one walk length. Choosing one would put the other off the
// curve with nothing said, so the scale is left as it is and the cook names both.
// With no character bound, the motion's own rig is what plays it, at ratio 1.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE RATIO IS TAKEN TO THE WORLD FIRST (#1508, #1633)
// ─────────────────────────────────────────────────────────────────────────────
// `rootTravelScale` answers in each rig's own units — what the retarget needs,
// because its output lives there. The path is drawn in world metres. A rig stored
// in centimetres under a 0.01 group (every Mixamo character) reads ~100× its world
// answer, so the request went out 100× too short. Blender never compares a
// rig-space length across rigs or against the scene: it goes through the object's
// world matrix first (`BKE_constraint_mat_convertspace`, constraint.cc:258-305,
// v5.1.1). So each side's ratio is carried to the world through the Object that
// stands its rig — and on the target side, only the Objects that PLAY this
// retarget: an idle copy of the character at another size walks nothing (#1680).
//
// REF: src/core/import/retarget.ts (`rootTravelScale` — the one derivation);
//      src/app/animate/retargetFromNodes.ts (`retargetOperandsFromNodes`, the
//      operands the retarget itself reads); src/nodes/MotionGenerate.ts
//      (`pathScale`, and why it enters the hash); src/app/resolveWorldTransform.ts
//      (the world composition the render uses); issues #1285, #1508, #1633, #1680.

import type { EvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { rootTravelScale } from '../../core/import/retarget';
import { edgeTarget, type GraphNodeLike } from '../animate/graphNodes';
import { poseLayerChain } from '../animate/poseChain';
import { retargetOperandsFromNodes } from '../animate/retargetFromNodes';
import { standingObjectsOf } from '../../core/import/skeletonObject';
import { resolveWorldTransform } from '../resolveWorldTransform';

/** Two ratios this close are one character size. Bone lengths come from the same
 *  bind pose every time, so this only absorbs float noise between two rigs that
 *  are the same rig. */
const SAME_RATIO = 1e-6;

/** What the graph says this producer's path scale should be. */
export type PathScaleFit =
  /** No path wired: the scale has nothing to scale. */
  | { readonly kind: 'no-path' }
  /** Every character the walk drives agrees (or none is bound: the walk's own rig, at 1). */
  | { readonly kind: 'fit'; readonly scale: number; readonly current: number }
  /** The walk drives characters of different sizes; no single request lands them all. */
  | {
      readonly kind: 'mixed';
      readonly current: number;
      readonly ratios: readonly { readonly retargetId: string; readonly scale: number }[];
    };

/** Frame 0, as the path is read (motionPathFromCurve's PATH_CTX): placement is a frame-0 fact. */
const FIT_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

/**
 * The world length of one unit of `skeletonId`'s rig, once per Object that stands it in the scene
 * — the uniform part of each one's world scale. Empty when none is reachable from the scene, which
 * the caller reads as 1: a rig nothing places is in world units by default. Two Objects at two
 * scales are two entries, so a rig stood twice at different sizes is refused as `mixed` like two
 * characters would be. With `playing`, only the Objects whose pose chain starts at that retarget
 * count (#1508): a copy of the character that plays something else, or nothing, is not this walk.
 */
function worldUnitsOf(
  state: DagState,
  skeletonId: string,
  cache?: EvaluatorCache,
  playing?: string,
): number[] {
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
  const units: number[] = [];
  for (const objectId of standingObjectsOf(state, skeletonId)) {
    if (playing !== undefined && poseLayerChain(nodes, objectId).source?.node !== playing) continue;
    const world = resolveWorldTransform(state, objectId, FIT_CTX, cache);
    if (!world) continue;
    const [x, y, z] = world.scale.map(Math.abs);
    const unit = Math.cbrt(x * y * z);
    if (Number.isFinite(unit) && unit > 0) units.push(unit);
  }
  return units;
}

/** The WORLD ratio every `RetargetClip` playing one of this producer's clips applies, by node. */
function retargetRatios(
  state: DagState,
  producerId: string,
  cache?: EvaluatorCache,
): { retargetId: string; scale: number }[] {
  const sinks = new Set(
    Object.keys(state.nodes).filter(
      (id) =>
        state.nodes[id].type === 'AnimationClip' &&
        edgeTarget(state.nodes[id], 'source') === producerId,
    ),
  );
  const out: { retargetId: string; scale: number }[] = [];
  for (const id of Object.keys(state.nodes).sort()) {
    const node = state.nodes[id];
    if (node.type !== 'RetargetClip') continue;
    // The retarget reads its source on the pose wire (`source`, #1225), a clip's `pose` here.
    const source = edgeTarget(node, 'source');
    if (!source || !sinks.has(source)) continue;
    const { sourceBones, map, targetBones } = retargetOperandsFromNodes(state.nodes, node) ?? {};
    // A half-wired retarget drives nothing, so it has no size to fit.
    if (!sourceBones?.length || !map || !targetBones?.length) continue;
    // #1633 — the leg ratio is in each RIG's units; the walk lands in the WORLD. A rig imported
    // from centimetres stands under a group scaled 0.01, so the rig ratio is ~100× the one the
    // path sees. Carry it to the world through each side's standing Object.
    const rigRatio = rootTravelScale(sourceBones, map, targetBones);
    const sourceSkeleton = edgeTarget(state.nodes[source], 'skeleton');
    const targetSkeleton = edgeTarget(node, 'skeleton');
    const sourceUnit = sourceSkeleton ? (worldUnitsOf(state, sourceSkeleton, cache)[0] ?? 1) : 1;
    const targetUnits = targetSkeleton ? worldUnitsOf(state, targetSkeleton, cache, id) : [];
    for (const targetUnit of targetUnits.length > 0 ? targetUnits : [1]) {
      const scale = (rigRatio * targetUnit) / sourceUnit;
      if (Number.isFinite(scale) && scale > 0) out.push({ retargetId: id, scale });
    }
  }
  return out;
}

export function motionPathScaleFit(
  state: DagState,
  producerId: string,
  cache?: EvaluatorCache,
): PathScaleFit {
  const node = state.nodes[producerId];
  if (!node || node.type !== 'MotionGenerate' || !edgeTarget(node, 'path')) {
    return { kind: 'no-path' };
  }
  const raw = (node.params as { pathScale?: unknown } | undefined)?.pathScale;
  const current = typeof raw === 'number' ? raw : 1;
  const ratios = retargetRatios(state, producerId, cache);
  if (ratios.length === 0) return { kind: 'fit', scale: 1, current };
  const [first] = ratios;
  if (ratios.every((r) => Math.abs(r.scale - first.scale) <= SAME_RATIO)) {
    return { kind: 'fit', scale: first.scale, current };
  }
  return { kind: 'mixed', current, ratios };
}

/** True when the producer's stored scale is not the one its characters need. */
export function pathScaleNeedsFit(fit: PathScaleFit): boolean {
  return fit.kind === 'fit' && Math.abs(fit.scale - fit.current) > SAME_RATIO;
}

export interface PathScaleFitting {
  readonly ops: Op[];
  /** One per producer whose characters disagree. Never swallowed: every one of them walks a
   *  path of the wrong length, and that looks like the generator ignoring the curve. */
  readonly refusals: { readonly producerId: string; readonly reason: string }[];
}

/**
 * Ops that bring every path-driven producer's `pathScale` to what its characters need,
 * optionally narrowed to one producer (the per-node cook, #964).
 *
 * A changed scale changes the request hash, so the cook that follows generates the fitted walk;
 * an unchanged one writes nothing and re-cooks nothing.
 */
export function fitMotionPathScaleOps(state: DagState, only?: string): PathScaleFitting {
  const ops: Op[] = [];
  const refusals: { producerId: string; reason: string }[] = [];
  for (const id of Object.keys(state.nodes).sort()) {
    if (state.nodes[id].type !== 'MotionGenerate') continue;
    if (only !== undefined && id !== only) continue;
    const fit = motionPathScaleFit(state, id);
    if (fit.kind === 'mixed') {
      refusals.push({
        producerId: id,
        reason:
          `the walk drives characters of different sizes (${fit.ratios
            .map((r) => `${r.retargetId} ×${r.scale.toFixed(3)}`)
            .join(', ')}), and one generated walk can land only one size on its path — ` +
          `the path is still asked for at ×${fit.current.toFixed(3)}. Give each character ` +
          `its own generator to put both on the curve.`,
      });
      continue;
    }
    if (pathScaleNeedsFit(fit) && fit.kind === 'fit') {
      ops.push({ type: 'setParam', nodeId: id, paramPath: 'pathScale', value: fit.scale });
    }
  }
  return { ops, refusals };
}
