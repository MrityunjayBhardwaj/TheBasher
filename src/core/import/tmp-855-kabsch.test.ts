// If the T-pose rest and the target bind are the same pose up to a RIGID rotation,
// then one whole-rig rotation should explain most of the 46° mean disagreement,
// and what is left is real per-bone anatomy. Solved in closed form (Kabsch) — no
// fitting, no free parameters. The degenerate rest is the control: it should NOT
// be explainable this way, because a rank-1 rest cannot align to a 3-D one.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3, type Bone } from 'three';
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

/** Best rigid rotation carrying `from` onto `to`, by brute-force refinement of a
 *  quaternion — small problem, and it avoids hand-rolling an SVD. Seeded from the
 *  24 axis-aligned rotations so it cannot land in a local minimum near identity. */
function bestRotation(from: Vector3[], to: Vector3[]): { q: Quaternion; rms: number } {
  const cost = (q: Quaternion) => {
    let s = 0;
    for (let i = 0; i < from.length; i++) {
      const a = from[i].clone().applyQuaternion(q).angleTo(to[i]) * DEG;
      s += a * a;
    }
    return Math.sqrt(s / from.length);
  };
  let best = new Quaternion();
  let bestC = cost(best);
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  for (const ax of axes)
    for (let d = 0; d < 360; d += 15) {
      const q = new Quaternion().setFromAxisAngle(ax, (d * Math.PI) / 180);
      const c = cost(q);
      if (c < bestC) {
        bestC = c;
        best = q;
      }
    }
  // local refinement
  for (let step = 20; step > 0.05; step *= 0.6) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const ax of axes)
        for (const sgn of [1, -1]) {
          const q = best
            .clone()
            .multiply(new Quaternion().setFromAxisAngle(ax, (sgn * step * Math.PI) / 180));
          const c = cost(q);
          if (c < bestC - 1e-9) {
            bestC = c;
            best = q;
            improved = true;
          }
        }
    }
  }
  return { q: best, rms: bestC };
}

describe('#855 — is the disagreement rigid?', () => {
  it('removes the best whole-rig rotation and reports what is left', async () => {
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
    const dirMap = (bones: Bone[], map: Record<string, unknown>) => {
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

    const tDirs = dirMap(specToThreeSkeleton(target.bones).bones, targetToSource);
    for (const [label, path] of [
      ['DEGENERATE rest (control)', DEGENERATE],
      ['T-POSE rest', TPOSE],
    ] as const) {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const sDirs = dirMap(specToThreeSkeleton(s.skeletonParams.bones).bones, nameMap);
      const from: Vector3[] = [];
      const to: Vector3[] = [];
      const names: string[] = [];
      for (const [tn, sn] of Object.entries(targetToSource)) {
        const td = tDirs.get(tn);
        const sd = sDirs.get(sn);
        if (!td || !sd) continue;
        from.push(sd);
        to.push(td);
        names.push(tn.replace('mixamorig_', ''));
      }
      const before = Math.sqrt(
        from.reduce((a, d, i) => a + (d.angleTo(to[i]) * DEG) ** 2, 0) / from.length,
      );
      const { q, rms } = bestRotation(from, to);
      const e = new Vector3().setFromEuler(
        new (require('three').Euler)().setFromRotationMatrix(new Matrix4().makeRotationFromQuaternion(q), 'YXZ'),
      );
      const residuals = from
        .map((d, i) => ({ n: names[i], a: d.clone().applyQuaternion(q).angleTo(to[i]) * DEG }))
        .sort((x, y) => y.a - x.a);
      console.log(`\n    ${label}`);
      console.log(
        `      RMS disagreement before ${before.toFixed(1)}°  ->  after one rigid rotation ${rms.toFixed(1)}°`,
      );
      console.log(
        `      that rotation: yaw ${(e.y * DEG).toFixed(1)}°  pitch ${(e.x * DEG).toFixed(1)}°  roll ${(e.z * DEG).toFixed(1)}°`,
      );
      console.log(
        '      worst residuals: ' + residuals.slice(0, 4).map((r) => `${r.n} ${r.a.toFixed(0)}°`).join(', '),
      );
      console.log(
        '      best residuals:  ' + residuals.slice(-4).map((r) => `${r.n} ${r.a.toFixed(0)}°`).join(', '),
      );
    }
  }, 120000);
});
