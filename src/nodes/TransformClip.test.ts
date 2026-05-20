// TransformClip evaluator tests — Wave B2.
//
// Locks the sampler contract: piecewise-linear, loop/clamp, absent-key
// for un-targeted nodes, and **degrees Euler** for rotation
// (CHECKPOINT B3 — SECTION-INVENTORY.md). The unit choice is asserted
// at the evaluator layer because a future drift (someone "fixes" the
// rotation by multiplying π/180) is exactly the trap RESEARCH Q3 warns
// about.
//
// REF: PLAN.md Wave B; AnimationClip.test.ts (precedent).

import { describe, expect, it } from 'vitest';
import { TransformClipNode, TransformClipParams } from './TransformClip';
import type { TimeValue, TransformClipValue } from './types';

function makeTime(seconds: number): TimeValue {
  return { frame: 0, seconds, normalized: 0 };
}

function evalClip(
  params: Parameters<typeof TransformClipParams.parse>[0],
  time: TimeValue | undefined,
): TransformClipValue {
  const parsed = TransformClipParams.parse(params);
  return TransformClipNode.evaluate(parsed, time ? { time } : {}) as TransformClipValue;
}

describe('TransformClip evaluator', () => {
  it('returns empty tracks when time input is absent', () => {
    const v = evalClip({ duration: 1, loop: 'clamp', keyframes: [] }, undefined);
    expect(v.kind).toBe('TransformClip');
    expect(v.tracks).toEqual({});
  });

  it('single keyframe at t=0 returns that keyframe at any sample time', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'clamp',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [5, 6, 7],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      makeTime(0.7),
    );
    expect(v.tracks.cube.position).toEqual([5, 6, 7]);
  });

  it('two keyframes interpolate piecewise-linearly between them', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'clamp',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          {
            targetNodeId: 'cube',
            time: 1,
            position: [1, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      makeTime(0.5),
    );
    expect(v.tracks.cube.position[0]).toBeCloseTo(0.5, 6);
    expect(v.tracks.cube.position[1]).toBe(0);
    expect(v.tracks.cube.position[2]).toBe(0);
  });

  it('loop mode folds time into [0, duration)', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'loop',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          {
            targetNodeId: 'cube',
            time: 1,
            position: [1, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      // t = duration*2 + 0.3 → folds to 0.3 → position[0] ≈ 0.3
      makeTime(1 * 2 + 0.3),
    );
    expect(v.tracks.cube.position[0]).toBeCloseTo(0.3, 6);
  });

  it('clamp mode pins post-end time to the last keyframe', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'clamp',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          {
            targetNodeId: 'cube',
            time: 1,
            position: [1, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      makeTime(5),
    );
    expect(v.tracks.cube.position).toEqual([1, 0, 0]);
  });

  it('multi-target: keyframed target appears, un-keyframed target is absent', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'clamp',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      makeTime(0),
    );
    expect(v.tracks.cube).toBeDefined();
    expect(v.tracks.otherChild).toBeUndefined();
  });

  // CHECKPOINT B3 lock: rotation is DEGREES Euler XYZ.
  // Two keyframes at 0deg → 180deg about X over t=[0,1]; sample at 0.5
  // must return ≈ 90 (degrees). A future drift to radians would give
  // ~π/2 ≈ 1.5708 and this test fires immediately.
  // SECTION-INVENTORY.md B3 documents the seam.
  it('rotation is stored + interpolated in DEGREES (B3 CHECKPOINT)', () => {
    const v = evalClip(
      {
        duration: 1,
        loop: 'clamp',
        keyframes: [
          {
            targetNodeId: 'cube',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          {
            targetNodeId: 'cube',
            time: 1,
            position: [0, 0, 0],
            rotation: [180, 0, 0],
            scale: [1, 1, 1],
          },
        ],
      },
      makeTime(0.5),
    );
    expect(v.tracks.cube.rotation[0]).toBeCloseTo(90, 6);
    // Negative assertion: NOT radians (π/2 ≈ 1.5708).
    expect(v.tracks.cube.rotation[0]).toBeGreaterThan(10);
  });

  it('deterministic: identical (params, time) → byte-identical output', () => {
    const params = {
      duration: 1,
      loop: 'clamp' as const,
      keyframes: [
        {
          targetNodeId: 'cube',
          time: 0,
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        {
          targetNodeId: 'cube',
          time: 1,
          position: [1, 2, 3] as [number, number, number],
          rotation: [10, 20, 30] as [number, number, number],
          scale: [2, 2, 2] as [number, number, number],
        },
      ],
    };
    const a = evalClip(params, makeTime(0.42));
    const b = evalClip(params, makeTime(0.42));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
