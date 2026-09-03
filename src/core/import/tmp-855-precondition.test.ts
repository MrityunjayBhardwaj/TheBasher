// #855 — (a) is the antiparallel case ARBITRARY, or just large?
//        (b) what discriminates "the two rests are the same pose" from "they are not"?
// (a) is the difference between a big number and a defect. (b) is the guard's threshold.
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

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

describe('#855 preconditions', () => {
  it('(a) perturbs the antiparallel input and watches the correction jump', () => {
    // three.js setFromUnitVectors picks a perpendicular by an axis-magnitude test
    // when the inputs oppose. Nothing about the rig chooses it, so a hair of noise
    // in the source rest flips it. That is the difference between "180 degrees"
    // and "arbitrary": a continuous input produces a discontinuous correction.
    const target = new Vector3(0, 1, 0);
    console.log('  perturbation of an antiparallel source direction -> resulting correction');
    let prev: Quaternion | null = null;
    for (const eps of [-0.02, -0.005, -0.0005, 0.0005, 0.005, 0.02]) {
      const src = new Vector3(eps, -1, eps * 0.5).normalize();
      const q = new Quaternion().setFromUnitVectors(target, src);
      const axis = new Vector3(q.x, q.y, q.z).normalize();
      const jump = prev ? prev.angleTo(q) * DEG : 0;
      console.log(
        `    eps ${eps.toFixed(4).padStart(8)}  angle ${(2 * Math.acos(Math.min(1, Math.abs(q.w))) * DEG).toFixed(1).padStart(6)}°` +
          `  axis (${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)})  jump from previous ${jump.toFixed(1).padStart(6)}°`,
      );
      prev = q;
    }
  });

  it('(b) measures how far each source rest is from the target bind, as a pose', async () => {
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
    // WORLD direction of each bone, at rest/bind. Frame-independent — comparable
    // across two rigs that disagree about every local axis.
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
    void worldRot;

    for (const [label, path] of [
      ['DEGENERATE rest', DEGENERATE],
      ['T-POSE rest', TPOSE],
    ] as const) {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones } = specToThreeSkeleton(s.skeletonParams.bones);
      const sDirs = worldDirs(bones, nameMap);
      const rows: Array<{ n: string; a: number }> = [];
      for (const [tn, sn] of Object.entries(targetToSource)) {
        const td = tDirs.get(tn);
        const sd = sDirs.get(sn);
        if (!td || !sd) continue;
        rows.push({ n: tn.replace('mixamorig_', ''), a: td.angleTo(sd) * DEG });
      }
      rows.sort((x, y) => y.a - x.a);
      const mean = rows.reduce((acc, r) => acc + r.a, 0) / rows.length;
      console.log(
        `\n  ${label}: WORLD rest direction vs the target's bind, ${rows.length} mapped bones`,
      );
      console.log(
        `    mean ${mean.toFixed(1)}°   max ${rows[0].a.toFixed(1)}° (${rows[0].n})   min ${rows[rows.length - 1].a.toFixed(1)}° (${rows[rows.length - 1].n})`,
      );
      console.log('    worst five: ' + rows.slice(0, 5).map((r) => `${r.n} ${r.a.toFixed(0)}°`).join(', '));
    }
  }, 120000);
});
