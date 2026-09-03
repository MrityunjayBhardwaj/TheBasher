// The three metrics that decide the fix: drift grade, planted-foot roll at
// ground contact (0 = correct), and facing-vs-travel. Run against whatever the
// code currently does, so it can score a candidate by inverse edit.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { specToThreeSkeleton } from './threeAdapter';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const DEG = 180 / Math.PI;
const LABEL = process.env.VARIANT ?? 'current';

const worldRot = (b: Bone) => {
  const q = new Quaternion();
  b.matrixWorld.decompose(new Vector3(), q, new Vector3());
  return q;
};
const twistDeg = (q: Quaternion, axis: Vector3) => {
  const v = new Vector3(q.x, q.y, q.z);
  const proj = axis.clone().multiplyScalar(v.dot(axis));
  const t = new Quaternion(proj.x, proj.y, proj.z, q.w).normalize();
  return 2 * Math.atan2(new Vector3(t.x, t.y, t.z).dot(axis), t.w) * DEG;
};

describe(`METRICS [${LABEL}]`, () => {
  it('drift, planted-foot roll, facing', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(preset.map)) targetToSource[t] = s;

    // target bind: world rotations + each mapped bone's rest direction in bone-local
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
    const restLocal = new Map<string, Vector3>();
    for (const b of bind) {
      const c = mappedChild(b);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const d = new Vector3().setFromMatrixPosition(c.matrixWorld).sub(here);
      if (d.lengthSq() < 1e-18) continue;
      restLocal.set(b.name, d.applyQuaternion(worldRot(b).clone().invert()).normalize());
    }

    for (const name of ['walk', 'run']) {
      const soma = parseBvh(
        readFileSync(resolve(__dirname, `../../../public/assets/motion/${name}.bvh`), 'utf8'),
        'clip', BVH_UNIT_SCALE_CENTIMETRES,
      );
      // contact frames from the SOURCE clip (cannot be contaminated by the retarget)
      const { bones: sp } = specToThreeSkeleton(soma.skeletonParams.bones);
      const sTimes = [...new Set(soma.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const sBy = new Map<number, typeof soma.clipParams.keyframes>();
      for (const k of soma.clipParams.keyframes) sBy.set(k.time, [...(sBy.get(k.time) ?? []), k]);
      const srcY = new Map<string, number[]>();
      for (const t of sTimes) {
        for (const k of sBy.get(t) ?? []) {
          const b = sp[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (k.position) b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        sp[0].updateMatrixWorld(true);
        for (const b of sp)
          srcY.set(b.name, [...(srcY.get(b.name) ?? []), new Vector3().setFromMatrixPosition(b.matrixWorld).y]);
      }
      const plantedFrames = (srcName: string): number[] => {
        const ys = srcY.get(srcName) ?? [];
        return ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]).slice(0, 8).map(([, i]) => i);
      };

      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
        targetBones: target.bones, nameMap: preset.map,
      });
      const oTimes = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const oBy = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) {
        if (!oBy.has(k.time)) oBy.set(k.time, new Map());
        oBy.get(k.time)!.set(k.bone, k);
      }
      const { bones: pose } = specToThreeSkeleton(target.bones);
      const rootPos: Vector3[] = [];
      const roll = new Map<string, number[]>();
      for (const t of oTimes) {
        const frame = oBy.get(t)!;
        for (const [bi, k] of frame) {
          const b = pose[bi];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (k.position) b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        pose[0].updateMatrixWorld(true);
        rootPos.push(new Vector3().setFromMatrixPosition(pose[1].matrixWorld));
        for (const b of pose) {
          const rl = restLocal.get(b.name);
          const br = bindRot.get(b.name);
          if (!rl || !br) continue;
          const residual = br.clone().invert().multiply(worldRot(b));
          roll.set(b.name, [...(roll.get(b.name) ?? []), twistDeg(residual, rl)]);
        }
      }
      const travel = Math.hypot(rootPos.at(-1)!.x - rootPos[0].x, rootPos.at(-1)!.z - rootPos[0].z);
      const rise = rootPos.at(-1)!.y - rootPos[0].y;
      const footRoll = (tName: string, sName: string) => {
        const rs = roll.get(tName) ?? [];
        const fr = plantedFrames(sName);
        return fr.reduce((a, i) => a + (rs[i] ?? 0), 0) / fr.length;
      };
      console.log(
        `[${LABEL}] ${name.padEnd(5)} rise=${rise.toFixed(4)}m /${travel.toFixed(3)}m => ${(Math.atan2(rise, travel) * DEG).toFixed(2)}° | ` +
        `planted-foot roll L=${footRoll('mixamorig_LeftFoot', 'LeftFoot').toFixed(1)}° R=${footRoll('mixamorig_RightFoot', 'RightFoot').toFixed(1)}°`,
      );
    }
  });
});
