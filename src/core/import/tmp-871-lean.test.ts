import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEG = 180 / Math.PI;

describe('does R tilt the BODY too, or only the travel?', () => {
  it('spine elevation, degenerate vs anatomical rest, same motion', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const iHips = target.bones.findIndex((b) => b.name === 'mixamorig_Hips');
    const iNeck = target.bones.findIndex((b) => /Neck|Head/.test(b.name));
    console.log('spine measured from', target.bones[iHips].name, '->', target.bones[iNeck].name);

    for (const [label, rel] of [['degenerate', 'kimodo-walk.bvh'], ['anatomical', 'kimodo-walk-tpose.bvh']] as const) {
      const soma = parseBvh(readFileSync(resolve(__dirname, '../../../public/assets/', rel), 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
        targetBones: target.bones, nameMap: preset.map,
      });
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) {
        if (!byTime.has(k.time)) byTime.set(k.time, new Map());
        byTime.get(k.time)!.set(k.bone, k);
      }
      const elev: number[] = [];
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
        const a = new Vector3().setFromMatrixPosition(mats[iHips]);
        const c = new Vector3().setFromMatrixPosition(mats[iNeck]);
        elev.push(90 - c.clone().sub(a).angleTo(new Vector3(0, 1, 0)) * DEG);
      }
      const mean = elev.reduce((x, y) => x + y, 0) / elev.length;
      console.log(`  ${label}: spine elevation from horizontal mean=${mean.toFixed(2)}° (90=upright) min=${Math.min(...elev).toFixed(2)} max=${Math.max(...elev).toFixed(2)}  => lean from vertical ${(90 - mean).toFixed(2)}°`);
    }
  });
});
