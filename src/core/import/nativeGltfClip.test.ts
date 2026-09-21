// #1051 — the clip reader. Every emitted channel is sampled through the channel node's own sampler
// and held to the glTF spec's formula for its interpolation (Appendix C), written out here rather
// than borrowed from the code under test. Every refusal is held to its own words.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readNativeClip, type ClipChannel, type ClipGltfJson } from './nativeGltfClip';
import { buildVec3Sampler, KeyframeChannelVec3Params } from '../../nodes/KeyframeChannelVec3';
import {
  KeyframeChannelQuatNode,
  KeyframeChannelQuatParams,
} from '../../nodes/KeyframeChannelQuat';
import type { KeyframeChannelQuatValue, Quat } from '../../nodes/types';

type Json = ClipGltfJson & {
  nodes: { name?: string; matrix?: number[] }[];
  buffers: { uri: string; byteLength: number }[];
  accessors: NonNullable<ClipGltfJson['accessors']>;
  bufferViews: NonNullable<ClipGltfJson['bufferViews']>;
  animations: NonNullable<ClipGltfJson['animations']>;
};

/** The fixture, with its one buffer decoded, and a way to append more data to it. */
function fixture(mutate: (json: Json, append: Append) => void = () => {}) {
  const json = JSON.parse(readFileSync('public/assets/anim-nested.gltf', 'utf8')) as Json;
  let bin = Uint8Array.from(Buffer.from(json.buffers[0].uri.split(',')[1], 'base64'));
  const append: Append = (bytes, accessor) => {
    const offset = Math.ceil(bin.length / 4) * 4;
    const next = new Uint8Array(offset + bytes.length);
    next.set(bin);
    next.set(bytes, offset);
    bin = next;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    json.accessors.push({ ...accessor, bufferView: json.bufferViews.length - 1 });
    return json.accessors.length - 1;
  };
  mutate(json, append);
  return { json, buffers: [bin] };
}
type Append = (
  bytes: Uint8Array,
  accessor: Omit<NonNullable<ClipGltfJson['accessors']>[number], 'bufferView'>,
) => number;
const floats = (...values: number[]) => new Uint8Array(Float32Array.from(values).buffer);

const read = (mutate?: (json: Json, append: Append) => void) => {
  const { json, buffers } = fixture(mutate);
  return readNativeClip(json, buffers);
};
function channelsOf(result: ReturnType<typeof readNativeClip>): ClipChannel[] {
  if ('refused' in result) throw new Error(result.refused);
  return result.channels;
}
const CUBE = 0;
const PIVOT = 1;
const find = (channels: ClipChannel[], node: number, path: string) =>
  channels.find((c) => c.node === node && c.path === path)!;

// ── The spec's formulas, Appendix C ────────────────────────────────────────────────────────
function hermite(p0: number, m0: number, p1: number, m1: number, td: number, u: number) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p0 +
    td * (u3 - 2 * u2 + u) * m0 +
    (-2 * u3 + 3 * u2) * p1 +
    td * (u3 - u2) * m1
  );
}
/** C.4 exactly: a = acos|v_k·v_k+1|, s = sign(v_k·v_k+1). */
function specSlerp(a: Quat, b: Quat, t: number): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const ang = Math.acos(Math.min(1, Math.abs(d)));
  if (ang < 1e-9) return a;
  const s = Math.sign(d) || 1;
  const wa = Math.sin(ang * (1 - t)) / Math.sin(ang);
  const wb = (s * Math.sin(ang * t)) / Math.sin(ang);
  return [0, 1, 2, 3].map((i) => wa * a[i] + wb * b[i]) as unknown as Quat;
}
const angleDeg = (a: readonly number[], b: readonly number[]) => {
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (la * lb);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};
function quatSampler(channel: ClipChannel) {
  const params = KeyframeChannelQuatParams.parse({ keyframes: channel.keyframes });
  return (KeyframeChannelQuatNode.evaluate(params, {}, {} as never) as KeyframeChannelQuatValue)
    .sample;
}

describe('#1051 — a clip reads into channels that sample as the spec defines', () => {
  it('the fixture reads as five channels, one per animated (node, path)', () => {
    const channels = channelsOf(read());
    expect(channels.map((c) => `${c.node}/${c.path}`).sort()).toEqual(
      ['0/rotation', '0/scale', '0/translation', '1/rotation', '1/translation'].sort(),
    );
  });

  it('CUBICSPLINE translation is the spec’s Hermite curve, tangents and all', () => {
    const ch = find(channelsOf(read()), CUBE, 'translation');
    const sample = buildVec3Sampler(KeyframeChannelVec3Params.parse({ keyframes: ch.keyframes }));
    const T = [0, 0.5, 2];
    const V = [
      [1, 0, 0],
      [2, 1, 0],
      [1, 0, 1],
    ];
    const IN = [
      [0, 0, 0],
      [8, -6, 2],
      [-5, 4, 9],
    ];
    const OUT = [
      [6, 5, -3],
      [-4, 7, 1],
      [0, 0, 0],
    ];
    let worst = 0;
    let samples = 0;
    for (let k = 0; k < 2; k++) {
      const td = T[k + 1] - T[k];
      for (let j = 0; j <= 500; j++) {
        const u = j / 500;
        const got = sample(T[k] + u * td);
        for (let c = 0; c < 3; c++) {
          worst = Math.max(
            worst,
            Math.abs(got[c] - hermite(V[k][c], OUT[k][c], V[k + 1][c], IN[k + 1][c], td, u)),
          );
          samples++;
        }
      }
    }
    expect(samples).toBe(2 * 501 * 3);
    // float32 in the file, float64 here: the curve agrees to the file's own precision.
    expect(worst).toBeLessThan(1e-5);
  });

  // #1157 — a rotation sampled CUBICSPLINE used to be refused, because a quaternion channel had
  // nowhere to hold the file's tangents. It holds them now, so the file arrives as itself. The
  // reference below is the spec's own formula (`Specification.adoc:3615-3638`): Hermite per
  // component, normalized (`:3628`), written out here rather than borrowed from the reader.
  const SPLINE_T = [0, 0.4, 1.5];
  const SPLINE_V: number[][] = [
    [0, 0, 0, 1],
    [0, 0.38268343, 0, 0.92387953],
    [0.5, 0.5, 0.5, 0.5],
  ];
  const SPLINE_IN: number[][] = [
    [0, 0, 0, 0],
    [0.3, -0.9, 0.2, 0.4],
    [-0.7, 0.25, 0.8, -0.3],
  ];
  const SPLINE_OUT: number[][] = [
    [0.8, 0.4, -0.2, 0.6],
    [-0.25, 0.7, 0.45, 0.1],
    [0, 0, 0, 0],
  ];

  /** The cube's rotation, re-written as a CUBICSPLINE track the way a file carries one. */
  function splineRotation(): ClipChannel {
    return find(
      channelsOf(
        read((j, append) => {
          const track = j.animations[0];
          const rot = track.channels.find(
            (c) => c.target.path === 'rotation' && c.target.node === CUBE,
          )!;
          const sampler = track.samplers[rot.sampler];
          sampler.interpolation = 'CUBICSPLINE';
          sampler.input = append(floats(...SPLINE_T), {
            componentType: 5126,
            count: SPLINE_T.length,
            type: 'SCALAR',
            // The spec requires an animation input to carry its bounds (`:2778`).
            min: [SPLINE_T[0]],
            max: [SPLINE_T[SPLINE_T.length - 1]],
          });
          // Per key, in the spec's order: in-tangent, value, out-tangent (`:3615`).
          const packed: number[] = [];
          for (let k = 0; k < SPLINE_T.length; k++) {
            packed.push(...SPLINE_IN[k], ...SPLINE_V[k], ...SPLINE_OUT[k]);
          }
          sampler.output = append(floats(...packed), {
            componentType: 5126,
            count: SPLINE_T.length * 3,
            type: 'VEC4',
          });
        }),
      ),
      CUBE,
      'rotation',
    );
  }

  it('CUBICSPLINE rotation is the spec’s Hermite over the components, normalized', () => {
    const sample = quatSampler(splineRotation());
    let worst = 0;
    let samples = 0;
    for (let k = 0; k < SPLINE_T.length - 1; k++) {
      const td = SPLINE_T[k + 1] - SPLINE_T[k];
      for (let j = 0; j <= 500; j++) {
        const u = j / 500;
        const got = sample(SPLINE_T[k] + u * td);
        const want = [0, 1, 2, 3].map((c) =>
          hermite(SPLINE_V[k][c], SPLINE_OUT[k][c], SPLINE_V[k + 1][c], SPLINE_IN[k + 1][c], td, u),
        );
        const len = Math.hypot(...want);
        for (let c = 0; c < 4; c++) {
          worst = Math.max(worst, Math.abs(got[c] - want[c] / len));
          samples++;
        }
      }
    }
    expect(samples).toBe(2 * 501 * 4);
    // float32 in the file, float64 here: the same bound the translation row holds to.
    expect(worst).toBeLessThan(1e-5);
  });

  it('the tangents land on the keys as handles a third of the span in', () => {
    const keys = splineRotation().keyframes;
    // float32 in the file: 0.4 comes back as 0.40000000596.
    keys.forEach((k, i) => expect(k.time).toBeCloseTo(SPLINE_T[i], 6));
    expect(keys.length).toBe(SPLINE_T.length);
    expect(keys.every((k) => k.easing === 'cubic')).toBe(true);
    // The first in-tangent and the last out-tangent are unused (`:3638`), so neither is written.
    expect(keys[0].inHandle).toBeUndefined();
    expect(keys[keys.length - 1].outHandle).toBeUndefined();
    const dt = SPLINE_T[1] - SPLINE_T[0];
    expect(keys[0].outHandle!.time).toBeCloseTo(dt / 3, 6); // float32 span, as above
    for (let c = 0; c < 4; c++) {
      expect(keys[0].outHandle!.value[c]).toBeCloseTo((SPLINE_OUT[0][c] * dt) / 3, 6);
      expect(keys[1].inHandle!.value[c]).toBeCloseTo((-SPLINE_IN[1][c] * dt) / 3, 6);
    }
  });

  it('a CUBICSPLINE rotation stays a rotation: unit at every sample', () => {
    const sample = quatSampler(splineRotation());
    for (let j = 0; j <= 200; j++) {
      const q = sample((1.5 * j) / 200);
      expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 12);
    }
  });

  it('LINEAR rotation is the spec’s slerp (C.4), not a component lerp', () => {
    const ch = find(channelsOf(read()), CUBE, 'rotation');
    const keys = ch.keyframes.map((k) => k.value as Quat);
    const sample = quatSampler(ch);
    let worst = 0;
    for (let j = 0; j <= 400; j++) {
      const t = (2 * j) / 400;
      const k = Math.min(Math.floor(t), 1);
      worst = Math.max(worst, angleDeg(sample(t), specSlerp(keys[k], keys[k + 1], t - k)));
    }
    expect(worst).toBeLessThan(1e-4);
    // Positive control: a component lerp (Blender's reading) is visibly elsewhere mid-segment.
    const lerp = keys[0].map((v, i) => v + (keys[1][i] - v) * 0.25);
    expect(angleDeg(sample(0.25), lerp)).toBeGreaterThan(1);
  });

  it('STEP holds each key until the next (C.2), on a rotation and on a scale', () => {
    const channels = channelsOf(read());
    const rot = find(channels, PIVOT, 'rotation');
    const sample = quatSampler(rot);
    const keys = rot.keyframes.map((k) => k.value as Quat);
    for (const [t, held] of [
      [0, 0],
      [0.999, 0],
      [1, 1],
      [1.5, 1],
      [2, 2],
    ] as const) {
      // Held means the key itself, so equality — an angle this near zero is acos noise.
      expect(sample(t), `t=${t}`).toEqual(keys[held]);
    }
    const scale = find(channels, CUBE, 'scale');
    const s = buildVec3Sampler(KeyframeChannelVec3Params.parse({ keyframes: scale.keyframes }));
    expect([s(0.5)[0], s(1.5)[0], s(2)[0]]).toEqual([1, 2, 1]);
  });

  it('LINEAR translation lerps (C.3)', () => {
    const ch = find(channelsOf(read()), PIVOT, 'translation');
    const s = buildVec3Sampler(KeyframeChannelVec3Params.parse({ keyframes: ch.keyframes }));
    expect(s(1)[1]).toBeCloseTo(3.5, 6);
  });

  it('a snorm16 rotation is dequantized by the spec’s table', () => {
    const q: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const ch = find(
      channelsOf(
        read((json, append) => {
          const ints = Int16Array.from([0, 0, 0, 32767, ...q.map((v) => Math.round(v * 32767))]);
          const out = append(new Uint8Array(ints.buffer), {
            componentType: 5122,
            normalized: true,
            count: 2,
            type: 'VEC4',
          });
          json.animations[0].samplers[1] = {
            input: json.animations[0].samplers[0].input,
            output: out,
            interpolation: 'STEP',
          };
        }),
      ),
      PIVOT,
      'rotation',
    );
    expect(angleDeg(ch.keyframes[1].value, q)).toBeLessThan(0.01);
  });

  it('a channel with no target node is skipped, as the spec says (:2782)', () => {
    const channels = channelsOf(
      read((json) => {
        delete (json.animations[0].channels[0].target as { node?: number }).node;
      }),
    );
    expect(channels).toHaveLength(4);
  });

  it('a file with no clip reads as no channels', () => {
    expect(
      channelsOf(read((json) => delete (json as { animations?: unknown }).animations)),
    ).toEqual([]);
  });
});

describe('#1051 — what cannot come across is refused, by name', () => {
  const refusal = (mutate: (json: Json, append: Append) => void) => {
    const r = read(mutate);
    if (!('refused' in r)) throw new Error('expected a refusal');
    return r;
  };
  const anim = (json: Json) => json.animations[0];

  it.each<[string, (json: Json, append: Append) => void, RegExp, string]>([
    [
      'a second clip',
      (j) => j.animations.push({ ...anim(j), name: 'Drop' }),
      /2 animation clips/,
      '#1154',
    ],
    [
      'a weights track',
      (j) => (anim(j).channels[0].target.path = 'weights'),
      /morph target weights/,
      '#1060',
    ],
    [
      // #1157 took the rotation refusal out; what is left here is the spec's count rule, which
      // this same mutation now trips: CUBICSPLINE wants three values per key (`:3615`).
      'a CUBICSPLINE output that is not three per key',
      (j) => (anim(j).samplers[anim(j).channels[2].sampler].interpolation = 'CUBICSPLINE'),
      /values for \d+ keys/,
      '#1063',
    ],
    [
      'an animated matrix node (:2786)',
      (j) => (j.nodes[PIVOT].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]),
      /node 1, which is given as a matrix/,
      '#1063',
    ],
    [
      'one target twice (:2796)',
      (j) => anim(j).channels.push({ ...anim(j).channels[0] }),
      /node 1's translation twice/,
      '#1063',
    ],
    [
      'an unknown interpolation',
      (j) => (anim(j).samplers[0].interpolation = 'BOUNCE'),
      /interpolation "BOUNCE"/,
      '#1063',
    ],
    [
      'an unknown path',
      (j) => (anim(j).channels[0].target.path = 'pointer'),
      /path "pointer"/,
      '#1063',
    ],
    [
      'a missing node',
      (j) => (anim(j).channels[0].target.node = 99),
      /node 99, which does not exist/,
      '#1063',
    ],
    [
      'a missing sampler',
      (j) => (anim(j).channels[0].sampler = 99),
      /sampler 99, which does not exist/,
      '#1063',
    ],
    [
      'an input with no min and max (:2833)',
      (j) => delete j.accessors[anim(j).samplers[0].input].max,
      /has no min and max/,
      '#1063',
    ],
    [
      'an input that is not float scalars',
      (j) => (j.accessors[anim(j).samplers[0].input].type = 'VEC3'),
      /is not float scalars/,
      '#1063',
    ],
    [
      'an input starting before 0 (schema)',
      (j, add) =>
        (anim(j).samplers[0].input = add(floats(-1, 2), {
          componentType: 5126,
          count: 2,
          type: 'SCALAR',
          min: [-1],
          max: [2],
        })),
      /starts before 0/,
      '#1063',
    ],
    [
      'an input not strictly increasing (schema)',
      (j, add) =>
        (anim(j).samplers[0].input = add(floats(1, 1), {
          componentType: 5126,
          count: 2,
          type: 'SCALAR',
          min: [1],
          max: [1],
        })),
      /not strictly increasing/,
      '#1063',
    ],
    [
      'an output with the wrong count',
      (j) => (j.accessors[anim(j).samplers[0].output].count = 3),
      /holds 3 values for 2 keys/,
      '#1063',
    ],
    [
      'a translation given as VEC4',
      (j) => (j.accessors[anim(j).samplers[0].output].type = 'VEC4'),
      /is not a translation the spec allows/,
      '#1063',
    ],
    [
      'an integer rotation that is not normalized',
      (j, add) =>
        (anim(j).samplers[1].output = add(new Uint8Array(new Int16Array(12).buffer), {
          componentType: 5122,
          count: 3,
          type: 'VEC4',
        })),
      /is not a rotation the spec allows/,
      '#1063',
    ],
    [
      'an input naming no accessor',
      (j) => (anim(j).samplers[0].input = 99),
      /input names accessor 99, which does not exist/,
      '#1063',
    ],
    [
      'a sparse input',
      (j) => (j.accessors[anim(j).samplers[0].input].sparse = {}),
      /input is a sparse accessor/,
      '#1063',
    ],
    [
      'an input with no keys',
      (j, add) => {
        anim(j).samplers[0].input = add(new Uint8Array(0), {
          componentType: 5126,
          count: 0,
          type: 'SCALAR',
          min: [0],
          max: [0],
        });
        anim(j).samplers[0].output = add(new Uint8Array(0), {
          componentType: 5126,
          count: 0,
          type: 'VEC3',
        });
      },
      /has no keys/,
      '#1063',
    ],
    [
      'a sparse accessor',
      (j) => (j.accessors[anim(j).samplers[0].output].sparse = {}),
      /output is a sparse accessor/,
      '#1063',
    ],
    [
      'a bufferless accessor',
      (j) => delete j.accessors[anim(j).samplers[0].output].bufferView,
      /output has no buffer view/,
      '#1063',
    ],
    [
      'an interleaved accessor',
      (j) => (j.bufferViews[j.accessors[anim(j).samplers[0].output].bufferView!].byteStride = 16),
      /output is interleaved/,
      '#1063',
    ],
    [
      'a CUBICSPLINE with one key (:3614)',
      (j, add) => {
        const s = anim(j).samplers[anim(j).channels[4].sampler];
        s.input = add(floats(0), {
          componentType: 5126,
          count: 1,
          type: 'SCALAR',
          min: [0],
          max: [0],
        });
        s.output = add(floats(0, 0, 0, 1, 0, 0, 0, 0, 0), {
          componentType: 5126,
          count: 3,
          type: 'VEC3',
        });
      },
      /CUBICSPLINE from a single key/,
      '#1063',
    ],
  ])('%s', (_what, mutate, words, issue) => {
    const r = refusal(mutate);
    expect(r.refused).toMatch(words);
    expect(r.issue).toBe(issue);
  });
});
