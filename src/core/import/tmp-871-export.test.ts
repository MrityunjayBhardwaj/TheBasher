// Export the retargeted pose per frame for an independent replay in Blender:
// each mapped bone's WORLD rotation delta from its own bind, plus the root's
// world travel. Orientation only — Blender supplies its own kinematics.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { specToThreeSkeleton } from './threeAdapter';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const CLIP = resolve(__dirname, '../../../public/assets/motion/walk.bvh');

describe('export for Blender', () => {
  it('dumps world rotation deltas + root travel', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    const { bones: bindBones } = specToThreeSkeleton(target.bones);
    bindBones[0].updateMatrixWorld(true);
    const bindRot = target.bones.map((_, i) => {
      const q = new Quaternion();
      bindBones[i].matrixWorld.decompose(new Vector3(), q, new Vector3());
      return q;
    });

    const soma = parseBvh(readFileSync(CLIP, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
    const out = retargetClip({
      sourceBones: soma.skeletonParams.bones,
      sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
      targetBones: target.bones, nameMap: preset.map,
    });
    const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
    const by = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
    for (const k of out.clipParams.keyframes) { if (!by.has(k.time)) by.set(k.time, new Map()); by.get(k.time)!.set(k.bone, k); }

    const frames = times.map((t) => {
      const f = by.get(t)!;
      const mats: Matrix4[] = [];
      target.bones.forEach((b, i) => {
        const k = f.get(i);
        const p = new Vector3(...(k?.position ?? b.position));
        const q = new Quaternion().setFromEuler(new Euler(...(k?.rotation ?? b.rotation), 'XYZ'));
        const l = new Matrix4().compose(p, q, new Vector3(1, 1, 1));
        mats[i] = b.parent >= 0 ? new Matrix4().multiplyMatrices(mats[b.parent], l) : l;
      });
      const delta: Record<string, number[]> = {};
      target.bones.forEach((b, i) => {
        const q = new Quaternion();
        mats[i].decompose(new Vector3(), q, new Vector3());
        const d = q.clone().multiply(bindRot[i].clone().invert());
        delta[b.name] = [d.x, d.y, d.z, d.w];
      });
      const rootWorld = new Vector3().setFromMatrixPosition(mats[1]);
      return { t, delta, root: rootWorld.toArray() };
    });
    writeFileSync(process.env.OUT!, JSON.stringify({ bones: target.bones.map((b) => b.name), frames }));
    console.log(`wrote ${frames.length} frames; root y ${frames[0].root[1].toFixed(4)} -> ${frames.at(-1)!.root[1].toFixed(4)}`);
  });
});
