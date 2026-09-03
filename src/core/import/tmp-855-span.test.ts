// Does a rest pose supply a BODY FRAME? A rest whose bone directions all lie on
// one line carries one dimension of information; a rest with a spine, arms and
// feet pointing three different ways carries three. The second axis the roll
// needs has to come from somewhere — this asks whether the rest has one at all.
// Measured as the singular values of the matrix of rest directions.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Matrix3, Vector3, type Bone } from 'three';
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

/** eigenvalues of a symmetric 3x3, ascending — enough for a scatter matrix. */
function eigenvalues(m: Matrix3): number[] {
  const e = m.elements;
  const [a, d, g, b, ee, h, c, f, i] = [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]];
  void d;
  void g;
  void b;
  void c;
  const p1 = h * h + f * f + (e[3] * e[3]);
  const q = (a + ee + i) / 3;
  const p2 = (a - q) ** 2 + (ee - q) ** 2 + (i - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  if (p < 1e-14) return [a, a, a];
  const B = new Matrix3().copy(m);
  const be = B.elements;
  for (let k = 0; k < 9; k++) be[k] = (be[k] - (k % 4 === 0 ? q : 0)) / p;
  const det =
    be[0] * (be[4] * be[8] - be[5] * be[7]) -
    be[3] * (be[1] * be[8] - be[2] * be[7]) +
    be[6] * (be[1] * be[5] - be[2] * be[4]);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e3, e2, e1].sort((x, y) => y - x);
}

describe('#855 — does the rest carry a body frame?', () => {
  it('reports the spread of rest directions for each rest and for the target', async () => {
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
    const dirs = (bones: Bone[], map: Record<string, unknown>): Vector3[] => {
      bones[0].updateMatrixWorld(true);
      const out: Vector3[] = [];
      for (const b of bones) {
        const c = mappedChild(b, map);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() > 1e-18) out.push(d.normalize());
      }
      return out;
    };
    const report = (label: string, ds: Vector3[]) => {
      const m = new Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      const el = m.elements;
      for (const d of ds) {
        el[0] += d.x * d.x;
        el[1] += d.y * d.x;
        el[2] += d.z * d.x;
        el[3] += d.x * d.y;
        el[4] += d.y * d.y;
        el[5] += d.z * d.y;
        el[6] += d.x * d.z;
        el[7] += d.y * d.z;
        el[8] += d.z * d.z;
      }
      for (let k = 0; k < 9; k++) el[k] /= ds.length;
      const ev = eigenvalues(m).map((v) => Math.max(0, v));
      console.log(
        `    ${label.padEnd(28)} n=${String(ds.length).padStart(2)}  spread ` +
          ev.map((v) => v.toFixed(3)).join(' / ') +
          `   smallest/largest = ${(ev[2] / ev[0]).toFixed(4)}`,
      );
    };

    const { bones: tgt } = specToThreeSkeleton(target.bones);
    const sD = parseBvh(readFileSync(DEGENERATE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
    const sT = parseBvh(readFileSync(TPOSE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
    console.log('    a rest spans 3 dimensions only if all three numbers are non-trivial');
    report('source, DEGENERATE rest', dirs(specToThreeSkeleton(sD.skeletonParams.bones).bones, nameMap));
    report('source, T-POSE rest', dirs(specToThreeSkeleton(sT.skeletonParams.bones).bones, nameMap));
    report('target bind (for contrast)', dirs(tgt, targetToSource));
  }, 120000);
});
