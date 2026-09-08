// #854 — THE ROLL A DIRECTION-ALIGNED RETARGET CANNOT RECOVER, MEASURED PER BONE.
//
// Direction alignment carries a target bone onto the direction of its mapped
// child. A direction is two degrees of freedom and a rotation has three, so the
// roll ABOUT the bone stays undetermined; `setFromUnitVectors` resolves it by
// taking the MINIMAL rotation, which adds no roll of its own.
//
// ─────────────────────────────────────────────────────────────────────────
// WHICH BRANCH — READ THIS BEFORE PROBING ANYTHING IN THIS AREA
// ─────────────────────────────────────────────────────────────────────────
// `retargetClip` picks between two offset builders, and the pair below takes
// the ALIGNED one:
//
//     solveRestAlignment(...) -> non-null  =>  alignedLocalOffsets     <- here
//                             -> null      =>  restDirectionLocalOffsets
//
// That is asserted rather than assumed, because it was assumed once and cost
// two probes: both perturbed `restDirectionLocalOffsets`, which does not run for
// this pair, and both returned a clean 0.0° that read as a result. The prose
// beside the branch said null was the ordinary answer; it had been true and was
// not any more. Row 2 pins the routing so the next probe is aimed before it is
// fired.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS MEASURES — TWO QUANTITIES, AND ONLY ONE OF THEM IS AN ERROR
// ─────────────────────────────────────────────────────────────────────────
// CROSS, rendered against SOURCE: the twist between the two rigs' absolute
// orientations. Measured on all seventeen mapped bones it is EXACTLY the angle
// between the two rigs' BIND orientations about that bone — to a tenth of a
// degree, on every bone, on every frame:
//
//     resid  +90.0   bindDiff  +90.0    Chest       -> mixamorig_Spine2
//     resid  -90.0   bindDiff  -90.0    LeftArm     -> mixamorig_LeftArm
//     resid  +47.6   bindDiff  +47.6    RightFoot   -> mixamorig_RightFoot
//
// 🔴 THAT QUANTITY IS NOT THE DEFECT, AND AN EARLIER READING OF THIS FILE SAID
// IT WAS. The pipeline composes `T_b(t) = R · W_b(t) · R⁻¹ · B_b`
// (`restAlignment.ts`), whose whole point is that the target sits at its OWN
// bind when the source sits at its rest. The two rigs disagree by a right angle
// about which way is "up" around a bone — a bone-axis CONVENTION — and the
// per-bone offset exists to absorb exactly that. If the cross residual were
// zero the target's mesh would be deformed at rest. So this identity records
// that the retarget adds no roll of its own and removes none, which is a real
// invariant; it is not a measure of anything lost.
//
// OWN-BIND, each rig against ITS OWN bind about ITS OWN axis. Measured on this
// pair:
//
//     0.00°  on fifteen of seventeen bones, every frame
//     0.47°  worst, at the two feet
//
// The roll is recovered here. It is recovered by the REST ALIGNMENT, which
// supplies the third degree of freedom uniformly — `alignedLocalOffsets` says so
// in its own docstring — and not by any per-bone second axis.
//
// 🔴 BUT OWN-BIND IS NOT THE CONTRACT, AND AN EARLIER READING OF THIS FILE SAID
// IT WAS — the same mistake as the cross residual above, one dimension over.
// It is a swing/twist decomposition taken about the SOURCE's axis on one side
// and the TARGET's on the other, and those two axes coincide only when the two
// rests already point the bone the same way IN WORLD. When they do not, the gap
// leaks into the reading in proportion to how far the bone swings — with nothing
// lost at all. Measured on the untracked vendor pair (mixamo-xbot driven by the
// generator's own BVH, which is what a director actually gets):
//
//     rest gap 18.3°   own-twist 51.3°   |Δmagnitude| 0.00°   both feet
//     rest gap  8.8°   own-twist 13.1°   |Δmagnitude| 0.00°   both shoulders
//     rest gap  0.0°   own-twist  0.0°   |Δmagnitude| 0.00°   both arms
//
// Read through own-twist alone that pair looks like half a right angle of lost
// roll at the foot. Nothing is lost: the row below injects a rest gap into THIS
// fixture and watches own-twist follow it while the magnitude stays at zero.
//
// THE CONTRACT IS AXIS-FREE: how far the target has turned from its bind versus
// how far the source has turned from its rest, as a magnitude, with no
// decomposition and no shared frame required. A retarget that carries the
// source's world motion onto the target's own bind preserves it exactly — the
// axis is conjugated into the target's frame, the size is untouched. Measured
// 0.00° on every mapped bone and frame of both aligned pairs, and 91.83° on the
// direction branch, which makes it the sharpest discriminator in this file.
//
// GROUNDED, not asserted: in Blender every bone space is defined against the
// OWNER's own rest (`BKE_armature_mat_pose_to_bone`, armature.cc:2281, reached
// from `BKE_constraint_mat_convertspace`, constraint.cc:311), and Copy Rotation
// transfers that delta without ever consulting the two rests' relative
// orientation (`rotlike_evaluate`, constraint.cc:2049). Two rigs' twists are
// therefore never in one frame unless their rests already agree, and a
// rest-direction disagreement survives any rotation copy — Blender's answer to
// it is matching the rests or adding IK, not a cleverer transfer.
// See ref/GROUND_TRUTH_BLENDER_BONE_SPACES.md.
//
// 🔑 THE OWN-BIND ROWS ARE FALSIFIED, because a 0.00° from an instrument nobody
// has broken is indistinguishable from an instrument that cannot move. Injecting
// a 20° roll into `alignedLocalOffsets` reads back 20.00° on the arms on every
// frame and 20.00° on every bone at the source's rest. Row 6 is a measurement,
// not a caption.
//
// ─────────────────────────────────────────────────────────────────────────
// WHERE #854 IS STILL REAL, AND WHY ITS PROPOSED FIX CANNOT GO THERE
// ─────────────────────────────────────────────────────────────────────────
// On the DIRECTION branch the roll genuinely is lost, and by more than #854
// recorded. Own-bind, over every BVH fixture on disk (seven of the eleven
// TRACKED ones take the aligned branch, and so do the two untracked served-output
// clips when present — the routing itself is gated in the third row below):
//
//     aligned branch    9 present     worst 0.5°-32.3°   mean 0.1°-2.6°
//     soma-walk         direction     worst 90.0°        mean 39.4°
//     soma-generated    direction     worst 153.4°       mean 86.6°
//
// Row 7 pins that, so recovering it reds deliberately.
//
// #854 proposes recovering the roll from a second axis both rigs agree on — the
// shoulder line. Measured on the rests that actually reach this branch, that
// axis is not there to take:
//
//     soma-walk        shoulder line |v| = 0.32, and 61 of its 62 bones run
//                      within 15° of it — a rank-1 rest lays the shoulder line
//                      on the same axis as everything else
//     soma-generated   shoulder line |v| = 0.0000 — both shoulders sit at one
//                      point
//     soma-walk-tpose  |v| = 0.79, healthy — and this rest takes the ALIGNED
//                      branch, which does not need it
//
// So the second axis is degenerate on precisely the inputs that need it and
// unnecessary on the ones where it is healthy. There is no second axis in a
// rank-1 rest; that is what rank-1 means. The remedy that does work is the
// T-pose conditioning of #855 — every conditioned clip takes the aligned branch
// and measures clean. What is missing is the SIGNAL when conditioning did not
// happen, which is #960.
//
// REF: src/core/import/retarget.ts:686-691 (the branch);
//      src/core/import/restAlignment.ts (`solveRestAlignment`,
//      `alignedLocalOffsets`, and the composition this file's argument rests on);
//      src/core/import/restAlignmentFixture.test.ts (the harness this borrows,
//      whose foot-contact row gates the RECONCILIATION and says in as many words
//      that it does not gate this residual); issues #854, #853, #855, #960.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip, resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const TPOSE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk-tpose.bvh');
/** The rank-1 rest: reaches the direction branch, where #854 is still real. */
const RANK1 = resolve(process.cwd(), 'public/fixtures/anim/soma-walk.bvh');
const DEG = 180 / Math.PI;

async function targetRig(): Promise<readonly BoneSpec[]> {
  const buf = readFileSync(RIG);
  const { json, bin } = parseGltfContainer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  return projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
}

/** A deliberate rest-axis gap: spin one target bone's BIND about a world axis,
 *  so the two rigs point that bone differently at rest while nothing about the
 *  motion changes. Used to show what a gap does to `ownWorst` (#979). */
interface BindBend {
  readonly bone: string;
  readonly deg: number;
}

function bentTargetRig(bones: readonly BoneSpec[], bend: BindBend): readonly BoneSpec[] {
  const i = bones.findIndex((b) => b.name === bend.bone);
  if (i < 0) throw new Error(`${bend.bone} is not in the target rig`);
  const rad = (bend.deg * Math.PI) / 180;
  const spin = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rad);
  // Move the bone's CHILDREN at bind, leaving its own frame alone: the two rigs
  // now genuinely point this bone somewhere else, which is the disagreement a
  // retarget inherits and cannot fix.
  //
  // 🔴 NOT by rotating the bone's own bind rotation. That was tried and measured
  // inert — rotating a bone's frame carries its children with it, so the rest
  // direction is unchanged in the world and every number here stays put. The
  // quantity that matters is the rest direction IN WORLD, because the target's
  // twist axis arrives conjugated into the world by the retarget's own offset.
  const moved = bones.map((b) => {
    if (b.parent !== i) return b;
    const p = new Vector3(b.position[0], b.position[1], b.position[2]).applyQuaternion(spin);
    return { ...b, position: [p.x, p.y, p.z] as [number, number, number] };
  });
  if (moved.every((b, idx) => b === bones[idx])) {
    throw new Error(`${bend.bone} has no child to move — the perturbation would be inert`);
  }
  return moved;
}

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN;
  let d = 2 * Math.atan2(s, q.w) * DEG;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

interface Row {
  readonly pair: string;
  /** Rendered against source, about the bone's own axis: the CONVENTION difference. */
  readonly mean: number;
  /** How much that varies across the clip. Its smallness IS the signature. */
  readonly spread: number;
  /** The angle between the two rigs' BIND orientations about this bone. `mean`
   *  turns out to equal this exactly, which is what "the retarget adds no roll
   *  of its own" means when it is measured rather than asserted. */
  readonly bindDiff: number;
  /** Each rig's twist away from ITS OWN bind about ITS OWN axis, target minus
   *  source, worst over the clip.
   *
   *  🔴 READ THIS WITH `restAxisGap`. It is a swing/twist decomposition taken
   *  about TWO DIFFERENT AXES whenever the two rests point the bone differently,
   *  so a gap leaks into it in proportion to how far the bone swings. It is not
   *  by itself a measure of roll lost — `magWorst` is. */
  readonly ownWorst: number;
  /** The angle between the two rigs' rest directions for this bone. The
   *  confound in `ownWorst`, reported beside it so the two cannot be read as one
   *  number (#979). */
  readonly restAxisGap: number;
  /** |target's rotation away from its bind| − |source's rotation away from its
   *  rest|, worst over the clip. AXIS-FREE: it needs no decomposition and no
   *  correspondence between the two rests, so nothing leaks into it. A retarget
   *  that carries the source's motion onto the target's bind preserves it
   *  exactly, whatever the two rests disagree about. */
  readonly magWorst: number;
}

/** Rest direction of each bone toward its first mapped descendant, in that bone's own frame. */
function restDirs(bones: Bone[], mapped: (n: string) => boolean): Map<string, Vector3> {
  bones[0].updateMatrixWorld(true);
  const out = new Map<string, Vector3>();
  const mappedChild = (b: Bone): Bone | null => {
    const stack = [...b.children];
    while (stack.length) {
      const n = stack.shift() as Bone;
      if (!n.isBone) continue;
      if (mapped(n.name)) return n;
      stack.push(...(n.children as Bone[]));
    }
    return null;
  };
  for (const b of bones) {
    const c = mappedChild(b);
    if (!c) continue;
    const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
    const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
    const d = there.sub(here);
    if (d.lengthSq() < 1e-18) continue;
    out.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
  }
  return out;
}

const wrap = (d: number): number => {
  let x = d;
  while (x > 180) x -= 360;
  while (x <= -180) x += 360;
  return x;
};

interface Measured {
  readonly frames: number;
  readonly rows: Row[];
  /** Which offset builder this pair routes to. Asserted, never assumed. */
  readonly branch: 'aligned' | 'direction';
}

async function measure(bvhPath: string, bendBind?: BindBend): Promise<Measured> {
  const target = bendBind ? bentTargetRig(await targetRig(), bendBind) : await targetRig();
  const preset = getBoneNameMapPreset('somaToMixamo')!;
  const parsed = parseBvh(readFileSync(bvhPath, 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);
  const sourceToTarget = resolveNameMapToTarget(
    resolveNameMapToSource(preset.map, parsed.skeletonParams.bones),
    target,
  ) as Record<string, string>;
  const targetMapped = new Set(Object.values(sourceToTarget));
  const sourceMapped = new Set(Object.keys(sourceToTarget));

  const { bones: sBind } = specToThreeSkeleton(parsed.skeletonParams.bones);
  const sRest = restDirs(sBind, (n) => sourceMapped.has(n));
  const sBindRot = new Map<string, Quaternion>();
  for (const b of sBind) sBindRot.set(b.name, worldRot(b));

  const { bones: tBind } = specToThreeSkeleton(target);
  const tRest = restDirs(tBind, (n) => targetMapped.has(n));
  const tBindRot = new Map<string, Quaternion>();
  for (const b of tBind) tBindRot.set(b.name, worldRot(b));

  const out = retargetClip({
    sourceBones: parsed.skeletonParams.bones,
    sourceClip: {
      name: parsed.clipParams.name,
      duration: parsed.clipParams.duration,
      keyframes: parsed.clipParams.keyframes,
    },
    targetBones: target,
    nameMap: preset.map,
  });

  type K = { bone: number; time: number; rotation: number[]; position: number[] };
  const index = (keys: readonly K[]) => {
    const times = [...new Set(keys.map((k) => k.time))].sort((a, b) => a - b);
    const by = new Map<number, K[]>();
    for (const k of keys) by.set(k.time, [...(by.get(k.time) ?? []), k]);
    return { times, by };
  };
  // WHICH BRANCH — taken from the retarget's OWN report, not recomputed here. A
  // second copy of this decision beside the one that chose the offsets is free to
  // drift from it, and this row exists precisely because a claim about the branch
  // drifted once already.
  const branch = out.restReconciliation.kind;

  const S = index(parsed.clipParams.keyframes as unknown as K[]);
  const T = index(out.clipParams.keyframes as unknown as K[]);
  const frames = Math.min(S.times.length, T.times.length);

  const byName = (bones: Bone[]) => new Map(bones.map((b) => [b.name, b]));
  const sByName = byName(sBind);
  const tByName = byName(tBind);

  const resid = new Map<string, number[]>();
  const bindRel = new Map<string, number[]>();
  const ownDelta = new Map<string, number[]>();
  const magDelta = new Map<string, number[]>();
  const gap = new Map<string, number>();
  for (let i = 0; i < frames; i++) {
    for (const k of S.by.get(S.times[i]) ?? []) {
      const b = sBind[k.bone];
      if (!b) continue;
      b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      b.position.set(k.position[0], k.position[1], k.position[2]);
    }
    sBind[0].updateMatrixWorld(true);
    for (const k of T.by.get(T.times[i]) ?? []) {
      const b = tBind[k.bone];
      if (!b) continue;
      b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      b.position.set(k.position[0], k.position[1], k.position[2]);
    }
    tBind[0].updateMatrixWorld(true);

    for (const [sName, tName] of Object.entries(sourceToTarget)) {
      const sd = sRest.get(sName);
      const td = tRest.get(tName);
      const sb = sByName.get(sName);
      const tb = tByName.get(tName);
      const sq = sBindRot.get(sName);
      const tq = tBindRot.get(tName);
      if (!sd || !td || !sb || !tb || !sq || !tq) continue;

      // CROSS: rendered against SOURCE, absolute. The convention difference.
      const r = wrap(twistDeg(worldRot(sb).clone().invert().multiply(worldRot(tb)), sd));
      // What that is compared AGAINST: the two binds' own disagreement about
      // "up" around this bone, with no clip involved at all.
      const bd = wrap(twistDeg(sq.clone().invert().multiply(tq), sd));
      // OWN-BIND: each rig against its own bind, about its own axis. Needs no
      // correspondence between the two rest POSES, so it is the one measure
      // that means the same thing on both branches.
      const sOwn = twistDeg(sq.clone().invert().multiply(worldRot(sb)), sd);
      const tOwn = twistDeg(tq.clone().invert().multiply(worldRot(tb)), td);
      if (Number.isNaN(r) || Number.isNaN(bd) || Number.isNaN(sOwn) || Number.isNaN(tOwn)) continue;
      const pair = `${sName} -> ${tName}`;
      resid.set(pair, [...(resid.get(pair) ?? []), r]);
      bindRel.set(pair, [bd]);
      ownDelta.set(pair, [...(ownDelta.get(pair) ?? []), Math.abs(wrap(tOwn - sOwn))]);

      // AXIS-FREE. The magnitude of each rig's rotation away from its own
      // neutral, with no axis chosen and no decomposition taken.
      const mag = (q: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * DEG;
      const sMag = mag(sq.clone().invert().multiply(worldRot(sb)));
      const tMag = mag(tq.clone().invert().multiply(worldRot(tb)));
      magDelta.set(pair, [...(magDelta.get(pair) ?? []), Math.abs(tMag - sMag)]);
      // IN WORLD, not in each bone's own frame. The own-frame gap is not the
      // confound: the target's twist axis arrives conjugated by the retarget's
      // own offset, which lands it in the world beside the source's.
      gap.set(pair, sd.clone().applyQuaternion(sq).angleTo(td.clone().applyQuaternion(tq)) * DEG);
    }
  }

  const rows: Row[] = [...resid.entries()].map(([pair, v]) => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      pair,
      mean: avg(v),
      spread: Math.max(...v) - Math.min(...v),
      bindDiff: (bindRel.get(pair) ?? [NaN])[0],
      ownWorst: Math.max(...(ownDelta.get(pair) ?? [NaN])),
      restAxisGap: gap.get(pair) ?? NaN,
      magWorst: Math.max(...(magDelta.get(pair) ?? [NaN])),
    };
  });
  return { frames, rows, branch };
}

describe('#854 — the roll, per bone, on the branch this pair actually takes', () => {
  it('recovers the roll on the ALIGNED branch, and the cross residual is convention, not error', async () => {
    const m = await measure(TPOSE);

    // 1. The population beside the verdict. Seventeen mapped bones; a probe that
    //    measured none would otherwise report a column of clean passes.
    expect(m.rows.length, 'no mapped bone was measured — every check below would be vacuous').toBe(
      17,
    );
    expect(m.frames, 'too few frames for "constant" to mean anything').toBeGreaterThan(20);

    // 2. THE ROUTING FACT. Perturbing the other builder for this pair changes
    //    nothing and reads as a discovery; it is a wrong aim. Pinned so the next
    //    probe is aimed before it is fired.
    expect(
      m.branch,
      'this pair no longer takes `alignedLocalOffsets`, so every number below is ' +
        'about a different code path than the one this file argues over',
    ).toBe('aligned');

    for (const r of m.rows) {
      // 3. THE SIGNATURE: constant, not drifting. This is why a gate watching for
      //    change could never have seen the defect #854 describes.
      expect(
        r.spread,
        `${r.pair}: the cross residual varies by ${r.spread.toFixed(2)}° across the clip, so it ` +
          `is no longer the constant convention offset this file records`,
      ).toBeLessThan(1);

      // 4. THE IDENTITY: the cross residual is EXACTLY the two binds' own
      //    disagreement. The retarget adds no roll of its own and removes none.
      expect(
        Math.abs(wrap(r.mean - r.bindDiff)),
        `${r.pair}: cross residual ${r.mean.toFixed(1)}° differs from the bind difference ` +
          `${r.bindDiff.toFixed(1)}° by ${Math.abs(wrap(r.mean - r.bindDiff)).toFixed(1)}°, so ` +
          `the retarget is contributing roll of its own where before it passed the two rigs' ` +
          `axis conventions through intact`,
      ).toBeLessThan(1);

      // 6. THE CONTRACT: each rig's twist away from ITS OWN bind, about ITS OWN
      //    axis, must agree. This is what a retarget owes, and it is what #854
      //    is about. Falsified — a 20° roll injected into `alignedLocalOffsets`
      //    reads back 20.00° here.
      expect(
        r.ownWorst,
        `${r.pair}: the target twists ${r.ownWorst.toFixed(1)}° away from its own bind more than ` +
          `the source does from its own, so the roll is no longer being carried across`,
      ).toBeLessThan(1);
    }

    // 5. The bind differences are LARGE, and that is what makes row 4 mean
    //    something: "residual equals bindDiff" is satisfiable by both being
    //    zero. These magnitudes are the positive control for that identity, not
    //    a defect — they are the two rigs' bone-axis conventions, which the
    //    per-bone offset exists to absorb.
    const widest = m.rows.reduce((a, b) => (Math.abs(b.bindDiff) > Math.abs(a.bindDiff) ? b : a));
    const narrowest = m.rows.reduce((a, b) =>
      Math.abs(b.bindDiff) < Math.abs(a.bindDiff) ? b : a,
    );
    expect(
      Math.abs(widest.bindDiff),
      `the two rigs' widest convention difference is ${widest.bindDiff.toFixed(1)}° at ` +
        `${widest.pair}; if this collapsed, row 4 would be comparing zero against zero`,
    ).toBeGreaterThan(80);
    expect(
      Math.abs(narrowest.bindDiff),
      `even the closest-agreeing bone (${narrowest.pair}) differs by ` +
        `${narrowest.bindDiff.toFixed(1)}°, so row 4 is exercised on every bone rather than a few`,
    ).toBeGreaterThan(40);
  });

  it('LOSES the roll on the DIRECTION branch, which is where #854 is still real', async () => {
    const m = await measure(RANK1);

    expect(m.rows.length, 'no mapped bone was measured — the verdict below would be vacuous').toBe(
      17,
    );
    // The routing fact again, the other way. If this rest starts taking the
    // aligned branch — someone conditioned the fixture — the numbers below stop
    // being about #854 and this row says so rather than the bound quietly passing.
    expect(
      m.branch,
      'soma-walk.bvh no longer routes to `restDirectionLocalOffsets`, so this row is no ' +
        'longer measuring the branch #854 is about',
    ).toBe('direction');

    // 7. REDS WHEN #854 IS FIXED, deliberately. A rank-1 rest carries no second
    //    axis to recover the roll FROM — measured: its shoulder line runs within
    //    15° of 61 of its 62 bones — so a fix here is a change of road (#855's
    //    conditioning) or a refusal (#960), not a better arithmetic.
    const worst = m.rows.reduce((a, b) => (b.ownWorst > a.ownWorst ? b : a));
    expect(
      worst.ownWorst,
      `the worst unrecovered roll on the direction branch is now ` +
        `${worst.ownWorst.toFixed(1)}° at ${worst.pair}. If it dropped because the roll is being ` +
        `recovered, that is #854 and this row is what you came to change — say how, given that ` +
        `this rest has no second axis in it. If it dropped because the fixture changed, the row ` +
        `above will have gone first`,
    ).toBeGreaterThan(60);
  });

  // ── THE CENSUS, AS A ROW RATHER THAN A SENTENCE ──────────────────────────
  //
  // Which fixtures take which builder is a fact this file's argument rests on,
  // and a count written into prose has no detector — which is exactly how the
  // comments beside the branch came to be wrong. So it is asserted here.
  //
  // TRACKED fixtures only, via `git ls-files`. The two served-output clips in
  // `public/assets/` are untracked, so a gate that counted them would be a false
  // green on a fresh checkout and a false red on a machine holding a different
  // set. Both of those solve non-null when present.
  it("the ALIGNED branch preserves every joint's rotation magnitude EXACTLY, and the direction branch does not", async () => {
    // THE AXIS-FREE CONTRACT (#979). Every other row here decomposes a rotation
    // about an axis one of the two rigs supplies, so a rest that points a bone
    // differently leaks into the answer. This one takes no axis at all: how far
    // has the target turned from its bind, how far has the source turned from
    // its rest, and do those two numbers agree? A retarget that carries the
    // source's world motion onto the target's own bind preserves the magnitude
    // exactly no matter what the two rests disagree about — the axis is
    // conjugated into the target's frame, the size is untouched.
    //
    // It is also the sharpest discriminator between the two branches this file
    // is about, which is why it is worth having as its own row:
    //
    //     soma-walk-tpose   aligned     |Δ| 0.00°   (own-twist 0.5°,  gap 113.5°)
    //     soma-walk         direction   |Δ| 91.83°  (own-twist 90.0°, gap  90.0°)
    //
    // Measured on the UNTRACKED vendor pair too — mixamo-xbot driven by the
    // generator's own BVH — where it reads 0.00° while own-twist reads 51.3° at
    // the foot on an 18.3° rest gap. That pair is the reason this row exists:
    // read through `ownWorst` alone it looks like half a right angle of lost
    // roll, and nothing is lost.
    const aligned = await measure(TPOSE);
    const direction = await measure(RANK1);
    expect(aligned.branch).toBe('aligned');
    expect(direction.branch).toBe('direction');

    const worstOf = (m: Measured) => m.rows.reduce((a, b) => (b.magWorst > a.magWorst ? b : a));
    const a = worstOf(aligned);
    expect(
      a.magWorst,
      `on the aligned branch ${a.pair} turns ${a.magWorst.toFixed(2)}° further from its bind than ` +
        `the source does from its rest — the retarget is adding or dropping motion, not just ` +
        `re-expressing its axis`,
    ).toBeLessThan(0.01);

    // ...and the same measure on the branch that genuinely loses the roll, so
    // "0.00°" is a result rather than an instrument that cannot move.
    const d = worstOf(direction);
    expect(
      d.magWorst,
      `the direction branch now preserves rotation magnitude to ${d.magWorst.toFixed(2)}°, so ` +
        `either it stopped losing the roll or this measure stopped being able to see it`,
    ).toBeGreaterThan(30);
  });

  it('a REST-AXIS GAP manufactures own-twist while nothing at all is lost', async () => {
    // Why `ownWorst` cannot be read on its own, demonstrated rather than argued.
    // Spin one target bone's BIND by 25° and nothing about the motion changes:
    // the retarget still carries the source's rotation onto the target's bind,
    // and the axis-free magnitude stays exact. What changes is that the two rigs
    // now point that bone 25° apart at rest, so the swing/twist decomposition —
    // taken about the source's axis on one side and the target's on the other —
    // reports a twist difference that is entirely the gap.
    //
    // Swept on this fixture, moving the target's toe at bind by a known angle:
    //
    //     injected   rest gap (world)   own-twist   |Δmagnitude|
    //        0°           0.3°            0.47°        0.000°
    //       15°           6.7°            3.30°        0.000°
    //       40°          17.7°            9.17°        0.000°
    //       60°          26.0°           20.54°        0.000°
    //       80°          33.6°           34.55°        0.000°
    //
    // The gap is one of two terms — the other is how far the bone SWINGS, since
    // a decomposition about two axes only diverges once there is motion to
    // decompose. That is why the vendor pair reads 51.3° on an 18.3° gap while
    // this fixture reads 9.17° on a 17.7° one: the generated walk moves the foot
    // far more than the stand-in clip does. Proportionality is not claimed; the
    // direction of the effect is, and the magnitude column stays at zero
    // throughout, which is the part that matters.
    //
    // This is the whole explanation of the vendor pair's 51.3° foot reading, and
    // it is why #854's own-bind table cannot be read as "degrees of roll lost"
    // on a pair whose rests differ. Grounded in Blender's own semantics: every
    // bone space in `BKE_constraint_mat_convertspace` is defined against the
    // OWNER's rest, so two rigs' twists are never in the same frame unless their
    // rests already agree (GROUND_TRUTH_BLENDER_BONE_SPACES.md, stages 2-4).
    const BONE = 'mixamorig_RightFoot';
    const plain = await measure(TPOSE);
    const bent = await measure(TPOSE, { bone: BONE, deg: 60 });
    expect(
      bent.branch,
      'bending one bind changed the routing, so this is not a like-for-like',
    ).toBe(plain.branch);

    const find = (m: Measured) => m.rows.find((r) => r.pair.endsWith(`-> ${BONE}`));
    const before = find(plain);
    const after = find(bent);
    expect(
      before && after,
      `${BONE} is not a mapped pair — the demonstration would be empty`,
    ).toBeTruthy();

    // The gap is what was injected...
    expect(
      (after as Row).restAxisGap - (before as Row).restAxisGap,
      `bending the bind by 25° moved the rest-axis gap by ` +
        `${((after as Row).restAxisGap - (before as Row).restAxisGap).toFixed(1)}°, so the ` +
        `perturbation did not land where this row says it did`,
    ).toBeGreaterThan(10);

    // ...the own-twist follows it...
    expect(
      (after as Row).ownWorst,
      `the injected rest gap moved own-twist to only ${(after as Row).ownWorst.toFixed(2)}°, so ` +
        `this row no longer demonstrates the confound it exists for`,
    ).toBeGreaterThan(5);

    // ...and NOTHING was lost, which is the point.
    expect(
      (after as Row).magWorst,
      `the axis-free magnitude moved to ${(after as Row).magWorst.toFixed(2)}° under a pure bind ` +
        `rotation, so the two measures are no longer independent and the argument above is stale`,
    ).toBeLessThan(0.01);
  });

  it('routes the tracked fixtures, and only these four reach the branch that loses roll', async () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.bvh'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
      .split('\0')
      .filter(Boolean);
    // The denominator. A glob that matched nothing would otherwise report a
    // clean pass over an empty set.
    expect(
      tracked.length,
      'git ls-files found no tracked BVH fixture, so every claim below is vacuous',
    ).toBeGreaterThanOrEqual(11);

    const target = await targetRig();
    const preset = getBoneNameMapPreset('somaToMixamo')!;
    const direction: string[] = [];
    const aligned: string[] = [];
    for (const rel of tracked) {
      const parsed = parseBvh(
        readFileSync(resolve(process.cwd(), rel), 'utf8'),
        'clip',
        BVH_UNIT_SCALE_CENTIMETRES,
      );
      const sourceToTarget = resolveNameMapToTarget(
        resolveNameMapToSource(preset.map, parsed.skeletonParams.bones),
        target,
      ) as Record<string, string> | null;
      const targetToSource = Object.fromEntries(
        Object.entries(sourceToTarget ?? {}).map(([sn, tn]) => [tn, sn]),
      );
      void targetToSource;
      const reported = retargetClip({
        sourceBones: parsed.skeletonParams.bones,
        sourceClip: {
          name: parsed.clipParams.name,
          duration: parsed.clipParams.duration,
          keyframes: parsed.clipParams.keyframes,
        },
        targetBones: target,
        nameMap: preset.map,
      }).restReconciliation;
      (reported.kind === 'aligned' ? aligned : direction).push(rel);
    }

    // The dangerous set, named. A new fixture that joins it is a clip whose roll
    // is silently lost (#960); a fixture that leaves it has been conditioned,
    // and the prose in this file's header is then owed an update.
    //
    // Two of these four carry no usable bone map at all, so their null is the
    // MIN_PAIRS refusal rather than a rank-1 rest. They are listed because this
    // row is about routing, and routing is what decides whether the roll survives.
    expect(
      [...direction].sort(),
      'the set of tracked fixtures reaching `restDirectionLocalOffsets` has changed',
    ).toEqual([
      'public/fixtures/anim/mixamo-naming.bvh',
      'public/fixtures/anim/soma-generated.bvh',
      'public/fixtures/anim/soma-walk.bvh',
      'public/fixtures/anim/walk.bvh',
    ]);
    // ...and the other arm is genuinely populated, so the row above is not
    // satisfied by everything having fallen into one bucket.
    expect(
      aligned.length,
      'no tracked fixture solves non-null any more, so the aligned branch this file measures ' +
        'is no longer reachable from anything committed',
    ).toBe(tracked.length - 4);
    expect(aligned.length).toBeGreaterThanOrEqual(7);
  });
});
