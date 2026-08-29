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

describe('a posed joint’s rest OFFSET is replaced by its channel, never added (#792)', () => {
  // three's BVHLoader composes an animated joint's translation as
  // `frame.position + bone.offset` (BVHLoader.js:375-377). For the conventional
  // root, whose OFFSET is 0 0 0, that is the same as taking the channel — which
  // is why nothing here ever noticed. For a joint that declares BOTH a non-zero
  // OFFSET and position channels, it counts the rest pose twice.

  /**
   * A REST frame: the pelvis's position channel equals its own OFFSET. This is
   * the shape of the T-pose reference the real generator ships, and it is what
   * settles the convention — a delta encoding would write zero in the channel.
   */
  const REST_FRAME = `HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
  JOINT Hips
  {
    OFFSET 0 100 0
    CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
    JOINT Spine
    {
      OFFSET 0 10 0
      CHANNELS 3 Zrotation Yrotation Xrotation
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333333333333
0 0 0 0 0 0 0 100 0 0 0 0 0 0 0
0 0 0 0 0 0 0 100 5 0 0 0 0 3 0
`;

  const posOf = (name: string, text = REST_FRAME) => {
    const parsed = parseBvh(text, 'rule');
    const i = parsed.skeletonParams.bones.findIndex((b) => b.name === name);
    return parsed.clipParams.keyframes.filter((k) => k.bone === i)[0].position;
  };

  it('a rest frame imports at its stated height, not at twice it', () => {
    // The self-refuting case: a reference pose whose whole purpose is to state
    // the rest height, importing at 200 when it says 100.
    expect(posOf('Hips')[1]).toBeCloseTo(100, 6);
  });

  it('a rotation-only joint keeps its OFFSET — the correction is not applied to it', () => {
    // The half that would collapse every limb onto its parent if the rule were
    // applied to joints that have no position channel: for those, three's
    // `0 + offset` already IS the correct local translation.
    expect(posOf('Spine')[1]).toBeCloseTo(10, 6);
  });

  it('a root at OFFSET 0 is unaffected — which is why this never surfaced', () => {
    expect(posOf('Root')).toEqual([0, 0, 0]);
  });

  it('the animated channel still moves — replacing the offset is not zeroing it', () => {
    const parsed = parseBvh(REST_FRAME, 'rule');
    const hips = parsed.skeletonParams.bones.findIndex((b) => b.name === 'Hips');
    const keyed = parsed.clipParams.keyframes.filter((k) => k.bone === hips);
    expect(keyed[0].position[2]).toBeCloseTo(0, 6);
    expect(keyed[1].position[2]).toBeCloseTo(5, 6);
  });

  it('the bind pose is untouched — only the keyed translation is recomposed', () => {
    const bones = parseBvh(REST_FRAME, 'rule').skeletonParams.bones;
    const hips = bones.find((b) => b.name === 'Hips')!;
    expect(hips.position).toEqual([0, 100, 0]);
  });
});
