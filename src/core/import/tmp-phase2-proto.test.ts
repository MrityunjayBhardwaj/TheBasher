// Cheapest proof the Phase 2 shape works, BEFORE it touches retarget.ts.
//
// The pipeline right-multiplies (SkeletonUtils.js:127): T_b(t) = W_b(t) · Q_b.
// So a whole-rig alignment R cannot live in Q_b. It has to be conjugated:
// pre-rotate the SOURCE WRAPPER by R and set Q_b = R^-1 · B_b, which yields
// T_b(t) = R · W_b(t) · R^-1 · B_b — the source's motion re-expressed in the
// target's body frame, then applied to the target's own bind.
//
// TWO nulls, because the first one alone cannot see the defect that matters:
//   (1) planted foot — at ground contact a foot's roll from its bind is ~0.
//   (2) travel facing — a walking character faces roughly where it travels.
// (2) is what catches a body-frame error: copying world rotations between rigs
// yawed 90° apart moves limbs in the wrong plane, and (1) is blind to it.
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
const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};
function bestRotation(from: Vector3[], to: Vector3[]): Quaternion {
  const cost = (q: Quaternion) =>
    from.reduce((a, d, i) => a + (d.clone().applyQuaternion(q).angleTo(to[i]) * DEG) ** 2, 0);
  let best = new Quaternion();
  let bestC = cost(best);
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  for (const ax of axes)
    for (let d = 0; d < 360; d += 15) {
      const q = new Quaternion().setFromAxisAngle(ax, (d * Math.PI) / 180);
      const c = cost(q);
      if (c < bestC) { bestC = c; best = q; }
    }
  for (let step = 20; step > 0.05; step *= 0.6) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const ax of axes)
        for (const sgn of [1, -1]) {
          const q = best.clone().multiply(new Quaternion().setFromAxisAngle(ax, (sgn * step * Math.PI) / 180));
          const c = cost(q);
          if (c < bestC - 1e-9) { bestC = c; best = q; improved = true; }
        }
    }
  }
  return best;
}

describe('Phase 2 prototype — conjugated alignment, two nulls', () => {
  it('scores each candidate on BOTH nulls', async () => {
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
    const { bones: bind } = specToThreeSkeleton(target.bones);
    bind[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bind) bindRot.set(b.name, worldRot(b));
    const restDirLocal = new Map<string, Vector3>();
    const restDirWorld = new Map<string, Vector3>();
    for (const b of bind) {
      const c = mappedChild(b, targetToSource);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) continue;
      restDirWorld.set(b.name, d.clone().normalize());
      restDirLocal.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
    }
    // The target's FORWARD, derived not assumed: a foot points where the toes go.
    const forward = new Vector3();
    for (const n of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const d = restDirWorld.get(n);
      if (d) forward.add(d);
    }
    forward.y = 0;
    forward.normalize();
    console.log(`  target's forward, from its own feet: (${forward.x.toFixed(2)}, ${forward.y.toFixed(2)}, ${forward.z.toFixed(2)})`);
    const hipsBind = bindRot.get('mixamorig_Hips')!;
    const forwardInHips = forward.clone().applyQuaternion(hipsBind.clone().invert());

    const score = (label: string, path: string, conjugate: boolean) => {
      const s = parseBvh(readFileSync(path, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones: sp } = specToThreeSkeleton(s.skeletonParams.bones);
      sp[0].updateMatrixWorld(true);
      const srcRestW = new Map<string, Vector3>();
      for (const b of sp) {
        const c = mappedChild(b, nameMap);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() > 1e-18) srcRestW.set(b.name, d.normalize());
      }
      const from: Vector3[] = [];
      const to: Vector3[] = [];
      for (const [tn, sn] of Object.entries(targetToSource)) {
        const a = srcRestW.get(sn);
        const b2 = restDirWorld.get(tn);
        if (a && b2) { from.push(a); to.push(b2); }
      }
      const R = conjugate ? bestRotation(from, to) : new Quaternion();

      // source world rotations + hip travel, per frame
      const times = [...new Set(s.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const by = new Map<number, typeof s.clipParams.keyframes>();
      for (const k of s.clipParams.keyframes) by.set(k.time, [...(by.get(k.time) ?? []), k]);
      const W = new Map<string, Quaternion[]>();
      const hipPos: Vector3[] = [];
      const srcFootY = new Map<string, number[]>();
      for (const t of times) {
        for (const k of by.get(t) ?? []) {
          const b = sp[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          // This clip carries world translation on HIPS, not on the Root wrapper
          // (Root's channels stay zero). Restricting positions to parent === -1
          // left the character walking on the spot — travelled 0.00 m — and the
          // facing null then read the same 90° for every candidate, which is the
          // tell that it was measuring nothing.
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        sp[0].updateMatrixWorld(true);
        for (const b of sp) {
          W.set(b.name, [...(W.get(b.name) ?? []), worldRot(b)]);
          srcFootY.set(b.name, [...(srcFootY.get(b.name) ?? []), new Vector3().setFromMatrixPosition(b.matrixWorld).y]);
        }
        const hipsBone = sp.find((b) => b.name === targetToSource['mixamorig_Hips']);
        if (hipsBone) hipPos.push(new Vector3().setFromMatrixPosition(hipsBone.matrixWorld));
      }

      // T_b(t) = R · W_b(t) · R^-1 · B_b   (R = identity for the unconjugated case)
      const Rinv = R.clone().invert();
      const Tof = (tn: string, i: number) =>
        R.clone().multiply(W.get(targetToSource[tn])![i]).multiply(Rinv).multiply(bindRot.get(tn)!);

      // NULL 1 — planted foot
      const feet: string[] = [];
      for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
        const ys = srcFootY.get(targetToSource[name])!;
        const planted = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y).slice(0, 8).map((r) => r.i);
        const d = restDirLocal.get(name)!;
        const bq = bindRot.get(name)!;
        const mean =
          planted.reduce((a, i) => a + twistDeg(bq.clone().invert().multiply(Tof(name, i)), d), 0) /
          planted.length;
        feet.push(`${name.replace('mixamorig_', '')} ${mean.toFixed(1).padStart(7)}°`);
      }

      // NULL 2 — travel facing. A walk goes where it faces.
      const travel = R.clone().multiply(new Quaternion()); void travel;
      // Per-frame velocity, not one chord: a walk can curve, and comparing every
      // frame's facing against a single endpoint-to-endpoint direction would
      // charge the curve to the retarget.
      const travelLen = hipPos[hipPos.length - 1].clone().sub(hipPos[0]).length();
      const velocity: (Vector3 | null)[] = hipPos.map((_, i) => {
        if (i === 0 || i === hipPos.length - 1) return null;
        const v = hipPos[i + 1].clone().sub(hipPos[i - 1]).applyQuaternion(R);
        v.y = 0;
        return v.lengthSq() < 1e-8 ? null : v.normalize();
      });
      let facingErr = 0;
      let counted = 0;
      for (let i = 0; i < times.length; i++) {
        const v = velocity[i];
        if (!v) continue;
        const f = forwardInHips.clone().applyQuaternion(Tof('mixamorig_Hips', i));
        f.y = 0;
        if (f.lengthSq() < 1e-9) continue;
        facingErr += f.normalize().angleTo(v) * DEG;
        counted++;
      }
      facingErr /= Math.max(1, counted);
      console.log(
        `  ${label.padEnd(34)} planted: ${feet.join('  ')}   |  facing-vs-travel ${facingErr.toFixed(1).padStart(6)}° (travelled ${travelLen.toFixed(2)} m)`,
      );
    };

    // CONTROL, read FIRST: does the SOURCE face where it travels? If the
    // generated clip itself walks sideways, a target that inherits that is
    // correct and this null would be charging the retarget for the clip.
    {
      const s = parseBvh(readFileSync(TPOSE, 'utf8'), 'c', BVH_UNIT_SCALE_CENTIMETRES);
      const { bones: sp } = specToThreeSkeleton(s.skeletonParams.bones);
      sp[0].updateMatrixWorld(true);
      const srcRestW = new Map<string, Vector3>();
      for (const b of sp) {
        const c = mappedChild(b, nameMap);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() > 1e-18) srcRestW.set(b.name, d.normalize());
      }
      const fwd = new Vector3();
      for (const n of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
        const d = srcRestW.get(targetToSource[n]);
        if (d) fwd.add(d);
      }
      fwd.y = 0;
      fwd.normalize();
      const hipsName = targetToSource['mixamorig_Hips'];
      const hipsRest = (() => {
        const b = sp.find((x) => x.name === hipsName)!;
        return worldRot(b).clone();
      })();
      const fwdLocal = fwd.clone().applyQuaternion(hipsRest.invert());
      const times = [...new Set(s.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const by = new Map<number, typeof s.clipParams.keyframes>();
      for (const k of s.clipParams.keyframes) by.set(k.time, [...(by.get(k.time) ?? []), k]);
      const pos: Vector3[] = [];
      const rot: Quaternion[] = [];
      for (const t of times) {
        for (const k of by.get(t) ?? []) {
          const b = sp[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        sp[0].updateMatrixWorld(true);
        const hb = sp.find((x) => x.name === hipsName)!;
        pos.push(new Vector3().setFromMatrixPosition(hb.matrixWorld));
        rot.push(worldRot(hb));
      }
      let err = 0;
      let n = 0;
      for (let i = 1; i < pos.length - 1; i++) {
        const v = pos[i + 1].clone().sub(pos[i - 1]);
        v.y = 0;
        if (v.lengthSq() < 1e-8) continue;
        const f = fwdLocal.clone().applyQuaternion(rot[i]);
        f.y = 0;
        if (f.lengthSq() < 1e-9) continue;
        err += f.normalize().angleTo(v.normalize()) * DEG;
        n++;
      }
      console.log(
        `  CONTROL — the SOURCE's own facing vs its own travel: ${(err / Math.max(1, n)).toFixed(1)}° over ${n} frames`,
      );
      console.log('  (a target cannot beat this; the clip is what it is)\n');
    }

    score('degenerate, world-delta', DEGENERATE, false);
    score('degenerate, conjugated', DEGENERATE, true);
    score('T-pose, world-delta', TPOSE, false);
    score('T-pose, CONJUGATED  <-- proposed', TPOSE, true);
  }, 180000);
});
