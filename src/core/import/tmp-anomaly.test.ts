// Is the left/right asymmetry in the arms a property of the DATA (which would
// invalidate the rigid-alignment numbers) or of the world-delta CANDIDATE (which
// is not the construction being recommended)?
//
// Discriminator: the rigid alignment's residual is left/right symmetric or it is
// not. If the geometry is symmetric once one whole-rig rotation is removed, the
// asymmetry belongs to whatever was applied on top of it.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEGENERATE = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const TPOSE =
  '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/c4498c5a-50b8-4a2a-9a8a-6a9415d0ec19/scratchpad/kimodo-walk-tpose.bvh';
const DEG = 180 / Math.PI;

describe('the arm asymmetry — data or candidate?', () => {
  it('checks the name map mirrors, then the residual symmetry', async () => {
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

    console.log('  1. DOES THE NAME MAP PAIR LEFT WITH LEFT?');
    let mismatched = 0;
    let checked = 0;
    for (const [tn, sn] of Object.entries(targetToSource)) {
      const tSide = /Left/i.test(tn) ? 'L' : /Right/i.test(tn) ? 'R' : '-';
      const sSide = /Left/i.test(sn) ? 'L' : /Right/i.test(sn) ? 'R' : '-';
      checked++;
      if (tSide !== sSide) {
        mismatched++;
        console.log(`     MISMATCH ${tn} -> ${sn}`);
      }
    }
    console.log(`     examined=${checked} mapped bones, side mismatches=${mismatched}`);

    const mappedChild = (b: Bone, map: Record<string, unknown>): Bone | null => {
      const stack = [...b.children];
      while (stack.length) {
        const n = stack.shift() as Bone;
        if (!n.isBone) continue;
        if (map[n.name] !== undefined) return n;
        stack.push(...(n.children as Bone[]));
      }
      return null;
    };
    const worldDirs = (bones: Bone[], map: Record<string, unknown>) => {
      bones[0].updateMatrixWorld(true);
      const out = new Map<string, Vector3>();
      for (const b of bones) {
        const c = mappedChild(b, map);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() > 1e-18) out.set(b.name, d.normalize());
      }
      return out;
    };
    const tDirs = worldDirs(specToThreeSkeleton(target.bones).bones, targetToSource);
    const sT = parseBvh(readFileSync(TPOSE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
    const sDirs = worldDirs(specToThreeSkeleton(sT.skeletonParams.bones).bones, nameMap);

    // 2. Are the two rigs each internally mirror-symmetric? A rig whose own left
    //    and right disagree would make any left/right comparison meaningless.
    console.log('\n  2. IS EACH RIG MIRROR-SYMMETRIC IN ITSELF? (left vs right, reflected in Z then X)');
    for (const [label, dirs, get] of [
      ['target bind', tDirs, (n: string) => tDirs.get(n)],
      ['source T-pose', sDirs, (n: string) => sDirs.get(n)],
    ] as const) {
      void dirs;
      for (const part of ['Shoulder', 'Arm', 'ForeArm', 'UpLeg', 'Leg', 'Foot']) {
        const names = [...(label === 'target bind' ? tDirs : sDirs).keys()];
        const l = names.find((n) => n.includes('Left') && n.endsWith(part));
        const r = names.find((n) => n.includes('Right') && n.endsWith(part));
        if (!l || !r) continue;
        const lv = get(l)!;
        const rv = get(r)!;
        const mirroredZ = new Vector3(rv.x, rv.y, -rv.z);
        const mirroredX = new Vector3(-rv.x, rv.y, rv.z);
        console.log(
          `     ${label.padEnd(13)} ${part.padEnd(9)} L-vs-mirror(R): about Z ${(lv.angleTo(mirroredZ) * DEG).toFixed(1).padStart(6)}°   about X ${(lv.angleTo(mirroredX) * DEG).toFixed(1).padStart(6)}°`,
        );
      }
    }
  }, 120000);
});
