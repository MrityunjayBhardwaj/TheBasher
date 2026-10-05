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
// WHY THE RATIO IS TAKEN TO THE WORLD FIRST (#1508)
// ─────────────────────────────────────────────────────────────────────────────
// `rootTravelScale` answers in the TARGET SKELETON's own units — what the retarget
// needs, because its output lives there. The path is drawn in world metres. A rig
// stored in centimetres under a 0.01 group (every Mixamo character) reads 103.88
// where the world answer is 1.04, so the request went out 100× too short. Blender
// never compares a rig-space length across rigs or against the scene: it goes
// through the object's world matrix first (`BKE_constraint_mat_convertspace`,
// constraint.cc:258-305, v5.1.1). So the ratio is multiplied by the world scale of
// the Object the retarget poses — its own scale and every group above it.
//
// REF: src/core/import/retarget.ts (`rootTravelScale` — the one derivation);
//      src/app/animate/retargetFromNodes.ts (`retargetOperandsFromNodes`, the
//      operands the retarget itself reads); src/nodes/MotionGenerate.ts
//      (`pathScale`, and why it enters the hash); src/app/resolveWorldTransform.ts
//      (the world composition the render uses); issues #1285, #1508.

import type { EvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { rootTravelScale } from '../../core/import/retarget';
import { standingObjectsOf } from '../../core/import/skeletonObject';
import { edgeTarget, type GraphNodeLike } from '../animate/graphNodes';
import { poseLayerChain } from '../animate/poseChain';
import { retargetOperandsFromNodes } from '../animate/retargetFromNodes';
import { resolveWorldTransform } from '../resolveWorldTransform';

/** A rig's size does not move with the playhead; it is read at the start. */
const AT_REST = { time: { frame: 0, seconds: 0, normalized: 0 } };

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

/**
 * World units per unit of each rig this retarget poses: one entry per Object that stands the
 * retarget's skeleton AND plays it (its pose chain reads the retarget). None — a retarget nothing
 * shows yet — is the rig's own units, 1, which is what the fit assumed before #1508.
 *
 * A non-uniform world scale has no single length ratio; its geometric mean is used.
 */
function posedWorldScales(state: DagState, retargetId: string, cache?: EvaluatorCache): number[] {
  const skeletonId = edgeTarget(state.nodes[retargetId], 'skeleton');
  if (!skeletonId) return [1];
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
  const scales = standingObjectsOf(state, skeletonId)
    .filter((objectId) => poseLayerChain(nodes, objectId).source?.node === retargetId)
    .map((objectId) => {
      const world = resolveWorldTransform(state, objectId, AT_REST, cache);
      // Not in the scene: nothing draws it, so its own units are all there is.
      if (!world) return 1;
      const [x, y, z] = world.scale;
      return Math.cbrt(Math.abs(x * y * z));
    });
  return scales.length > 0 ? scales : [1];
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
    const rigRatio = rootTravelScale(sourceBones, map, targetBones);
    for (const world of posedWorldScales(state, id, cache)) {
      const scale = rigRatio * world;
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
