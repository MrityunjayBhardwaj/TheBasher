// The clip's own per-bone sampler (`buildClipBoneSamplers`): what it does with params nothing
// re-validated, and which time domain its extend rule runs over. These rows lived with the clone
// road's clip band (#888), which read through this sampler; the band retired with the clone road's
// character half (#1053), and the sampler's behaviour is kept here, where it lives.

import { describe, it, expect } from 'vitest';
import { buildClipBoneSamplers } from './AnimationClip';

describe('#888 — a clip’s params reach the sampler unre-validated, so it must survive them', () => {
  it('a non-positive or NaN duration folds to 0 rather than producing NaN poses', () => {
    // The schema forbids these, but a caller can hand `clip.params` straight off a
    // saved file — the schema guards the NODE's inputs, not this path. `x % 0`
    // is NaN in JS, and a NaN would propagate through every lerp into a bone
    // pose of NaNs: a limb that silently vanishes rather than an error anyone
    // can trace back here.
    for (const duration of [0, -1, Number.NaN]) {
      const sampler = buildClipBoneSamplers({
        duration,
        loop: 'cycle-offset',
        keyframes: [
          { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 0, time: 1, position: [0, 9, 0], rotation: [0, 0, 0] },
        ],
      } as never).get(0)!;
      const p = sampler(0.5).position;
      expect(Number.isFinite(p[1])).toBe(true);
      expect(p[1]).toBe(1); // the first key, which is what "no time domain" means
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #924 — WHICH DOMAIN the extend rule runs over. This is a behaviour change the
// fix carries beyond the seam it was filed for, so it is stated rather than left
// to be discovered: the domain is the clip's KEY RANGE, not its declared
// `duration`.
//
// It closes a latent divergence rather than opening one. A minted channel has
// only its keys — its Cycles modifier repeats the KEY range — while the clip band
// used to fold on `duration`. Whenever the two disagreed, an edited bone and an
// unedited one rendered different motion, and nothing said so. They now read the
// same domain by construction.
//
// Blender draws the same line: a Cycles F-Modifier repeats the keyframe range,
// and an action's frame range is separate metadata that "does not make the action
// cycle on its own".
// ─────────────────────────────────────────────────────────────────────────
describe('#924 the extend domain is the key range, not the declared duration', () => {
  /** Keys spanning [0,3] on a clip that CLAIMS duration 2 — deliberately unequal. */
  const KEYS = [
    { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 3, position: [0, 3, 0], rotation: [0, 0, 0] },
  ];

  it('a non-looping clip holds its LAST KEY, not the value at `duration`', () => {
    const s = buildClipBoneSamplers({ keyframes: KEYS, duration: 2, loop: 'hold' } as never).get(
      0,
    )!;
    // Inside the keys but past the declared duration: the authored key wins, so
    // this reads 2.5. Clamping to `duration` first would truncate the last third
    // of the authored motion and read 2.
    expect(s(2.5).position[1]).toBeCloseTo(2.5, 6);
    // Far outside: hold the last KEY (3), not the value at `duration` (2).
    expect(s(9).position[1]).toBeCloseTo(3, 6);
  });

  it('a looping clip cycles over the key range, so one period out is one key span', () => {
    const s = buildClipBoneSamplers({
      keyframes: KEYS,
      duration: 2,
      loop: 'cycle-offset',
    } as never).get(0)!;
    // Period 3 (the key span), not 2 (the declared duration). At t = 3.5 the
    // mapped time is 0.5 and one span of travel has accumulated: 0.5 + 3 = 3.5.
    // A duration-period would map t = 3.5 to 1.5 and read a different number, so
    // this row distinguishes the two domains rather than merely showing a cycle.
    expect(s(3.5).position[1]).toBeCloseTo(3.5, 6);
  });
});
