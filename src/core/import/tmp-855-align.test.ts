// #855 — WHY the T-pose rest makes the shipped correction worse.
// Prints, per mapped bone: the source's rest direction under each rest, the
// target's, and the angle setFromUnitVectors must span. 180° is the singular
// case — the minimal rotation's axis is arbitrary there.
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

describe('#855 — rest direction alignment under both rests', () => {
  it('prints the angle the minimal rotation has to span', async () => {
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

    const localDir = (b: Bone, c: Bone): Vector3 | null => {
      const here = new Vector3();
      const rot = new Quaternion();
      const sc = new Vector3();
      b.matrixWorld.decompose(here, rot, sc);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) return null;
      return d.applyQuaternion(rot.invert()).normalize();
    };
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

    const { bones: tgt } = specToThreeSkeleton(target.bones);
    tgt[0].updateMatrixWorld(true);

    const srcDirs = (path: string) => {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones } = specToThreeSkeleton(s.skeletonParams.bones);
      bones[0].updateMatrixWorld(true);
      const byName = new Map(bones.map((b) => [b.name, b]));
      const out = new Map<string, Vector3>();
      for (const b of bones) {
        const c = mappedChild(b, nameMap);
        if (!c) continue;
        const d = localDir(b, c);
        if (d) out.set(b.name, d);
      }
      // also report rest world rotations, to show whether the rest carries frames
      const rots = new Map<string, Quaternion>();
      for (const b of bones) {
        const p = new Vector3();
        const r = new Quaternion();
        const sc = new Vector3();
        b.matrixWorld.decompose(p, r, sc);
        rots.set(b.name, r);
      }
      void byName;
      return { dirs: out, rots };
    };

    const deg = srcDirs(DEGENERATE);
    const tp = srcDirs(TPOSE);

    console.log(
      '  bone            target local dir        | degenerate src dir  ang | T-pose src dir      ang',
    );
    for (const tb of tgt) {
      const sn = targetToSource[tb.name];
      if (!sn) continue;
      const tc = mappedChild(tb, targetToSource);
      if (!tc) continue;
      const td = localDir(tb, tc);
      const dd = deg.dirs.get(sn);
      const td2 = tp.dirs.get(sn);
      if (!td || !dd || !td2) continue;
      const f = (v: Vector3) =>
        `(${v.x.toFixed(2).padStart(5)},${v.y.toFixed(2).padStart(5)},${v.z.toFixed(2).padStart(5)})`;
      console.log(
        `  ${tb.name.replace('mixamorig_', '').padEnd(14)} ${f(td)}   | ${f(dd)} ${(td.angleTo(dd) * DEG).toFixed(0).padStart(4)}° | ${f(td2)} ${(td.angleTo(td2) * DEG).toFixed(0).padStart(4)}°`,
      );
    }

    console.log('\n  DOES EITHER REST CARRY BONE FRAMES? (rest world rotation, identity = no)');
    for (const n of ['Hips', 'LeftFoot', 'RightFoot', 'LeftArm', 'LeftLeg']) {
      const a = deg.rots.get(n);
      const b = tp.rots.get(n);
      if (!a || !b) continue;
      const fmt = (q: Quaternion) =>
        `(${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)})`;
      console.log(`    ${n.padEnd(10)} degenerate ${fmt(a)}   T-pose ${fmt(b)}`);
    }
  }, 120000);
});
