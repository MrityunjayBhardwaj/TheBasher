// PROBE — is the reconciliation REACHABLE on what the server emits?
// The improvement in tmp-855-tpose is CONSISTENT WITH the new path running, but
// consistent-with is not observed. This asks solveRestAlignment directly, on both
// rests, and prints the disagreement it solves.
//
// Companion figure (H564): the number of correspondence pairs each solve saw. A
// solve that saw too few pairs returns null for a reason unrelated to the rest,
// and that would read exactly like a degenerate rest.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { solveRestAlignment, MIN_PAIRS, MAX_RESIDUAL_DEGREES } from './restAlignment';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const CLIPS: Array<[string, string]> = [
  ['degenerate (server today)', resolve(__dirname, '../../../public/assets/kimodo-walk.bvh')],
  ['T-pose (converted offline)', resolve(__dirname, '../../../public/assets/kimodo-walk-tpose.bvh')],
  ['SERVED by the edited server', resolve(__dirname, '../../../public/assets/kimodo-served-tpose.bvh')],
  ['BUNDLED sample: walk', resolve(__dirname, '../../../public/assets/motion/walk.bvh')],
  ['BUNDLED sample: run', resolve(__dirname, '../../../public/assets/motion/run.bvh')],
  ['BUNDLED sample: jump', resolve(__dirname, '../../../public/assets/motion/jump.bvh')],
  ['BUNDLED sample: crouch', resolve(__dirname, '../../../public/assets/motion/crouch.bvh')],
  ['BUNDLED sample: turn', resolve(__dirname, '../../../public/assets/motion/turn.bvh')],
  ['BUNDLED sample: wave', resolve(__dirname, '../../../public/assets/motion/wave.bvh')],
];

describe('PROBE — reachability of the rest reconciliation', () => {
  it('asks solveRestAlignment directly under both rests', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const { bones: targetBones } = specToThreeSkeleton(target.bones);
    targetBones[0].updateMatrixWorld(true);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    console.log(`\nsolver bars: MIN_PAIRS=${MIN_PAIRS}  MAX_RESIDUAL=${MAX_RESIDUAL_DEGREES}°`);
    for (const [label, path] of CLIPS) {
      const bvh = parseBvh(readFileSync(path, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones: sourceBones } = specToThreeSkeleton(bvh.skeletonParams.bones);
      sourceBones[0].updateMatrixWorld(true);
      const nameMap = resolveNameMapToTarget(
        resolveNameMapToSource(preset.map, bvh.skeletonParams.bones),
        target.bones,
      );
      const targetToSource: Record<string, string> = {};
      for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;
      const pairs = Object.keys(targetToSource).length;

      const a = solveRestAlignment(sourceBones, targetBones, targetToSource);
      console.log(
        `  ${label.padEnd(30)} pairs=${String(pairs).padStart(3)}  ` +
          (a
            ? `ACCEPTED  ${a.disagreementBefore.toFixed(1)}° -> ${a.disagreementAfter.toFixed(1)}° ` +
              `(explains ${(100 * (1 - a.disagreementAfter / a.disagreementBefore)).toFixed(0)}%)`
            : 'REFUSED (null) -> per-bone direction fallback'),
      );
    }
    console.log('');
  });
});
