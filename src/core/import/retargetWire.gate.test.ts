// #1225 — a retarget that reads the pose WIRE retargets a clip as the retarget that read the clip.
//
// `RetargetClip` samples its source wire over the range the wire carries (Houdini's `clipinfo`); a
// clip's range puts those samples on the clip's keys, three's own rate rule (`SkeletonUtils.js:204`).
// This gate runs every tracked BVH onto the stand-in glTF rig both ways — the clip's keys straight
// into `retargetClip`, and the clip's pose sampled by `wireKeyframes` — and holds them together.
//
// Measured 2026-09-25 over the 12 tracked BVHs: identical key counts, key times and rest
// reconciliation; positions within 4.8e-7; rotations within 1.52e-3° (run.bvh; ≤ 4.2e-5° on the
// rest). The rotation residue is the sampler meeting a key at a time computed as i·span/(n−1)
// rather than read off the file. The bounds sit just above those numbers.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata, Vec3 } from '../../nodes/types';
import {
  AnimationClipNode,
  AnimationClipParams,
  type ClipOutputs,
} from '../../nodes/AnimationClip';
import { wireKeyframes } from '../../nodes/RetargetClip';
import { quatFromEulerXYZ } from '../../nodes/bonePose';
import { clipNodeParams } from '../../test-utils/bvhClip';

const POSITION_BOUND = 1e-6;
const ROTATION_BOUND_DEG = 2e-3;

async function targetRig(): Promise<readonly BoneSpec[]> {
  const buf = readFileSync(resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb'));
  const { json, bin } = parseGltfContainer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  return projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
}

/** The angle between two XYZ-euler orientations, in degrees. */
function angleDeg(a: Vec3, b: Vec3): number {
  const qa = quatFromEulerXYZ(a);
  const qb = quatFromEulerXYZ(b);
  const dot = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

describe('a retarget reading the wire equals the retarget reading the clip', () => {
  it('every tracked BVH onto the stand-in rig', async () => {
    const tracked = execFileSync('git', ['ls-files', '*.bvh'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    // The denominator: a glob that matched nothing would pass over an empty set.
    expect(tracked.length).toBeGreaterThanOrEqual(12);
    const target = await targetRig();
    const preset = getBoneNameMapPreset('somaToMixamo')!;

    let compared = 0;
    for (const rel of tracked) {
      const parsed = parseBvh(
        readFileSync(resolve(process.cwd(), rel), 'utf8'),
        'clip',
        BVH_UNIT_SCALE_CENTIMETRES,
      );
      const viaClip = retargetClip({
        sourceBones: parsed.skeletonParams.bones,
        sourceClip: { ...parsed.clipParams, name: 'clip' },
        targetBones: target,
        nameMap: preset.map,
      });
      const { pose } = AnimationClipNode.evaluate(
        AnimationClipParams.parse(clipNodeParams(parsed)),
        { skeleton: { kind: 'Skeleton', bones: parsed.skeletonParams.bones } },
        undefined as never,
      ) as ClipOutputs;
      const range = pose.clip!;
      const viaWire = retargetClip({
        sourceBones: pose.skeleton.bones,
        sourceClip: {
          name: 'clip',
          duration: range.end - range.start,
          keyframes: wireKeyframes(pose, range, range.rate),
          loop: range.loop,
        },
        targetBones: target,
        nameMap: preset.map,
      });

      const a = viaClip.clipParams.keyframes;
      const b = viaWire.clipParams.keyframes;
      expect(b.length, rel).toBe(a.length);
      expect(viaWire.clipParams.duration, rel).toBe(viaClip.clipParams.duration);
      expect(viaWire.restReconciliation.kind, rel).toBe(viaClip.restReconciliation.kind);
      a.forEach((k, i) => {
        expect(b[i].bone, rel).toBe(k.bone);
        // `toBe` is Object.is, so a one-frame source's NaN times (#1249) compare equal too.
        expect(b[i].time, rel).toBe(k.time);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(b[i].position[c] - k.position[c]), rel).toBeLessThan(POSITION_BOUND);
        }
        expect(angleDeg(b[i].rotation, k.rotation), rel).toBeLessThan(ROTATION_BOUND_DEG);
        compared++;
      });
    }
    // At least: the six library motions alone retarget to 2760 keys each.
    expect(compared).toBeGreaterThanOrEqual(6 * 2760);
  }, 120_000);
});
