// #854 — THE ROLL A DIRECTION-ALIGNED RETARGET CANNOT RECOVER, MEASURED PER BONE.
//
// Direction alignment carries a target bone onto the direction of its mapped
// child. A direction is two degrees of freedom and a rotation has three, so the
// roll ABOUT the bone stays undetermined; `setFromUnitVectors` resolves it by
// taking the MINIMAL rotation, which adds no roll of its own.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS MEASURES, AND WHY THE FIRST INSTRUMENT READ ZERO
// ─────────────────────────────────────────────────────────────────────────
// #854 asks for "the roll of a bone about its own axis, rendered against source
// … a row per bone rather than a single worst case — the whole signature of this
// defect is that it is CONSTANT, so a gate that watches for change cannot see
// it."
//
// The first attempt compared each bone's twist against its OWN rig's bind and
// read 0.0° on fifteen of seventeen bones. That number is real and it is
// useless: the residual IS a difference between the two binds, so subtracting
// each bind removes exactly the quantity under test. An instrument can move with
// the subject and still be blind to what you are asking it.
//
// ─────────────────────────────────────────────────────────────────────────
// THE FINDING, WHICH IS SHARPER THAN "A CONSTANT PER-BONE DIFFERENCE"
// ─────────────────────────────────────────────────────────────────────────
// Measured on all seventeen mapped bones: the rendered-against-source roll is
// EXACTLY the angle between the two rigs' bind orientations about that bone.
// Not approximately — the two agree to a tenth of a degree, on every bone, on
// every frame:
//
//     resid  +90.0   bindDiff  +90.0    Chest       -> mixamorig_Spine2
//     resid  -90.0   bindDiff  -90.0    LeftArm     -> mixamorig_LeftArm
//     resid  +47.6   bindDiff  +47.6    RightFoot   -> mixamorig_RightFoot
//
// So the retarget adds no roll of its own and removes none. The residual is not
// an error accumulating through the pipeline — it is the two binds' disagreement
// passed through intact, which is what "the source's twist passes through
// unchanged" means when it is measured rather than asserted.
//
// That pins the fix as well as the defect: recovering the roll means subtracting
// the bind difference wherever a second axis can determine it, and introducing
// NO frame-varying term. A fix that leaves any spread behind has done something
// other than what this file records.
//
// Confirmed from the other side: neutralising `restDirectionLocalOffsets`
// entirely reds ELEVEN rows in `retarget.test.ts` and moves these numbers by
// 0.0°. Direction alignment and roll are orthogonal, measured rather than
// argued.
//
// 🔴 ROWS 2 AND 3 BOTH RED WHEN #854 IS FIXED, deliberately, and row 2 goes
// first. Measured, by injecting a -90° roll into `alignedLocalOffsets` — the
// live path for this pair — which drives the residual to 0.0°: row 2 reports
// "residual 0.0° differs from the bind difference 90.0°". Read literally that
// message is right and its inference is not; a fix IS the retarget contributing
// roll of its own, on purpose. Whoever recovers the roll updates both rows and
// says why. This file records what is true now so that change is argued rather
// than a number that quietly moved.
//
// The magnitudes are a property of the two rigs' axis conventions rather than of
// the code: this pair disagrees by a clean right angle on limbs and spine, and
// by 47.6° at the feet. On the vendor pair #854 recorded +84° and +82°.
//
// REF: src/core/import/retarget.ts (`restDirectionLocalOffsets`, the single
//      `setFromUnitVectors`, and the header that states the missing second axis);
//      src/core/import/restAlignmentFixture.test.ts (the harness this borrows,
//      whose foot-contact row gates the RECONCILIATION and says in as many words
//      that it does not gate this residual); issues #854, #853.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
  /** Rendered against source, about the bone's own axis: the residual #854 names. */
  readonly mean: number;
  /** How much that residual varies across the clip. Its smallness IS the signature. */
  readonly spread: number;
  /** The angle between the two rigs' BIND orientations about this bone. The
   *  residual turns out to equal this exactly, which is the finding. */
  readonly bindDiff: number;
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

async function measure(): Promise<{ frames: number; rows: Row[] }> {
  const target = await targetRig();
  const preset = getBoneNameMapPreset('somaToMixamo')!;
  const parsed = parseBvh(readFileSync(TPOSE, 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);
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
  const S = index(parsed.clipParams.keyframes as unknown as K[]);
  const T = index(out.clipParams.keyframes as unknown as K[]);
  const frames = Math.min(S.times.length, T.times.length);

  const byName = (bones: Bone[]) => new Map(bones.map((b) => [b.name, b]));
  const sByName = byName(sBind);
  const tByName = byName(tBind);

  const resid = new Map<string, number[]>();
  const bindRel = new Map<string, number[]>();
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

      // The residual: rendered against SOURCE, in one frame. Not each against its
      // own bind — the rest offset is exactly what makes that agree.
      const r = wrap(twistDeg(worldRot(sb).clone().invert().multiply(worldRot(tb)), sd));
      // What the residual is being compared AGAINST: the two binds' own
      // disagreement about "up" around this bone, with no clip involved at all.
      const bd = wrap(twistDeg(sq.clone().invert().multiply(tq), sd));
      if (Number.isNaN(r) || Number.isNaN(bd)) continue;
      void td;
      const pair = `${sName} -> ${tName}`;
      resid.set(pair, [...(resid.get(pair) ?? []), r]);
      bindRel.set(pair, [bd]);
    }
  }

  const rows: Row[] = [...resid.entries()].map(([pair, v]) => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      pair,
      mean: avg(v),
      spread: Math.max(...v) - Math.min(...v),
      bindDiff: (bindRel.get(pair) ?? [NaN])[0],
    };
  });
  return { frames, rows };
}

describe('#854 — the unrecovered roll, per bone', () => {
  it("is a CONSTANT that equals the two binds' own disagreement, and it is large", async () => {
    const m = await measure();

    // The population beside the verdict. Seventeen mapped bones; a probe that
    // measured none would otherwise report three clean passes.
    expect(m.rows.length, 'no mapped bone was measured — every check below would be vacuous').toBe(
      17,
    );
    expect(m.frames, 'too few frames for "constant" to mean anything').toBeGreaterThan(20);

    for (const r of m.rows) {
      // 1. THE SIGNATURE: constant, not drifting. This is why a gate watching for
      //    change could never have seen the defect.
      expect(
        r.spread,
        `${r.pair}: the residual varies by ${r.spread.toFixed(2)}° across the clip, so it is no ` +
          `longer the constant offset #854 describes and this row is measuring something else`,
      ).toBeLessThan(1);

      // 2. THE IDENTITY, which is the finding: the residual is EXACTLY the two
      //    binds' disagreement. The retarget adds no roll of its own and removes
      //    none. A fix must subtract this and introduce nothing frame-varying.
      expect(
        Math.abs(wrap(r.mean - r.bindDiff)),
        `${r.pair}: residual ${r.mean.toFixed(1)}° differs from the bind difference ` +
          `${r.bindDiff.toFixed(1)}° by ${Math.abs(wrap(r.mean - r.bindDiff)).toFixed(1)}°, so ` +
          `the retarget is contributing roll of its own. If that was DELIBERATE — #854's second ` +
          `axis — this row and the magnitudes below are what you came to change. If it was not, ` +
          `it is a new defect, because until now this residual was exactly the binds' own ` +
          `disagreement and nothing else`,
      ).toBeLessThan(1);
    }

    // 3. THE RESIDUAL ITSELF — recorded, not accepted. REDS WHEN #854 IS FIXED.
    const worst = m.rows.reduce((a, b) => (Math.abs(b.mean) > Math.abs(a.mean) ? b : a));
    const quietest = m.rows.reduce((a, b) => (Math.abs(b.mean) < Math.abs(a.mean) ? b : a));
    expect(
      Math.abs(worst.mean),
      `the worst unrecovered roll is ${worst.mean.toFixed(1)}° at ${worst.pair}`,
    ).toBeGreaterThan(80);
    expect(
      Math.abs(quietest.mean),
      `even the quietest bone (${quietest.pair}) carries ${quietest.mean.toFixed(1)}°, so this is ` +
        `every bone rather than a few awkward ones`,
    ).toBeGreaterThan(40);
  });
});
