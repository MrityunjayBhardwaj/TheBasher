// stripRetime — the strip PLACEMENT time remap (NLA, epic #283 Phase 2, Slice B).
//
// The one genuinely-new piece of NLA: given a global time `t` and a Strip's
// placement, return the LOCAL Action time τ to sample. This is placement-level
// retime (start offset / scale / repeat / reverse / extrapolate) — DISTINCT from
// `resolveSampleTime` (which is a WITHIN-Action Stepped/Limits-X F-Modifier remap
// and runs AFTER this, inside the Action's own sampler). The two compose: this
// maps global→action-local; the sampler's own F-Modifier time phase runs on τ.
//
// Grounded on Blender `nlastrip_get_frame_actionclip` (nla.cc:706-768, design I-6):
//   τ = actstart + fmod(t − start, actlen·scale) / scale        (forward)
// with reverse flipping within the clip (nla.cc:748) and repeat extending the
// placed range so fmod wraps within each loop. `scale` (timeScale) > 1 = slower.
//
// PURE — the Action's time domain (`actStart` = min key time, `actLen` = key span)
// is passed IN, never read from a store. Returns `null` for "no contribution at
// this t" (extrapolate 'nothing', or 'hold-forward' before the start). NOTE: Slice
// C wires 'hold' only in v1 (it reduces 'nothing'/'hold-forward' to 'hold' at
// enumeration), so the null-returning branches are correct Blender semantics but
// dead in the wired path until Phase 3 — they are unit-tested here regardless.
//
// REF: docs/NLA-DESIGN.md §3.4/§6 (Phase 2, Slice B), §11 (I-6); RESEARCH.md risk #1.

import type { StripExtrapolate } from '../nodes/types';

/** A Strip's retime placement + the referenced Action's time domain (derived by
 *  the caller in Slice C from the Action's keyframe min/max — pure, no store). */
export interface StripPlacement {
  /** Global time where the Action's first key lands. */
  readonly start: number;
  /** Playback rate; > 1 stretches the Action over more global time (slower). */
  readonly timeScale: number;
  /** Loop count within the placement (≥ 1). */
  readonly repeat: number;
  readonly reverse: boolean;
  readonly extrapolate: StripExtrapolate;
  /** The Action's first key time (its local domain start). */
  readonly actStart: number;
  /** The Action's key-time span (last − first). Zero for a single-key Action. */
  readonly actLen: number;
}

/**
 * Map global time `t` to the local Action time to sample, or `null` when the
 * strip contributes nothing at `t` (extrapolate 'nothing', or 'hold-forward'
 * before the placed start).
 */
export function remapStripTime(t: number, p: StripPlacement): number | null {
  const { start, timeScale, repeat, reverse, extrapolate, actStart, actLen } = p;

  // Degenerate single-instant clip (≤ 1 distinct key time): the placement has
  // zero width, so it always samples that one instant under 'hold'; before start
  // the non-hold modes contribute nothing, and any t past the (zero-width) end is
  // "after" — 'nothing' drops it.
  if (actLen <= 0) {
    if (t < start) return extrapolate === 'hold' ? actStart : null;
    if (t > start && extrapolate === 'nothing') return null;
    return actStart;
  }

  const clipPlaced = actLen * timeScale; // one loop's global duration
  const placedLen = clipPlaced * repeat; // the whole placement's global duration
  let local = t - start; // global → placement-local

  // Extrapolation outside the placed range [0, placedLen].
  if (local < 0) {
    if (extrapolate !== 'hold') return null; // 'nothing' / 'hold-forward' → nothing before start
    local = 0; // 'hold' → clamp to the start edge
  } else if (local > placedLen) {
    if (extrapolate === 'nothing') return null; // 'nothing' → nothing after end
    local = placedLen; // 'hold' / 'hold-forward' → clamp to the end edge
  }

  // Within [0, placedLen]: wrap into one loop, convert to action time. `phase` is
  // the action-local offset in [0, actLen]. The exact end maps to `actLen` (the
  // clip's end) rather than fmod-wrapping to 0, so a held/looped end shows the last
  // frame instead of snapping back to the clip start.
  let phase: number;
  if (local >= placedLen) {
    phase = actLen;
  } else {
    const loopLocal = repeat > 1 ? local % clipPlaced : local; // global offset within the current loop
    phase = loopLocal / timeScale; // → action-local time in [0, actLen)
  }

  return reverse ? actStart + actLen - phase : actStart + phase;
}
