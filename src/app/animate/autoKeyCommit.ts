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
 * THE single animated-param edit-route gate (P7.3 / D-02 — lifted here in
 * P7.4 W5.1 / D-05 so it has TWO callers: the viewport gizmo grab AND the
 * NPanel inspector value-commit handlers). Body is BYTE-IDENTICAL to the
 * prior Gizmo.tsx module-private `routeAnimatedGrab` — `selectedId` is now a
 * PARAMETER instead of a closure read; nothing else changed (verified: the
 * p7.3 gizmo e2e + NPanel suite stay green after the extraction).
 *
 * Re-route BEFORE the caller's raw `setParam`. Branch order is load-bearing
 * and must be preserved exactly: animated check → playing gate → AutoKey-OFF
 * alert → AutoKey-ON autoKeyCommit.
 *
 *   - un-animated param → false: caller falls through to the EXISTING raw
 *     setParam dispatch, byte-unchanged (today's behavior, D-02). For the
 *     NPanel caller this means the existing `setParam` + separate
 *     `autoKeyCommit` (the un-animated AutoKey-ON first-key composite — the
 *     "Animate this" path — MUST survive: matrix rows 1-2).
 *   - animated + playing → handled here, returns true (no op — during
 *     playback the surface is display-follow, D-03; belt-and-suspenders with
 *     the gizmo's enabled={!playing} and the inspector's W2.1 readOnly gate).
 *   - animated + paused + Auto-Key OFF → reject with a surfaced reason,
 *     ZERO ops, returns true. *** NET-NEW BEHAVIOR — DO NOT DELETE
 *     (FLAG-A): pre-D-05 NPanel returned SILENTLY on Auto-Key OFF; there
 *     was NO NPanel OFF-path feedback to be redundant with. A silent edit
 *     that does nothing is the exact #68/#77-class silent failure this
 *     route exists to kill. The window.alert is only the browser PRIMITIVE
 *     reuse, not a reuse of any NPanel OFF behavior. NOTE (D-05 intentional
 *     delta, matrix row 4): routing the inspector through this MEANS NPanel
 *     is no longer byte-silent on OFF — that is expected and desired. ***
 *   - animated + paused + Auto-Key ON → autoKeyCommit (the shared P7 seam
 *     chokepoint — closure-gated V13, Op-only V1), returns true so the raw
 *     setParam does NOT also fire (H36 anti-double-write — the whole point).
 *
 * Returns true  ⇒ the route was handled here (caller must NOT setParam, and
 *                  must NOT separately call autoKeyCommit — the seam keyed).
 * Returns false ⇒ un-animated, caller proceeds with its EXISTING path.
 */
export function routeAnimatedGrab(
  selectedId: string,
  paramPath: string,
  value: unknown,
): boolean {
  if (!selectedId) return false;
  const state = useDagStore.getState().state;
  const grabFrame = useTimeStore.getState().frame;
  const animated = paramAnimationState(state, selectedId, paramPath, grabFrame) !== 'none';
  if (!animated) return false; // un-animated → raw setParam, byte-identical

  // D-03 paused gate: during playback the surface is display-follow only.
  if (useTimeStore.getState().playing) return true; // handled: no op

  // Auto-Key read LIVE at grab time (never a render closure — staleness
  // pre-mortem). OFF → reject with a surfaced reason, ZERO ops.
  if (!useAutoKeyStore.getState().enabled) {
    // *** NET-NEW — DO NOT DELETE (FLAG-A). pre-D-05 NPanel was byte-silent
    // on OFF; D-05 intentionally surfaces this (matrix row 4). ***
    // eslint-disable-next-line no-alert
    window.alert?.(`${paramPath} is animated — enable Auto-Key or edit the curve.`);
    return true; // handled: rejected, zero ops
  }

  // Auto-Key ON → the SHARED seam chokepoint (one path, two callers).
  // RETURN true so the raw setParam below does NOT also fire (H36).
  autoKeyCommit(selectedId, paramPath, value);
  return true;
}

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
    const kfs = Array.isArray(p.keyframes) ? (p.keyframes as { time: number }[]) : [];
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
  const exists = paramAnimationState(dagState, nodeId, paramPath, frame) !== 'none';

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
