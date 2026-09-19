// #1165 — keying a value a curve already has leaves the curve as it was.
//
// Every row keys through the seam Auto-Key, the I key and the agent all use
// (`mutator.timeline.keyframe` via `dispatchMutatorFromUI`), with the value the curve already
// has at that time, then samples the channel before and after at 2,001 times. Blender's insert
// is the reference (animrig `fcurve.cc`): a replaced key keeps its handles and interpolation, and
// a key landing between two keys whose handles are stored splits the segment (De Casteljau), so
// the curve does not move. Handles stored bare take the sampler's fast path; handles typed 'free'
// (what the curve editor writes on a drag) take the typed path, which also shrinks a handle that
// overshoots its span — one row gives it one to shrink.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import {
  sampleScalarKeyframes,
  sampleVec2Keyframes,
  sampleVec3Keyframes,
  type HandleType,
  type ScalarKey,
  type Vec2Key,
  type Vec3Key,
} from '../../nodes/keyframeInterp';
import { makeSplitCube } from '../../test-utils/splitCube';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

type Channel = 'KeyframeChannelNumber' | 'KeyframeChannelVec2' | 'KeyframeChannelVec3';
type AnyKey = ScalarKey | Vec2Key | Vec3Key;

function sampler(type: Channel) {
  return (keys: readonly AnyKey[], t: number): number[] => {
    if (type === 'KeyframeChannelNumber') return [sampleScalarKeyframes(keys as ScalarKey[], t)];
    if (type === 'KeyframeChannelVec2') return [...sampleVec2Keyframes(keys as Vec2Key[], t)];
    return [...sampleVec3Keyframes(keys as Vec3Key[], t)];
  };
}

/** The channel on a cube, hydrated into the store the seam writes to. */
function hydrate(type: Channel, keys: readonly AnyKey[]): void {
  let s: DagState = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = makeSplitCube(s, {
    objectId: 'box',
    size: [1, 1, 1],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color: '#fff',
    connectTo: { node: 'scene', socket: 'children' },
  }).state;
  const paramPath =
    type === 'KeyframeChannelNumber'
      ? 'position.0'
      : type === 'KeyframeChannelVec2'
        ? 'pivot'
        : 'position';
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'ch',
    nodeType: type,
    params: { name: 'c', target: 'box', paramPath, keyframes: keys },
  }).next;
  useDagStore.getState().hydrate(s);
}

const keysNow = () =>
  (useDagStore.getState().state.nodes['ch'].params as { keyframes: AnyKey[] }).keyframes;

/** Key `value` (default: the curve's own) at `t`; the curve's worst move over [0, 2]. */
function keyAndMeasure(
  type: Channel,
  keys: readonly AnyKey[],
  t: number,
  value?: number[],
): { worst: number; after: AnyKey[] } {
  hydrate(type, keys);
  const sample = sampler(type);
  const own = sample(keys, t);
  const v = value ?? own;
  const res = dispatchMutatorFromUI(
    'mutator.timeline.keyframe',
    { channelId: 'ch', time: t, value: type === 'KeyframeChannelNumber' ? v[0] : v },
    'key',
  );
  expect(res).toEqual({ ok: true });
  const after = keysNow();
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const at = (i / 2000) * 2;
    const a = sample(keys, at);
    const b = sample(after, at);
    worst = Math.max(worst, ...a.map((x, j) => Math.abs(x - b[j])));
  }
  return { worst, after };
}

/** Three keys at 0 / 1 / 2 with stored handles, per component count, optionally typed. */
function handled(n: 1 | 2 | 3, handleType?: HandleType): AnyKey[] {
  const v = (x: number) => (n === 1 ? x : Array.from({ length: n }, (_, i) => x * (i + 1)));
  const ht = handleType ? { handleType } : {};
  return [
    { time: 0, value: v(0), easing: 'cubic', ...ht, outHandle: { time: 0.3, value: v(2) } },
    {
      time: 1,
      value: v(1),
      easing: 'cubic',
      ...ht,
      inHandle: { time: -0.3, value: v(1) },
      outHandle: { time: 0.3, value: v(-1) },
    },
    { time: 2, value: v(0), easing: 'cubic', ...ht, inHandle: { time: -0.3, value: v(0) } },
  ] as AnyKey[];
}

const CHANNELS: [Channel, 1 | 2 | 3][] = [
  ['KeyframeChannelNumber', 1],
  ['KeyframeChannelVec2', 2],
  ['KeyframeChannelVec3', 3],
];

describe('#1165 — keying the value a curve already has leaves it unchanged', () => {
  for (const [type, n] of CHANNELS) {
    for (const ht of [undefined, 'free'] as const) {
      const label = `${type}, handles ${ht ?? 'stored bare'}`;
      it(`${label}: re-keying an existing key keeps the curve and the key's handles`, () => {
        const keys = handled(n, ht);
        const { worst, after } = keyAndMeasure(type, keys, 1);
        expect(worst).toBeLessThan(1e-6);
        expect(after[1].inHandle).toEqual(keys[1].inHandle);
        expect(after[1].outHandle).toEqual(keys[1].outHandle);
      });
      for (const t of [0.1, 0.5, 1.7]) {
        it(`${label}: a key inserted at t = ${t} leaves the curve where it was`, () => {
          const { worst, after } = keyAndMeasure(type, handled(n, ht), t);
          expect(after).toHaveLength(4);
          expect(worst).toBeLessThan(1e-6);
        });
      }
    }
  }

  // The keys the native import writes for `anim-nested.gltf`'s CUBICSPLINE translation (#1164),
  // verbatim: the file's tangents as handles at ±Δt/3, keys at 0, 0.5 and 2.
  const IMPORTED: Vec3Key[] = [
    {
      time: 0,
      value: [1, 0, 0],
      easing: 'cubic',
      outHandle: { time: 1 / 6, value: [1, 5 / 6, -0.5] },
    },
    {
      time: 0.5,
      value: [2, 1, 0],
      easing: 'cubic',
      inHandle: { time: -1 / 6, value: [-4 / 3, 1, -1 / 3] },
      outHandle: { time: 0.5, value: [-2, 3.5, 0.5] },
    },
    {
      time: 2,
      value: [1, 0, 1],
      easing: 'cubic',
      inHandle: { time: -0.5, value: [2.5, -2, -4.5] },
    },
  ];
  for (const t of [0.1, 0.5, 1.2]) {
    it(`an imported CUBICSPLINE track keyed at t = ${t} keeps the file's curve`, () => {
      expect(keyAndMeasure('KeyframeChannelVec3', IMPORTED, t).worst).toBeLessThan(1e-6);
    });
  }

  it('a handle longer than its span (the typed path shrinks it) still splits to the same curve', () => {
    const keys: Vec3Key[] = [
      {
        time: 0,
        value: [0, 0, 0],
        easing: 'cubic',
        handleType: 'free',
        outHandle: { time: 0.9, value: [0, 3, 0] },
      },
      {
        time: 1,
        value: [0, 1, 0],
        easing: 'cubic',
        handleType: 'free',
        inHandle: { time: -0.8, value: [0, 1, 0] },
      },
    ];
    const { worst } = keyAndMeasure('KeyframeChannelVec3', keys, 0.35);
    expect(worst).toBeLessThan(1e-6);
  });

  it('re-keying keeps a linear key linear when the call names no easing', () => {
    const keys: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 1, value: [0, 2, 0], easing: 'linear' },
      { time: 2, value: [0, 0, 0], easing: 'linear' },
    ];
    const { worst, after } = keyAndMeasure('KeyframeChannelVec3', keys, 1);
    expect(after[1].easing).toBe('linear');
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('#1165 — a key off the curve moves it only between its neighbours, and lands exactly', () => {
  it('a new value inside a handled segment reshapes that segment alone', () => {
    const keys = handled(3);
    hydrate('KeyframeChannelVec3', keys);
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 0.5, [0.5, 3, -1]);
    const sample = sampler('KeyframeChannelVec3');
    sample(after, 0.5).forEach((x, j) => expect(Math.abs(x - [0.5, 3, -1][j])).toBeLessThan(1e-6));
    for (let i = 0; i <= 1000; i++) {
      const t = 1 + i / 1000; // the untouched segment 1 → 2
      const a = sample(keys, t);
      const b = sample(after, t);
      a.forEach((x, j) => expect(Math.abs(x - b[j])).toBeLessThan(1e-6));
    }
  });

  it('a re-key to a new value moves the key and keeps its handles as offsets', () => {
    const keys = handled(3);
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 1, [0, 5, 0]);
    expect(after[1].value).toEqual([0, 5, 0]);
    expect(after[1].outHandle).toEqual(keys[1].outHandle);
  });
});

describe('#1165 — what is not split', () => {
  it('a segment with no stored handles inserts plainly, as before', () => {
    const keys: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [0, 2, 0], easing: 'linear' },
    ];
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 1);
    expect(after[1]).toEqual({ time: 1, value: [0, 1, 0], easing: 'cubic' });
    expect(after[0]).toEqual(keys[0]);
  });

  it('an auto handle on a neighbour is left to recompute, as Blender leaves it', () => {
    const keys = handled(3, 'auto');
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 0.5);
    expect(after[0]).toEqual(keys[0]);
    expect(after[1].inHandle).toBeUndefined();
  });

  it('an auto handle on ONE end of the segment is enough to leave it unsplit', () => {
    const keys: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'cubic', handleType: 'auto' },
      {
        time: 1,
        value: [0, 1, 0],
        easing: 'cubic',
        handleType: 'free',
        inHandle: { time: -0.3, value: [0, 1, 0] },
      },
    ];
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 0.5);
    expect(after[0]).toEqual(keys[0]);
    expect(after[2]).toEqual(keys[1]);
    expect(after[1].inHandle).toBeUndefined();
  });

  it('an equation interpolation (it ignores handles) is left unsplit', () => {
    const keys: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'cubic', outHandle: { time: 0.3, value: [0, 2, 0] } },
      { time: 1, value: [0, 1, 0], easing: 'sine', inHandle: { time: -0.3, value: [0, 1, 0] } },
    ];
    const { after } = keyAndMeasure('KeyframeChannelVec3', keys, 0.5);
    expect(after[0]).toEqual(keys[0]);
    expect(after[1].inHandle).toBeUndefined();
  });

  it("a quaternion channel re-key keeps the key's interpolation", () => {
    let s: DagState = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelQuat',
      params: {
        name: 'q',
        target: 'scene',
        paramPath: 'quaternion',
        keyframes: [
          { time: 0, value: [0, 0, 0, 1], easing: 'linear' },
          { time: 1, value: [0, 0, 0.7071068, 0.7071068], easing: 'linear' },
        ],
      },
    }).next;
    useDagStore.getState().hydrate(s);
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'ch', time: 1, value: [0, 0, 0.7071068, 0.7071068] },
      'key',
    );
    expect(res).toEqual({ ok: true });
    expect((keysNow()[1] as { easing: string }).easing).toBe('linear');
  });
});
