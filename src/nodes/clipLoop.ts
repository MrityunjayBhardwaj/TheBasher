// ClipLoop — the ONE vocabulary for what a clip does past its last key.
//
// ─────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS REPLACES
// ─────────────────────────────────────────────────────────────────────────
// Two clip carriers spelled one concept two ways, with OPPOSITE defaults:
//
//     TransformClip.loop  z.enum(['loop', 'clamp']).default('clamp')
//     AnimationClip.loop  z.boolean().default(true)
//
// So an AnimationClip whose params omitted the key cycled, and a TransformClip
// whose params omitted it clamped. `clipChannelRows` already had to normalise
// the two at the one place they meet.
//
// The reference settles which default is right: F-Curve extrapolation is a
// two-value enum defaulting to CONSTANT (hold), and cycling is DELIBERATELY
// absent from it — it arrives as a separate modifier whose per-side mode
// defaults to none. So holding is the reference's answer in both places, and
// the boolean's `true` was the outlier rather than the enum's `clamp`.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THREE VALUES AND NOT TWO
// ─────────────────────────────────────────────────────────────────────────
// A boolean could only ever pick between two of the three behaviours the
// sampler already implements, and it picked the wrong pair: `true` mapped to
// cycle-WITH-OFFSET on position, so asking a walk to repeat always brought
// travel with it and **cycle-in-place was unreachable** — a director could not
// ask for a walk on the spot.
//
// The three are the reference's own distinction, not an invention here: its
// cycles modifier separates "repeat the keyframe range as-is" from "repeat with
// an offset based on the gradient between start and end values". That is the
// difference between a treadmill walk and one that covers ground, and between a
// seamless loop and a teleport every period.
//
// ─────────────────────────────────────────────────────────────────────────
// BOTH CARRIERS NOW TAKE ALL THREE (#934)
// ─────────────────────────────────────────────────────────────────────────
// They did not always. `TransformClip` took `hold | cycle` only, because it
// folds TIME (`t % duration`) rather than extending per-component values, and
// offering `cycle-offset` there would have silently degraded to plain cycling —
// the quiet-wrong-answer shape this codebase keeps finding. The note here said
// "unreachable beats degraded: giving TransformClip a real offset is its own
// slice", and #934 is that slice: it keeps the fold and ADDS the per-period
// position delta, so the value is real rather than accepted-and-ignored.
//
// The subset split is therefore gone, and with it the translation that used to
// sit at the mint seam, where a `cycle` TransformClip minted a channel that
// TRAVELLED while the clip itself cycled in place. One concept, one spelling,
// the same meaning on both carriers and on the channels minted from them.
//
// REF: src/nodes/keyframeInterp.ts (ChannelExtend — the superset this draws
//      from); src/nodes/AnimationClip.ts (clipExtendRules); src/nodes/
//      TransformClip.ts (the time fold); src/timeline/clipChannelRows.ts (where
//      the two used to be normalised); issues #930, #927, #924.

import { z } from 'zod';
import type { ChannelExtend } from './keyframeInterp';

/** What a clip does past its authored range. A subset of {@link ChannelExtend}:
 *  `mirror` and `slope` are per-channel authoring rules, not transport intent. */
export type ClipLoop = 'hold' | 'cycle' | 'cycle-offset';

/**
 * Every clip carrier's `loop`, defaulting to HOLD.
 *
 * The default is the behaviour change this schema exists to make, so it is not
 * incidental: a stored project that omits the key used to cycle on one carrier
 * and hold on the other. Nothing relies on the old default any more, because the
 * v10 → v11 migration writes every existing clip's value explicitly — the
 * default now only decides what a NEWLY created clip does.
 */
export const ClipLoopSchema = z.enum(['hold', 'cycle', 'cycle-offset']).default('hold');

/**
 * The per-component extend rule a clip's transport intent implies.
 *
 * POSITION is the only component that differs between `cycle` and
 * `cycle-offset`, and ROTATION never offsets under either: rotation is bounded
 * and returns to its start, so adding a residual every period would compound it
 * without bound. Offset is self-limiting on position — for a bone whose track is
 * constant, `last === first` and the offset is exactly zero — which is why it can
 * be applied to every bone rather than only the root.
 */
export function clipExtendRules(loop: ClipLoop): {
  position: ChannelExtend;
  rotation: ChannelExtend;
} {
  // Normalised on the way in even though the parameter is typed. Params reach
  // this from stored JSON, where the type is a promise rather than a guarantee —
  // and an unrecognised value used to fall out of the switch as `undefined`,
  // which destructures into a crash two frames away from the bad data. Holding
  // is the honest answer for a value nobody can interpret.
  switch (clipLoopOf(loop)) {
    case 'cycle-offset':
      return { position: 'cycle-offset', rotation: 'cycle' };
    case 'cycle':
      return { position: 'cycle', rotation: 'cycle' };
    case 'hold':
      return { position: 'hold', rotation: 'hold' };
  }
}

/**
 * Normalise a stored `loop` to the tri-state — the ONE place that answers "what
 * does an unset or unrecognised value mean".
 *
 * That question having had several answers is the defect #930 records: five
 * readers each spelled their own fallback (`?? true`, `!== false`) and all five
 * disagreed with the sibling carrier's schema default. After the v10 → v11
 * migration every stored clip carries an explicit value, so this is a backstop
 * rather than a road — but a backstop that agrees with the schema, instead of
 * five that agree with each other and not with it.
 */
export function clipLoopOf(raw: unknown): ClipLoop {
  return raw === 'cycle' || raw === 'cycle-offset' || raw === 'hold' ? raw : 'hold';
}

/** Does this clip repeat at all? The half of the question a boolean could ask. */
export function isCycling(loop: ClipLoop): boolean {
  return loop !== 'hold';
}
