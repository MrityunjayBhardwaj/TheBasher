// paramAnimationState — the 3-state derivation for the inspector diamond
// (Phase 7, Wave C / D-03).
//
// PURE. No store reads inside. The caller passes (state, nodeId,
// paramPath, currentFrame); the function returns one of three states:
//
//   'none'     — no KeyframeChannel* node animates this (nodeId, paramPath)
//   'animated' — a channel exists but the current frame is NOT a key
//   'on-key'   — a channel exists AND the current frame IS a key
//
// The SECONDS ↔ FRAME conversion lives HERE, once (PLAN "Seconds ↔ frame
// unit boundary"). Keyframes are stored in SECONDS (KeyframeChannel*.ts
// params.keyframes[].time). The playhead int is FRAMES. The on-key
// equality is frame-rounded-integer equality against the 60fps grid —
// `Math.round(kf.time * FRAMES_PER_SECOND) === currentFrame` — NOT a
// float epsilon compare (C1 pre-mortem: raw-float === misses off-by-eps).
//
// Mirrors the D-W9-4 tested-pure-geometry discipline: the only place the
// unit boundary is crossed, isolated and unit-tested in isolation.
//
// REF: .planning/phases/07-animation-authoring/PLAN.md Wave C (C1);
//      D-01/D-03; timeStore.ts:42 (FRAMES_PER_SECOND); RESEARCH U5.

import { FRAMES_PER_SECOND } from '../stores/timeStore';
import type { DagState } from '../../core/dag/state';

export type ParamAnimationState = 'none' | 'animated' | 'on-key';

interface ChannelKeyframe {
  time: number;
}

interface ChannelParams {
  target?: unknown;
  paramPath?: unknown;
  keyframes?: unknown;
}

/**
 * Derive the 3-state animation status for a param on a node at a given
 * playhead frame.
 *
 * @param state         the DAG state (channels live in state.nodes)
 * @param nodeId        the animated target node id
 * @param paramPath     the param path on the target (e.g. 'rotation')
 * @param currentFrame  the playhead frame int (useTimeStore.frame)
 */
export function paramAnimationState(
  state: DagState,
  nodeId: string,
  paramPath: string,
  currentFrame: number,
): ParamAnimationState {
  // 1 — find the KeyframeChannel* node whose target/paramPath match.
  let keyframes: ChannelKeyframe[] | null = null;
  for (const node of Object.values(state.nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = (node.params ?? {}) as ChannelParams;
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    keyframes = Array.isArray(p.keyframes)
      ? (p.keyframes as ChannelKeyframe[])
      : [];
    break;
  }

  if (keyframes === null) return 'none';

  // 2 — on-key check: frame-rounded SECONDS equality against the 60fps
  //     grid (the DECIDED rule — RESEARCH U5; no float epsilon).
  const onKey = keyframes.some(
    (kf) => Math.round(kf.time * FRAMES_PER_SECOND) === currentFrame,
  );
  return onKey ? 'on-key' : 'animated';
}
