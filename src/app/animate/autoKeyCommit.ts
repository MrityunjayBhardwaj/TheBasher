// THE single Auto-Key commit chokepoint — lifted from NPanel.tsx (P7 Wave D)
// in P7.3 so it has TWO callers: the NPanel inspector value-commit handlers
// AND the viewport gizmo grab on an animated param (issue #68 / D-02).
//
// Domain-Aligned-Abstraction consolidation: one Auto-Key spine, two callers.
// The body is BYTE-IDENTICAL to the prior NPanel module-private function —
// NPanel's behavior must not change after the extraction (verified: the
// NPanel test suite stays green). `resolveChannel` moved with it because
// `autoKeyCommit` depends on it and the NPanel diamond handler also uses it
// (re-imported there).
//
// Strictly gated on `useAutoKeyStore.getState().enabled`: when Auto-Key is
// OFF this returns IMMEDIATELY, before any seam call. For the NPanel caller
// that means BYTE-IDENTICAL-to-pre-P7 (the caller already did the raw
// setParam; nothing else happens). For the Gizmo caller the OFF case is
// handled EARLIER by an explicit reject-with-alert (Gizmo.tsx) that returns
// before ever calling this — so this internal OFF guard is the silent
// shared safety net, not the Gizmo's user-facing path (FLAG-A: NPanel is
// byte-silent on OFF; the Gizmo's louder OFF reject is net-new behavior).
//
// REF: issue #68, CONTEXT D-02, NPanel.tsx P7 Wave D, vyapti V1/V13.

import { useDagStore } from '../../core/dag/store';
import { useTimeStore } from '../stores/timeStore';
import { dispatchFirstKeyComposite, dispatchMutatorFromUI } from './dispatchMutator';
import { paramAnimationState } from './paramAnimationState';
import { useAutoKeyStore } from '../stores/autoKeyStore';

/**
 * Find the KeyframeChannel* node that animates (nodeId, paramPath) and
 * return its id plus the exact stored `time` (SECONDS) of any sample on
 * the current frame. Single source of truth = the DAG (same scan as the
 * C1 helper). Returns null when no channel exists.
 */
export function resolveChannel(
  nodes: Record<string, { id: string; type: string; params?: unknown }>,
  nodeId: string,
  paramPath: string,
  currentFrame: number,
): { channelId: string; onKeySeconds: number | null } | null {
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = (node.params ?? {}) as {
      target?: unknown;
      paramPath?: unknown;
      keyframes?: unknown;
    };
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    const kfs = Array.isArray(p.keyframes)
      ? (p.keyframes as { time: number }[])
      : [];
    const onKey = kfs.find((kf) => Math.round(kf.time * 60) === currentFrame);
    return { channelId: node.id, onKeySeconds: onKey ? onKey.time : null };
  }
  return null;
}

/**
 * THE single Auto-Key commit chokepoint (Phase 7, Wave D / D4).
 *
 * Called by every inspector value-commit handler (NumericField +
 * VectorComponent, onChange AND onCommit) AFTER the raw `setParam`
 * dispatch — and (P7.3) by the gizmo grab on an animated param.
 *
 * Strictly gated on `useAutoKeyStore.getState().enabled`: when Auto-Key
 * is OFF this returns IMMEDIATELY, before any seam call, so the inspector
 * behaviour is BYTE-IDENTICAL to pre-P7.
 *
 * Channel-exists ⇒ single `keyframe` Mutator at the current SECONDS
 * (never a frame — the single conversion rule). No channel ⇒ first-key
 * composite. Both at `useTimeStore.getState().seconds`.
 */
export function autoKeyCommit(nodeId: string, paramPath: string, value: unknown): void {
  if (!useAutoKeyStore.getState().enabled) return; // OFF → byte-identical pre-P7

  const seconds = useTimeStore.getState().seconds;
  const frame = useTimeStore.getState().frame;
  const dagState = useDagStore.getState().state;

  // `paramAnimationState !== 'none'` ⇔ a KeyframeChannel* already animates
  // this (nodeId, paramPath) — the SAME pure scan the diamond uses (C1).
  const exists =
    paramAnimationState(dagState, nodeId, paramPath, frame) !== 'none';

  let result: { ok: true } | { ok: false; reason: string };
  if (!exists) {
    result = dispatchFirstKeyComposite({ targetId: nodeId, paramPath, value, seconds });
  } else {
    const resolved = resolveChannel(dagState.nodes, nodeId, paramPath, frame);
    if (!resolved) {
      result = { ok: false, reason: 'Auto-Key: channel not found for animated param.' };
    } else {
      result = dispatchMutatorFromUI(
        'mutator.timeline.keyframe',
        { channelId: resolved.channelId, time: seconds, value },
        `Auto-Key ${nodeId}.${paramPath}`,
      );
    }
  }
  if (!result.ok) {
    // eslint-disable-next-line no-alert
    window.alert?.(result.reason);
  }
}
