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
// The film's cuts are a camera channel too: `overlayCutChannel` gives the cut channel the same
// rules, so muting it plays the switch's own camera.
//
// It lives in its own module because `resolveWorldTransform` cannot import `activeCamera`
// (the import would cycle).

import type { DagState } from '../core/dag/state';
import type { Node } from '../core/dag/types';
import { overlayChannels } from '../nodes/overlayChannels';
import {
  bareChannelValuesForSubject,
  channelEntriesFromNodes,
  directChannelNodesForTarget,
} from './nodeChannels';
import { linkedDataNodeId } from './resolveDataParamOwner';

/**
 * `base` with the camera's channels overlaid at `seconds`: those on the Object and on its
 * CameraData, limited to the fields `base` has. Returns `base` itself when no channel applies.
 */
export function overlayCameraChannels<T extends object>(
  state: DagState,
  cameraId: string,
  base: T,
  seconds: number,
): T {
  const channels = bareChannelValuesForSubject(
    state.nodes,
    cameraId,
    linkedDataNodeId(state, cameraId),
  ).filter((c) => c.paramPath in base);
  if (channels.length === 0) return base;
  return overlayChannels(base, channels, 1, seconds) ?? base;
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
