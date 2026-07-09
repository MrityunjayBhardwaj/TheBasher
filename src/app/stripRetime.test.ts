// stripRetime — unit tests for the strip placement remap (epic #283 Phase 2, Slice B).
// Every expectation is a HAND-COMPUTED Blender `nlastrip_get_frame_actionclip`
// value, verified BEFORE any wiring (RESEARCH risk #1 — the one genuinely-new
// formula is de-risked in isolation).

import { describe, it, expect } from 'vitest';
import { remapStripTime, type StripPlacement } from './stripRetime';

// A 2s Action (keys span [0, 2]) placed at start=0, identity scale/repeat/dir.
const base: StripPlacement = {
  start: 0,
  timeScale: 1,
  repeat: 1,
  reverse: false,
  extrapolate: 'hold',
  actStart: 0,
  actLen: 2,
};

const at = (t: number, over: Partial<StripPlacement> = {}) =>
  remapStripTime(t, { ...base, ...over });

describe('remapStripTime — forward identity (start=0, scale=1, repeat=1)', () => {
  it('maps global time straight to action time inside the range', () => {
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBe(0.5);
    expect(at(1)).toBe(1);
    expect(at(1.5)).toBe(1.5);
  });
  it('the placed end maps to the clip end (not a wrap to 0)', () => {
    expect(at(2)).toBe(2);
  });
});

describe('remapStripTime — start offset', () => {
  it('the Action first key lands at strip.start', () => {
    expect(at(3, { start: 3 })).toBe(0); // strip begins → action t=0
    expect(at(4, { start: 3 })).toBe(1);
    expect(at(5, { start: 3 })).toBe(2); // placed end → clip end
  });
});

describe('remapStripTime — timeScale (>1 = slower)', () => {
  it('a 2× scale stretches the 2s clip over 4s of global time', () => {
    // placedLen = actLen·scale = 4; global t=2 is halfway → action t=1.
    expect(at(2, { timeScale: 2 })).toBe(1);
    expect(at(1, { timeScale: 2 })).toBe(0.5);
    expect(at(4, { timeScale: 2 })).toBe(2); // end → clip end
  });
});

describe('remapStripTime — repeat (loops within the placement)', () => {
  it('wraps into each loop; interior boundary restarts the clip; final end clamps', () => {
    // repeat=2, actLen=2, scale=1 → placedLen=4, one loop = 2s.
    const twice = { repeat: 2 } as Partial<StripPlacement>;
    expect(at(0, twice)).toBe(0);
    expect(at(1, twice)).toBe(1);
    expect(at(2, twice)).toBe(0); // interior loop boundary → start of 2nd loop
    expect(at(3, twice)).toBe(1);
    expect(at(4, twice)).toBe(2); // final placed end → clip end, not a wrap to 0
  });
});

describe('remapStripTime — reverse (plays the clip backwards)', () => {
  it('mirrors within the clip: start→clip-end, end→clip-start', () => {
    // start=3, reverse: last key at t=3, first key at t=5 (design §6 observe).
    const rev = { start: 3, reverse: true } as Partial<StripPlacement>;
    expect(at(3, rev)).toBe(2); // placed start → clip END
    expect(at(4, rev)).toBe(1); // midpoint
    expect(at(5, rev)).toBe(0); // placed end → clip START
  });
});

describe('remapStripTime — extrapolate outside the placed range', () => {
  it("'hold' (default) clamps to the nearest edge on both sides", () => {
    expect(at(-1)).toBe(0); // before start → first frame held
    expect(at(3)).toBe(2); // after end → last frame held
  });
  it("'nothing' contributes null on both sides", () => {
    expect(at(-1, { extrapolate: 'nothing' })).toBeNull();
    expect(at(3, { extrapolate: 'nothing' })).toBeNull();
  });
  it("'hold-forward' is null before start, clamps after end", () => {
    expect(at(-1, { extrapolate: 'hold-forward' })).toBeNull();
    expect(at(3, { extrapolate: 'hold-forward' })).toBe(2);
  });
  it('inside the range every mode agrees with forward', () => {
    for (const extrapolate of ['hold', 'nothing', 'hold-forward'] as const) {
      expect(at(1, { extrapolate })).toBe(1);
    }
  });
});

describe('remapStripTime — non-zero action domain (actStart != 0)', () => {
  it('maps into [actStart, actStart+actLen] so the sampler reads real keys', () => {
    const dom = { actStart: 1, actLen: 2 } as Partial<StripPlacement>; // keys span [1,3]
    expect(at(0, dom)).toBe(1); // placed start → first key time
    expect(at(1, dom)).toBe(2);
    expect(at(2, dom)).toBe(3); // placed end → last key time
  });
});

describe('remapStripTime — degenerate single-instant clip (actLen=0)', () => {
  it("always samples the single key under 'hold'", () => {
    const pt = { actStart: 5, actLen: 0 } as Partial<StripPlacement>;
    expect(at(-1, pt)).toBe(5);
    expect(at(0, pt)).toBe(5);
    expect(at(10, pt)).toBe(5);
  });
  it("respects 'nothing' before start and after the zero-width end", () => {
    const pt = { actStart: 5, actLen: 0, extrapolate: 'nothing' } as Partial<StripPlacement>;
    expect(at(-1, pt)).toBeNull();
    expect(at(0, pt)).toBe(5); // exactly at start
    expect(at(1, pt)).toBeNull();
  });
});
