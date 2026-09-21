// #1157 — a quaternion channel holds the tangents a glTF CUBICSPLINE rotation carries, and
// reads them as the spec defines them.
//
// THE REFERENCE IS THE SPEC ITSELF, written out here and never imported from the code under
// test: glTF Appendix C.5 (`Specification.adoc:3615-3638`) defines a CUBICSPLINE segment as the
// Hermite
//
//     p(u) = (2u³-3u²+1)·v_k + Δt(u³-2u²+u)·b_k + (-2u³+3u²)·v_k+1 + Δt(u³-u²)·a_k+1
//
// over each component, normalized afterwards for a rotation (`:3628`). The channel stores the
// same curve as bézier handles at ±Δt/3 — the identity the vec3 import already relies on — so
// the gate's question is whether the two agree to the sample.
//
// The other half is that nothing moved for a curve with no handles: a slerp channel must sample
// EXACTLY as it did before handles existed, which is why the pre-#1157 slerp is written out here
// too and compared bit for bit.

import { describe, expect, it } from 'vitest';
import { sampleQuatKeyframes, type QuatKey } from './keyframeInterp';
import { slerp } from './quatMath';
import type { Quat } from './types';

/** The spec's Hermite, per component, normalized after (`Specification.adoc:3615-3638`). */
function specCubicSpline(
  vk: Quat,
  outTangent: Quat,
  vk1: Quat,
  inTangent: Quat,
  dt: number,
  u: number,
): Quat {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    out[i] = h00 * vk[i] + dt * h10 * outTangent[i] + h01 * vk1[i] + dt * h11 * inTangent[i];
  }
  const len = Math.hypot(out[0], out[1], out[2], out[3]);
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

/** The sampler as it stood before #1157: slerp, smoothstep on 'cubic', hold on 'constant'. */
function preTangentSample(keys: readonly QuatKey[], t: number): Quat {
  if (keys.length === 0) return [0, 0, 0, 1];
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      if (b.easing === 'constant') return u >= 1 ? b.value : a.value;
      const f = b.easing === 'cubic' ? u * u * (3 - 2 * u) : u;
      return slerp(a.value, b.value, f);
    }
  }
  return last.value;
}

const unit = (q: number[]): Quat => {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
};

/** A rotation of `deg` about a normalized axis — an honest quaternion to key. */
function axisAngle(axis: [number, number, number], deg: number): Quat {
  const half = (deg * Math.PI) / 360;
  const s = Math.sin(half);
  const n = Math.hypot(...axis);
  return [(axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s, Math.cos(half)];
}

/**
 * A CUBICSPLINE track as a file holds it: per key [in-tangent, value, out-tangent], tangents
 * per second. The rows below build one, then convert it the way the native import does.
 */
interface SplineKey {
  time: number;
  inTangent: Quat;
  value: Quat;
  outTangent: Quat;
}

/** The importer's conversion: tangents become handles at ±Δt/3 (`nativeGltfClip.ts`). */
function toChannelKeys(track: readonly SplineKey[]): QuatKey[] {
  return track.map((k, i) => {
    const key: {
      time: number;
      value: Quat;
      easing: 'cubic';
      inHandle?: { time: number; value: Quat };
      outHandle?: { time: number; value: Quat };
    } = { time: k.time, value: k.value, easing: 'cubic' };
    if (i > 0) {
      const dt = k.time - track[i - 1].time;
      key.inHandle = {
        time: -dt / 3,
        value: k.inTangent.map((a) => (-a * dt) / 3) as unknown as Quat,
      };
    }
    if (i < track.length - 1) {
      const dt = track[i + 1].time - k.time;
      key.outHandle = {
        time: dt / 3,
        value: k.outTangent.map((b) => (b * dt) / 3) as unknown as Quat,
      };
    }
    return key as QuatKey;
  });
}

/** Unequal spans and tangents that are not gentle — the case a lax implementation passes. */
const TRACK: SplineKey[] = [
  {
    time: 0,
    inTangent: [0, 0, 0, 0],
    value: axisAngle([0, 1, 0], 0),
    outTangent: unit([0.4, 0.9, -0.2, 0.15]),
  },
  {
    time: 0.35,
    inTangent: unit([0.2, 1.1, 0.3, -0.4]),
    value: axisAngle([0, 1, 0], 85),
    outTangent: unit([-0.7, 0.5, 0.9, 0.2]),
  },
  {
    time: 1.6,
    inTangent: unit([0.9, -0.3, 0.25, 0.6]),
    value: axisAngle([1, 0.4, 0], 190),
    outTangent: unit([0.1, 0.2, -1.3, 0.4]),
  },
  {
    time: 2.05,
    inTangent: unit([-0.25, 0.8, 0.45, -0.9]),
    value: axisAngle([0.3, 0.2, 1], 300),
    outTangent: [0, 0, 0, 0],
  },
];

const SAMPLES = 2001;

/** Max per-component distance between the channel and the spec, over the whole domain. */
function driftFromSpec(track: readonly SplineKey[]): number {
  const keys = toChannelKeys(track);
  const t0 = track[0].time;
  const t1 = track[track.length - 1].time;
  let worst = 0;
  for (let n = 0; n < SAMPLES; n++) {
    const t = t0 + ((t1 - t0) * n) / (SAMPLES - 1);
    let seg = 0;
    while (seg < track.length - 2 && t > track[seg + 1].time) seg++;
    const a = track[seg];
    const b = track[seg + 1];
    const dt = b.time - a.time;
    const u = Math.min(1, Math.max(0, (t - a.time) / dt));
    const want = specCubicSpline(a.value, a.outTangent, b.value, b.inTangent, dt, u);
    const got = sampleQuatKeyframes(keys, t);
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  }
  return worst;
}

describe("#1157 — a quaternion curve keeps the file's tangents", () => {
  it('samples a CUBICSPLINE rotation exactly as the spec defines it', () => {
    // 9.8e-10 measured. The floor is the shared x→s solve, not the model: `solveParamForX`
    // is a 30-iteration bisection, "≈1e-9 precision in s" by its own doc
    // (`keyframeInterp.ts`), and a segment multiplies that by its slope. The gentle row below
    // separates the two. The vec3 import rides the same solve and measured 2.5e-8 (#1157).
    expect(driftFromSpec(TRACK)).toBeLessThan(1e-8);
  });

  it('is exact where the solve is not the limit — a gentle segment', () => {
    // Small tangents over wide spans: the same model, with almost no slope to multiply the
    // solve's error by. 7.3e-11 measured here against 9.8e-10 above — a 13× drop from slope
    // alone, which is what says the 1e-9 belongs to the bisection and not to the Hermite.
    const gentle: SplineKey[] = [
      {
        time: 0,
        inTangent: [0, 0, 0, 0],
        value: axisAngle([0, 1, 0], 0),
        outTangent: [0.004, 0.002, 0, 0.001],
      },
      {
        time: 4,
        inTangent: [0.003, -0.001, 0.002, 0],
        value: axisAngle([0, 1, 0], 12),
        outTangent: [0, 0, 0, 0],
      },
    ];
    expect(driftFromSpec(gentle)).toBeLessThan(1e-10);
  });

  it('holds to the spec on a track whose spans and tangents are extreme', () => {
    const steep: SplineKey[] = [
      {
        time: 0,
        inTangent: [0, 0, 0, 0],
        value: axisAngle([1, 0, 0], 10),
        outTangent: [3.2, -2.8, 1.4, 2.1],
      },
      {
        time: 0.04,
        inTangent: [-2.9, 3.4, -1.1, 0.7],
        value: axisAngle([0, 0, 1], 175),
        outTangent: [0.05, 0.02, -0.01, 0.03],
      },
      {
        time: 7.5,
        inTangent: [0.01, -0.02, 0.04, 0.01],
        value: axisAngle([0.5, 0.5, 0.5], 355),
        outTangent: [0, 0, 0, 0],
      },
    ];
    expect(driftFromSpec(steep)).toBeLessThan(1e-8); // 1.3e-9 measured — the solve's floor again
  });

  it('is a unit quaternion at every sample, which is what makes it a rotation', () => {
    const keys = toChannelKeys(TRACK);
    let worst = 0;
    for (let n = 0; n < SAMPLES; n++) {
      const t = (2.05 * n) / (SAMPLES - 1);
      const q = sampleQuatKeyframes(keys, t);
      worst = Math.max(worst, Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('leaves a curve with no handles exactly where it was — slerp, to the bit', () => {
    const plain: QuatKey[] = [
      { time: 0, value: axisAngle([0, 1, 0], 0), easing: 'cubic' },
      { time: 0.7, value: axisAngle([0, 1, 0], 120), easing: 'linear' },
      { time: 1.9, value: axisAngle([1, 0.2, 0], 300), easing: 'cubic' },
      { time: 2.4, value: axisAngle([0.2, 1, 0.3], 44), easing: 'constant' },
      { time: 3.1, value: axisAngle([0, 0, 1], 90), easing: 'linear' },
    ];
    for (let n = 0; n < SAMPLES; n++) {
      const t = (3.4 * n) / (SAMPLES - 1) - 0.15;
      expect(sampleQuatKeyframes(plain, t)).toEqual(preTangentSample(plain, t));
    }
  });

  it('holds on a constant key even where the segment stores handles', () => {
    const held: QuatKey[] = [
      {
        time: 0,
        value: axisAngle([0, 1, 0], 0),
        easing: 'cubic',
        outHandle: { time: 0.3, value: [0.1, 0.2, 0, 0] },
      },
      {
        time: 1,
        value: axisAngle([0, 1, 0], 90),
        easing: 'constant',
        inHandle: { time: -0.3, value: [-0.1, 0.05, 0, 0] },
      },
    ];
    expect(sampleQuatKeyframes(held, 0.5)).toEqual(held[0].value);
    expect(sampleQuatKeyframes(held, 0.999)).toEqual(held[0].value);
    expect(sampleQuatKeyframes(held, 1)).toEqual(held[1].value);
  });

  it("reads the file's key signs as given, rather than flipping to the short arc", () => {
    // Two keys 200° apart: slerp takes the short way round (the flip), the spec's cubic does
    // not. A sampler that flipped before interpolating would land on the other side.
    const far = axisAngle([0, 1, 0], 200);
    const keys = toChannelKeys([
      {
        time: 0,
        inTangent: [0, 0, 0, 0],
        value: axisAngle([0, 1, 0], 0),
        outTangent: [0, 0, 0, 0],
      },
      { time: 1, inTangent: [0, 0, 0, 0], value: far, outTangent: [0, 0, 0, 0] },
    ]);
    const mid = sampleQuatKeyframes(keys, 0.5);
    const shortArc = slerp(axisAngle([0, 1, 0], 0), far, 0.5);
    const dot =
      mid[0] * shortArc[0] + mid[1] * shortArc[1] + mid[2] * shortArc[2] + mid[3] * shortArc[3];
    expect(Math.abs(dot)).toBeLessThan(0.99);
  });
});
