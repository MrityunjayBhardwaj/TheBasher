// #1211 — a Skeleton's `pose` output: the skeleton standing at rest, the source at the bottom of a pose
// chain whose motion lives in pose layers (step 4 of "Bones as Channels", #1233). The oracle is the
// rest transform each bone states, not the sampler under test.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import { emptyDagState } from '../core/dag/state';
import { registerAllNodes } from './registerAll';
import { quatFromEulerXYZ } from './bonePose';
import type { BoneSpec, PosedSkeletonValue, SkeletonValue } from './types';

const BONES: BoneSpec[] = [
  { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  {
    name: 'Arm.001',
    parent: 0,
    position: [0, 1, 0],
    rotation: [0.3, -0.7, 1.1],
    scale: [1, 2, 0.5],
  },
];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function skeletonState() {
  return applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: 'sk',
    nodeType: 'Skeleton',
    params: { bones: BONES },
  }).next;
}

describe('Skeleton.pose — the rest pose (#1211)', () => {
  it('stands every bone at its own rest transform, by name, at any time', () => {
    const state = skeletonState();
    const pose = evaluate(state, 'sk', { socket: 'pose' }).value as PosedSkeletonValue;
    expect(pose.kind).toBe('PosedSkeleton');
    for (const seconds of [0, 0.5, 7]) {
      const at = pose.sample(seconds);
      expect(at.map((b) => b.name)).toEqual(['Root', 'Arm.001']);
      expect(at[1].position).toEqual([0, 1, 0]);
      expect(at[1].scale).toEqual([1, 2, 0.5]);
      const q = quatFromEulerXYZ([0.3, -0.7, 1.1]);
      at[1].quaternion.forEach((c, i) => expect(c).toBeCloseTo(q[i], 12));
      expect(at[0].scale).toEqual([1, 1, 1]);
    }
  });

  it('is built once: every sample returns the same list', () => {
    const pose = evaluate(skeletonState(), 'sk', { socket: 'pose' }).value as PosedSkeletonValue;
    expect(pose.sample(0)).toBe(pose.sample(3));
  });

  it('keeps `out` the skeleton itself, and the pose names that skeleton', () => {
    // One evaluation, both sockets: the pose must be built on the skeleton the node hands out.
    const both = evaluate(skeletonState(), 'sk').value as {
      out: SkeletonValue;
      pose: PosedSkeletonValue;
    };
    const { out, pose } = both;
    expect(out.kind).toBe('Skeleton');
    expect(out.bones.map((b) => b.name)).toEqual(['Root', 'Arm.001']);
    expect(pose.skeleton).toBe(out);
  });
});
