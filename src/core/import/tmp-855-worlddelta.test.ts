// #855, the decisive question: does a T-pose source rest make the world-delta
// transfer legitimate, and does it satisfy the planted-foot null?
//
// R_T(t) = R_S(t) · Q. The shipped Q aligns rest DIRECTIONS. The alternative here
// is Q = R_T_bind — "apply the source's world rotation-from-its-own-rest to the
// target's bind" — which is the transfer Blender independently validated (V334).
// It is only correct when the source's rest and the target's bind are THE SAME
// POSE. Under a degenerate rest they are not, and it scored -83/+8. Under a
// T-pose rest they should be.
//
// Scored against the planted-foot null: at the frames where a foot is lowest,
// roll from the target's own bind must be ~0. That null is anatomy.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip, resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEGENERATE = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const TPOSE =
  '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/c4498c5a-50b8-4a2a-9a8a-6a9415d0ec19/scratchpad/kimodo-walk-tpose.bvh';
const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);

function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN;
  let d = 2 * Math.atan2(s, q.w) * DEG;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}
const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

describe('#855 — the world-delta transfer under each rest', () => {
  it('scores it against the planted-foot null', async () => {
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

    // target bind frame + rest directions
    const { bones: bind } = specToThreeSkeleton(target.bones);
    bind[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bind) bindRot.set(b.name, worldRot(b));
    const mappedChild = (b: Bone): Bone | null => {
      const stack = [...b.children];
      while (stack.length) {
        const n = stack.shift() as Bone;
        if (!n.isBone) continue;
        if (targetToSource[n.name] !== undefined) return n;
        stack.push(...(n.children as Bone[]));
      }
      return null;
    };
    const restDir = new Map<string, Vector3>();
    for (const b of bind) {
      const c = mappedChild(b);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) continue;
      restDir.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
    }

    const run = (label: string, path: string) => {
      const soma = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);

      // source world rotations per frame, and its own rest rotations
      const { bones: sp } = specToThreeSkeleton(soma.skeletonParams.bones);
      sp[0].updateMatrixWorld(true);
      const srcRest = new Map<string, Quaternion>();
      for (const b of sp) srcRest.set(b.name, worldRot(b));
      const sTimes = [...new Set(soma.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const sBy = new Map<number, typeof soma.clipParams.keyframes>();
      for (const k of soma.clipParams.keyframes) sBy.set(k.time, [...(sBy.get(k.time) ?? []), k]);
      const srcWorld = new Map<string, Quaternion[]>();
      for (const t of sTimes) {
        for (const k of sBy.get(t) ?? []) {
          const b = sp[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
        }
        sp[0].updateMatrixWorld(true);
        for (const b of sp) srcWorld.set(b.name, [...(srcWorld.get(b.name) ?? []), worldRot(b)]);
      }

      // planted frames read off the SOURCE clip's own foot height. The two files
      // carry the same motion (4e-6 m), so this picks the SAME frames for both and
      // cannot be contaminated by a retarget that is itself under test.
      const srcFootY = new Map<string, number[]>();
      {
        const { bones: sp2 } = specToThreeSkeleton(soma.skeletonParams.bones);
        for (const t of sTimes) {
          for (const k of sBy.get(t) ?? []) {
            const b = sp2[k.bone];
            if (!b) continue;
            b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
            if (soma.skeletonParams.bones[k.bone].parent === -1)
              b.position.set(k.position[0], k.position[1], k.position[2]);
          }
          sp2[0].updateMatrixWorld(true);
          for (const b of sp2)
            srcFootY.set(b.name, [
              ...(srcFootY.get(b.name) ?? []),
              new Vector3().setFromMatrixPosition(b.matrixWorld).y,
            ]);
        }
      }

      // (kept for contrast) the shipped retarget's posed target
      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: {
          name: soma.clipParams.name,
          duration: soma.clipParams.duration,
          keyframes: soma.clipParams.keyframes,
        },
        targetBones: target.bones,
        nameMap: preset.map,
      });
      const { bones: pose } = specToThreeSkeleton(target.bones);
      const tTimes = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const tBy = new Map<number, typeof out.clipParams.keyframes>();
      for (const k of out.clipParams.keyframes) tBy.set(k.time, [...(tBy.get(k.time) ?? []), k]);
      const footY = new Map<string, number[]>();
      for (const t of tTimes) {
        for (const k of tBy.get(t) ?? []) {
          const b = pose[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (target.bones[k.bone].parent === -1)
            b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        pose[0].updateMatrixWorld(true);
        for (const b of pose)
          footY.set(b.name, [
            ...(footY.get(b.name) ?? []),
            new Vector3().setFromMatrixPosition(b.matrixWorld).y,
          ]);
      }

      const rollAt = (name: string, Q: Quaternion, frames: number[]): number => {
        const bq = bindRot.get(name)!;
        const d = restDir.get(name)!;
        const ws = srcWorld.get(targetToSource[name])!;
        const v = frames.map((i) =>
          twistDeg(bq.clone().invert().multiply(ws[i].clone().multiply(Q)), d),
        );
        return v.reduce((a, b) => a + b, 0) / v.length;
      };

      console.log(`\n===== ${label} =====`);
      for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
        const ys = srcFootY.get(targetToSource[name]);
        if (!ys) continue;
        const planted = ys
          .map((y, i) => ({ y, i }))
          .sort((a, b) => a.y - b.y)
          .slice(0, 8)
          .map((r) => r.i);
        // Q = R_S_rest^-1 · R_T_bind — the world-delta-from-own-rest transfer.
        const sn = targetToSource[name];
        const Q = srcRest.get(sn)!.clone().invert().multiply(bindRot.get(name)!);
        console.log(
          `  ${name.replace('mixamorig_', '').padEnd(11)} world-delta mean roll ` +
            `${rollAt(name, Q, planted).toFixed(1).padStart(8)}°  at the 8 planted frames ` +
            `(source foot y ${Math.min(...planted.map((i) => ys[i])).toFixed(3)}–${Math.max(...planted.map((i) => ys[i])).toFixed(3)} m)`,
        );
      }
      // PER-BONE, so a fix that helps its subset and damages the rest is visible
      // rather than hidden behind two good foot rows (the split IS the diagnosis).
      // Each row labelled valid/BLIND against the bone's own bind orientation FIRST:
      // a roll probe cannot see a bone that stands vertical at bind.
      console.log('  per-bone roll from bind, world-delta transfer — closest approach over the clip');
      for (const tn of Object.keys(targetToSource)) {
        const bq = bindRot.get(tn);
        const d = restDir.get(tn);
        const rest = srcRest.get(targetToSource[tn]);
        const ws = srcWorld.get(targetToSource[tn]);
        if (!bq || !d || !rest || !ws) continue;
        const Q = rest.clone().invert().multiply(bq);
        const rolls = ws.map((w) => Math.abs(twistDeg(bq.clone().invert().multiply(w.clone().multiply(Q)), d)));
        const offVertical = Math.abs(90 - d.clone().applyQuaternion(bq).angleTo(UP) * DEG);
        console.log(
          `    ${(offVertical > 70 ? 'BLIND ' : 'valid ')}${tn.replace('mixamorig_', '').padEnd(14)}` +
            ` min ${Math.min(...rolls).toFixed(1).padStart(6)}°  max ${Math.max(...rolls).toFixed(1).padStart(6)}°`,
        );
      }

      // and how far every mapped bone lands from its bind at the reference frame
      let worst = 0;
      let worstName = '';
      for (const [tn, sn] of Object.entries(targetToSource)) {
        const bq = bindRot.get(tn);
        const rest = srcRest.get(sn);
        const ws = srcWorld.get(sn);
        if (!bq || !rest || !ws) continue;
        const Q = rest.clone().invert().multiply(bq);
        const at0 = ws[0].clone().multiply(Q);
        const off = bq.angleTo(at0) * DEG;
        if (off > worst) {
          worst = off;
          worstName = tn.replace('mixamorig_', '');
        }
      }
      console.log(
        `  worst bone offset from its bind at the clip's first frame: ${worst.toFixed(1)}° (${worstName})`,
      );
    };

    run('DEGENERATE REST', DEGENERATE);
    run('T-POSE REST', TPOSE);
  }, 120000);
});
