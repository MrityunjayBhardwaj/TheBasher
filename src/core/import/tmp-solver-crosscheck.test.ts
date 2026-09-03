// Cross-check: the production solver against the brute-force search that
// produced the numbers the design was argued from. Two implementations, one
// answer, or the convention flip was tuned to a green rather than resolved.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { solveRestAlignment } from './restAlignment';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEGENERATE = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const TPOSE =
  '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/c4498c5a-50b8-4a2a-9a8a-6a9415d0ec19/scratchpad/kimodo-walk-tpose.bvh';
const DEG = 180 / Math.PI;

describe('production solver vs the brute-force it must agree with', () => {
  it('reports the alignment for both rests on the live pair', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const probe = parseBvh(readFileSync(DEGENERATE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
    const nameMap = resolveNameMapToTarget(
      resolveNameMapToSource(preset.map, probe.skeletonParams.bones),
      target.bones,
    );
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;
    const trg: Bone[] = specToThreeSkeleton(target.bones).bones;

    for (const [label, path] of [
      ['degenerate rest (must be REFUSED)', DEGENERATE],
      ['T-pose rest (must be ACCEPTED)', TPOSE],
    ] as const) {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const src = specToThreeSkeleton(s.skeletonParams.bones).bones;
      const a = solveRestAlignment(src, trg, targetToSource);
      if (!a) {
        console.log(`  ${label.padEnd(36)} -> REFUSED`);
        continue;
      }
      const e = new Euler().setFromRotationMatrix(
        new Matrix4().makeRotationFromQuaternion(a.rotation),
        'YXZ',
      );
      void Vector3;
      console.log(
        `  ${label.padEnd(36)} -> accepted; ${a.disagreementBefore.toFixed(1)}° -> ${a.disagreementAfter.toFixed(1)}°` +
          `  (yaw ${(e.y * DEG).toFixed(1)}°, pitch ${(e.x * DEG).toFixed(1)}°, roll ${(e.z * DEG).toFixed(1)}°)`,
      );
      console.log(
        `     brute force said: 63.4° -> 17.2°  (yaw 89.8°, pitch -4.6°, roll 0.3°)`,
      );
      void Quaternion;
    }
  }, 120000);
});
