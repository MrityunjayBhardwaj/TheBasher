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
// params.keyframes[].time). The playhead int is FRAMES.
//
// ON-KEY RULE (P7.1 / D-05): a key reads 'on-key' when its time is
// WITHIN ½ FRAME of the playhead second. WHY: Phase 7.1 (D-02) lets a
// director drag a keyframe to ANY sub-frame second (Blender-style free
// seconds). The original rule was `Math.round(kf.time*60) ===
// currentFrame` — exact frame-grid integer equality. A sub-frame-retimed
// key (e.g. t=1.3333, not on any 60fps grid line) would then NEVER read
// 'on-key' at any integer playhead frame, so the P7 inspector diamond
// would silently look broken ("I moved my key here, it won't light").
// D-05 chosen mechanism (b): widen to a ±½-frame tolerance — preserves
// the director's "I see my key is here" feedback WITHOUT forcing snap
// (D-02 forbids snap). ½ frame is the correct half-window: a key strictly
// between two frames is on-key only for the NEARER frame, never both.
// One frame (1/60s) > ½ frame (0.5/60s), so every prior off-by-one-frame
// case stays 'animated' by construction (verified by arithmetic per
// existing test before this change — zero cases flip). NOT a second
// equality rule à la D-03 — D-03 is exact-float sample identity for the
// REMOVE; this is the VIEWER's on-grid tolerance. Different concern.
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
/**
 * Is `node` a keyframe channel? The canonical spelling of the question.
 *
 * `type.startsWith('KeyframeChannel')` is currently written out at ~16 call sites
 * (nodeChannels, resolveEvaluatedParam, activeCamera, KeyboardShortcuts, the agent
 * mutators, CurveEditor, …). This is the one home for it — new callers use this,
 * and the existing literals are tracked for migration rather than being copied a
 * seventeenth time ([[V101]] — one projection, not a parallel list).
 */
export function isKeyframeChannelNode(node: { type: string } | undefined): boolean {
  return !!node && node.type.startsWith('KeyframeChannel');
}

export function paramAnimationState(
  state: DagState,
  nodeId: string,
  paramPath: string,
  currentFrame: number,
): ParamAnimationState {
  // 1 — find the KeyframeChannel* node whose target/paramPath match.
  let keyframes: ChannelKeyframe[] | null = null;
  for (const node of Object.values(state.nodes)) {
    if (!isKeyframeChannelNode(node)) continue;
    const p = (node.params ?? {}) as ChannelParams;
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    keyframes = Array.isArray(p.keyframes) ? (p.keyframes as ChannelKeyframe[]) : [];
    break;
  }

  if (keyframes === null) return 'none';

  // 2 — on-key check: WITHIN ½ frame of the playhead second (P7.1 / D-05
  //     — see the ON-KEY RULE doc above). The `+ 1e-9` absorbs binary
  //     float dust at the exact ½-frame boundary so a key landing exactly
  //     ½ frame away reads on-key deterministically — boundary slack, NOT
  //     a second equality rule (D-03 is exact-float; this is grid slack).
  const halfFrameSec = 0.5 / FRAMES_PER_SECOND;
  const playheadSec = currentFrame / FRAMES_PER_SECOND;
  const onKey = keyframes.some((kf) => Math.abs(kf.time - playheadSec) <= halfFrameSec + 1e-9);
  return onKey ? 'on-key' : 'animated';
}
