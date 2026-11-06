// keyedCook — what a compute node cooks with: its settings at the time being evaluated (#575).
//
// A compute node's cook sees its saved params, and a key lives off the graph, so a key on Mix's
// factor read back and changed nothing. Here the settings something animates are read through
// `resolveEvaluatedParam`, the read the inspector and the chain steps already use, so a key, a strip
// or a driver gives the cook the value the row shows. Saved params are never written.
//
// Compute nodes only. A geometry cook runs off the render's per-frame path, and the geometry that
// does follow keys is repaired there (`rebuildGeometryRef`), so that half of #575 stays open. A
// compute node wired straight into such a cook is cooked once at the root like it, so it follows
// its keys only where its reader evaluates per frame: a driver, a constraint chain.
//
// On the render root's cook state this folds no path twice: that fold admits only a held edit over
// an overwrite (`refoldSafe`), which reads the same again here.

import { setKeyedParams, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { writeAt } from '../nodes/overlayChannels';
import { stripChannelValuesForTarget } from './layeredChannels';
import { keyframeChannelsTargeting } from './nodeChannels';
import { driverStackForTarget } from './paramDrivers';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { stripTargetsOf } from './stripTargetIndex';

/** The settings of `id` something animates. Empty for almost every node, and cheap to ask. */
function animatedPaths(state: DagState, id: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const add = (params: unknown) => {
    const path = (params as { paramPath?: unknown } | undefined)?.paramPath;
    if (typeof path === 'string') paths.add(path);
  };
  for (const node of keyframeChannelsTargeting(state.nodes, id)) add(node.params);
  for (const node of driverStackForTarget(state.nodes, id)) add(node.params);
  if (stripTargetsOf(state.nodes).has(id)) {
    for (const value of stripChannelValuesForTarget(state.nodes, id)) add(value);
  }
  return paths;
}

function keyedParamsOf(
  state: DagState,
  id: string,
  params: unknown,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): unknown {
  let out: Record<string, unknown> | null = null;
  for (const path of animatedPaths(state, id)) {
    const read = resolveEvaluatedParam(state, id, path, ctx, cache);
    if (!read) continue;
    out ??= { ...(params as Record<string, unknown>) };
    writeAt(out, path, read.value);
  }
  return out ?? params;
}

/** Hands the evaluator this read. Called by `registerAllNodes`. */
export function registerKeyedCook(): void {
  setKeyedParams(keyedParamsOf);
}
