// transformChannelSource — the shared reader for the "Transform Channel" driver
// source road (#296). A driver (or, from Epic 2, a stateful Lag node) can pull a
// scalar from one transform channel (tx…sz) of a controller's EVALUATED transform,
// optionally remapped through a range. This module owns that parsing + per-frame
// read in ONE place so the direct driver road (paramDrivers.ts) and the stateful
// replay (statefulOps.ts) cannot drift.
//
// WHY the read is EVALUATED (not raw params): the controller (a Null) may be
// animated / auto-keyed, so its channel value at frame f comes from
// `resolveEvaluatedTransform`, not `node.params`. Reading it here (the seam has
// `state`) is the same reason the whole driver overlay lives in the seam and not in
// the pure `evaluate` (which sees only its own fixed params, evaluator.ts:167).
//
// REF: ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §3/§5; ParamDriver.ts
//      (TransformChannel); resolveEvaluatedTransform.ts; issues #296, #297.

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { TransformChannel } from '../nodes/ParamDriver';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { fit } from '../nodes/valueMath';

export const TRANSFORM_CHANNEL_SET = new Set<string>([
  'tx',
  'ty',
  'tz',
  'rx',
  'ry',
  'rz',
  'sx',
  'sy',
  'sz',
]);

export interface TransformSourceRef {
  node: string;
  channel: TransformChannel;
  remap?: { inMin: number; inMax: number; outMin: number; outMax: number };
}

interface NodeLike {
  readonly params?: unknown;
}
interface RawTransformSource {
  node?: unknown;
  channel?: unknown;
  remap?: { inMin?: unknown; inMax?: unknown; outMin?: unknown; outMax?: unknown };
}

/** The transform-channel source ref carried by a node's `params.sourceTransform`,
 *  validated (node id + a real tx…sz channel + an optional fully-specified remap).
 *  Null if the node has no transform source. */
export function transformSourceOf(node: NodeLike): TransformSourceRef | null {
  const s = ((node.params ?? {}) as { sourceTransform?: RawTransformSource }).sourceTransform;
  if (!s || typeof s.node !== 'string' || !s.node) return null;
  if (typeof s.channel !== 'string' || !TRANSFORM_CHANNEL_SET.has(s.channel)) return null;
  const r = s.remap;
  const remap =
    r &&
    typeof r.inMin === 'number' &&
    typeof r.inMax === 'number' &&
    typeof r.outMin === 'number' &&
    typeof r.outMax === 'number'
      ? { inMin: r.inMin, inMax: r.inMax, outMin: r.outMin, outMax: r.outMax }
      : undefined;
  return { node: s.node, channel: s.channel as TransformChannel, remap };
}

/** Read one transform channel (tx…sz) from an evaluated transform. Translation reads
 *  position, rotation reads the degrees vector, scale reads the scale vector
 *  (defaults 0/0/1 when a value carries no rotation/scale). */
export function readTransformChannel(
  xf: {
    position: readonly number[];
    rotation: readonly number[] | null;
    scale: readonly number[] | null;
  },
  channel: TransformChannel,
): number {
  const axis = channel[1] === 'x' ? 0 : channel[1] === 'y' ? 1 : 2;
  if (channel[0] === 't') return xf.position[axis] ?? 0;
  if (channel[0] === 'r') return (xf.rotation ?? [0, 0, 0])[axis] ?? 0;
  return (xf.scale ?? [1, 1, 1])[axis] ?? 1;
}

/** The scalar a transform source resolves to at `ctx`: the controller's EVALUATED
 *  transform → the picked channel → optional range remap (`fit`). A controller that
 *  is not currently rendered (null resolve) reads 0. This is the ONE per-frame read
 *  the direct driver road and the stateful replay both call — so both are identical
 *  under scrub (H40). */
export function readTransformChannelAt(
  state: DagState,
  source: TransformSourceRef,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): number {
  const xf = resolveEvaluatedTransform(state, source.node, ctx, cache);
  const raw = xf ? readTransformChannel(xf, source.channel) : 0;
  const r = source.remap;
  return r ? fit(raw, r.inMin, r.inMax, r.outMin, r.outMax) : raw;
}
