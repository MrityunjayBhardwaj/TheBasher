// PROBE — what does the SOURCE clip's head do, and does the mapping carry it?
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const BVH = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const DEG = 180 / Math.PI;

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  b.matrixWorld.decompose(p, q, s);
  return q;
};
const twistDeg = (q: Quaternion, axis: Vector3): number => {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  let d = 2 * Math.atan2(s, q.w) * DEG;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
};
const stat = (v: number[]) => ({
  lo: Math.min(...v), hi: Math.max(...v), range: Math.max(...v) - Math.min(...v),
});

describe('PROBE — the head roll in the kimodo walk', () => {
  it('measures the source head, then the retargeted head', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const soma = parseBvh(readFileSync(BVH, 'utf8'), 'kimodo-walk', BVH_UNIT_SCALE_CENTIMETRES);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    // ---------- SOURCE, on its own. No retarget involved. ----------
    const sBind = specToThreeSkeleton(soma.skeletonParams.bones);
    sBind.bones[0].updateMatrixWorld(true);
    const sBindRot = new Map(sBind.bones.map((b) => [b.name, worldRot(b)]));
    const sBindPos = new Map(
      sBind.bones.map((b) => [b.name, new Vector3().setFromMatrixPosition(b.matrixWorld)]),
    );
    // the head's own axis, in the head's local frame, from Head -> HeadEnd
    const hHead = sBindPos.get('Head')!;
    const hEnd = sBindPos.get('HeadEnd')!;
    const sHeadAxis = hEnd.clone().sub(hHead)
      .applyQuaternion(sBindRot.get('Head')!.clone().invert()).normalize();
    console.log(`source head axis (local): (${sHeadAxis.x.toFixed(2)}, ${sHeadAxis.y.toFixed(2)}, ${sHeadAxis.z.toFixed(2)})`);

    const sPose = specToThreeSkeleton(soma.skeletonParams.bones);
    const sTimes = [...new Set(soma.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
    const sBy = new Map<number, typeof soma.clipParams.keyframes>();
    for (const k of soma.clipParams.keyframes) sBy.set(k.time, [...(sBy.get(k.time) ?? []), k]);

    const sHeadRoll: number[] = [];      // roll about the head's own axis, from rest
    const sHeadVsChest: number[] = [];   // total turn of head relative to chest, from rest
    const sNeckBend: number[] = [];      // Neck1 -> Head composite, total angle from rest
    for (const t of sTimes) {
      for (const k of sBy.get(t) ?? []) {
        const b = sPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      sPose.bones[0].updateMatrixWorld(true);
      const now = new Map(sPose.bones.map((b) => [b.name, worldRot(b)]));
      const dHead = sBindRot.get('Head')!.clone().invert().multiply(now.get('Head')!);
      sHeadRoll.push(twistDeg(dHead, sHeadAxis));
      const relNow = now.get('Chest')!.clone().invert().multiply(now.get('Head')!);
      const relRest = sBindRot.get('Chest')!.clone().invert().multiply(sBindRot.get('Head')!);
      sHeadVsChest.push(relRest.clone().invert().multiply(relNow).angleTo(new Quaternion()) * DEG);
      const nNow = now.get('Neck1')!.clone().invert().multiply(now.get('Head')!);
      const nRest = sBindRot.get('Neck1')!.clone().invert().multiply(sBindRot.get('Head')!);
      sNeckBend.push(nRest.clone().invert().multiply(nNow).angleTo(new Quaternion()) * DEG);
    }
    const f0 = 0;
    console.log('SOURCE');
    console.log(`  head roll about its own axis   ${JSON.stringify(stat(sHeadRoll))}  frame0=${sHeadRoll[f0].toFixed(1)}`);
    console.log(`  head turn relative to chest    ${JSON.stringify(stat(sHeadVsChest))}  frame0=${sHeadVsChest[f0].toFixed(1)}`);
    console.log(`  Neck1->Head composite bend     ${JSON.stringify(stat(sNeckBend))}  frame0=${sNeckBend[f0].toFixed(1)}`);
    const sorted = [...sHeadRoll].sort((a, b) => a - b);
    console.log(`  where frame 0 sits in the head-roll range: ${(
      (sHeadRoll[f0] - sorted[0]) / (sorted[sorted.length - 1] - sorted[0]) * 100
    ).toFixed(0)}% (50% would be mid-range)`);

    // ---------- TARGET, after the retarget ----------
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
    const tBind = specToThreeSkeleton(target.bones);
    tBind.bones[0].updateMatrixWorld(true);
    const tBindRot = new Map(tBind.bones.map((b) => [b.name, worldRot(b)]));
    const tBindPos = new Map(
      tBind.bones.map((b) => [b.name, new Vector3().setFromMatrixPosition(b.matrixWorld)]),
    );
    const tHeadAxis = tBindPos
      .get('mixamorig_Head')!
      .clone()
      .sub(tBindPos.get('mixamorig_Neck')!)
      .applyQuaternion(tBindRot.get('mixamorig_Head')!.clone().invert())
      .normalize();

    const tPose = specToThreeSkeleton(target.bones);
    const tTimes = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
    const tBy = new Map<number, typeof out.clipParams.keyframes>();
    for (const k of out.clipParams.keyframes) tBy.set(k.time, [...(tBy.get(k.time) ?? []), k]);
    const tHeadRoll: number[] = [];
    const tHeadVsChest: number[] = [];
    for (const t of tTimes) {
      for (const k of tBy.get(t) ?? []) {
        const b = tPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      tPose.bones[0].updateMatrixWorld(true);
      const now = new Map(tPose.bones.map((b) => [b.name, worldRot(b)]));
      const dHead = tBindRot.get('mixamorig_Head')!.clone().invert().multiply(now.get('mixamorig_Head')!);
      tHeadRoll.push(twistDeg(dHead, tHeadAxis));
      const relNow = now.get('mixamorig_Spine2')!.clone().invert().multiply(now.get('mixamorig_Head')!);
      const relRest = tBindRot.get('mixamorig_Spine2')!.clone().invert().multiply(tBindRot.get('mixamorig_Head')!);
      tHeadVsChest.push(relRest.clone().invert().multiply(relNow).angleTo(new Quaternion()) * DEG);
    }
    console.log('TARGET (after retarget)');
    console.log(`  head roll about its own axis   ${JSON.stringify(stat(tHeadRoll))}  frame0=${tHeadRoll[0].toFixed(1)}`);
    console.log(`  head turn relative to chest    ${JSON.stringify(stat(tHeadVsChest))}  frame0=${tHeadVsChest[0].toFixed(1)}`);
    // ---- convention-free: actual angles between bone DIRECTIONS ----------
    // An angle at a joint is a physical fact about the pose. It does not care
    // which axis either rig calls "along the bone", so the two sides are
    // directly comparable — the same reason the Blender differential uses it.
    const posOf = (bones: readonly Bone[]) => {
      const m = new Map<string, Vector3>();
      for (const b of bones) m.set(b.name, new Vector3().setFromMatrixPosition(b.matrixWorld));
      return m;
    };
    const angleAt = (m: Map<string, Vector3>, a: string, j: string, c: string): number | null => {
      const A = m.get(a); const J = m.get(j); const Cc = m.get(c);
      if (!A || !J || !Cc) return null;
      const u = A.clone().sub(J); const v = Cc.clone().sub(J);
      if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return null;
      return u.angleTo(v) * DEG;
    };
    const srcNeckHead: number[] = [];
    const srcHeadPitch: number[] = [];
    for (const t of sTimes) {
      for (const k of sBy.get(t) ?? []) {
        const b = sPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      sPose.bones[0].updateMatrixWorld(true);
      const m = posOf(sPose.bones);
      const a = angleAt(m, 'Neck2', 'Head', 'HeadEnd');
      if (a !== null) srcNeckHead.push(180 - a); // 0 = head in line with the neck
      const H = m.get('Head')!; const E = m.get('HeadEnd')!;
      srcHeadPitch.push(90 - E.clone().sub(H).angleTo(new Vector3(0, 1, 0)) * DEG);
    }
    const tgtNeckHead: number[] = [];
    for (const t of tTimes) {
      for (const k of tBy.get(t) ?? []) {
        const b = tPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      tPose.bones[0].updateMatrixWorld(true);
      const m = posOf(tPose.bones);
      const a = angleAt(m, 'mixamorig_Neck', 'mixamorig_Head', 'mixamorig_HeadTop_End');
      if (a !== null) tgtNeckHead.push(180 - a);
    }
    console.log('JOINT ANGLES (convention-free, comparable across rigs)');
    console.log(`  source: bend at the HEAD joint (Neck2-Head-HeadEnd) ${JSON.stringify(stat(srcNeckHead))}`);
    console.log(`  source: head axis elevation from horizontal          ${JSON.stringify(stat(srcHeadPitch))}`);
    console.log(`  target: bend at the HEAD joint                       ${
      tgtNeckHead.length ? JSON.stringify(stat(tgtNeckHead)) : 'NO mixamorig_HeadTop_End — head is a leaf on the target'
    }`);
    console.log(`  target bone names: ${target.bones.map((b) => b.name).join(', ')}`);

    // ---- the source's POSTURE profile: each segment's elevation ----------
    // A standing human's spine and neck are near-vertical (~90 deg). This says
    // what the generated clip actually asks for, before any retarget touches it.
    const CHAIN: Array<[string, string]> = [
      ['Hips', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Chest'],
      ['Chest', 'Neck1'], ['Neck1', 'Neck2'], ['Neck2', 'Head'], ['Head', 'HeadEnd'],
      ['LeftLeg', 'LeftShin'], ['LeftShin', 'LeftFoot'],
    ];
    const series = new Map<string, number[]>();
    for (const t of sTimes) {
      for (const k of sBy.get(t) ?? []) {
        const b = sPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      sPose.bones[0].updateMatrixWorld(true);
      const m = posOf(sPose.bones);
      for (const [a, b] of CHAIN) {
        const A = m.get(a); const B2 = m.get(b);
        if (!A || !B2) continue;
        const d = B2.clone().sub(A);
        const e = 90 - d.angleTo(new Vector3(0, 1, 0)) * DEG;
        series.set(`${a}->${b}`, [...(series.get(`${a}->${b}`) ?? []), e]);
      }
    }
    console.log('SOURCE POSTURE — segment elevation from horizontal (90 = straight up)');
    for (const [k, v] of series) {
      const st = stat(v);
      console.log(`  ${k.padEnd(22)} ${st.lo.toFixed(1).padStart(7)} .. ${st.hi.toFixed(1).padStart(7)}   (frame0 ${v[0].toFixed(1)})`);
    }

    // Falsification: at the source's REST the chain is degenerate (every bone
    // along +X), so the head joint must read ~0. If it does not, the "bend" I am
    // attributing to the clip is really the rig's own geometry.
    {
      const m0 = posOf(sBind.bones);
      const restBend = angleAt(m0, 'Neck2', 'Head', 'HeadEnd');
      console.log(`REST bend at the head joint: ${restBend === null ? 'n/a' : (180 - restBend).toFixed(2)}deg  (0 expected on a degenerate rest)`);
    }
    // Is the kink a yaw or a pitch? Compare the horizontal bearing of each segment.
    const AZ: Array<[string, string]> = [
      ['Spine2', 'Chest'], ['Chest', 'Neck1'], ['Neck1', 'Neck2'], ['Neck2', 'Head'], ['Head', 'HeadEnd'],
    ];
    const az = new Map<string, number[]>();
    for (const t of sTimes) {
      for (const k of sBy.get(t) ?? []) {
        const b = sPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      sPose.bones[0].updateMatrixWorld(true);
      const m = posOf(sPose.bones);
      for (const [a, b] of AZ) {
        const A = m.get(a)!; const B2 = m.get(b)!;
        const d = B2.clone().sub(A);
        az.set(`${a}->${b}`, [...(az.get(`${a}->${b}`) ?? []), Math.atan2(d.x, d.z) * DEG]);
      }
    }
    console.log('SOURCE BEARING — horizontal direction of each segment (degrees)');
    const base = az.get('Spine2->Chest')!;
    for (const [k, v] of az) {
      const rel = v.map((x, i) => { let d = x - base[i]; while (d > 180) d -= 360; while (d <= -180) d += 360; return d; });
      const st = stat(rel);
      console.log(`  ${k.padEnd(16)} relative to the chest: ${st.lo.toFixed(1).padStart(7)} .. ${st.hi.toFixed(1).padStart(7)}   (frame0 ${rel[0].toFixed(1)})`);
    }

    // Split the source's neck->head joint into WHERE the head points (swing) and
    // WHICH WAY THE FACE TURNS (roll about the head's own axis), both relative to
    // the source's own rest, so the degenerate rest cancels out.
    const swing: number[] = [];
    const roll: number[] = [];
    const restRel = sBindRot.get('Neck2')!.clone().invert().multiply(sBindRot.get('Head')!);
    for (const t of sTimes) {
      for (const k of sBy.get(t) ?? []) {
        const b = sPose.bones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      sPose.bones[0].updateMatrixWorld(true);
      const now = new Map(sPose.bones.map((b) => [b.name, worldRot(b)]));
      const rel = now.get('Neck2')!.clone().invert().multiply(now.get('Head')!);
      const d = restRel.clone().invert().multiply(rel);
      roll.push(twistDeg(d, sHeadAxis));
      // swing = total minus twist
      const tw = new Quaternion().setFromAxisAngle(sHeadAxis, (twistDeg(d, sHeadAxis) * Math.PI) / 180);
      swing.push(d.clone().multiply(tw.invert()).angleTo(new Quaternion()) * DEG);
    }
    console.log('SOURCE neck->head joint, split (relative to the source rest)');
    console.log(`  SWING (where the head points) ${JSON.stringify(stat(swing))}  frame0=${swing[0].toFixed(1)}`);
    console.log(`  ROLL  (which way the face turns) ${JSON.stringify(stat(roll))}  frame0=${roll[0].toFixed(1)}`);

    console.log('COMPARISON — the head-vs-chest turn is the physical quantity both rigs must reproduce');
    console.log(`  source range ${stat(sHeadVsChest).range.toFixed(1)}째  vs  target range ${stat(tHeadVsChest).range.toFixed(1)}째`);
  }, 300_000);
});
