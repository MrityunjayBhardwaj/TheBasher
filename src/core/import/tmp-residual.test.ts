// PROBE (#item03) — WHERE does the 17.2 deg rest residual live?
// solveRestAlignment reports one RMS number. A single number cannot say whether
// the residual is spread evenly (nothing more to derive) or concentrated on a
// few bones (a per-bone layer would mop it up). This prints the per-bone angle
// between the ROTATED source rest direction and the target bind direction.
//
// Companion figure (H564): the RMS recomputed from the rows below. If it does
// not reproduce solveRestAlignment's own number, these rows are not the residual.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3, type Bone } from 'three';
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
const TPOSE = resolve(__dirname, '../../../public/assets/kimodo-walk-tpose.bvh');
const DEG = 180 / Math.PI;

// A bone's rest direction is the direction to its first MAPPED descendant --
// the same rule solveRestAlignment uses, restated here so the rows are
// independent of it rather than borrowed from it.
function restDirs(bones: readonly Bone[], mapped: (n: string) => boolean): Map<string, Vector3> {
  bones[0].updateMatrixWorld(true);
  const out = new Map<string, Vector3>();
  const pos = (b: Bone) => new Vector3().setFromMatrixPosition(b.matrixWorld);
  for (const b of bones) {
    if (!mapped(b.name)) continue;
    const stack = [...(b.children as Bone[])];
    let child: Bone | null = null;
    while (stack.length) {
      const n = stack.shift() as Bone;
      if (n.isBone && mapped(n.name)) { child = n; break; }
      if (n.isBone) stack.push(...(n.children as Bone[]));
    }
    if (!child) continue;
    const d = pos(child).sub(pos(b));
    if (d.length() > 1e-9) out.set(b.name, d.normalize());
  }
  return out;
}

describe('PROBE — per-bone rest residual after the rigid rotation', () => {
  it('breaks the 17.2 deg RMS down by bone', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const { bones: targetBones } = specToThreeSkeleton(target.bones);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    const bvh = parseBvh(readFileSync(TPOSE, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
    const { bones: sourceBones } = specToThreeSkeleton(bvh.skeletonParams.bones);
    const nameMap = resolveNameMapToTarget(
      resolveNameMapToSource(preset.map, bvh.skeletonParams.bones),
      target.bones,
    );
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;

    const a = solveRestAlignment(sourceBones, targetBones, targetToSource)!;
    const srcNames = new Set(Object.values(targetToSource));
    const sd = restDirs(sourceBones, (n) => srcNames.has(n));
    const td = restDirs(targetBones, (n) => targetToSource[n] !== undefined);

    const rows: Array<[string, number]> = [];
    for (const [t, s] of Object.entries(targetToSource)) {
      const S = sd.get(s), T = td.get(t);
      if (!S || !T) continue;
      const r = S.clone().applyQuaternion(a.rotation);
      rows.push([t, Math.acos(Math.max(-1, Math.min(1, r.dot(T)))) * DEG]);
    }
    rows.sort((x, y) => y[1] - x[1]);
    const rms = Math.sqrt(rows.reduce((s, [, v]) => s + v * v, 0) / rows.length);
    console.log(`\nsolver says: ${a.disagreementBefore.toFixed(1)}° -> ${a.disagreementAfter.toFixed(1)}°`);
    console.log(`rows recompute RMS = ${rms.toFixed(1)}° over ${rows.length} bones`
      + `  (must match ${a.disagreementAfter.toFixed(1)}° or these rows are not the residual)\n`);
    for (const [n, v] of rows) console.log(`   ${v.toFixed(1).padStart(6)}°  ${n}`);
    console.log('');
  });
});
