// A differential against Blender — a gate that can DISAGREE with us (#857).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────
// Every other gate on the retarget seam asserts a property WE chose, and that
// has been enough to catch five defects while being structurally unable to
// catch a sixth of a kind nobody thought of. Worse, an authored probe can be
// blind to its own subject: while diagnosing #853, one returned an identical
// constant for three different bones, and one was algebraically invariant to
// the very offsets it was built to measure. A gate we wrote cannot contradict
// the belief we wrote it with.
//
// Blender can. It parses the same clip with an independently written importer
// and computes the skeleton's world pose with none of our code involved. If it
// disagrees, our parse, our unit scale, our Euler order or our forward
// kinematics is wrong — and every correction layered on top is built on sand.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT IS AN ORACLE FOR, AND WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────────────────
// The SOURCE side only. It deliberately does not check a retargeted result:
// Blender's automatic offset capture (Child Of + Set Inverse) samples the whole
// three-DOF offset in the WORLD, which is the construction measured WRONG in
// #853 — it moves the wrists 96° and 114°, because an A-pose and a T-pose
// disagree at the shoulder. Blender beats that only when a human matches the
// two rest poses first, so an automated "Blender says" for the correction would
// be our own assumption wearing a second implementation's name.
//
// The correction is a CHOICE. The input is a FACT. This gates the fact.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY JOINT ANGLES
// ─────────────────────────────────────────────────────────────────────────
// Blender is Z-up and we are Y-up, and it imports at the file's own scale while
// we convert to metres. An angle at a joint is invariant to BOTH, so neither
// side has to agree about which way is up or how big a centimetre is for the
// comparison to mean something. Raw world matrices would need an alignment step,
// and an alignment step solved from the same data can absorb a real error.
//
// REF: `scripts/blender-retarget-oracle.py` (the pinned method — Blender
// version and every import setting that changes the answer are recorded in the
// fixture itself). Issue #857.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import oracle from './__fixtures__/blender-oracle-soma-walk.json';

const BVH = path.resolve(__dirname, '../../../public/fixtures/anim/soma-walk.bvh');

/** (parent, joint, child) — the angle AT the middle bone. */
const TRIPLES: Array<[string, string, string]> = [
  ['Hips', 'Spine1', 'Spine2'],
  ['Spine1', 'Spine2', 'Chest'],
  ['Chest', 'Neck1', 'Neck2'],
  ['Neck1', 'Neck2', 'Head'],
  ['LeftShoulder', 'LeftArm', 'LeftForeArm'],
  ['LeftArm', 'LeftForeArm', 'LeftHand'],
  ['RightShoulder', 'RightArm', 'RightForeArm'],
  ['RightArm', 'RightForeArm', 'RightHand'],
  ['Hips', 'LeftLeg', 'LeftShin'],
  ['LeftLeg', 'LeftShin', 'LeftFoot'],
  ['Hips', 'RightLeg', 'RightShin'],
  ['RightLeg', 'RightShin', 'RightFoot'],
];

/** Where the two implementations may differ, in degrees. Measured 0.0003°;
 *  a wrong Euler order reads 37-47°, so the bar has four orders of headroom
 *  and still cannot be met by any answer that is actually wrong. */
const MAX_DISAGREEMENT_DEG = 0.5;

interface OracleFrame {
  frame: number;
  /** `pos` at 4dp, `quat` as (w, x, y, z) at 6dp — see the trim script for why
   *  the two precisions differ. Positions carry the joint angles; orientation
   *  carries the roll the angles cannot see (#979). */
  bones: Record<string, { pos: number[]; quat: number[] }>;
}

/** One walk of OUR forward kinematics over the clip, keeping both quantities the
 *  rows below read: world POSITION (joint angles) and world ROTATION (roll).
 *  `bend` runs after a frame's keys are applied and before the matrices are
 *  updated, so a falsification row can perturb one bone as the clip plays. */
type OurFrame = { pos: Map<string, Vector3>; quat: Map<string, Quaternion> };
type Specs = ReturnType<typeof parseBvh>['skeletonParams']['bones'];
type Bones = ReturnType<typeof specToThreeSkeleton>['bones'];

function ourFrames(bend?: (bones: Bones, specs: Specs) => void): OurFrame[] {
  const parsed = parseBvh(fs.readFileSync(BVH, 'utf8'), 'oracle', BVH_UNIT_SCALE_CENTIMETRES);
  const specs = parsed.skeletonParams.bones;
  const { bones } = specToThreeSkeleton(specs);

  const times = [...new Set(parsed.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
  const byTime = new Map<number, typeof parsed.clipParams.keyframes>();
  for (const k of parsed.clipParams.keyframes) {
    byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
  }

  const out: OurFrame[] = [];
  for (const t of times) {
    for (const k of byTime.get(t) ?? []) {
      const bone = bones[k.bone];
      if (!bone) continue;
      bone.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
      if (specs[k.bone].parent === -1) {
        bone.position.set(k.position[0], k.position[1], k.position[2]);
      }
    }
    if (bend) bend(bones, specs);
    bones[0].updateMatrixWorld(true);
    const pos = new Map<string, Vector3>();
    const quat = new Map<string, Quaternion>();
    specs.forEach((sp, i) => {
      const q = new Quaternion();
      bones[i].matrixWorld.decompose(new Vector3(), q, new Vector3());
      pos.set(sp.name, new Vector3().setFromMatrixPosition(bones[i].matrixWorld));
      quat.set(sp.name, q);
    });
    out.push({ pos, quat });
  }
  return out;
}

/** Blender stores (w, x, y, z); three takes (x, y, z, w). */
const theirQuat = (f: OracleFrame, name: string): Quaternion | null => {
  const b = f.bones[name];
  return b ? new Quaternion(b.quat[1], b.quat[2], b.quat[3], b.quat[0]) : null;
};

/** Rotation magnitude, in degrees. */
const angleOf = (q: Quaternion) => (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;

/** R_rel = R(t) · R(0)⁻¹, both in world space. */
const rel = (qt: Quaternion, q0: Quaternion) => qt.clone().multiply(q0.clone().invert());

/** The BVH importer's up-axis conversion for `axis_up='Y'`: +90° about X. It is
 *  READ FROM THE SETTINGS, not fitted — an alignment solved from the data could
 *  absorb the very error this is here to find. The dump's own Root bone reads
 *  (0.7071, 0.7071, 0, 0), which is this rotation. */
const UP_AXIS = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

const angleAt = (at: Map<string, Vector3>, [p, j, c]: [string, string, string]): number | null => {
  const P = at.get(p);
  const J = at.get(j);
  const C = at.get(c);
  if (!P || !J || !C) return null;
  const a = new Vector3().subVectors(P, J);
  const b = new Vector3().subVectors(C, J);
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return null;
  return (a.angleTo(b) * 180) / Math.PI;
};

const oracleAngles = (frame: OracleFrame): Map<string, number> => {
  const at = new Map<string, Vector3>();
  for (const [name, b] of Object.entries(frame.bones)) {
    at.set(name, new Vector3(b.pos[0], b.pos[1], b.pos[2]));
  }
  const out = new Map<string, number>();
  for (const t of TRIPLES) {
    const a = angleAt(at, t);
    if (a !== null) out.set(t.join('-'), a);
  }
  return out;
};

describe('a differential against Blender (#857)', () => {
  const frames = oracle.source.frames as OracleFrame[];

  it('our forward kinematics agrees with Blender at every joint, on every frame', () => {
    const ours = ourFrames();
    const count = Math.min(frames.length, ours.length);
    expect(count, 'no overlapping frames — the comparison would be vacuous').toBeGreaterThan(20);

    const worst = new Map<string, number>();
    for (let f = 0; f < count; f++) {
      const theirs = oracleAngles(frames[f]);
      for (const t of TRIPLES) {
        const key = t.join('-');
        const a = angleAt(ours[f].pos, t);
        const b = theirs.get(key);
        if (a === null || b === undefined) continue;
        worst.set(key, Math.max(worst.get(key) ?? 0, Math.abs(a - b)));
      }
    }

    expect(worst.size, 'no joint compared — the probe would report a vacuous pass').toBe(
      TRIPLES.length,
    );
    const max = Math.max(...worst.values());
    const loudest = [...worst.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(
      max,
      `our forward kinematics disagrees with Blender by ${max.toFixed(3)}° at ` +
        `${loudest[0]} — the clip is being read differently (unit scale, Euler order, ` +
        `or the walk up the hierarchy), and every correction built on it inherits that`,
    ).toBeLessThan(MAX_DISAGREEMENT_DEG);
  });

  it('FALSIFICATION: the compared joints actually move, so agreeing is not free', () => {
    // A table of zeros is also what a probe comparing a thing to ITSELF prints,
    // so the angles have to TRAVEL for their agreement to carry information.
    //
    // 🔴 AND THIS ROW IS WHERE THE STAND-IN CLIP'S LIMIT SHOWS. Measured travel
    // across the fixture: knees 34.4°, hips 13.8°, shoulders 0.7°, and spine,
    // chest, neck, head, elbows and wrists all EXACTLY 0.0°. Four of twelve
    // joints move. The vendor clip moves nine, so the same differential run
    // against `public/assets/kimodo-walk.bvh` locally is a materially stronger
    // check — and this fixture cannot see an upper-body defect at all, which is
    // the same blind spot that hid the head in #853. Tracked as its own issue.
    //
    // The bar is set at what is really there rather than at what would be nice,
    // because a bar the fixture cannot clear is a red that teaches nothing.
    //
    // #858 — what is really there is now ALL TWELVE. It was four: the legs moved
    // and everything from the spine up read exactly 0.0°, so this gate could not
    // fail on a defect in the spine, neck, head, elbows or wrists, which is most
    // of the bones and — on the evidence of the last five defects — most of the
    // risk. #853 is the proof: the head sat 42° off at the neck on the vendor
    // pair, and the stand-in read 0.0° off before the fix and 0.0° after.
    //
    // So the bar is EVERY compared joint, not a count with slack in it. A joint
    // that stops moving is the fixture regressing to the state that made this
    // gate decorative, and there is no reading of that which should stay green.
    const lo = new Map<string, number>();
    const hi = new Map<string, number>();
    for (const frame of frames) {
      for (const [k, v] of oracleAngles(frame)) {
        lo.set(k, Math.min(lo.get(k) ?? v, v));
        hi.set(k, Math.max(hi.get(k) ?? v, v));
      }
    }
    const travel = [...hi.entries()].map(([k, v]) => [k, v - (lo.get(k) ?? v)] as const);
    const moving = travel.filter(([, d]) => d > 5);
    expect(
      moving.length,
      `only ${moving.length} of ${TRIPLES.length} joints move more than 5° across this clip, so ` +
        `the agreement above is over a nearly static pose: ` +
        `${travel
          .sort((a, b) => b[1] - a[1])
          .map(([k, d]) => `${k} ${d.toFixed(1)}°`)
          .join(', ')}`,
    ).toBe(TRIPLES.length);

    // ...and with margin, so "moves" is not a joint trembling just over the line.
    // Stated separately because the count above would be satisfied by twelve
    // joints at 5.1° each, which is the same nearly-static agreement this row
    // exists to refuse.
    //
    // The quietest is a shoulder at 8.4°, and its ceiling is not arbitrary: the
    // term that moves the shoulder angle is the arm lifting AWAY from the body,
    // and `generated-character-generated-motion.spec.ts` separately requires the
    // upper arm to stay more than 50° below horizontal — the #845 guard against
    // arms held out toward the target's T-pose bind. Measured at 54.7°, so the
    // two requirements are both met and neither has much room. Anyone raising
    // this bar has to spend that margin, and should read #845 first.
    const quietest = Math.min(...travel.map(([, d]) => d));
    expect(
      quietest,
      `the quietest joint travels only ${quietest.toFixed(1)}°, so the clip is closer to ` +
        `static than the count above admits`,
    ).toBeGreaterThan(7);
  });

  // ───────────────────────────────────────────────────────────────────────
  // ORIENTATION (#979). The rows above compare THREE-POINT ANGLES built from
  // positions, and an angle between three points is unchanged by a bone rolling
  // about its own axis. Roll is where the open leg defects live (#854, #960,
  // #866), so until these rows existed the one gate that can disagree with us
  // was structurally unable to fail on the class of bug it is most needed for.
  //
  // WHY RELATIVE TO FRAME 0. Blender is Z-up, we are Y-up, and each gives a bone
  // its own rest frame, so raw world rotations are not comparable. Taking each
  // bone's rotation relative to its own frame 0 removes both differences by
  // construction: the up-axis change is a left-multiply and the per-bone rest
  // difference is a right-multiply, so
  //     W_blender(t) = C · W_ours(t) · Q_bone   ⇒   R_rel_bl = C · R_rel_ours · C⁻¹
  // with Q gone entirely and C reduced to a conjugation — which leaves the
  // rotation MAGNITUDE invariant, so that witness needs no alignment at all.
  // What survives is the motion, which is the same physical fact on both sides.
  // ───────────────────────────────────────────────────────────────────────

  /** The floor is the FIXTURE's, and the relationship is a square root: the
   *  residual is a near-identity rotation, and its angle goes as √(component
   *  error). Blender stores these matrices as float32, so ~6e-8 per component
   *  becomes ~0.13° whatever the dump writes; 6dp rounding adds a little on top.
   *  MEASURED on this fixture: magnitude 0.001°, residual 0.20°. A wrong Euler
   *  order reads 37-47° and a rolled bone reads its roll, so the bar sits an
   *  order of magnitude above the floor and two below anything actually wrong. */
  const MAX_ORIENTATION_DISAGREEMENT_DEG = 2;

  it('our forward kinematics agrees with Blender in FULL orientation, roll included', () => {
    const ours = ourFrames();
    const count = Math.min(frames.length, ours.length);
    const names = Object.keys(frames[0].bones).filter((n) => ours[0].quat.has(n));
    expect(names.length, 'no bone joined — the fixture and our parse name them apart').toBe(
      Object.keys(frames[0].bones).length,
    );

    const worstMag = new Map<string, number>();
    const worstResidual = new Map<string, number>();
    const travel = new Map<string, number>();
    for (const name of names) {
      const o0 = ours[0].quat.get(name);
      const b0 = theirQuat(frames[0], name);
      if (!o0 || !b0) continue;
      for (let f = 1; f < count; f++) {
        const ot = ours[f].quat.get(name);
        const bt = theirQuat(frames[f], name);
        if (!ot || !bt) continue;
        const ro = rel(ot, o0);
        const rb = rel(bt, b0);
        travel.set(name, Math.max(travel.get(name) ?? 0, angleOf(rb)));
        worstMag.set(name, Math.max(worstMag.get(name) ?? 0, Math.abs(angleOf(ro) - angleOf(rb))));
        const conj = UP_AXIS.clone().multiply(ro).multiply(UP_AXIS.clone().invert());
        worstResidual.set(
          name,
          Math.max(worstResidual.get(name) ?? 0, angleOf(rb.clone().invert().multiply(conj))),
        );
      }
    }

    // A bone that never turns agrees for free, so the ones that must turn are
    // named rather than counted — a count with slack in it is satisfied by a
    // fixture quietly going still.
    //
    // 🔴 AND THE SIX THAT ARE MISSING FROM THIS LIST ARE THE POINT. Measured on
    // this fixture: Root 0.0°, Hips 0.0°, both Feet 0.1°, both ToeBases 0.1°.
    // The stand-in clip walks with rigid hips and rigid feet, so this gate is
    // blind in orientation exactly where #854's defect is (feet rolling at
    // ground contact). The vendor clip turns those same feet through 128-139°.
    // Same shape as #858, which found the whole upper body reading 0.0°.
    const MUST_ROTATE = [
      'Spine1',
      'Spine2',
      'Chest',
      'Neck1',
      'Neck2',
      'Head',
      'LeftShoulder',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'RightShoulder',
      'RightArm',
      'RightForeArm',
      'RightHand',
      'LeftLeg',
      'LeftShin',
      'RightLeg',
      'RightShin',
    ];
    const moving = [...travel.entries()].filter(([, d]) => d > 10).map(([n]) => n);
    expect(
      moving,
      `these bones stopped rotating across the clip, so their agreement below is free: ` +
        `${MUST_ROTATE.filter((n) => !moving.includes(n)).join(', ')}`,
    ).toEqual(expect.arrayContaining(MUST_ROTATE));

    const mag = [...worstMag.entries()].sort((a, b) => b[1] - a[1])[0];
    const res = [...worstResidual.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(
      mag[1],
      `our bone rotations differ from Blender's in MAGNITUDE by ${mag[1].toFixed(3)}° at ${mag[0]}`,
    ).toBeLessThan(MAX_ORIENTATION_DISAGREEMENT_DEG);
    expect(
      res[1],
      `our bone orientations differ from Blender's by ${res[1].toFixed(3)}° at ${res[0]} once the ` +
        `up-axis conversion is undone — the axis of the motion disagrees even where its size does not`,
    ).toBeLessThan(MAX_ORIENTATION_DISAGREEMENT_DEG);
  });

  /** Roll `LeftShin` about the axis that points at `LeftFoot`. A rotation fixes
   *  its own axis, so LeftFoot does not move and every compared triple is
   *  untouched — the defect is purely orientation. */
  const rollLeftShin = (degAt: (f: number) => number) => {
    let f = -1;
    return ourFrames((bones, specs) => {
      f += 1;
      const i = specs.findIndex((sp) => sp.name === 'LeftShin');
      const c = specs.findIndex((sp) => sp.parent === i);
      if (i < 0 || c < 0) throw new Error('LeftShin or its child is missing from the parse');
      const axis = bones[c].position.clone().normalize();
      bones[i].quaternion.multiply(
        new Quaternion().setFromAxisAngle(axis, (degAt(f) * Math.PI) / 180),
      );
    });
  };

  const worstResidualFor = (ours: OurFrame[], name: string) => {
    const o0 = ours[0].quat.get(name);
    const b0 = theirQuat(frames[0], name);
    if (!o0 || !b0) throw new Error(`${name} is missing from one side`);
    let worst = 0;
    for (let f = 1; f < Math.min(frames.length, ours.length); f++) {
      const ot = ours[f].quat.get(name);
      const bt = theirQuat(frames[f], name);
      if (!ot || !bt) continue;
      const conj = UP_AXIS.clone().multiply(rel(ot, o0)).multiply(UP_AXIS.clone().invert());
      worst = Math.max(worst, angleOf(rel(bt, b0).clone().invert().multiply(conj)));
    }
    return worst;
  };

  const worstAngleShift = (ours: OurFrame[]) => {
    const clean = ourFrames();
    let shift = 0;
    for (let f = 0; f < Math.min(frames.length, ours.length); f++) {
      for (const t of TRIPLES) {
        const a = angleAt(clean[f].pos, t);
        const b = angleAt(ours[f].pos, t);
        if (a === null || b === null) continue;
        shift = Math.max(shift, Math.abs(a - b));
      }
    }
    return shift;
  };

  it('FALSIFICATION: a DRIFTING roll reds orientation and is invisible to the joint angles', () => {
    // The row above, made falsifiable. A roll that grows to 30° over the clip
    // moves no joint angle at all — not "less" — and moves the orientation
    // witness by the full roll.
    // The denominator is OUR frame count, not the oracle's: this clip has 31
    // keyed times while the dump carries 61 frames (Blender holds the last pose
    // past the end of the action), and dividing by the wrong one quietly injects
    // half the roll it says it does.
    const ourCount = ourFrames().length;
    const rolled = rollLeftShin((f) => (30 * f) / (ourCount - 1));
    const worst = worstResidualFor(rolled, 'LeftShin');
    expect(
      worst,
      `a roll drifting to 30° moved the orientation witness by only ${worst.toFixed(2)}° — ` +
        `the gate is not measuring what it claims to`,
    ).toBeGreaterThan(25);

    const shift = worstAngleShift(rolled);
    expect(
      shift,
      `the joint angles moved ${shift.toFixed(6)}° under a pure roll, so this row is no longer ` +
        `demonstrating the blind spot it was written for`,
    ).toBeLessThan(1e-6);
  });

  it('THE LIMIT, PINNED: a CONSTANT roll is invisible here, and that is the price of the method', () => {
    // Taking each bone's rotation relative to its own frame 0 is what makes two
    // applications comparable at all — it cancels the per-bone rest-frame
    // difference between Blender's bone convention and ours, which no amount of
    // care can otherwise separate from a real error. But a constant roll has
    // EXACTLY that shape: W'(t) = W(t)·R, so R cancels in W'(t)·W'(0)⁻¹ and the
    // witness reads zero. Measured: a flat 30° roll moves it 0.09°.
    //
    // So the range of these rows is TIME-VARYING orientation. A bone that is
    // constantly mis-rolled — which is what #854 sees at the feet and what #960
    // traces to rest alignment — cannot be caught here by construction, and
    // needs an instrument that knows what each bone's rest frame is SUPPOSED to
    // be. Written as a row rather than a comment because a limit nobody runs is
    // a limit that gets forgotten and then re-derived as a surprise.
    const rolled = rollLeftShin(() => 30);
    const worst = worstResidualFor(rolled, 'LeftShin');
    expect(
      worst,
      `a constant roll now moves the orientation witness by ${worst.toFixed(2)}° — if this ever ` +
        `becomes large the method changed, and the comment above is stale`,
    ).toBeLessThan(1);
  });

  it('records the method, so the oracle cannot drift without saying so', () => {
    // An oracle whose settings moved between runs is worse than none: it would
    // still agree, and the agreement would be about a different question.
    const m = oracle.method as Record<string, unknown>;
    expect(m.blender).toBe('5.1.1');
    expect(m.bvh).toBe('public/fixtures/anim/soma-walk.bvh');
    expect(m.bvh_import).toMatchObject({
      global_scale: 1,
      rotate_mode: 'NATIVE',
      axis_forward: '-Z',
      axis_up: 'Y',
    });
    // And the SHAPE, because a re-trim that dropped the quaternions would leave
    // the orientation rows comparing nothing while every position row stayed
    // green — the fixture is where this gate's range actually lives (#979).
    const first = (oracle.source.frames as OracleFrame[])[0].bones;
    for (const [name, b] of Object.entries(first)) {
      expect(b.pos, `${name} has no position in the fixture`).toHaveLength(3);
      expect(b.quat, `${name} has no orientation in the fixture`).toHaveLength(4);
    }
  });
});
