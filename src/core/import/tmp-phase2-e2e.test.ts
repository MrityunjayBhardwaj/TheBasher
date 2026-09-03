// The nulls, measured end to end through retargetClip's actual output keyframes.
// The prototype composed the formula by hand; this poses the target from the
// clip the pipeline really emits, which is what the viewport plays.
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

describe('end to end through retargetClip', () => {
  it('measures both nulls on the emitted clip', async () => {
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
    const { bones: bind } = specToThreeSkeleton(target.bones);
    bind[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bind) bindRot.set(b.name, worldRot(b));
    const restLocal = new Map<string, Vector3>();
    const restWorld = new Map<string, Vector3>();
    for (const b of bind) {
      const c = mappedChild(b);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) continue;
      restWorld.set(b.name, d.clone().normalize());
      restLocal.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
    }
    const forward = new Vector3();
    for (const n of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const d = restWorld.get(n);
      if (d) forward.add(d);
    }
    forward.y = 0;
    forward.normalize();
    void forward;

    const run = (label: string, path: string) => {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const out = retargetClip({
        sourceBones: s.skeletonParams.bones,
        sourceClip: {
          name: s.clipParams.name,
          duration: s.clipParams.duration,
          keyframes: s.clipParams.keyframes,
        },
        targetBones: target.bones,
        nameMap: preset.map,
      });
      const { bones: pose } = specToThreeSkeleton(target.bones);
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const by = new Map<number, typeof out.clipParams.keyframes>();
      for (const k of out.clipParams.keyframes) by.set(k.time, [...(by.get(k.time) ?? []), k]);
      const roll = new Map<string, number[]>();
      const y = new Map<string, number[]>();
      const hips: Vector3[] = [];
      const hipsRot: Quaternion[] = [];
      for (const t of times) {
        for (const k of by.get(t) ?? []) {
          const b = pose[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        pose[0].updateMatrixWorld(true);
        for (const b of pose) {
          const d = restLocal.get(b.name);
          const bq = bindRot.get(b.name);
          if (!d || !bq) continue;
          roll.set(b.name, [...(roll.get(b.name) ?? []), twistDeg(bq.clone().invert().multiply(worldRot(b)), d)]);
          y.set(b.name, [...(y.get(b.name) ?? []), new Vector3().setFromMatrixPosition(b.matrixWorld).y]);
        }
        const hb = pose.find((b) => b.name === 'mixamorig_Hips');
        if (hb) hips.push(new Vector3().setFromMatrixPosition(hb.matrixWorld));
        // FACING FROM THE FEET'S OWN DIRECTIONS, not from the hips' orientation.
        // Carrying a forward vector on the hips reads that bone's ROLL, which is
        // precisely what is undetermined on the unaligned path — it reported 170°
        // there and would have been mistaken for a character walking backwards.
        // A direction is roll-independent, so this measures the same property on
        // both paths.
        {
          const f = new Vector3();
          for (const nm of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
            const b = pose.find((x) => x.name === nm);
            const c = b ? mappedChild(b) : null;
            if (!b || !c) continue;
            f.add(
              new Vector3()
                .setFromMatrixPosition(c.matrixWorld)
                .sub(new Vector3().setFromMatrixPosition(b.matrixWorld))
                .normalize(),
            );
          }
          f.y = 0;
          hipsRot.push(new Quaternion(f.x, 0, f.z, 0));
        }
      }
      const feet: string[] = [];
      for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
        const ys = y.get(name)!;
        const rs = roll.get(name)!;
        const planted = ys.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, 8).map((r) => r.i);
        feet.push(
          `${name.replace('mixamorig_', '')} ${(planted.reduce((a, i) => a + rs[i], 0) / planted.length).toFixed(1).padStart(7)}°`,
        );
      }
      let err = 0;
      let n = 0;
      for (let i = 1; i < hips.length - 1; i++) {
        const v = hips[i + 1].clone().sub(hips[i - 1]);
        v.y = 0;
        if (v.lengthSq() < 1e-8) continue;
        const f = new Vector3(hipsRot[i].x, 0, hipsRot[i].z);
        if (f.lengthSq() < 1e-9) continue;
        err += f.normalize().angleTo(v.normalize()) * DEG;
        n++;
      }
      const travel = hips[hips.length - 1].clone().sub(hips[0]).length();
      console.log(
        `  ${label.padEnd(22)} planted: ${feet.join('  ')}   facing ${(err / Math.max(1, n)).toFixed(1).padStart(6)}°   travelled ${travel.toFixed(2)} m`,
      );
      console.log(
        '     per-bone roll, closest approach:  ' +
          ['mixamorig_LeftArm', 'mixamorig_LeftForeArm', 'mixamorig_RightArm', 'mixamorig_LeftFoot', 'mixamorig_RightFoot', 'mixamorig_Head']
            .filter((nm) => roll.has(nm))
            .map((nm) => {
              const d = restLocal.get(nm)!;
              const bq = bindRot.get(nm)!;
              const blind = Math.abs(90 - d.clone().applyQuaternion(bq).angleTo(UP) * DEG) > 70;
              return `${nm.replace('mixamorig_', '')}${blind ? '(BLIND)' : ''} ${Math.min(...roll.get(nm)!.map(Math.abs)).toFixed(1)}°`;
            })
            .join('  '),
      );
    };
    run('degenerate rest', DEGENERATE);
    run('T-pose rest', TPOSE);
  }, 180000);
});
