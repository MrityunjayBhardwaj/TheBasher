// OBSERVE — root world Y against frame index, source vs our retargeted output.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const CLIPS = [
  resolve(__dirname, '../../../public/assets/motion/walk.bvh'),
  resolve(__dirname, '../../../public/assets/kimodo-walk.bvh'),
];

function fit(ys: number[]) {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  return { slope: num / den, total: (num / den) * (n - 1) };
}

describe('OBSERVE — +Y drift', () => {
  it('dumps root world Y per frame', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    for (const CLIP of CLIPS) {
      const soma = parseBvh(readFileSync(CLIP, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      // SOURCE side: hip bone local translation per frame (metres, after unit scale)
      const srcHipIdx = soma.skeletonParams.bones.findIndex((b) => b.name === 'Hips');
      const srcY: number[] = [];
      const srcTimes = [...new Set(soma.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      for (const t of srcTimes) {
        const k = soma.clipParams.keyframes.find((kk) => kk.time === t && kk.bone === srcHipIdx);
        if (k?.position) srcY.push(k.position[1]);
      }

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

      // which target bones carry a position track that is not the bind position?
      const posBones = new Map<number, number[][]>();
      for (const k of out.clipParams.keyframes) {
        if (!k.position) continue;
        posBones.set(k.bone, [...(posBones.get(k.bone) ?? []), [k.time, ...k.position]]);
      }
      const moving = [...posBones.entries()].filter(([, rows]) => {
        const xs = rows.map((r) => r[1]), ys = rows.map((r) => r[2]), zs = rows.map((r) => r[3]);
        const span = (a: number[]) => Math.max(...a) - Math.min(...a);
        return span(xs) + span(ys) + span(zs) > 1e-6;
      });

      console.log(`\n===== ${CLIP.split('/').pop()} =====`);
      console.log(`source Hips Y (m): f0=${srcY[0]?.toFixed(4)} end=${srcY.at(-1)?.toFixed(4)} ` +
        `min=${Math.min(...srcY).toFixed(4)} max=${Math.max(...srcY).toFixed(4)} ` +
        `slope=${fit(srcY).slope.toFixed(6)}/frame total=${fit(srcY).total.toFixed(4)}`);
      console.log(`target bones with a MOVING position track: ${moving.length} of ${posBones.size}`);
      for (const [bi, rows] of moving) {
        rows.sort((a, b) => a[0] - b[0]);
        const ys = rows.map((r) => r[2]);
        const f = fit(ys);
        console.log(`  bone[${bi}] ${target.bones[bi]?.name}: ` +
          `Y f0=${ys[0].toFixed(4)} end=${ys.at(-1)!.toFixed(4)} min=${Math.min(...ys).toFixed(4)} max=${Math.max(...ys).toFixed(4)} ` +
          `slope=${f.slope.toFixed(6)}/frame TOTAL=${f.total.toFixed(4)}`);
        console.log(`    X f0=${rows[0][1].toFixed(3)} end=${rows.at(-1)![1].toFixed(3)}  Z f0=${rows[0][3].toFixed(3)} end=${rows.at(-1)![3].toFixed(3)}`);
        console.log('    Y samples: ' + rows.filter((_, i) => i % 10 === 0).map((r) => `${r[0].toFixed(2)}s:${r[2].toFixed(3)}`).join(' '));
      }
    }
  });
});

// WORLD-SPACE FK on the target, using the retargeted keyframes.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
describe('OBSERVE — world Y', () => {
  it('composes target FK per frame', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    console.log('\nTARGET BIND (first 4 bones):');
    target.bones.slice(0, 4).forEach((b, i) =>
      console.log(`  [${i}] ${b.name} parent=${b.parent} pos=[${b.position.map((v) => v.toFixed(3))}] rotEuler=[${b.rotation.map((v) => ((v * 180) / Math.PI).toFixed(2))}]`));

    for (const CLIP of CLIPS) {
      const soma = parseBvh(readFileSync(CLIP, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
        targetBones: target.bones,
        nameMap: preset.map,
      });
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) {
        if (!byTime.has(k.time)) byTime.set(k.time, new Map());
        byTime.get(k.time)!.set(k.bone, k);
      }
      const world: Array<[number, Vector3]> = [];
      for (const t of times) {
        const frame = byTime.get(t)!;
        const mats: Matrix4[] = [];
        target.bones.forEach((b, i) => {
          const k = frame.get(i);
          const p = new Vector3(...(k?.position ?? b.position));
          const q = new Quaternion().setFromEuler(new Euler(...(k?.rotation ?? b.rotation), 'XYZ'));
          const local = new Matrix4().compose(p, q, new Vector3(1, 1, 1));
          mats[i] = b.parent >= 0 ? new Matrix4().multiplyMatrices(mats[b.parent], local) : local;
        });
        world.push([t, new Vector3().setFromMatrixPosition(mats[1])]);
      }
      const ys = world.map(([, v]) => v.y);
      const f = fit(ys);
      console.log(`\n== ${CLIP.split('/').pop()} — mixamorig_Hips WORLD ==`);
      console.log(`  Y f0=${ys[0].toFixed(4)} end=${ys.at(-1)!.toFixed(4)} min=${Math.min(...ys).toFixed(4)} max=${Math.max(...ys).toFixed(4)} slope=${f.slope.toFixed(6)}/frame TOTAL=${f.total.toFixed(4)}`);
      console.log(`  X f0=${world[0][1].x.toFixed(3)} end=${world.at(-1)![1].x.toFixed(3)}   Z f0=${world[0][1].z.toFixed(3)} end=${world.at(-1)![1].z.toFixed(3)}`);
      console.log('  Y: ' + world.filter((_, i) => i % 10 === 0).map(([t, v]) => `${t.toFixed(2)}:${v.y.toFixed(3)}`).join(' '));
    }
  });
});
