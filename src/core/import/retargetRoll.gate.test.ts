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
// OWN-BIND, each rig against ITS OWN bind about ITS OWN axis: the quantity a
// retarget is actually obliged to preserve. If the source twists a bone 30° away
// from its rest, the target must twist 30° away from its bind. Measured on this
// pair:
//
//     0.00°  on fifteen of seventeen bones, every frame
//     0.47°  worst, at the two feet
//
// The roll is recovered here. It is recovered by the REST ALIGNMENT, which
// supplies the third degree of freedom uniformly — `alignedLocalOffsets` says so
// in its own docstring — and not by any per-bone second axis.
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
   *  source, worst over the clip. THIS is the quantity #854 is about. */
  readonly ownWorst: number;
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

async function measure(bvhPath: string): Promise<Measured> {
  const target = await targetRig();
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
