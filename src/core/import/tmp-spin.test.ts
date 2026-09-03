// PROBE — the 360° spins. AnimationKeyframe.rotation is an EULER TRIPLE
// (types.ts:1177, Vec3). Between two keys an interpolator moves each COMPONENT
// linearly, so if a component wraps (+179 -> -179) the bone travels ~358°
// instead of ~2°. That is a spin on one bone, or on the whole body if it
// happens near the root.
//
// For each consecutive key pair this prints:
//   geo  = the true rotation change (quaternion geodesic) -- what SHOULD happen
//   eul  = the largest single Euler-component jump      -- what the data says
// eul >> geo is the defect, and it localises it exactly.
//
// Companion figure (H564): pairs examined per clip. A zero denominator is
// visible rather than reading as "no spins found".
import { describe, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
const A = (p: string) => resolve(__dirname, '../../../public/assets/' + p);
const CLIPS: Array<[string, string]> = [
  ['served T-pose', A('kimodo-served-tpose.bvh')],
  ['served degenerate', A('kimodo-served-degenerate.bvh')],
  ['held walk (T-pose)', A('kimodo-walk-tpose.bvh')],
  ['held walk (degenerate)', A('kimodo-walk.bvh')],
  ['bundled walk', A('motion/walk.bvh')],
];
const DEG = 180 / Math.PI;

const geodesic = (a: Quaternion, b: Quaternion) =>
  2 * Math.asin(Math.min(1, a.clone().invert().multiply(b).length() === 0 ? 0 : 0)) || // placeholder
  2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEG;

describe('PROBE — Euler wrap spins in the retargeted clip', () => {
  it('finds steps where the Euler data implies far more rotation than actually happens', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    for (const [label, path] of CLIPS) {
      if (!existsSync(path)) { console.log(`\n${label}: MISSING ${path}`); continue; }
      const soma = parseBvh(readFileSync(path, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
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

      // group keys per bone, ordered in time
      const perBone = new Map<number, Array<{ t: number; r: readonly number[] }>>();
      for (const k of out.clipParams.keyframes) {
        perBone.set(k.bone, [...(perBone.get(k.bone) ?? []), { t: k.time, r: k.rotation }]);
      }
      let pairs = 0;
      const bad: Array<[number, string, number, number]> = [];
      for (const [boneIdx, keysRaw] of perBone) {
        const keys = [...keysRaw].sort((a, b) => a.t - b.t);
        for (let i = 1; i < keys.length; i++) {
          pairs++;
          const p = keys[i - 1], c = keys[i];
          const qp = new Quaternion().setFromEuler(new Euler(p.r[0], p.r[1], p.r[2], 'XYZ'));
          const qc = new Quaternion().setFromEuler(new Euler(c.r[0], c.r[1], c.r[2], 'XYZ'));
          const geo = 2 * Math.acos(Math.min(1, Math.abs(qp.dot(qc)))) * DEG;
          const eul = Math.max(
            ...[0, 1, 2].map((a) => Math.abs(c.r[a] - p.r[a]) * DEG),
          );
          if (eul - geo > 90) bad.push([c.t, target.bones[boneIdx].name, geo, eul]);
        }
      }
      bad.sort((x, y) => x[0] - y[0]);
      console.log(`\n=== ${label} === pairs examined: ${pairs}`);
      console.log(`   steps where Euler implies >90° more than actually happens: ${bad.length}`);
      for (const [t, n, geo, eul] of bad.slice(0, 12)) {
        console.log(`     t=${t.toFixed(3)}s  ${n.padEnd(26)} true ${geo.toFixed(1)}°  euler jump ${eul.toFixed(1)}°`);
      }
      if (bad.length > 12) console.log(`     ... and ${bad.length - 12} more`);
    }
    console.log('');
  });
});
