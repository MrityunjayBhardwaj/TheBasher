// cameraChannels — the channels that pose a camera, read by the rules every other node's
// channels follow (#482).
//
// A camera is wired through `scene.camera`, not `scene.children`, so it never meets the
// scene-child walk where channel resolution lives, and it grew a private loop that sampled the
// keys and ignored mute, solo, weight and the layered fold. Its two readers then disagreed: the
// pose (`resolveCameraPoseAt`, what renders) used the private loop while the world transform
// (`resolveWorldTransform`, what the gizmo shows) went through `overlayChannels`. Both call this
// now, so they cannot drift apart again: solo is applied per camera by `channelValuesFromNodes`,
// and mute, weight, order and blend by `overlayChannels`.
//
// #480 — and the rest of what animates a param reaches a camera too: NLA strips placed on it and
// drivers bound to it, the same three sources `useLayeredChannels` folds for every scene child.
// A strip on a camera used to fold nothing, so push-down had to refuse cameras (#479); a driver
// bound to a lens param did nothing at all.
//
// The film's cuts are a camera channel too: `overlayCutChannel` gives the cut channel the same
// rules, so muting it plays the switch's own camera.
//
// It lives in its own module because `resolveWorldTransform` cannot import `activeCamera`
// (the import would cycle).

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Node } from '../core/dag/types';
import { overlayChannels } from '../nodes/overlayChannels';
import type { KeyframeChannelValue } from '../nodes/types';
import { stripChannelValuesForTarget } from './layeredChannels';
import {
  bareChannelValuesForSubject,
  channelEntriesFromNodes,
  directChannelNodesForTarget,
} from './nodeChannels';
import { driverChannelValuesForTarget } from './paramDrivers';
import { linkedDataNodeId } from './resolveDataParamOwner';

/**
 * `base` with the camera's channels overlaid at `ctx`: its bare channels, the strips placed on it
 * and the drivers bound to it, on the Object and on its CameraData, limited to the fields `base`
 * has. Returns `base` itself when nothing applies.
 *
 * The order is the render seam's — bare, then strips, then drivers — and solo is judged over the
 * bare channels alone, as `channelValuesFromNodes` judges it for every other node.
 */
export function overlayCameraChannels<T extends object>(
  state: DagState,
  cameraId: string,
  base: T,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): T {
  const dataId = linkedDataNodeId(state, cameraId);
  const ids = dataId && dataId !== cameraId ? [cameraId, dataId] : [cameraId];
  const all: KeyframeChannelValue[] = [
    ...bareChannelValuesForSubject(state.nodes, cameraId, dataId),
    ...ids.flatMap((id) => stripChannelValuesForTarget(state.nodes, id)),
    ...ids.flatMap((id) => driverChannelValuesForTarget(state, id, ctx, cache)),
  ];
  const channels = all.filter((c) => c.paramPath in base);
  if (channels.length === 0) return base;
  return overlayChannels(base, channels, 1, ctx.time.seconds) ?? base;
}

/**
 * The camera the switch `selectId` shows at `seconds`: `picked`, the camera its cut channel
 * names there, folded onto the switch's own `active` by the rules every channel follows. Solo
 * is judged over all of the switch's channels, so a soloed sibling silences the cuts; then
 * mute, weight and blend decide in `overlayChannels`. The caller picks the key, since only it
 * knows which cameras the switch lists.
 */
export function overlayCutChannel(
  state: DagState,
  selectId: string,
  channel: Node,
  active: string,
  picked: string,
  seconds: number,
): string {
  const value = channelEntriesFromNodes(directChannelNodesForTarget(state.nodes, selectId)).find(
    (e) => e.node === channel,
  )?.value;
  // A cut names its camera, so only a text channel can be one.
  if (!value || value.valueType !== 'text') return active;
  const cut = { ...value, sample: () => picked };
  const folded = overlayChannels({ active }, [cut], 1, seconds);
  return folded?.active ?? active;
}
