// lagBind — the pure op-builders for authoring a Lag node's INPUT (#297 S4).
//
// A stateful Lag trails a time-varying scalar; v1 that scalar is one transform channel
// of a controller (an animated Null), stored on `Lag.params.sourceTransform` — the
// same "Transform Channel" shape the driver uses (#296). These builders set / clear
// that source (the range remap is set by the shared, node-agnostic
// `buildSetDriverRemapOps`). Pure + testable, mirroring driverBind.ts.
//
// REF: src/nodes/Lag.ts; src/app/statefulOps.ts (the replay that reads the source);
//      src/app/driverBind.ts (DriverSource + buildSetDriverRemapOps); issue #297.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import type { DriverSource } from './driverBind';

/**
 * Set (or clear, when `source` is null) a Lag node's transform-channel input. A fresh
 * controller/channel drops any prior range (it belonged to the old channel); the range
 * is then authored separately via {@link buildSetDriverRemapOps}. No-op if the node is
 * missing or the source is not a transform source (v1 only trails a controller channel).
 */
export function buildSetLagSourceOps(
  state: DagState,
  lagId: string,
  source: DriverSource | null,
): Op[] {
  const node = state.nodes[lagId];
  if (!node) return [];
  if (source === null) {
    // Clear only if there is something to clear (keeps undo history tidy).
    if ((node.params as { sourceTransform?: unknown }).sourceTransform === undefined) return [];
    return [{ type: 'setParam', nodeId: lagId, paramPath: 'sourceTransform', value: undefined }];
  }
  if (source.kind !== 'transform') return [];
  return [
    {
      type: 'setParam',
      nodeId: lagId,
      paramPath: 'sourceTransform',
      value: { node: source.node, channel: source.channel },
    },
  ];
}
