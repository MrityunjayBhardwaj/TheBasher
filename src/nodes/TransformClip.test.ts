// TransformClip evaluator tests — Wave B2 + P7.10 Wave A (#114).
//
// Locks the sampler contract: piecewise-linear, loop/clamp, absent-key
// for un-targeted nodes, and **degrees Euler** for rotation
// (CHECKPOINT B3 — SECTION-INVENTORY.md). The unit choice is asserted
// at the evaluator layer because a future drift (someone "fixes" the
// rotation by multiplying π/180) is exactly the trap RESEARCH Q3 warns
// about.
//
// P7.10 (B13 Pass 3, #114) — value-shape change: TransformClipValue now
// carries `.sample(seconds)` instead of a pre-baked `.tracks` map. These
// tests assert the same byte-identical interpolation contract via the
// new shape. The behavior (piecewise-linear, loop/clamp, degrees) is
// unchanged; only the call shape moves from `value.tracks[id]` to
// `value.sample(t)[id]`. Also asserts the new contract: TransformClip
// has NO `time` input socket — time enters via `.sample(seconds)`.
//
// REF: PLAN.md Wave B; AnimationClip.test.ts (precedent); PLAN 7.10 Wave A.

import { describe, expect, it } from 'vitest';
import { TransformClipNode, TransformClipParams } from './TransformClip';
import type { TransformClipValue } from './types';

function evalClip(params: Parameters<typeof TransformClipParams.parse>[0]): TransformClipValue {
  const parsed = TransformClipParams.parse(params);
  return TransformClipNode.evaluate(parsed, {}) as TransformClipValue;
}

describe('TransformClip evaluator', () => {
  // P7.10 — V3 amend lock. The Time input socket is GONE; the schema
  // declares no inputs. Time enters via .sample(seconds). Detection:
  // a future revert that re-adds `time: { type: 'Time', ... }` to inputs
  // restores the per-frame cache-miss propagation that B13 fixed.
  it('declares no inputs — time enters via .sample(seconds) (V3 amend)', () => {
    expect(TransformClipNode.inputs).toEqual({});
  });

  it('returns empty sample map for empty keyframes', () => {
    const v = evalClip({ duration: 1, loop: 'clamp', keyframes: [] });
    expect(v.kind).toBe('TransformClip');
    expect(v.sample(0)).toEqual({});
    expect(v.sample(0.5)).toEqual({});
  });

  it('single keyframe at t=0 returns that keyframe at any sample time', () => {
    const v = evalClip({
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
    });
    expect(v.sample(0.7).cube.position).toEqual([5, 6, 7]);
    // Same closure invoked at different time → still pinned (single keyframe).
    expect(v.sample(0).cube.position).toEqual([5, 6, 7]);
    expect(v.sample(2).cube.position).toEqual([5, 6, 7]);
  });

  it('two keyframes interpolate piecewise-linearly between them', () => {
    const v = evalClip({
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
    });
    const tracks = v.sample(0.5);
    expect(tracks.cube.position[0]).toBeCloseTo(0.5, 6);
    expect(tracks.cube.position[1]).toBe(0);
    expect(tracks.cube.position[2]).toBe(0);
  });

  it('loop mode folds time into [0, duration)', () => {
    const v = evalClip({
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
    });
    // t = duration*2 + 0.3 → folds to 0.3 → position[0] ≈ 0.3
    expect(v.sample(1 * 2 + 0.3).cube.position[0]).toBeCloseTo(0.3, 6);
  });

  it('clamp mode pins post-end time to the last keyframe', () => {
    const v = evalClip({
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
    });
    expect(v.sample(5).cube.position).toEqual([1, 0, 0]);
  });

  it('multi-target: keyframed target appears, un-keyframed target is absent', () => {
    const v = evalClip({
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
    });
    const tracks = v.sample(0);
    expect(tracks.cube).toBeDefined();
    expect(tracks.otherChild).toBeUndefined();
  });

  // CHECKPOINT B3 lock: rotation is DEGREES Euler XYZ.
  // Two keyframes at 0deg → 180deg about X over t=[0,1]; sample at 0.5
  // must return ≈ 90 (degrees). A future drift to radians would give
  // ~π/2 ≈ 1.5708 and this test fires immediately.
  // SECTION-INVENTORY.md B3 documents the seam.
  it('rotation is stored + interpolated in DEGREES (B3 CHECKPOINT)', () => {
    const v = evalClip({
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
    });
    const tracks = v.sample(0.5);
    expect(tracks.cube.rotation[0]).toBeCloseTo(90, 6);
    // Negative assertion: NOT radians (π/2 ≈ 1.5708).
    expect(tracks.cube.rotation[0]).toBeGreaterThan(10);
  });

  it('deterministic: identical (params, sample-time) → byte-identical tracks', () => {
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
    const a = evalClip(params).sample(0.42);
    const b = evalClip(params).sample(0.42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // P7.10 — closure-reuse property: the SAME closure invoked at different
  // times produces the corresponding interpolated tracks. This is the
  // mechanism that lets GltfAssetR's useFrame call .sample(currentTime)
  // every frame without re-evaluating the DAG. Detection: a future revert
  // that captures `seconds` at evaluate time (instead of as a parameter)
  // would fail this test — same closure would return the same tracks
  // regardless of the sample-time argument.
  it('same closure samples different times → corresponding interpolated tracks', () => {
    const v = evalClip({
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
          position: [10, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    });
    expect(v.sample(0).cube.position[0]).toBeCloseTo(0, 6);
    expect(v.sample(0.5).cube.position[0]).toBeCloseTo(5, 6);
    expect(v.sample(1).cube.position[0]).toBeCloseTo(10, 6);
  });
});
