// ParamDiamond — the 3(+1)-state inspector keyframe diamond.
//
// Extracted from NPanel.tsx (#190) so more than one inspector control can render
// the SAME keying affordance without a circular import: the generic ParamRows
// (NPanel) AND the custom CameraLensControls (camera fov/near/far) both import
// it from here. One diamond, one keying spine, no drift.
//
// The 3-state derivation (D-01 entry / D-03 viz). Owns NO state — renders derived
// `paramAnimationState` and dispatches through the Wave A seam. Subscribes to
// `useTimeStore((s) => s.frame)` so it re-derives on scrub. Never reads
// currentFrameRef (V20).
//
// - hollow ◇  → 'none'   : click = first-key (addLayer+addChannel+keyframe, or
//                          for a camera the #190 free-floating channel)
// - filled ◆  → 'animated' (off-key) : click = single keyframe Mutator
// - record ◆  → 'on-key' : click (or Alt-click) = removeKeyframes (scope:{time})
// - orange ◆  → transient (held-but-not-keyed) : top of display precedence
//
// Every Mutator call passes `useTimeStore.getState().seconds` (never a frame
// int) — the on-key check via C1 is the only place frames are used.
//
// REF: issue #68/#149/#190; vyapti V1/V13/V20; hetvabhasa H40.

import { useDagStore } from '../core/dag/store';
import { dispatchMutatorFromUI } from './animate/dispatchMutator';
import { keyParamFromTransient, resolveChannel } from './animate/autoKeyCommit';
import { paramAnimationState } from './animate/paramAnimationState';
import { useTimeStore } from './stores/timeStore';
import { keyOf, useTransientEditStore } from './stores/transientEditStore';

export function ParamDiamond({
  nodeId,
  paramPath,
  value,
}: {
  nodeId: string;
  paramPath: string;
  value: unknown;
}) {
  const frame = useTimeStore((s) => s.frame);
  const nodes = useDagStore((s) => s.state.nodes);
  const dagState = useDagStore((s) => s.state);

  const animState = paramAnimationState(dagState, nodeId, paramPath, frame);
  // #149 F1 — the 4th color (orange). SUBSCRIBED selector (not a getState
  // snapshot) so the diamond re-renders the moment the transient is set/cleared
  // (B12). A transient only exists on an ANIMATED param (routeAnimatedGrab
  // returns false for un-animated), so it always coincides with animState !==
  // 'none' — but orange wins display regardless (the unsaved edit is the most
  // urgent signal, the Blender contract). This is FLAG-A's replacement safety
  // net: orange = "held but not persisted" (supersedes the removed reject alert).
  const isTransient = useTransientEditStore((s) => s.edits.has(keyOf(nodeId, paramPath)));

  const glyph = animState === 'none' && !isTransient ? '◇' : '◆';
  const colorClass = isTransient
    ? 'text-warn' // orange — edited-but-not-keyed (transient), TOP of precedence
    : animState === 'on-key'
      ? 'text-record' // yellow — keyed here
      : animState === 'animated'
        ? 'text-accent' // green — animated, no key here
        : 'text-fg/40 hover:text-accent'; // gray — not animated

  const onActivate = (alt: boolean) => {
    // DELETE path (unchanged): an on-key click OR Alt-click on an animated param
    // removes the on-key sample (Blender's toggle). Off-key Alt is a silent no-op.
    if (animState !== 'none' && (animState === 'on-key' || alt)) {
      const resolved = resolveChannel(nodes, nodeId, paramPath, frame);
      if (!resolved) {
        window.alert?.('Channel not found for animated param.');
        return;
      }
      const t = resolved.onKeySeconds ?? null;
      if (t === null) return; // Alt off-key → silent no-op
      const del = dispatchMutatorFromUI(
        'mutator.timeline.removeKeyframes',
        { channelId: resolved.channelId, scope: { time: t } },
        `Delete key ${nodeId}.${paramPath}`,
      );
      if (!del.ok) {
        window.alert?.(del.reason);
      }
      return;
    }

    // INSERT/KEY path — #149 E1: the SHARED fork (keyParamFromTransient) captures
    // the HELD TRANSIENT value (the orange edit) when present, else the authored
    // `value`, then clears the slot on success. The SAME helper K/I uses (E2), so
    // the diamond and the viewport gesture cannot drift.
    const result = keyParamFromTransient(nodeId, paramPath, value);
    if (!result.ok) {
      window.alert?.(result.reason);
    }
  };

  return (
    <button
      type="button"
      data-testid={`inspector-diamond-${nodeId}-${paramPath}`}
      data-anim-state={animState}
      data-transient={isTransient || undefined}
      aria-label={`Toggle keyframe for ${paramPath} (${animState})`}
      title="Click to key/unkey at the playhead. Alt-click to delete a key."
      className={`select-none px-1 text-[11px] leading-none ${colorClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
      onClick={(e) => onActivate(e.altKey)}
    >
      {glyph}
    </button>
  );
}
