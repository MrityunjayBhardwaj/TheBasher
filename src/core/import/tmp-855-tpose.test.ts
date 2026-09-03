// PROBE (#855) — the same clip, the same target, TWO source rests.
//
// The generator's exporter takes `standard_tpose`. Read from source, it swaps the
// written rest between `neutral_joints` (anatomical) and `bvh_neutral_joints`
// (every bone straightened onto ±X), and rewrites the channels to match. A
// round-trip of the clip we already hold produced a T-pose-rest twin whose world
// joint positions agree with the original to 3.8e-06 m — same motion, different rest.
//
// So this asks the only question that matters: does the retarget's open defect
// survive the rest change, or dissolve with it?
//
// Every row is labelled valid/BLIND against the bone's own bind orientation
// BEFORE it is read — a roll probe cannot see a bone that stands vertical at bind,
// and reading those rows as health is what mis-scoped #854 twice.
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
const DEGENERATE = resolve(__dirname, '../../../public/assets/motion-old-walk.bvh');
const TPOSE = resolve(__dirname, '../../../public/assets/motion/walk.bvh');
const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);

function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN;
  let deg = 2 * Math.atan2(s, q.w) * DEG;
  while (deg > 180) deg -= 360;
  while (deg <= -180) deg += 360;
  return deg;
}

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

describe('PROBE #855 — degenerate rest vs T-pose rest', () => {
  it('measures the planted-foot null under both source rests', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    // ---- target-side bind frame: shared by both runs, computed once --------
    const { bones: bindBones } = specToThreeSkeleton(target.bones);
    bindBones[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bindBones) bindRot.set(b.name, worldRot(b));

    const somaProbe = parseBvh(
      readFileSync(DEGENERATE, 'utf8'),
      'kimodo-walk',
      BVH_UNIT_SCALE_CENTIMETRES,
    );
    const nameMap = resolveNameMapToTarget(
      resolveNameMapToSource(preset.map, somaProbe.skeletonParams.bones),
      target.bones,
    );
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;

    const restDir = new Map<string, Vector3>();
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
    for (const b of bindBones) {
      const c = mappedChild(b);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) continue;
      restDir.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
    }

    // A roll probe is BLIND on a bone that stands vertical at bind — its axis
    // becomes the direction check, which the retarget satisfies exactly (H561).
    const validity = new Map<string, string>();
    for (const [name, d] of restDir) {
      const bind = bindRot.get(name)!;
      const worldDir = d.clone().applyQuaternion(bind);
      const offVertical = Math.abs(90 - worldDir.angleTo(UP) * DEG); // 90 = horizontal
      validity.set(name, offVertical > 70 ? 'BLIND ' : 'valid ');
    }

    const measure = (label: string, bvhPath: string) => {
      const soma = parseBvh(readFileSync(bvhPath, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
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

      const { bones: poseBones } = specToThreeSkeleton(target.bones);
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, typeof out.clipParams.keyframes>();
      for (const k of out.clipParams.keyframes)
        byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);

      const roll = new Map<string, number[]>();
      const footY = new Map<string, number[]>();
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const b = poseBones[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (target.bones[k.bone].parent === -1)
            b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        poseBones[0].updateMatrixWorld(true);
        for (const b of poseBones) {
          const d = restDir.get(b.name);
          const bind = bindRot.get(b.name);
          if (!d || !bind) continue;
          const delta = bind.clone().invert().multiply(worldRot(b));
          roll.set(b.name, [...(roll.get(b.name) ?? []), twistDeg(delta, d)]);
          footY.set(b.name, [
            ...(footY.get(b.name) ?? []),
            new Vector3().setFromMatrixPosition(b.matrixWorld).y,
          ]);
        }
      }

      console.log(`\n===== ${label} =====`);
      console.log('  THE PLANTED-FOOT NULL — mean roll from the target’s own bind');
      console.log('  at the 8 frames where the foot is lowest. 0 is correct; it is anatomy.');
      for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
        const ys = footY.get(name);
        const rs = roll.get(name);
        if (!ys || !rs) continue;
        const planted = ys
          .map((y, i) => ({ y, i }))
          .sort((a, b) => a.y - b.y)
          .slice(0, 8)
          .map((r) => r.i);
        const mean = planted.reduce((a, i) => a + rs[i], 0) / planted.length;
        console.log(
          `    ${validity.get(name)}${name.replace('mixamorig_', '').padEnd(11)} ` +
            `mean ${mean.toFixed(1).padStart(8)}°   ` +
            `min|roll| ${Math.min(...planted.map((i) => Math.abs(rs[i]))).toFixed(1).padStart(6)}°`,
        );
      }

      console.log('  PER-BONE ROLL (closest approach to bind), labelled before reading:');
      for (const name of [
        'mixamorig_Hips',
        'mixamorig_Spine',
        'mixamorig_Spine2',
        'mixamorig_Neck',
        'mixamorig_Head',
        'mixamorig_LeftArm',
        'mixamorig_LeftForeArm',
        'mixamorig_LeftHand',
        'mixamorig_LeftUpLeg',
        'mixamorig_LeftLeg',
        'mixamorig_LeftFoot',
        'mixamorig_RightFoot',
      ]) {
        const rs = roll.get(name);
        if (!rs) continue;
        console.log(
          `    ${validity.get(name)}${name.replace('mixamorig_', '').padEnd(13)} ` +
            `min ${Math.min(...rs.map(Math.abs)).toFixed(1).padStart(6)}°  ` +
            `max ${Math.max(...rs.map(Math.abs)).toFixed(1).padStart(6)}°`,
        );
      }
    };

    measure('DEGENERATE REST (what we receive today)', DEGENERATE);
    measure('T-POSE REST (standard_tpose=True, same motion)', TPOSE);
  }, 120000);
});
