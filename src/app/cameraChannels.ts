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
// The film's cuts are a camera channel too: `overlayCutChannels` gives the cut channel the same
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
import { stripTargetsOf } from './stripTargetIndex';
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
    // #1757 — strips only for a half some strip targets: with none, the enumerator walks every
    // track (per camera, per frame) to return nothing.
    ...ids.flatMap((id) =>
      stripTargetsOf(state.nodes).has(id) ? stripChannelValuesForTarget(state.nodes, id) : [],
    ),
    ...ids.flatMap((id) => driverChannelValuesForTarget(state, id, ctx, cache)),
  ];
  const channels = all.filter((c) => c.paramPath in base);
  if (channels.length === 0) return base;
  return overlayChannels(base, channels, 1, ctx.time.seconds) ?? base;
}

/**
 * The camera a cut channel names at `seconds`, among the cameras the switch lists (#1668):
 * Blender's rule for camera markers (`BKE_scene_camera_switch_find`, scene.cc). A key naming a
 * camera not in `listed` is skipped, so the shot before it runs on; the live key is the last one
 * at or before `seconds`; before the first key, the left-most key's camera holds. Null when no key
 * names a listed camera, so the channel has nothing to say.
 */
export function cutPickAt(
  channel: Node,
  listed: readonly string[],
  seconds: number,
): string | null {
  const keys = (channel.params as { keyframes?: { time: number; value: unknown }[] }).keyframes;
  if (!Array.isArray(keys)) return null;
  const live = keys
    .filter((k): k is { time: number; value: string } => listed.includes(k.value as string))
    .sort((a, b) => a.time - b.time);
  if (live.length === 0) return null;
  let picked = live[0];
  for (const k of live) if (k.time <= seconds) picked = k;
  return picked.value;
}

/** Every channel on the switch's `active`, each with the camera `pickOf` says it names, folded
 *  onto `active` in one pass. Solo is judged over all of the switch's channels by the shared
 *  collector, then mute, weight and order decide in `overlayChannels`. */
function foldCuts(
  state: DagState,
  selectId: string,
  active: string,
  pickOf: (channel: Node) => string | null,
  seconds: number,
): string {
  const cuts: KeyframeChannelValue[] = [];
  for (const e of channelEntriesFromNodes(directChannelNodesForTarget(state.nodes, selectId))) {
    // A cut names its camera, so only a text channel on `active` can be one.
    if (e.value.valueType !== 'text' || e.value.paramPath !== 'active') continue;
    const picked = pickOf(e.node);
    if (picked !== null) cuts.push({ ...e.value, sample: () => picked });
  }
  if (cuts.length === 0) return active;
  return overlayChannels({ active }, cuts, 1, seconds)?.active ?? active;
}

/**
 * The camera the switch `selectId` shows at `seconds`: every channel on its `active`, each naming
 * the camera `cutPickAt` picks among `listed`, folded onto the switch's own `active` by the rules
 * every channel follows. #1754 — all of them, not the first: a soloed second channel silences the
 * cuts and plays its own camera, as a soloed channel on any other param does.
 */
export function overlayCutChannels(
  state: DagState,
  selectId: string,
  active: string,
  listed: readonly string[],
  seconds: number,
): string {
  return foldCuts(state, selectId, active, (c) => cutPickAt(c, listed, seconds), seconds);
}

/**
 * #1747 — whether `channel` decides the camera at `seconds`, judged by the very fold
 * `overlayCutChannels` runs: given a pick no camera id can be, with the other channels picking
 * what they really pick and the switch on a camera no id can be either, does that pick win? A
 * muted channel, one a soloed sibling silences, one under the text snap, or one a later sibling
 * overrides leaves something else on screen, so its cuts cut nothing.
 */
export function cutChannelHasSay(
  state: DagState,
  selectId: string,
  channel: Node,
  listed: readonly string[],
  seconds: number,
): boolean {
  const mine = '\u0000cut';
  const pickOf = (c: Node) => (c === channel ? mine : cutPickAt(c, listed, seconds));
  return foldCuts(state, selectId, '\u0000static', pickOf, seconds) === mine;
}
