// What does R do to "up", and does it predict the ramp?
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { solveRestAlignment } from './restAlignment';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEG = 180 / Math.PI;
const CLIPS = ['kimodo-walk.bvh', 'kimodo-walk-tpose.bvh', 'motion/walk.bvh', 'motion/run.bvh', 'motion/jump.bvh'];

describe('R vs the ramp', () => {
  it('measures R and its tilt of world up', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const { bones: targetBoneObjs } = specToThreeSkeleton(target.bones);

    for (const rel of CLIPS) {
      const path = resolve(__dirname, '../../../public/assets/', rel);
      const soma = parseBvh(readFileSync(path, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones: sourceBoneObjs } = specToThreeSkeleton(soma.skeletonParams.bones);
      // targetToSource, built the way retargetClip does (name maps already match here)
      const targetToSource: Record<string, string> = {};
      for (const [s, t] of Object.entries(preset.map)) targetToSource[t] = s;
      const R = solveRestAlignment(sourceBoneObjs, targetBoneObjs, targetToSource);
      if (!R) { console.log(`${rel}: REFUSED (null)`); continue; }
      const up = new Vector3(0, 1, 0);
      const rUp = up.clone().applyQuaternion(R.rotation);
      const tilt = rUp.angleTo(up) * DEG;
      // source travel in its own frame (hip world X/Z displacement, cm->m)
      const hipIdx = soma.skeletonParams.bones.findIndex((b) => b.name === 'Hips');
      const ks = soma.clipParams.keyframes.filter((k) => k.bone === hipIdx && k.position).sort((a, b) => a.time - b.time);
      const p0 = new Vector3(...ks[0].position!);
      const p1 = new Vector3(...ks.at(-1)!.position!);
      const travel = p1.clone().sub(p0);
      const rotated = travel.clone().applyQuaternion(R.rotation);
      console.log(`${rel}: |R|=${(2 * Math.acos(Math.min(1, Math.abs(R.rotation.w))) * DEG).toFixed(2)}°  R·up tilt=${tilt.toFixed(2)}°  ` +
        `travel=[${travel.toArray().map((v) => v.toFixed(3))}] -> R·travel=[${rotated.toArray().map((v) => v.toFixed(3))}]  ` +
        `predicted rise (x scale) = ${rotated.y.toFixed(3)}`);
    }
  });
});
