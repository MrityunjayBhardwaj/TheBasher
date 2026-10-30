// #1731 (4.3) — an armature's pose is sampled once per time, whoever asks.

import { describe, expect, it } from 'vitest';
import { samplePose, poseSampleCounts } from './poseSample';
import type { BonePose, PosedSkeletonValue } from './types';

function counted(name: string): { pose: PosedSkeletonValue; runs: () => number } {
  let runs = 0;
  const pose = {
    kind: 'PosedSkeleton',
    skeleton: { kind: 'Skeleton', bones: [] },
    sample: (seconds: number): readonly BonePose[] => {
      runs++;
      return [{ name, position: [seconds, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }];
    },
  } as unknown as PosedSkeletonValue;
  return { pose, runs: () => runs };
}

describe('#1731 — samplePose', () => {
  it('a second reader at the same time gets the first reader’s answer, without sampling', () => {
    const a = counted('a');
    const first = samplePose(a.pose, 0.5);
    const before = poseSampleCounts();
    expect(samplePose(a.pose, 0.5)).toBe(first);
    expect(samplePose(a.pose, 0.5)).toBe(first);
    expect(a.runs()).toBe(1);
    const after = poseSampleCounts();
    expect(after.asked - before.asked).toBe(2);
    expect(after.sampled - before.sampled).toBe(0);
  });

  it('a new time samples again, and the answer is that time’s', () => {
    const a = counted('a');
    samplePose(a.pose, 0.5);
    expect(samplePose(a.pose, 0.75)[0].position[0]).toBe(0.75);
    expect(a.runs()).toBe(2);
  });

  it('two armatures keep their own answers at the same time', () => {
    const a = counted('a');
    const b = counted('b');
    samplePose(a.pose, 1);
    expect(samplePose(b.pose, 1)[0].name).toBe('b');
    expect(samplePose(a.pose, 1)[0].name).toBe('a');
    expect(a.runs() + b.runs()).toBe(2);
  });
});
