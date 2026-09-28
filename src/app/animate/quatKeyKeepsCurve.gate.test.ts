// #1177 — keying the rotation a quaternion curve already has leaves it unchanged, the way Blender's
// I key leaves its four rotation F-curves unchanged.
//
// THE REFERENCE, measured in Blender 5.1.1 (headless, a rotation_quaternion curve with hand-set
// handles, the I key pressed mid-segment at frame 40):
//   - the rotation is FOUR scalar F-curves, array_index 0..3 (animrig `keyframing.cc`, one insert per
//     array index);
//   - the property the I key reads is their RAW evaluation, |q| = 0.797 — not unit — and the new key
//     stores exactly that (`get_keyframe_values` → `get_rna_values`, the value as it stands);
//   - each component's segment is split (`subdivide_nonauto_handles`), so the curve moved 0.0°.
//
// Our channel normalizes when it samples, so the value a keying call hands in is the unit rotation.
// These rows key through the seam Auto-Key, the I key and the agent all use
// (`mutator.timeline.keyframe` via `dispatchMutatorFromUI`) and sample the curve 2,001 times before
// and after, as the #1165 gate does for the scalar and vec curves.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { sampleQuatKeyframes, type QuatKey } from '../../nodes/keyframeInterp';
import type { Quat } from '../../nodes/types';
import { makeSplitCube } from '../../test-utils/splitCube';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const unit = (q: number[]): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const axisAngle = (axis: [number, number, number], deg: number): Quat => {
  const h = (deg * Math.PI) / 360;
  const n = Math.hypot(...axis);
  const s = Math.sin(h);
  return [(axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s, Math.cos(h)];
};
const neg = (q: Quat): Quat => [-q[0], -q[1], -q[2], -q[3]];
const norm = (q: readonly number[]) => Math.hypot(q[0], q[1], q[2], q[3]);
/** The angle between two rotations, in degrees — what a viewer sees move. */
const degreesApart = (a: Quat, b: Quat) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (norm(a) * norm(b));
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

/** A rotation curve holding a file's tangents: three keys, handles on every inner side. The same
 *  shape the #1177 issue measured a 23.1° reshape on. */
function handledCurve(): QuatKey[] {
  const h = (q: number[], dt: number) => unit(q).map((v) => (v * dt) / 3) as unknown as Quat;
  return [
    {
      time: 0,
      value: axisAngle([0, 1, 0], 0),
      easing: 'cubic',
      outHandle: { time: 0.35 / 3, value: h([0.4, 0.9, -0.2, 0.15], 0.35) },
    },
    {
      time: 0.35,
      value: axisAngle([0, 1, 0], 85),
      easing: 'cubic',
      inHandle: { time: -0.35 / 3, value: h([0.2, 1.1, 0.3, -0.4], -0.35) },
      outHandle: { time: 1.25 / 3, value: h([-0.7, 0.5, 0.9, 0.2], 1.25) },
    },
    {
      time: 1.6,
      value: axisAngle([1, 0.4, 0], 190),
      easing: 'cubic',
      inHandle: { time: -1.25 / 3, value: h([0.9, -0.3, 0.25, 0.6], -1.25) },
    },
  ];
}

function hydrate(keys: readonly QuatKey[]): void {
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
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'ch',
    nodeType: 'KeyframeChannelQuat',
    params: { name: 'c', target: 'box', paramPath: 'quaternion', keyframes: keys },
  }).next;
  useDagStore.getState().hydrate(s);
}

const keysNow = () =>
  (useDagStore.getState().state.nodes['ch'].params as { keyframes: QuatKey[] }).keyframes;

/** Key `value` (default: the rotation the curve has there) at `t`; the worst move over the domain. */
function keyAndMeasure(
  keys: readonly QuatKey[],
  t: number,
  value?: Quat,
): { worstDeg: number; after: QuatKey[] } {
  hydrate(keys);
  const v = value ?? sampleQuatKeyframes(keys, t);
  const res = dispatchMutatorFromUI(
    'mutator.timeline.keyframe',
    { channelId: 'ch', time: t, value: [...v] },
    'key',
  );
  expect(res).toEqual({ ok: true });
  const after = keysNow();
  let worstDeg = 0;
  for (let i = 0; i <= 2000; i++) {
    const at = (i / 2000) * 1.6;
    worstDeg = Math.max(
      worstDeg,
      degreesApart(sampleQuatKeyframes(keys, at), sampleQuatKeyframes(after, at)),
    );
  }
  return { worstDeg, after };
}

describe('#1177 — keying the rotation a quaternion curve already has leaves it unchanged', () => {
  it('a new key mid-segment splits the segment, and the curve does not move', () => {
    // 23.1° before this change (the issue's measurement); Blender measured 0.0°.
    const { worstDeg, after } = keyAndMeasure(handledCurve(), 0.9);
    expect(after).toHaveLength(4);
    expect(worstDeg).toBeLessThan(1e-4);
  });

  it('stores the RAW curve point, not a unit quaternion — as Blender’s I key does', () => {
    // Blender stored |q| = 0.797 at its mid-segment key. Ours must store the curve's own length
    // there too: a unit value in its place is what kinks the curve.
    const keys = handledCurve();
    const { after } = keyAndMeasure(keys, 0.9);
    const stored = after.find((k) => k.time === 0.9)!;
    expect(norm(stored.value)).toBeLessThan(0.999);
    expect(stored.inHandle).toBeDefined();
    expect(stored.outHandle).toBeDefined();
  });

  it('the opposite sign of the same rotation keys the same curve (q and −q are one rotation)', () => {
    const keys = handledCurve();
    const own = sampleQuatKeyframes(keys, 0.9);
    const { worstDeg } = keyAndMeasure(keys, 0.9, neg(own));
    expect(worstDeg).toBeLessThan(1e-4);
  });

  it('a different rotation lands exactly where it was keyed, and the far segment keeps its shape', () => {
    const keys = handledCurve();
    const target = axisAngle([0, 0, 1], 33);
    hydrate(keys);
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'ch', time: 0.9, value: [...target] },
      'key',
    );
    expect(res).toEqual({ ok: true });
    const after = keysNow();
    expect(degreesApart(sampleQuatKeyframes(after, 0.9), target)).toBeLessThan(1e-6);
    // The segment before the key's neighbour is outside the split: unchanged to the bit. Compared
    // by component, not by angle — acos near 1 turns 1e-16 of float noise into ~1e-6°.
    for (let i = 0; i <= 500; i++) {
      const at = (i / 500) * 0.35;
      expect(sampleQuatKeyframes(after, at)).toEqual(sampleQuatKeyframes(keys, at));
    }
  });

  it('re-keying an existing key keeps its handles and the curve', () => {
    const keys = handledCurve();
    const { worstDeg, after } = keyAndMeasure(keys, 0.35);
    expect(after).toHaveLength(3);
    expect(after[1].inHandle).toEqual(keys[1].inHandle);
    expect(after[1].outHandle).toEqual(keys[1].outHandle);
    expect(worstDeg).toBeLessThan(1e-4);
  });

  it('a slerp curve with no handles takes a plain key, as before — nothing to split', () => {
    const plain: QuatKey[] = [
      { time: 0, value: axisAngle([0, 1, 0], 0), easing: 'linear' },
      { time: 1, value: axisAngle([0, 1, 0], 120), easing: 'linear' },
    ];
    const { worstDeg, after } = keyAndMeasure(plain, 0.4);
    const stored = after.find((k) => k.time === 0.4)!;
    expect(stored.inHandle).toBeUndefined();
    expect(stored.outHandle).toBeUndefined();
    expect(norm(stored.value)).toBeCloseTo(1, 12);
    // A slerp's great-circle arc at constant speed survives a key on its own path.
    expect(worstDeg).toBeLessThan(1e-4);
  });
});
