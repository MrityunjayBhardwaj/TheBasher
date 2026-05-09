// BVH parser unit tests.
//
// Synthetic 3-bone "wave" BVH text fixture: a chest + 1 arm bone. Two
// frames at 30fps so the clip duration is 1/30s. The hierarchy + offsets
// follow the BVH spec verbatim — no external file needed.

import { describe, expect, it } from 'vitest';
import { parseBvh } from './bvh';

const SYNTHETIC_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    JOINT ArmL
    {
      OFFSET 0.5 0.0 0.0
      CHANNELS 3 Xrotation Yrotation Zrotation
      End Site
      {
        OFFSET 0.0 -0.5 0.0
      }
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0.0 1.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 45.0 0.0
0.0 1.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 -45.0 0.0
`;

describe('parseBvh', () => {
  it('extracts the BVH hierarchy with parent indices (incl. End Site terminals)', () => {
    // THREE.BVHLoader treats every End Site as a bone (no channels but a
    // bone with offset). Reflect that: 3 named bones + 1 end-site = 4.
    const r = parseBvh(SYNTHETIC_BVH, 'wave');
    expect(r.skeletonParams.bones).toHaveLength(4);
    const [hips, spine, armL] = r.skeletonParams.bones;
    expect(hips.name).toBe('Hips');
    expect(hips.parent).toBe(-1);
    expect(spine.name).toBe('Spine');
    expect(spine.parent).toBe(0);
    expect(armL.name).toBe('ArmL');
    expect(armL.parent).toBe(1);
    // End site terminal: parent = ArmL index, no channels.
    expect(r.skeletonParams.bones[3].parent).toBe(2);
  });

  it('preserves bind-pose offsets as bone positions', () => {
    const r = parseBvh(SYNTHETIC_BVH, 'wave');
    expect(r.skeletonParams.bones[0].position).toEqual([0, 1, 0]);
    expect(r.skeletonParams.bones[1].position).toEqual([0, 0.5, 0]);
    expect(r.skeletonParams.bones[2].position).toEqual([0.5, 0, 0]);
  });

  it('emits keyframes for animated bones, sorted by (time, bone)', () => {
    const r = parseBvh(SYNTHETIC_BVH, 'wave');
    expect(r.clipParams.name).toBe('wave');
    expect(r.clipParams.duration).toBeGreaterThan(0);
    expect(r.clipParams.loop).toBe(true);
    // Times monotonic.
    for (let i = 1; i < r.clipParams.keyframes.length; i++) {
      expect(r.clipParams.keyframes[i].time).toBeGreaterThanOrEqual(
        r.clipParams.keyframes[i - 1].time,
      );
    }
    // ArmL has a 45° Y rotation at frame 0, -45° at frame 1.
    const armKfs = r.clipParams.keyframes.filter((k) => k.bone === 2);
    expect(armKfs.length).toBeGreaterThanOrEqual(2);
    // Quaternion → Euler (XYZ) lossy at the y-axis only — first kf should
    // have a positive y rotation, second negative. ~45° = ~0.785 rad.
    const ySigns = armKfs.map((k) => Math.sign(k.rotation[1]));
    expect(ySigns).toContain(1);
    expect(ySigns).toContain(-1);
  });

  it('twice-call yields deep-equal output (V2 purity)', () => {
    const a = parseBvh(SYNTHETIC_BVH, 'wave');
    const b = parseBvh(SYNTHETIC_BVH, 'wave');
    expect(a).toEqual(b);
  });

  it('throws on malformed input', () => {
    expect(() => parseBvh('not a bvh file')).toThrow();
  });
});
