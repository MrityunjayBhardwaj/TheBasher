// PROOF — the Euler wrap becomes MOTION, not just odd data.
// Mirrors the real playback sampler: AnimationClip.ts:76-94 picks the bracketing
// keyframes and does `lerpVec3(a.rotation, b.rotation, u)` on the EULER triple.
// Sampling densely INSIDE each keyframe interval shows how far the bone actually
// travels between two keys that are only a couple of degrees apart.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Quaternion } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const CLIP = resolve(__dirname, '../../../public/assets/kimodo-served-tpose.bvh');
const DEG = 180 / Math.PI;
const q = (r: readonly number[]) =>
  new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));

describe('PROOF — the wrap is a real 360° sweep at playback', () => {
  it('walks each keyframe interval the way the sampler does', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const soma = parseBvh(readFileSync(CLIP, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
    const out = retargetClip({
      sourceBones: soma.skeletonParams.bones,
      sourceClip: {
        name: soma.clipParams.name,
        duration: soma.clipParams.duration,
        keyframes: soma.clipParams.keyframes,
      },
      targetBones: target.bones,
      nameMap: preset.map,
    });

    const perBone = new Map<number, Array<{ t: number; r: readonly number[] }>>();
    for (const k of out.clipParams.keyframes)
      perBone.set(k.bone, [...(perBone.get(k.bone) ?? []), { t: k.time, r: k.rotation }]);

    const worst: Array<[number, string, number, number]> = [];
    let intervals = 0;
    for (const [bi, raw] of perBone) {
      const keys = [...raw].sort((a, b) => a.t - b.t);
      for (let i = 1; i < keys.length; i++) {
        intervals++;
        const a = keys[i - 1], b = keys[i];
        const endpoints = 2 * Math.acos(Math.min(1, Math.abs(q(a.r).dot(q(b.r))))) * DEG;
        // dense walk INSIDE the interval, exactly as lerpVec3 would produce
        let travelled = 0;
        let prev = q(a.r);
        for (let s = 1; s <= 40; s++) {
          const u = s / 40;
          const mid = [0, 1, 2].map((c) => a.r[c] + (b.r[c] - a.r[c]) * u);
          const cur = q(mid);
          travelled += 2 * Math.acos(Math.min(1, Math.abs(prev.dot(cur)))) * DEG;
          prev = cur;
        }
        if (travelled - endpoints > 90)
          worst.push([b.t, target.bones[bi].name, endpoints, travelled]);
      }
    }
    worst.sort((x, y) => y[3] - x[3]);
    console.log(`\nintervals examined: ${intervals}   intervals that sweep >90° further than needed: ${worst.length}`);
    console.log('  time      bone                       endpoints apart   ACTUALLY SWEEPS');
    for (const [t, n, e, tr] of worst.slice(0, 10))
      console.log(`  t=${t.toFixed(3)}s  ${n.padEnd(26)} ${e.toFixed(1).padStart(6)}°  ->  ${tr.toFixed(0).padStart(5)}°`);
    console.log('');
  });
});
