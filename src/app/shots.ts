// shots — the film's shots, DERIVED from the keys on the active camera (#1595).
//
// A shot is a stretch of time plus the camera that films it. Nothing stores a shot: the keys on
// `CameraSelect.active` are the cuts, and since #1663 each key holds until the next, so the span
// between two keys is one shot and the camera it shows is the one that key picks. Deriving the
// rows here, instead of storing them beside the keys, is what keeps the panel, the timeline, the
// render and the agent on ONE road: there is no second record to drift from the one that plays.
//
// The camera of each shot is read through `selectActiveCameraNode(state, start)` — the resolver
// the viewport and the render use — rather than re-deriving the index here, so a row can never
// name a camera other than the one on screen at that time.
//
// Blender's equivalent is a timeline marker bound to a camera (Bind Camera to Markers): the marker
// is the cut, the camera is the shot, and the list is read off the markers.
//
// #1668 — a key names its camera. A key whose camera has been deleted (or taken out of the switch)
// is not a cut: the resolver skips it and the shot before runs on, so it starts no row here either.

import type { DagState } from '../core/dag';
import type { Node, NodeRef } from '../core/dag/types';
import { cutChannelOf, listedCameraIds, selectActiveCameraNode } from './activeCamera';

export { cutChannelOf };

export interface Shot {
  /** 0-based position in the film. */
  readonly index: number;
  /** Seconds (film time) the shot starts at. The first shot always starts at 0. */
  readonly start: number;
  /** Seconds the shot ends at: the next cut, or the film's end. */
  readonly end: number;
  /** The camera on screen during the shot, or null when the scene has no camera. */
  readonly cameraId: string | null;
  /** The key that starts this shot, or null for a shot no key starts (an un-keyed film, or the
   *  stretch before the first key, which the first key's camera holds). */
  readonly keyTime: number | null;
}

export interface ShotsView {
  /** The `CameraSelect` that switches cameras, or null when one camera is wired directly. */
  readonly selectId: string | null;
  /** The channel keying `selectId.active`, or null when nothing is keyed yet. */
  readonly channelId: string | null;
  /** The cameras the select can pick, in wire order. */
  readonly cameraIds: readonly string[];
  readonly shots: readonly Shot[];
}

/** The `CameraSelect` wired into `scene.camera`, if any. */
export function cameraSelectOf(state: DagState): Node | null {
  const sceneRef = state.outputs.scene;
  const scene = sceneRef ? state.nodes[sceneRef.node] : undefined;
  const raw = scene?.inputs.camera;
  const ref = (Array.isArray(raw) ? raw[0] : raw) as NodeRef | undefined;
  const node = ref?.node ? state.nodes[ref.node] : undefined;
  return node?.type === 'CameraSelect' ? node : null;
}

/** The film's shots, from the active camera's keys. `end` is the film's length in seconds. */
export function shotsOf(state: DagState, end: number): ShotsView {
  const select = cameraSelectOf(state);
  const cameraIds = select ? listedCameraIds(select) : [];
  const channel = select ? cutChannelOf(state, select.id) : null;
  const keyTimes = channel
    ? [
        ...new Set(
          ((channel.params as { keyframes?: { time: number; value: unknown }[] }).keyframes ?? [])
            .filter((k) => cameraIds.includes(k.value as string))
            .map((k) => k.time),
        ),
      ].sort((a, b) => a - b)
    : [];

  // Cuts are the keys after the first: before the first key its camera holds (extend hold), so
  // the first key starts nothing new. A key at or past the film's end starts no visible shot.
  const starts: { time: number; keyTime: number | null }[] = [
    { time: 0, keyTime: keyTimes[0] === 0 ? 0 : null },
  ];
  for (const t of keyTimes.slice(1)) if (t > 0 && t < end) starts.push({ time: t, keyTime: t });

  const shots = starts.map((s, i) => ({
    index: i,
    start: s.time,
    end: starts[i + 1]?.time ?? end,
    // Read through the resolver, so the row names the camera that is actually on screen.
    cameraId: selectActiveCameraNode(state, s.time)?.id ?? null,
    keyTime: s.keyTime,
  }));
  return { selectId: select?.id ?? null, channelId: channel?.id ?? null, cameraIds, shots };
}
