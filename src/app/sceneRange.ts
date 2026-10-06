// #1287 — the scene's frame range: how long the 3D scene's animation is.
//
// Blender keeps it on the scene (`scene.frame_end`, "Final frame of the playback/rendering
// range"), saved with the file and edited from the Timeline header. Basher keeps it on the
// Scene node for the same reasons: it is saved with the project, an edit is undoable, the
// agent can set it with the ops it already has, and the render reads it from the graph it
// renders rather than from a UI store.
//
// What the range does and does not do, as observed in Blender 4.5:
//   - playback loops at End, and Render ▸ Animation renders 0..End;
//   - the playhead is NOT held inside it (frame 500 with End at 250 is allowed), so content
//     past End can still be scrubbed to and looked at;
//   - keying past End, or importing a longer clip, leaves End alone (BVH's opt-in "Update
//     Scene Duration" aside). Basher says so instead (#1287's notice) and offers Extend.
//
// Start is 0: Basher's time model starts at 0.
//
// REF: /Applications/Blender.app/.../startup/bl_ui/space_time.py (Start/End in the Timeline
//      header); keymap_data/blender_default.py (anim.end_frame_set = Ctrl+End); the Blender
//      manual's editors/timeline.rst "Frame Range" and animation_editors.rst "Frame Controls".

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { useDagStore } from '../core/dag/store';
import { buildNlaLanes } from '../timeline/nlaLaneModel';
import { isKeyframeChannelNode } from './animate/paramAnimationState';
import { nodeDisplayName } from './sceneTreeWalk';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';

/** 10 s at 60 fps: what every project played before End was stored, so an old one is unchanged. */
export const DEFAULT_SCENE_FRAME_END = 600;

/** The Scene node the project renders (`outputs.scene`), or null. */
function sceneNodeId(state: DagState): string | null {
  const ref = state.outputs.scene;
  return ref && state.nodes[ref.node]?.type === 'Scene' ? ref.node : null;
}

/** The scene's last frame (at `FRAMES_PER_SECOND`), never below 1. */
export function sceneFrameEnd(state: DagState): number {
  const id = sceneNodeId(state);
  const raw = id ? (state.nodes[id].params as { frameEnd?: unknown }).frameEnd : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
    ? Math.round(raw)
    : DEFAULT_SCENE_FRAME_END;
}

/** The scene's End in seconds: where playback loops and the animation render stops. */
export function sceneEndSeconds(state: DagState): number {
  return sceneFrameEnd(state) / FRAMES_PER_SECOND;
}

/** Where the scene's animated content ends, and what ends there (null when nothing does). */
export interface ContentEnd {
  readonly seconds: number;
  /** The node whose content ends last, and its name as the outliner shows it. */
  readonly nodeId: string | null;
  readonly label: string | null;
}

/**
 * #1287 — the latest time anything in the scene animates to: a keyframe on any channel, the end
 * of any live NLA strip (the lane model's own placed span), and the length of any motion clip
 * (a clip plays from 0 for its `duration`). Read off params, never by evaluating, so it costs no
 * retarget. Content that ends before End leaves the range alone; content past it is what the
 * timeline reaches to and the notice names.
 */
export function sceneContentEnd(state: DagState): ContentEnd {
  let best: { seconds: number; nodeId: string } | null = null;
  const consider = (seconds: number, nodeId: string) => {
    if (Number.isFinite(seconds) && (best === null || seconds > best.seconds))
      best = { seconds, nodeId };
  };
  for (const node of Object.values(state.nodes)) {
    if (isKeyframeChannelNode(node)) {
      const keys = (node.params as { keyframes?: readonly { time?: unknown }[] }).keyframes ?? [];
      for (const k of keys) if (typeof k.time === 'number') consider(k.time, node.id);
    } else if (node.type === 'AnimationClip') {
      const duration = (node.params as { duration?: unknown }).duration;
      if (typeof duration === 'number') consider(duration, node.id);
    }
  }
  for (const row of buildNlaLanes(state.nodes).rows)
    for (const strip of row.strips) if (strip.live) consider(strip.end, strip.stripId);
  const found = best as { seconds: number; nodeId: string } | null;
  if (!found) return { seconds: 0, nodeId: null, label: null };
  return {
    seconds: found.seconds,
    nodeId: found.nodeId,
    label: nodeDisplayName(state.nodes, found.nodeId),
  };
}

/** The op that moves End to `seconds` (rounded to a frame, at least one), or none when it
 *  would not change End or there is no Scene node. */
export function buildSetSceneEndOps(state: DagState, seconds: number): Op[] {
  const id = sceneNodeId(state);
  if (!id || !Number.isFinite(seconds)) return [];
  const frameEnd = Math.max(1, Math.round(seconds * FRAMES_PER_SECOND));
  if (frameEnd === sceneFrameEnd(state)) return [];
  return [{ type: 'setParam', nodeId: id, paramPath: 'frameEnd', value: frameEnd }];
}

/** Move End to `seconds`, as one undoable edit (the Timebar's End field). */
export function setSceneEnd(seconds: number): void {
  const dag = useDagStore.getState();
  const ops = buildSetSceneEndOps(dag.state, seconds);
  if (ops.length > 0) dag.dispatchAtomic(ops, 'user', 'Set End Frame');
}

/** Blender's Set End Frame (Ctrl+End): End moves to the playhead. */
export function setSceneEndAtPlayhead(): void {
  setSceneEnd(useTimeStore.getState().seconds);
}
