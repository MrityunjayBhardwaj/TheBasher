// THROWAWAY — dump Basher's retargeted clip so a second implementation can play it.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { specToThreeSkeleton } from './threeAdapter';
import { Quaternion, Vector3 } from 'three';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const BVH = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');

describe('dump', () => {
  it('writes the retargeted clip as JSON', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const soma = parseBvh(readFileSync(BVH, 'utf8'), 'kimodo-walk', BVH_UNIT_SCALE_CENTIMETRES);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
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
    const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
    const byTime = new Map<number, typeof out.clipParams.keyframes>();
    for (const k of out.clipParams.keyframes) byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);

    // World rotations computed by THREE, not re-derived — only orientation
    // crosses into the other program, so no position or basis guess can hide.
    const worldOf = (bones: ReturnType<typeof specToThreeSkeleton>['bones']) => {
      const out2: Record<string, number[]> = {};
      for (const b of bones) {
        const p = new Vector3();
        const q = new Quaternion();
        const sc = new Vector3();
        b.matrixWorld.decompose(p, q, sc);
        out2[b.name] = [q.x, q.y, q.z, q.w, p.x, p.y, p.z];
      }
      return out2;
    };
    const bindSkel = specToThreeSkeleton(target.bones);
    bindSkel.bones[0].updateMatrixWorld(true);
    const bind = worldOf(bindSkel.bones);

    const posed = specToThreeSkeleton(target.bones);
    const frames = times.map((t) => {
      for (const k of byTime.get(t) ?? []) {
        const b = posed.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
        if (target.bones[k.bone].parent === -1)
          b.position.set(k.position[0], k.position[1], k.position[2]);
      }
      posed.bones[0].updateMatrixWorld(true);
      return { t, world: worldOf(posed.bones) };
    });
    writeFileSync(
      '/tmp/basher-retargeted.json',
      JSON.stringify(
        {
          bones: target.bones.map((b) => ({ name: b.name, parent: b.parent })),
          bind,
          duration: out.clipParams.duration,
          frames,
        },
        null,
        1,
      ),
    );
    console.log(`wrote ${frames.length} frames, ${target.bones.length} bones`);
  }, 120_000);
});
