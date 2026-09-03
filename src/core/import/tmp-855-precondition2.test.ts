// (a) done properly: sweep the AZIMUTH of a small perturbation around an
//     antiparallel pair. If the resulting roll about the bone swings with an
//     angle nothing in the rig chooses, the correction is arbitrary there.
// (b) the world rest directions, side by side, rather than a summary statistic.
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

function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN;
  let d = 2 * Math.atan2(s, q.w) * DEG;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

describe('#855 preconditions, second pass', () => {
  it('(a) sweeps the azimuth of the perturbation, not a single line', () => {
    const t = new Vector3(0, 1, 0);
    const perp1 = new Vector3(1, 0, 0);
    const perp2 = new Vector3(0, 0, 1);
    for (const polar of [5, 1, 0.1]) {
      const rolls: number[] = [];
      for (let az = 0; az < 360; az += 45) {
        const p = perp1
          .clone()
          .multiplyScalar(Math.cos((az * Math.PI) / 180))
          .add(perp2.clone().multiplyScalar(Math.sin((az * Math.PI) / 180)));
        const s = t
          .clone()
          .multiplyScalar(-Math.cos((polar * Math.PI) / 180))
          .add(p.multiplyScalar(Math.sin((polar * Math.PI) / 180)))
          .normalize();
        rolls.push(twistDeg(new Quaternion().setFromUnitVectors(t, s), t));
      }
      console.log(
        `    ${(180 - polar).toFixed(1)}° apart: roll about the bone across 8 azimuths = ` +
          rolls.map((r) => r.toFixed(0)).join(', ') +
          `   SPREAD ${(Math.max(...rolls) - Math.min(...rolls)).toFixed(1)}°`,
      );
    }
    // Contrast: the same sweep at 90 degrees apart, where the pair is well-conditioned.
    const rolls90: number[] = [];
    for (let az = 0; az < 360; az += 45) {
      const p = perp1
        .clone()
        .multiplyScalar(Math.cos((az * Math.PI) / 180))
        .add(perp2.clone().multiplyScalar(Math.sin((az * Math.PI) / 180)));
      const s = t.clone().multiplyScalar(0).add(p).normalize();
      rolls90.push(twistDeg(new Quaternion().setFromUnitVectors(t, s), t));
    }
    console.log(
      `    90.0° apart (today's case): ` +
        rolls90.map((r) => r.toFixed(0)).join(', ') +
        `   SPREAD ${(Math.max(...rolls90) - Math.min(...rolls90)).toFixed(1)}°`,
    );
  });

  it('(b) prints the world rest directions side by side', async () => {
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
    const { bones: tgt } = specToThreeSkeleton(target.bones);
    const tDirs = worldDirs(tgt, targetToSource);
    const sT = parseBvh(readFileSync(TPOSE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
    const { bones: sb } = specToThreeSkeleton(sT.skeletonParams.bones);
    const sDirs = worldDirs(sb, nameMap);

    const f = (v: Vector3) =>
      `(${v.x.toFixed(2).padStart(5)},${v.y.toFixed(2).padStart(5)},${v.z.toFixed(2).padStart(5)})`;
    console.log('    bone           target bind world dir   source T-pose world dir   angle');
    for (const [tn, sn] of Object.entries(targetToSource)) {
      const td = tDirs.get(tn);
      const sd = sDirs.get(sn);
      if (!td || !sd) continue;
      console.log(
        `    ${tn.replace('mixamorig_', '').padEnd(14)} ${f(td)}       ${f(sd)}   ${(td.angleTo(sd) * DEG).toFixed(0).padStart(4)}°`,
      );
    }
  }, 120000);
});
