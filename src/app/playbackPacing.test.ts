// #1733 — the playback step, against Blender's (screen_ops.cc:6149-6191).

import { describe, expect, it } from 'vitest';
import { createPacer, framesDue, meterStep } from './playbackPacing';

const FPS = 60;

/** Steps for a run of ticks `ms` apart. */
function run(sync: 'drop' | 'every', ms: number[]): number[] {
  const p = createPacer();
  return ms.map((m) => framesDue(p, sync, m / 1000, FPS));
}

describe('#1733 — drop frames keeps real time', () => {
  it('a 150 ms frame advances 9 frames: real time, in whole frames', () => {
    const steps = run('drop', Array(20).fill(150));
    expect(steps.every((s) => s === 9)).toBe(true);
    // 20 ticks × 150 ms = 3 s = 180 frames.
    expect(steps.reduce((a, b) => a + b, 0)).toBe(180);
  });

  it('the fraction is carried: 40 ms ticks advance 2, 2, 3, 2, 3 … and keep real time', () => {
    const steps = run('drop', Array(30).fill(40));
    expect(new Set(steps)).toEqual(new Set([2, 3]));
    // 30 × 40 ms = 1.2 s = 72 frames; the carried fraction may still hold under one frame.
    const total = steps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(71);
    expect(total).toBeLessThanOrEqual(72);
  });

  it('a step under one frame is one frame, and drops the fraction (Blender: no jitter)', () => {
    const p = createPacer();
    expect(framesDue(p, 'drop', 0.0158, FPS)).toBe(1);
    expect(p.lagging).toBe(0);
  });

  it('a hidden tab resumes one frame on, not a jump', () => {
    expect(run('drop', [30_000])).toEqual([1]);
  });
});

describe('#1733 — every frame shows every frame', () => {
  it('a 150 ms frame advances one frame', () => {
    expect(run('every', Array(10).fill(150))).toEqual(Array(10).fill(1));
  });
});

describe('#1733 — a display faster than the scene does not speed it up', () => {
  for (const sync of ['drop', 'every'] as const) {
    it(`${sync}: at 120 Hz every other tick steps, one frame each`, () => {
      const steps = run(sync, Array(120).fill(1000 / 120));
      expect(steps.reduce((a, b) => a + b, 0)).toBe(60);
      expect(Math.max(...steps)).toBe(1);
    });
  }

  it('at 60 Hz with vsync jitter, every tick steps', () => {
    const jitter = Array.from({ length: 60 }, (_, i) => 1000 / 60 + (i % 2 ? -0.9 : 0.9));
    expect(run('drop', jitter).every((s) => s >= 1)).toBe(true);
  });
});

describe('#1733 — the achieved rate', () => {
  it('counts steps per real second over each half-second window', () => {
    const p = createPacer();
    const rates: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const r = meterStep(p, i * 50); // a step every 50 ms = 20 per second
      if (r !== null) rates.push(r);
    }
    expect(rates.length).toBeGreaterThan(1);
    for (const r of rates) expect(r).toBeCloseTo(20, 6);
  });
});
