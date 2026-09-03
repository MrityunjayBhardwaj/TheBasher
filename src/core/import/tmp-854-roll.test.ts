// PROBE (#854) — is the arm-chain roll a CONSTANT rig-convention offset, or the
// clip's own twist that simply never passes through the target's bind?
//
// The refuted premise measured "closest approach to the target's own bind roll"
// and read 41.9 on LeftArm. That statistic cannot tell those two apart: a
// constant offset and a clip that keeps a limb permanently twisted both report a
// large minimum. The SPREAD can: a constant offset has none.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, Euler, Matrix4, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import {
  retargetClip,
  restDirectionLocalOffsets,
  referenceWorldRotations,
  resolveNameMapToSource,
  resolveNameMapToTarget,
} from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const BVH = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');
const DEG = 180 / Math.PI;

/** The twist of `q` about `axis` (axis in q's own pre-rotation frame), signed, in degrees. */
function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN; // twist undefined at the singularity
  let deg = 2 * Math.atan2(s, q.w) * DEG;
  while (deg > 180) deg -= 360;
  while (deg <= -180) deg += 360;
  return deg;
}

/** difference of two angles, wrapped to (-180, 180]. */
function wrap(d: number): number {
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

describe('PROBE #854 — the arm roll', () => {
  it('reports per-bone roll, its spread, and the direction-alignment angle', async () => {
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

    // ---- the direction-alignment offsets, recomputed on FRESH skeletons ----
    const { bones: srcBones } = specToThreeSkeleton(soma.skeletonParams.bones);
    const { bones: tgtBones } = specToThreeSkeleton(target.bones);
    const nameMap = resolveNameMapToTarget(
      resolveNameMapToSource(preset.map, soma.skeletonParams.bones),
      target.bones,
    );
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;

    const referenceTime = soma.clipParams.keyframes.reduce(
      (e, k) => Math.min(e, k.time),
      Number.POSITIVE_INFINITY,
    );
    const referencePose: Record<string, readonly [number, number, number]> = {};
    for (const k of soma.clipParams.keyframes) {
      if (k.time !== referenceTime) continue;
      const b = soma.skeletonParams.bones[k.bone];
      if (b) referencePose[b.name] = k.rotation;
    }
    const sourceReference = referenceWorldRotations(srcBones, referencePose);
    const offsets = restDirectionLocalOffsets(srcBones, tgtBones, targetToSource, sourceReference);

    // bind world rotations + rest directions, target side, BEFORE posing
    const { bones: bindBones } = specToThreeSkeleton(target.bones);
    bindBones[0].updateMatrixWorld(true);
    const bindRot = new Map<string, Quaternion>();
    for (const b of bindBones) bindRot.set(b.name, worldRot(b));

    const restDir = new Map<string, Vector3>();
    const byName = new Map(bindBones.map((b) => [b.name, b]));
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

    // ---- pose the target with the RETARGETED clip, frame by frame ----------
    const { bones: poseBones } = specToThreeSkeleton(target.bones);
    const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
    const byTime = new Map<number, typeof out.clipParams.keyframes>();
    for (const k of out.clipParams.keyframes)
      byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);

    const series = new Map<string, number[]>();
    const tgtDir = new Map<string, Vector3[]>();
    for (const t of times) {
      for (const k of byTime.get(t) ?? []) {
        const b = poseBones[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      poseBones[0].updateMatrixWorld(true);
      for (const b of poseBones) {
        const d = restDir.get(b.name);
        const bind = bindRot.get(b.name);
        if (!d || !bind) continue;
        const delta = bind.clone().invert().multiply(worldRot(b));
        series.set(b.name, [...(series.get(b.name) ?? []), twistDeg(delta, d)]);
        tgtDir.set(b.name, [
          ...(tgtDir.get(b.name) ?? []),
          d.clone().applyQuaternion(worldRot(b)),
        ]);
      }
    }

    // ---- the source's OWN twist-from-rest, same measure -------------------
    const { bones: srcPose } = specToThreeSkeleton(soma.skeletonParams.bones);
    const srcBind = new Map<string, Quaternion>();
    srcPose[0].updateMatrixWorld(true);
    for (const b of srcPose) srcBind.set(b.name, worldRot(b));
    const srcRestDir = new Map<string, Vector3>();
    const srcMappedChild = (b: Bone): Bone | null => {
      const stack = [...b.children];
      while (stack.length) {
        const n = stack.shift() as Bone;
        if (!n.isBone) continue;
        if (nameMap[n.name] !== undefined) return n;
        stack.push(...(n.children as Bone[]));
      }
      return null;
    };
    for (const b of srcPose) {
      const c = srcMappedChild(b);
      if (!c) continue;
      const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
      const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
      const d = there.sub(here);
      if (d.lengthSq() < 1e-18) continue;
      srcRestDir.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
    }
    const srcTimes = [...new Set(soma.clipParams.keyframes.map((k) => k.time))].sort(
      (a, b) => a - b,
    );
    const srcByTime = new Map<number, typeof soma.clipParams.keyframes>();
    for (const k of soma.clipParams.keyframes)
      srcByTime.set(k.time, [...(srcByTime.get(k.time) ?? []), k]);
    const srcSeries = new Map<string, number[]>();
    const srcDir = new Map<string, Vector3[]>();
    for (const t of srcTimes) {
      for (const k of srcByTime.get(t) ?? []) {
        const b = srcPose[k.bone];
        if (!b) continue;
        b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      }
      srcPose[0].updateMatrixWorld(true);
      for (const b of srcPose) {
        const d = srcRestDir.get(b.name);
        const bind = srcBind.get(b.name);
        if (!d || !bind) continue;
        const delta = bind.clone().invert().multiply(worldRot(b));
        srcSeries.set(b.name, [...(srcSeries.get(b.name) ?? []), twistDeg(delta, d)]);
        srcDir.set(b.name, [...(srcDir.get(b.name) ?? []), d.clone().applyQuaternion(worldRot(b))]);
      }
    }

    // ── INSTRUMENT GATE: the design says the target points where the source
    // points, in WORLD, at every frame. If this is not ~0 the composition I am
    // reasoning about is not the one that ran.
    // ── WHAT ROLL WOULD THE REFERENCE POSE GIVE? ───────────────────────────
    // Build the #853 reference-derived offset for a bone that HAS a direction,
    // then RE-POINT it so it satisfies the direction constraint exactly. What is
    // left over is a pure roll about the bone — the one number the direction
    // alignment does not determine, sourced from the pose instead of guessed.
    console.log('--- the roll the reference pose asks for, per bone ---');
    const parentOf = new Map<string, string>();
    for (const b of bindBones) for (const c of b.children) if ((c as Bone).isBone)
      parentOf.set((c as Bone).name, b.name);
    for (const b of bindBones) {
      const dT = restDir.get(b.name);
      const sn = targetToSource[b.name];
      if (!dT || !sn) continue;
      const dS = srcRestDir.get(sn);
      if (!dS) continue;
      let anc = parentOf.get(b.name);
      while (anc && (targetToSource[anc] === undefined || !offsets[anc])) anc = parentOf.get(anc);
      if (!anc) continue;
      const refHere = sourceReference.get(sn);
      const refThere = sourceReference.get(targetToSource[anc]);
      if (!refHere || !refThere) continue;
      const bindBend = bindRot.get(anc)!.clone().invert().multiply(bindRot.get(b.name)!);
      const qRef = refHere
        .clone()
        .invert()
        .multiply(refThere)
        .multiply(new Quaternion().setFromRotationMatrix(offsets[anc]))
        .multiply(bindBend);
      const qMin = new Quaternion().setFromRotationMatrix(offsets[b.name]);
      // how far the reference's answer points from where it must point
      const pointsTo = dT.clone().applyQuaternion(qRef);
      const offBy = pointsTo.angleTo(dS) * DEG;
      // re-point, then read off the pure roll that remains
      const repointed = new Quaternion().setFromUnitVectors(pointsTo, dS).multiply(qRef);
      const residual = qMin.clone().invert().multiply(repointed);
      const roll = twistDeg(residual, dT);
      const axisErr = dT.clone().applyQuaternion(residual).angleTo(dT) * DEG;
      console.log(
        `  ${b.name.replace('mixamorig_', '').padEnd(16)} ref points ${offBy
          .toFixed(1)
          .padStart(6)}° off   roll to add ${roll.toFixed(1).padStart(7)}°   (residual is a pure roll to ${axisErr.toFixed(2)}°)`,
      );
    }

    console.log('--- rest directions, both rigs, in each bone\'s OWN local frame ---');
    for (const b of bindBones) {
      const d = restDir.get(b.name);
      const sn = targetToSource[b.name];
      const ds = sn ? srcRestDir.get(sn) : undefined;
      if (!d) continue;
      const f = (v: Vector3) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
      console.log(
        `  ${b.name.replace('mixamorig_', '').padEnd(16)} target ${f(d)}  source ${
          ds ? f(ds) : '   —   '
        }  angle ${ds ? (d.angleTo(ds) * DEG).toFixed(1) : '—'}`,
      );
    }

    console.log('--- world direction agreement (design invariant) ---');
    for (const [name, ds] of tgtDir) {
      const sn = targetToSource[name];
      const ss = sn ? srcDir.get(sn) : undefined;
      if (!ss || ss.length !== ds.length) continue;
      let w = 0;
      for (let i = 0; i < ds.length; i++) w = Math.max(w, ds[i].angleTo(ss[i]) * DEG);
      console.log(`  ${name.replace('mixamorig_', '').padEnd(16)} max ${w.toFixed(3)}°`);
    }

    // ── SELF-TEST (H556): if the correction passes the source's twist through
    // unchanged, the target's twist-from-bind must EQUAL the source's
    // twist-from-rest at every frame. If this table is not ~0 the probe (or the
    // theory) is wrong and nothing below it means anything.
    console.log(`frames: target ${times.length}  source ${srcTimes.length}`);
    console.log(
      'bone'.padEnd(22) +
        '|Q|'.padStart(7) +
        'tgt.lo'.padStart(9) +
        'tgt.hi'.padStart(9) +
        'tgt.range'.padStart(10) +
        'src.lo'.padStart(9) +
        'src.hi'.padStart(9) +
        'max|t-s|'.padStart(10) +
        'spread(t-s)'.padStart(11),
    );
    for (const b of poseBones) {
      const s = series.get(b.name);
      if (!s || s.length === 0) continue;
      const sn = targetToSource[b.name];
      const ss = sn ? srcSeries.get(sn) : undefined;
      const q = offsets[b.name]
        ? 2 *
          Math.acos(
            Math.min(1, Math.abs(new Quaternion().setFromRotationMatrix(offsets[b.name]).w)),
          ) *
          DEG
        : NaN;
      let worst = 0;
      const diffs: number[] = [];
      if (ss && ss.length === s.length) {
        for (let i = 0; i < s.length; i++) {
          const d = wrap(s[i] - ss[i]);
          diffs.push(d);
          worst = Math.max(worst, Math.abs(d));
        }
      }
      // spread of the DIFFERENCE — the theory says it is a constant per bone.
      const dSpread =
        diffs.length > 1
          ? (() => {
              const ref = diffs[0];
              const rel = diffs.map((d) => wrap(d - ref));
              return Math.max(...rel) - Math.min(...rel);
            })()
          : NaN;
      console.log(
        b.name.replace('mixamorig_', '').padEnd(22) +
          q.toFixed(1).padStart(7) +
          Math.min(...s).toFixed(1).padStart(9) +
          Math.max(...s).toFixed(1).padStart(9) +
          (Math.max(...s) - Math.min(...s)).toFixed(1).padStart(10) +
          (ss ? Math.min(...ss).toFixed(1).padStart(9) + Math.max(...ss).toFixed(1).padStart(9) : '') +
          (ss && ss.length === s.length
            ? worst.toFixed(1).padStart(10) + dSpread.toFixed(2).padStart(11)
            : ''),
      );
    }

    // ── AN EXTERNALLY GROUNDED CHECK: a walk plants its feet FLAT. ─────────
    // The target's bind is a standing T-pose, so the bone-local vector that
    // points world-up at bind is the foot's own "up". During a walk that vector
    // must return to world up at least once per step — that is anatomy, not our
    // construction, and roll about the foot's own axis is exactly what breaks it.
    console.log('--- how flat does each foot get? (min tilt of its bind-up from world up) ---');
    const UP = new Vector3(0, 1, 0);
    for (const name of [
      'mixamorig_Hips',
      'mixamorig_Spine',
      'mixamorig_LeftUpLeg',
      'mixamorig_LeftLeg',
      'mixamorig_LeftFoot',
      'mixamorig_RightFoot',
      'mixamorig_LeftHand',
      'mixamorig_RightHand',
      'mixamorig_Head',
    ]) {
      const bind = bindRot.get(name);
      if (!bind) continue;
      const localUp = UP.clone().applyQuaternion(bind.clone().invert());
      const tilts: number[] = [];
      const posed = specToThreeSkeleton(target.bones);
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const b = posed.bones[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
        }
        posed.bones[0].updateMatrixWorld(true);
        const b = posed.bones.find((x) => x.name === name);
        if (!b) continue;
        tilts.push(localUp.clone().applyQuaternion(worldRot(b)).angleTo(UP) * DEG);
      }
      if (!tilts.length) continue;
      console.log(
        `  ${name.replace('mixamorig_', '').padEnd(12)} min ${Math.min(...tilts)
          .toFixed(1)
          .padStart(6)}°   max ${Math.max(...tilts).toFixed(1).padStart(6)}°`,
      );
    }

    // ── A FAST, VALIDATED SHORTCUT ─────────────────────────────────────────
    // The pipeline composes R_T(world) = R_S(world) · Q, and the 0.000° table
    // above proves that is exactly what ran. So a candidate Q can be scored
    // without posing anything: compose it against the source's world rotations.
    const srcWorld = new Map<string, Quaternion[]>();
    {
      const posed = specToThreeSkeleton(soma.skeletonParams.bones);
      for (const t of srcTimes) {
        for (const k of srcByTime.get(t) ?? []) {
          const b = posed.bones[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
        }
        posed.bones[0].updateMatrixWorld(true);
        for (const b of posed.bones)
          srcWorld.set(b.name, [...(srcWorld.get(b.name) ?? []), worldRot(b)]);
      }
    }

    /** Roll from bind, at the frame where the bone's own axis is most horizontal.
     *  Only meaningful for a bone that is HORIZONTAL at bind — for a vertical one
     *  the perpendicular test degenerates into the direction check, which is
     *  exact by construction and therefore says nothing. */
    const scoreAtLevel = (targetName: string, q: Quaternion) => {
      const bind = bindRot.get(targetName);
      const d = restDir.get(targetName);
      const sn = targetToSource[targetName];
      const ws = sn ? srcWorld.get(sn) : undefined;
      if (!bind || !d || !ws) return null;
      let best: { elev: number; roll: number; frame: number } | null = null;
      ws.forEach((rs, i) => {
        const w = rs.clone().multiply(q);
        const elev = Math.abs(90 - d.clone().applyQuaternion(w).angleTo(UP) * DEG);
        if (!best || elev < best.elev)
          best = { elev, roll: twistDeg(bind.clone().invert().multiply(w), d), frame: i };
      });
      return best as { elev: number; roll: number; frame: number } | null;
    };

    // sanity: the shortcut must reproduce what the posed pipeline reported
    for (const n of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const r = scoreAtLevel(n, new Quaternion().setFromRotationMatrix(offsets[n]));
      console.log(
        `  SHORTCUT CHECK ${n.replace('mixamorig_', '')}: elev ${r!.elev.toFixed(1)}° roll ${r!.roll.toFixed(1)}° (frame ${r!.frame})`,
      );
    }

    // ── CANDIDATE: roll from the reference, swing from the direction ────────
    const refRollOffsets: Record<string, Quaternion> = {};
    for (const b of bindBones) {
      const sn = targetToSource[b.name];
      if (!sn || !offsets[b.name]) continue;
      refRollOffsets[b.name] = new Quaternion().setFromRotationMatrix(offsets[b.name]);
    }
    for (const b of bindBones) {
      const dT = restDir.get(b.name);
      const sn = targetToSource[b.name];
      if (!dT || !sn) continue;
      const dS = srcRestDir.get(sn);
      if (!dS) continue;
      let anc = parentOf.get(b.name);
      while (anc && (targetToSource[anc] === undefined || !refRollOffsets[anc])) anc = parentOf.get(anc);
      if (!anc) continue;
      const refHere = sourceReference.get(sn);
      const refThere = sourceReference.get(targetToSource[anc]);
      if (!refHere || !refThere) continue;
      const bindBend = bindRot.get(anc)!.clone().invert().multiply(bindRot.get(b.name)!);
      const qRef = refHere
        .clone()
        .invert()
        .multiply(refThere)
        .multiply(refRollOffsets[anc])
        .multiply(bindBend);
      const pointsTo = dT.clone().applyQuaternion(qRef);
      refRollOffsets[b.name] = new Quaternion().setFromUnitVectors(pointsTo, dS).multiply(qRef);
    }

    console.log('--- roll at the levellest frame: SHIPPED vs REFERENCE-ROLL ---');
    console.log(
      'bone'.padEnd(16) + 'vertical?'.padStart(10) + 'elev'.padStart(8) + 'shipped'.padStart(10) + 'ref-roll'.padStart(10),
    );
    for (const b of bindBones) {
      if (!offsets[b.name] || !restDir.get(b.name)) continue;
      const d = restDir.get(b.name)!;
      const bind = bindRot.get(b.name)!;
      const bindDirWorld = d.clone().applyQuaternion(bind);
      const vertical = Math.abs(bindDirWorld.y) > 0.9;
      const a = scoreAtLevel(b.name, new Quaternion().setFromRotationMatrix(offsets[b.name]));
      const c = scoreAtLevel(b.name, refRollOffsets[b.name]);
      if (!a || !c) continue;
      console.log(
        b.name.replace('mixamorig_', '').padEnd(16) +
          (vertical ? 'BLIND' : 'valid').padStart(10) +
          a.elev.toFixed(1).padStart(8) +
          a.roll.toFixed(1).padStart(10) +
          c.roll.toFixed(1).padStart(10),
      );
    }

    // ── PLANTED, BY HEIGHT — the strongest null available. ─────────────────
    // A foot at its lowest point in the cycle is on the ground, and a foot on
    // the ground has its sole down: the same roll it has in the target's own
    // standing bind. This needs world POSITIONS, so it poses the skeleton
    // rather than composing rotations.
    console.log('--- the foot when it is PLANTED (lowest in the cycle) ---');
    for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const bind = bindRot.get(name);
      const d = restDir.get(name);
      if (!bind || !d) continue;
      const posed = specToThreeSkeleton(target.bones);
      const rows: Array<{ y: number; elev: number; roll: number; t: number }> = [];
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const b = posed.bones[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (target.bones[k.bone].parent === -1)
            b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        posed.bones[0].updateMatrixWorld(true);
        const b = posed.bones.find((x) => x.name === name);
        if (!b) continue;
        const w = worldRot(b);
        rows.push({
          y: new Vector3().setFromMatrixPosition(b.matrixWorld).y,
          elev: Math.abs(90 - d.clone().applyQuaternion(w).angleTo(UP) * DEG),
          roll: twistDeg(bind.clone().invert().multiply(w), d),
          t,
        });
      }
      const lowest = [...rows].sort((a, b) => a.y - b.y).slice(0, 6);
      console.log(
        `  ${name.replace('mixamorig_', '')}: ` +
          lowest
            .map((r) => `t=${r.t.toFixed(2)} y=${r.y.toFixed(3)} elev=${r.elev.toFixed(0)} roll=${r.roll.toFixed(0)}`)
            .join('  |  '),
      );
    }

    // ── CANDIDATE SWEEP against the planted-foot null ──────────────────────
    // Scored by composing R_T = R_S · Q on the source's world rotations (the
    // shortcut validated above) and reading the roll at the frames where the
    // POSED foot is on the floor.
    const plantedFrames = (name: string): number[] => {
      const posed = specToThreeSkeleton(target.bones);
      const ys: Array<{ i: number; y: number }> = [];
      times.forEach((t, i) => {
        for (const k of byTime.get(t) ?? []) {
          const b = posed.bones[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          if (target.bones[k.bone].parent === -1)
            b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        posed.bones[0].updateMatrixWorld(true);
        const b = posed.bones.find((x) => x.name === name);
        if (b) ys.push({ i, y: new Vector3().setFromMatrixPosition(b.matrixWorld).y });
      });
      return ys.sort((a, b) => a.y - b.y).slice(0, 8).map((r) => r.i);
    };

    const rollAt = (name: string, q: Quaternion, frames: number[]): number => {
      const bind = bindRot.get(name)!;
      const d = restDir.get(name)!;
      const ws = srcWorld.get(targetToSource[name])!;
      const v = frames.map((i) => twistDeg(bind.clone().invert().multiply(ws[i].clone().multiply(q)), d));
      return v.reduce((a, b) => a + b, 0) / v.length;
    };

    /** Q that carries the target's (direction, up) frame onto the source's. */
    const secondAxis = (targetName: string): Quaternion | null => {
      const dT = restDir.get(targetName);
      const sn = targetToSource[targetName];
      if (!dT || !sn) return null;
      const dS = srcRestDir.get(sn);
      const refHere = sourceReference.get(sn);
      const bind = bindRot.get(targetName);
      if (!dS || !refHere || !bind) return null;
      const perp = (u: Vector3, d: Vector3) =>
        u.clone().sub(d.clone().multiplyScalar(u.dot(d)));
      const uT = perp(UP.clone().applyQuaternion(bind.clone().invert()), dT);
      const uS = perp(UP.clone().applyQuaternion(refHere.clone().invert()), dS);
      if (uT.lengthSq() < 1e-6 || uS.lengthSq() < 1e-6) return null;
      uT.normalize();
      uS.normalize();
      const m = (d: Vector3, u: Vector3) => {
        const w = new Vector3().crossVectors(d, u);
        return new Matrix4().makeBasis(d, u, w);
      };
      const qT = new Quaternion().setFromRotationMatrix(m(dT, uT));
      const qS = new Quaternion().setFromRotationMatrix(m(dS, uS));
      return qS.multiply(qT.invert());
    };

    console.log('--- CANDIDATES, mean roll at the 8 planted frames (0 is correct) ---');
    for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const frames = plantedFrames(name);
      const shipped = new Quaternion().setFromRotationMatrix(offsets[name]);
      const dT = restDir.get(name)!;
      const plus90 = shipped.clone().multiply(new Quaternion().setFromAxisAngle(dT, Math.PI / 2));
      const sa = secondAxis(name);
      console.log(
        `  ${name.replace('mixamorig_', '').padEnd(11)}` +
          ` shipped ${rollAt(name, shipped, frames).toFixed(1).padStart(8)}` +
          ` | ref-roll ${rollAt(name, refRollOffsets[name], frames).toFixed(1).padStart(8)}` +
          ` | shipped+90 ${rollAt(name, plus90, frames).toFixed(1).padStart(8)}` +
          ` | second-axis ${sa ? rollAt(name, sa, frames).toFixed(1).padStart(8) : '   n/a'}`,
      );
    }

    // Are the source's rest frames world-aligned? If they are, the source's
    // convention is readable with NO pose at all: bone along ±X, up along +Y.
    console.log('--- source rest world rotations (identity ⇒ frames are world-aligned) ---');
    for (const n of ['Hips', 'LeftFoot', 'RightFoot', 'LeftArm', 'Spine1']) {
      const q = srcBind.get(n);
      if (q) console.log(`  ${n.padEnd(10)} (${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.z.toFixed(3)}, ${q.w.toFixed(3)})`);
    }

    /** Second axis with NO reference pose: each rig's own rest convention. */
    const restConvention = (targetName: string): Quaternion | null => {
      const dT = restDir.get(targetName);
      const sn = targetToSource[targetName];
      if (!dT || !sn) return null;
      const dS = srcRestDir.get(sn);
      const bind = bindRot.get(targetName);
      if (!dS || !bind) return null;
      const perp = (u: Vector3, d: Vector3) => u.clone().sub(d.clone().multiplyScalar(u.dot(d)));
      const uT = perp(UP.clone().applyQuaternion(bind.clone().invert()), dT);
      const uS = perp(UP.clone(), dS); // source rest frames are world-aligned
      if (uT.lengthSq() < 1e-6 || uS.lengthSq() < 1e-6) return null;
      uT.normalize();
      uS.normalize();
      const m = (d: Vector3, u: Vector3) =>
        new Matrix4().makeBasis(d, u, new Vector3().crossVectors(d, u));
      return new Quaternion()
        .setFromRotationMatrix(m(dS, uS))
        .multiply(new Quaternion().setFromRotationMatrix(m(dT, uT)).invert());
    };

    console.log('--- rest-convention candidate, at the planted frames ---');
    for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const frames = plantedFrames(name);
      const q = restConvention(name);
      const dT = restDir.get(name)!;
      const shipped = new Quaternion().setFromRotationMatrix(offsets[name]);
      console.log(
        `  ${name.replace('mixamorig_', '').padEnd(11)} rest-convention ${
          q ? rollAt(name, q, frames).toFixed(1) : 'n/a'
        }   (points ${q ? dT.clone().applyQuaternion(q).angleTo(srcRestDir.get(targetToSource[name])!).toFixed(2) : '-'}° off)   shipped ${rollAt(name, shipped, frames).toFixed(1)}`,
      );
    }

    // ── CANDIDATE (f): source the roll from the frame where the two rigs are
    // in the SAME configuration for this bone. No calibration pose is assumed:
    // for each bone, find the clip frame where the source bone points closest to
    // where the TARGET's bone points at its own bind. At that frame the two rigs
    // agree about this bone, so the target's bind roll is the right roll — and
    // zeroing the roll there leaves the direction untouched.
    console.log('--- candidate (f): roll zeroed at each bone\'s own best-match frame ---');
    const matchedRoll: Record<string, Quaternion> = {};
    for (const b of bindBones) {
      const dT = restDir.get(b.name);
      const sn = targetToSource[b.name];
      if (!dT || !sn || !offsets[b.name]) continue;
      const bind = bindRot.get(b.name)!;
      const ws = srcWorld.get(sn);
      if (!ws) continue;
      const q0 = new Quaternion().setFromRotationMatrix(offsets[b.name]);
      const bindDirWorld = dT.clone().applyQuaternion(bind);
      let best = { i: -1, off: 1e9 };
      ws.forEach((rs, i) => {
        const off = dT.clone().applyQuaternion(rs.clone().multiply(q0)).angleTo(bindDirWorld) * DEG;
        if (off < best.off) best = { i, off };
      });
      if (best.i < 0) continue;
      const theta =
        (twistDeg(bind.clone().invert().multiply(ws[best.i].clone().multiply(q0)), dT) * Math.PI) /
        180;
      matchedRoll[b.name] = q0.clone().multiply(new Quaternion().setFromAxisAngle(dT, -theta));
      console.log(
        `  ${b.name.replace('mixamorig_', '').padEnd(16)} best frame ${String(best.i).padStart(3)} ` +
          `(points ${best.off.toFixed(1)}° from bind)  roll removed ${((theta * 180) / Math.PI).toFixed(1)}°`,
      );
    }
    console.log('--- (f) scored at the planted frames ---');
    for (const name of ['mixamorig_LeftFoot', 'mixamorig_RightFoot']) {
      const frames = plantedFrames(name);
      console.log(
        `  ${name.replace('mixamorig_', '').padEnd(11)} shipped ${rollAt(
          name,
          new Quaternion().setFromRotationMatrix(offsets[name]),
          frames,
        ).toFixed(1)}  →  matched ${rollAt(name, matchedRoll[name], frames).toFixed(1)}`,
      );
    }

    void Euler;
  }, 300_000);
});
