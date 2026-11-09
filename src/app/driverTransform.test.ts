// #1785 (the driver half) — a driver takes a rotation or a whole transform: a Quaternion drives a
// rotation, a Matrix4 drives position, rotation and scale together. Measured through the readers
// the inspector and the renderer use (`resolveEvaluatedTransform`, `resolveWorldTransform`).
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { buildDefaultDagState } from '../core/project/default';
import { composeTransform, eulerToQuat, type Mat4 } from '../core/math/transformMath';
import { registerAllNodes } from '../nodes/registerAll';
import type { KeyframeChannelValue } from '../nodes/types';
import { makeSplitCube } from '../test-utils/splitCube';
import { driverChannelValuesForTarget, driverStackForTarget } from './paramDrivers';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveWorldTransform } from './resolveWorldTransform';
import { clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());

const run = (s: DagState, op: object) => applyOp(s, op as never).next;
const SCENE = { node: 'n_scene', socket: 'children' };

/** A cube at the top level, with a constant `value` of `type` fed to a driver on `paramPath`. */
function driven(
  value: { vec: [number, number, number] } | { euler: [number, number, number] } | { m: Mat4 },
  paramPath: string,
  boxParams: Record<string, unknown> = {},
): DagState {
  let s = buildDefaultDagState();
  s = makeSplitCube(s, { objectId: 'box', position: [9, 9, 9], connectTo: SCENE }).state;
  for (const [k, v] of Object.entries(boxParams))
    s = run(s, { type: 'setParam', nodeId: 'box', paramPath: k, value: v });
  const fit = (id: string, v: number) => [
    { type: 'addNode', nodeId: id, nodeType: 'Fit', params: { outMin: v, outMax: v } },
  ];
  const vec3 = (id: string, v: readonly number[]) => [
    { type: 'addNode', nodeId: id, nodeType: 'MakeVec3', params: {} },
    ...(['x', 'y', 'z'] as const).flatMap((axis, i) => [
      ...fit(`${id}_${axis}`, v[i]),
      {
        type: 'connect',
        from: { node: `${id}_${axis}`, socket: 'out' },
        to: { node: id, socket: axis },
      },
    ]),
  ];
  const ops: object[] = [];
  let source: string;
  if ('m' in value) {
    // A constant transform: Combine Transform of a translation, an Euler rotation and a scale,
    // each from its own constants (the matrix is passed as those three parts).
    const [t, e, sc] = parts(value.m);
    ops.push(...vec3('t', t), ...vec3('e', e), ...vec3('sc', sc));
    ops.push({ type: 'addNode', nodeId: 'q', nodeType: 'EulerToRotation', params: {} });
    ops.push({
      type: 'connect',
      from: { node: 'e', socket: 'out' },
      to: { node: 'q', socket: 'euler' },
    });
    ops.push({ type: 'addNode', nodeId: 'xf', nodeType: 'CombineTransform', params: {} });
    ops.push({
      type: 'connect',
      from: { node: 't', socket: 'out' },
      to: { node: 'xf', socket: 'translation' },
    });
    ops.push({
      type: 'connect',
      from: { node: 'q', socket: 'out' },
      to: { node: 'xf', socket: 'rotation' },
    });
    ops.push({
      type: 'connect',
      from: { node: 'sc', socket: 'out' },
      to: { node: 'xf', socket: 'scale' },
    });
    source = 'xf';
  } else if ('euler' in value) {
    ops.push(...vec3('e', value.euler));
    ops.push({ type: 'addNode', nodeId: 'q', nodeType: 'EulerToRotation', params: {} });
    ops.push({
      type: 'connect',
      from: { node: 'e', socket: 'out' },
      to: { node: 'q', socket: 'euler' },
    });
    source = 'q';
  } else {
    ops.push(...vec3('v', value.vec));
    source = 'v';
  }
  ops.push({
    type: 'addNode',
    nodeId: 'drv',
    nodeType: 'ParamDriver',
    params: { target: 'box', paramPath, blendMode: 'replace', order: 0 },
  });
  ops.push({
    type: 'connect',
    from: { node: source, socket: 'out' },
    to: { node: 'drv', socket: 'in' },
  });
  for (const op of ops) s = run(s, op);
  return s;
}

/** The test transforms are built from these parts, kept beside them. */
const PARTS = new WeakMap<Mat4, [number[], number[], number[]]>();
function transform(t: number[], euler: number[], scale: number[]): Mat4 {
  const m = composeTransform(t as never, eulerToQuat(euler as never), scale as never);
  PARTS.set(m, [t, euler, scale]);
  return m;
}
const parts = (m: Mat4) => PARTS.get(m)!;

const ctx = clockedCtx(0.5, 0.5);
/** A channel's sample, read as the numbers it carries. */
const sampleOf = (c: KeyframeChannelValue) => (t: number) =>
  (c.sample as (t: number) => unknown)(t) as number[];
const own = (s: DagState) => resolveEvaluatedTransform(s, 'box', ctx)!;
const close = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(b[i], digits));

describe('#1785 — a rotation drives a rotation', () => {
  it('on an Euler `rotation`, as Euler degrees', () => {
    const s = driven({ euler: [10, 20, 30] }, 'rotation');
    close(own(s).rotation!, [10, 20, 30]);
    close(own(s).position, [9, 9, 9]); // nothing else moves
  });

  it('on a quaternion-mode `quaternion`, as the quaternion', () => {
    const s = driven({ euler: [0, 90, 0] }, 'quaternion', {
      rotationMode: 'quaternion',
      quaternion: [0, 0, 0, 1],
    });
    close(own(s).quaternion!, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });
});

describe('#1785 — a transform drives position, rotation and scale together', () => {
  const M = transform([1, 2, 3], [10, 20, 30], [2, 1, 0.5]);

  it('the object reads and draws at the transform', () => {
    const s = driven({ m: M }, 'transform');
    const t = own(s);
    close(t.position, [1, 2, 3]);
    close(t.rotation!, [10, 20, 30]);
    close(t.scale!, [2, 1, 0.5]);
    // A top-level object's world is its own transform: the drawn matrix is the driver's.
    close(resolveWorldTransform(s, 'box', ctx)!.matrix, M);
  });

  it('in quaternion mode it writes the quaternion, and leaves the Euler rotation alone', () => {
    const s = driven({ m: M }, 'transform', {
      rotationMode: 'quaternion',
      quaternion: [0, 0, 0, 1],
      rotation: [0, 0, 0],
    });
    close(resolveWorldTransform(s, 'box', ctx)!.matrix, M);
    const paths = driverChannelValuesForTarget(s, 'box', ctx).map((c) => c.paramPath);
    expect(paths).toEqual(['position', 'quaternion', 'scale']);
  });

  it("is one member of each of the three params' stacks, and a reader of one param gets its own", () => {
    const s = driven({ m: M }, 'transform');
    for (const p of ['position', 'rotation', 'scale'])
      expect(
        driverStackForTarget(s.nodes, 'box', p).map((n) => n.id),
        p,
      ).toEqual(['drv']);
    expect(driverStackForTarget(s.nodes, 'box', 'material.opacity')).toEqual([]);
    const scale = driverChannelValuesForTarget(s, 'box', ctx, undefined, 'scale');
    expect(scale.map((c) => c.paramPath)).toEqual(['scale']);
    close(sampleOf(scale[0])(0.5), [2, 1, 0.5]);
  });

  it('evaluated alone it folds nothing: no `transform` field is ever written', () => {
    const s = driven({ m: M }, 'transform');
    const v = evaluate(s, 'drv', { ctx }).value as KeyframeChannelValue;
    expect(v.mute).toBe(true);
  });

  it('CONTROL: a vector driver on position still moves only the position', () => {
    const s = driven({ vec: [4, 5, 6] }, 'position');
    close(own(s).position, [4, 5, 6]);
    close(own(s).rotation!, [0, 0, 0]);
  });
});

describe("#1785 — an object placed at another object's world, through the wire (#1810)", () => {
  it("a Null's world, times an offset, drives a cube's whole transform", () => {
    let s = driven({ vec: [0, 0, 0] }, 'position');
    s = run(s, {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [1, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
    });
    // The driver now reads ctl.world · offset, and writes the transform.
    s = run(s, { type: 'setParam', nodeId: 'drv', paramPath: 'paramPath', value: 'transform' });
    s = run(s, {
      type: 'disconnect',
      from: { node: 'v', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    s = run(s, { type: 'addNode', nodeId: 'off', nodeType: 'CombineTransform', params: {} });
    s = run(s, {
      type: 'connect',
      from: { node: 'v', socket: 'out' },
      to: { node: 'off', socket: 'translation' },
    });
    s = run(s, { type: 'setParam', nodeId: 'v_x', paramPath: 'outMin', value: 2 });
    s = run(s, { type: 'setParam', nodeId: 'v_x', paramPath: 'outMax', value: 2 });
    s = run(s, { type: 'addNode', nodeId: 'mul', nodeType: 'MultiplyTransforms', params: {} });
    s = run(s, {
      type: 'connect',
      from: { node: 'ctl', socket: 'world' },
      to: { node: 'mul', socket: 'a' },
    });
    s = run(s, {
      type: 'connect',
      from: { node: 'off', socket: 'out' },
      to: { node: 'mul', socket: 'b' },
    });
    s = run(s, {
      type: 'connect',
      from: { node: 'mul', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    // (2,0,0) in ctl's space, turned 90° about Y, is (0,0,-2); plus ctl at (1,0,0).
    const t = own(s);
    close(t.position, [1, 0, -2]);
    close(t.rotation!, [0, 90, 0]);
  });
});

describe('#1785 — a Solver carrying a transform drives one', () => {
  it('its transform state, stepped one unit along x a frame, places the cube at x = frame', () => {
    let s = driven({ vec: [1, 0, 0] }, 'transform');
    s = run(s, {
      type: 'disconnect',
      from: { node: 'v', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    const ops: object[] = [
      { type: 'addNode', nodeId: 'solver', nodeType: 'Solver', params: {} },
      { type: 'addNode', nodeId: 'step', nodeType: 'CombineTransform', params: {} },
      {
        type: 'connect',
        from: { node: 'v', socket: 'out' },
        to: { node: 'step', socket: 'translation' },
      },
      {
        type: 'addNode',
        nodeId: 'px',
        nodeType: 'BodyInputTransform',
        params: { input: 'prevTransform', slot: 0 },
      },
      { type: 'addNode', nodeId: 'moved', nodeType: 'MultiplyTransforms', params: {} },
      {
        type: 'connect',
        from: { node: 'step', socket: 'out' },
        to: { node: 'moved', socket: 'a' },
      },
      { type: 'connect', from: { node: 'px', socket: 'out' }, to: { node: 'moved', socket: 'b' } },
      {
        type: 'connect',
        from: { node: 'moved', socket: 'out' },
        to: { node: 'solver', socket: 'bodiesTransform' },
      },
      {
        type: 'connect',
        from: { node: 'solver', socket: 'outTransform' },
        to: { node: 'drv', socket: 'in' },
      },
    ];
    for (const op of ops) s = run(s, op);
    for (const frame of [0, 3, 7]) {
      const at = clockedCtx(frame / 60, frame / 60);
      close(resolveEvaluatedTransform(s, 'box', at)!.position, [frame, 0, 0]);
    }
  });

  it('behind another node, it still moves with the playhead: channels built once, sampled later', () => {
    let s = driven({ vec: [1, 0, 0] }, 'transform');
    s = run(s, {
      type: 'disconnect',
      from: { node: 'v', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    const ops: object[] = [
      { type: 'addNode', nodeId: 'solver', nodeType: 'Solver', params: {} },
      { type: 'addNode', nodeId: 'step', nodeType: 'CombineTransform', params: {} },
      {
        type: 'connect',
        from: { node: 'v', socket: 'out' },
        to: { node: 'step', socket: 'translation' },
      },
      {
        type: 'addNode',
        nodeId: 'px',
        nodeType: 'BodyInputTransform',
        params: { input: 'prevTransform', slot: 0 },
      },
      { type: 'addNode', nodeId: 'moved', nodeType: 'MultiplyTransforms', params: {} },
      {
        type: 'connect',
        from: { node: 'step', socket: 'out' },
        to: { node: 'moved', socket: 'a' },
      },
      { type: 'connect', from: { node: 'px', socket: 'out' }, to: { node: 'moved', socket: 'b' } },
      {
        type: 'connect',
        from: { node: 'moved', socket: 'out' },
        to: { node: 'solver', socket: 'bodiesTransform' },
      },
      // A node between the Solver and the driver: the driver does not read the Solver directly.
      { type: 'addNode', nodeId: 'after', nodeType: 'MultiplyTransforms', params: {} },
      {
        type: 'connect',
        from: { node: 'solver', socket: 'outTransform' },
        to: { node: 'after', socket: 'a' },
      },
      // Its other input is unwired: the identity, so `after` passes the state through.
      {
        type: 'connect',
        from: { node: 'after', socket: 'out' },
        to: { node: 'drv', socket: 'in' },
      },
    ];
    for (const op of ops) s = run(s, op);
    // As the renderer does: the channels are built at one time and sampled at each frame.
    const [position] = driverChannelValuesForTarget(
      s,
      'box',
      clockedCtx(0, 0),
      undefined,
      'position',
    );
    const at = (frame: number) => sampleOf(position)(frame / 60);
    // State x = frame, through the node after the Solver.
    close(at(0), [0, 0, 0]);
    close(at(7), [7, 0, 0]);
  });

  it('a rotation behind another node also moves with the playhead', () => {
    // State: turn 10° about Y a frame. After the Solver, Separate Transform takes its rotation.
    let s = driven({ euler: [0, 10, 0] }, 'rotation');
    s = run(s, {
      type: 'disconnect',
      from: { node: 'q', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    const ops: object[] = [
      { type: 'addNode', nodeId: 'solver', nodeType: 'Solver', params: {} },
      { type: 'addNode', nodeId: 'step', nodeType: 'CombineTransform', params: {} },
      {
        type: 'connect',
        from: { node: 'q', socket: 'out' },
        to: { node: 'step', socket: 'rotation' },
      },
      {
        type: 'addNode',
        nodeId: 'px',
        nodeType: 'BodyInputTransform',
        params: { input: 'prevTransform', slot: 0 },
      },
      { type: 'addNode', nodeId: 'moved', nodeType: 'MultiplyTransforms', params: {} },
      {
        type: 'connect',
        from: { node: 'step', socket: 'out' },
        to: { node: 'moved', socket: 'a' },
      },
      { type: 'connect', from: { node: 'px', socket: 'out' }, to: { node: 'moved', socket: 'b' } },
      {
        type: 'connect',
        from: { node: 'moved', socket: 'out' },
        to: { node: 'solver', socket: 'bodiesTransform' },
      },
      { type: 'addNode', nodeId: 'sep', nodeType: 'SeparateTransform', params: {} },
      {
        type: 'connect',
        from: { node: 'solver', socket: 'outTransform' },
        to: { node: 'sep', socket: 'transform' },
      },
      {
        type: 'connect',
        from: { node: 'sep', socket: 'rotation' },
        to: { node: 'drv', socket: 'in' },
      },
    ];
    for (const op of ops) s = run(s, op);
    const [rotation] = driverChannelValuesForTarget(
      s,
      'box',
      clockedCtx(0, 0),
      undefined,
      'rotation',
    );
    const at = (frame: number) => sampleOf(rotation)(frame / 60);
    close(at(0), [0, 0, 0]);
    close(at(3), [0, 30, 0]);
  });
});
