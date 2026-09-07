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
import { Vector3 } from 'three';
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
  bones: Record<string, number[]>;
}

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
  for (const [name, p] of Object.entries(frame.bones)) {
    at.set(name, new Vector3(p[0], p[1], p[2]));
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
    const parsed = parseBvh(fs.readFileSync(BVH, 'utf8'), 'oracle', BVH_UNIT_SCALE_CENTIMETRES);
    const specs = parsed.skeletonParams.bones;
    const { bones } = specToThreeSkeleton(specs);

    const times = [...new Set(parsed.clipParams.keyframes.map((k) => k.time))].sort(
      (a, b) => a - b,
    );
    const byTime = new Map<number, typeof parsed.clipParams.keyframes>();
    for (const k of parsed.clipParams.keyframes) {
      byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
    }

    const count = Math.min(frames.length, times.length);
    expect(count, 'no overlapping frames — the comparison would be vacuous').toBeGreaterThan(20);

    const worst = new Map<string, number>();
    for (let f = 0; f < count; f++) {
      for (const k of byTime.get(times[f]) ?? []) {
        const bone = bones[k.bone];
        if (!bone) continue;
        bone.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
        if (specs[k.bone].parent === -1) {
          bone.position.set(k.position[0], k.position[1], k.position[2]);
        }
      }
      bones[0].updateMatrixWorld(true);
      const ours = new Map<string, Vector3>();
      specs.forEach((s, i) => {
        ours.set(s.name, new Vector3().setFromMatrixPosition(bones[i].matrixWorld));
      });

      const theirs = oracleAngles(frames[f]);
      for (const t of TRIPLES) {
        const key = t.join('-');
        const a = angleAt(ours, t);
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
  });
});
