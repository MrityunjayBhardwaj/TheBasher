// #1811, #1812 — editing a chain through its wires. What it builds has to read as what was asked,
// and at Blender's numbers where a row exists (`constraintChain.blender.test.ts` has the full set).

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import {
  addStepOps,
  influenceOf,
  moveStepOps,
  readChain,
  removeStepOps,
  setInfluenceOps,
} from './chainEdit';

type Vec3 = [number, number, number];
const at = (seconds = 0) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: readonly object[] | null) => {
  expect(ops).not.toBeNull();
  for (const o of ops!) s = applyOp(s, o as never).next;
  return s;
};
const cube = (s: DagState, objectId: string, position: Vec3) =>
  makeSplitCube(s, {
    objectId,
    position,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
const add = (
  s: DagState,
  id: string,
  type: 'TrackTo' | 'FollowPath',
  params: object,
  pos?: number,
) => run(s, addStepOps(s, 'a', id, type, params as Record<string, unknown>, pos));
const matrix = (s: DagState, seconds = 0) =>
  new THREE.Matrix4().fromArray(
    evaluate(s, 'a', { socket: 'world', ctx: at(seconds) }).value as number[],
  );
const position = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m).toArray();
const forward = (m: THREE.Matrix4) =>
  new THREE.Vector3().setFromMatrixColumn(m, 2).normalize().negate().toArray();
const close = (got: number[], want: number[]) =>
  got.forEach((v, i) => expect(v, `${got} vs ${want}`).toBeCloseTo(want[i], 3));
const order = (s: DagState) => readChain(s, 'a')!.steps.map((step) => step.id);

/** A line from the origin to (10, 0, 0), turned 90° about Z, in the scene. */
const withCurve = (s: DagState) =>
  run(s, [
    {
      type: 'addNode',
      nodeId: 'cd',
      nodeType: 'CurveData',
      params: {
        points: withIds([
          [0, 0, 0],
          [10, 0, 0],
        ]),
        closed: false,
        resolution: 32,
      },
    },
    { type: 'addNode', nodeId: 'c', nodeType: 'Object', params: { rotation: [0, 0, 90] } },
    { type: 'connect', from: { node: 'cd', socket: 'out' }, to: { node: 'c', socket: 'data' } },
    {
      type: 'connect',
      from: { node: 'c', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]);
const followParams = { evalTime: 1, offset: 0 };
const follow = (s: DagState, id: string, params: object = followParams) => {
  const next = add(s, id, 'FollowPath', params);
  return run(next, [
    { type: 'connect', from: { node: 'c', socket: 'world' }, to: { node: id, socket: 'curve' } },
  ]);
};

describe('the chain as a stack', () => {
  it('adds on top by default, and starts the chain on the first', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    expect(readChain(s, 'a')).toEqual({ own: null, steps: [] });
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    s = add(s, 't2', 'TrackTo', { aimPoint: [1, 5, 0], up: [0, 0, 1] });
    expect(order(s)).toEqual(['t1', 't2']);
    close(forward(matrix(s)), [0, 1, 0]);
  });

  it('adds at a position when asked, for a path below an aim', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    s = add(s, 't2', 'TrackTo', { aimPoint: [1, 5, 0], up: [0, 0, 1] }, 0);
    expect(order(s)).toEqual(['t2', 't1']);
    close(forward(matrix(s)), [1, 0, 0]);
  });

  it('moving a step changes which wins, and moving back restores the wires', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    s = add(s, 't2', 'TrackTo', { aimPoint: [1, 5, 0], up: [0, 0, 1] });
    const original = s;
    s = run(s, moveStepOps(s, 'a', 't2', 0));
    expect(order(s)).toEqual(['t2', 't1']);
    close(forward(matrix(s)), [1, 0, 0]);
    s = run(s, moveStepOps(s, 'a', 't2', 1));
    expect(s.nodes.t1.inputs).toEqual(original.nodes.t1.inputs);
    expect(s.nodes.t2.inputs).toEqual(original.nodes.t2.inputs);
    expect(s.nodes.a.inputs).toEqual(original.nodes.a.inputs);
  });

  it('moving to where it already is writes nothing', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    expect(moveStepOps(s, 'a', 't1', 0)).toEqual([]);
  });

  it('removing a middle step closes the gap', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    s = add(s, 't2', 'TrackTo', { aimPoint: [1, 5, 0], up: [0, 0, 1] });
    s = add(s, 't3', 'TrackTo', { aimPoint: [1, 0, 5], up: [0, 1, 0] });
    s = run(s, removeStepOps(s, 'a', 't2'));
    expect(order(s)).toEqual(['t1', 't3']);
    expect(s.nodes.t2).toBeUndefined();
    close(forward(matrix(s)), [0, 0, 1]);
  });

  it('removing the last step leaves nothing behind and the object as it was', () => {
    const start = cube(buildDefaultDagState(), 'a', [1, 2, 3]);
    let s = add(start, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    s = run(s, setInfluenceOps(s, 'a', 't1', 0.5));
    s = run(s, removeStepOps(s, 'a', 't1'));
    expect(Object.keys(s.nodes).sort()).toEqual(Object.keys(start.nodes).sort());
    expect(readChain(s, 'a')).toEqual({ own: null, steps: [] });
    close(position(matrix(s)), [1, 2, 3]);
  });

  it('refuses to edit a chain wired into another shape, and says so with null', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = run(s, [
      { type: 'addNode', nodeId: 'm', nodeType: 'MultiplyTransforms', params: {} },
      {
        type: 'connect',
        from: { node: 'm', socket: 'out' },
        to: { node: 'a', socket: 'constraints' },
      },
    ]);
    expect(readChain(s, 'a')).toBeNull();
    expect(addStepOps(s, 'a', 't', 'TrackTo', {})).toBeNull();
  });

  it('a step and its blend reading different things is not edited', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    s = run(s, [
      { type: 'addNode', nodeId: 'o2', nodeType: 'OwnWorld', params: { object: 'a' } },
      { type: 'connect', from: { node: 'o2', socket: 'world' }, to: { node: 'fp', socket: 'in' } },
    ]);
    expect(readChain(s, 'a')).toBeNull();
  });

  it('a chain naming another object at the bottom is not edited', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [1, 0, 0]), 'b', [2, 0, 0]);
    s = run(s, [
      { type: 'addNode', nodeId: 'o', nodeType: 'OwnWorld', params: { object: 'b' } },
      {
        type: 'connect',
        from: { node: 'o', socket: 'world' },
        to: { node: 'a', socket: 'constraints' },
      },
    ]);
    expect(readChain(s, 'a')).toBeNull();
  });
});

describe('influence', () => {
  it('at 1 it adds nothing', () => {
    let s = cube(buildDefaultDagState(), 'a', [1, 0, 0]);
    s = add(s, 't1', 'TrackTo', { aimPoint: [5, 0, 0], up: [0, 1, 0] });
    expect(setInfluenceOps(s, 'a', 't1', 1)).toEqual([]);
    expect(influenceOf(s, 'a', 't1')).toEqual({ kind: 'none' });
  });

  it("at 0.5, Blender 5.1.1's row: a Follow Path half way, at (-2, 7, 0)", () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    close(position(matrix(s)), [-2, 7, 0]);
  });

  it('at 0 the object is where it was, at 1 where the step puts it', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    const full = position(matrix(s));
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0));
    close(position(matrix(s)), [0, 4, 0]);
    s = run(s, setInfluenceOps(s, 'a', 'fp', 1));
    close(position(matrix(s)), full);
  });

  it('one number feeds all three parts, and a second write changes that number only', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    const nodes = Object.keys(s.nodes).length;
    const ops = setInfluenceOps(s, 'a', 'fp', 0.25);
    expect(ops).toHaveLength(1);
    s = run(s, ops);
    expect(Object.keys(s.nodes)).toHaveLength(nodes);
    const held = influenceOf(s, 'a', 'fp');
    expect(held).toMatchObject({ kind: 'value' });
    expect((s.nodes[(held as { nodeId: string }).nodeId].params as { value: number }).value).toBe(
      0.25,
    );
  });

  it('a key on the one number moves the whole blend', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    const { nodeId } = influenceOf(s, 'a', 'fp') as { nodeId: string };
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'k',
        nodeType: 'KeyframeChannelNumber',
        params: {
          target: nodeId,
          paramPath: 'value',
          keyframes: [
            { time: 0, value: 0 },
            { time: 1, value: 0.5 },
          ],
        },
      },
    ]);
    close(position(matrix(s, 0)), [0, 4, 0]);
    close(position(matrix(s, 1)), [-2, 7, 0]);
  });

  it('a blended step moves and comes off whole, and the step above reads through it', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    s = add(s, 'tt', 'TrackTo', { aimPoint: [-2, 17, 0], up: [0, 0, 1] });
    expect(order(s)).toEqual(['fp', 'tt']);
    close(position(matrix(s)), [-2, 7, 0]);
    close(forward(matrix(s)), [0, 1, 0]);

    s = run(s, moveStepOps(s, 'a', 'fp', 1));
    expect(order(s)).toEqual(['tt', 'fp']);
    expect(readChain(s, 'a')!.steps[1].blend).not.toBeNull();

    const nodes = Object.keys(s.nodes).length;
    s = run(s, removeStepOps(s, 'a', 'fp'));
    expect(order(s)).toEqual(['tt']);
    expect(Object.keys(s.nodes)).toHaveLength(nodes - 9);
  });

  it('taking off a step with a keyed influence takes the key too', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    const { nodeId } = influenceOf(s, 'a', 'fp') as { nodeId: string };
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'k',
        nodeType: 'KeyframeChannelNumber',
        params: { target: nodeId, paramPath: 'value', keyframes: [{ time: 0, value: 0 }] },
      },
    ]);
    s = run(s, removeStepOps(s, 'a', 'fp'));
    expect(s.nodes.k).toBeUndefined();
  });

  it('a number wired over the factors belongs to that wire: the row reads it, and does not write', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    s = run(s, [
      { type: 'addNode', nodeId: 'drive', nodeType: 'Clamp', params: { min: 0.5, max: 0.5 } },
      ...['location', 'rotation', 'stretch'].map((m) => ({
        type: 'connect',
        from: { node: 'drive', socket: 'out' },
        to: { node: `fp_influence_${m}`, socket: 'factor' },
      })),
    ]);
    expect(influenceOf(s, 'a', 'fp')).toEqual({
      kind: 'wired',
      from: { node: 'drive', socket: 'out' },
    });
    expect(setInfluenceOps(s, 'a', 'fp', 0.2)).toBeNull();
    close(position(matrix(s)), [-2, 7, 0]);
  });

  it('factors from different sources read as wired with no single source', () => {
    let s = withCurve(cube(buildDefaultDagState(), 'a', [0, 4, 0]));
    s = follow(s, 'fp');
    s = run(s, setInfluenceOps(s, 'a', 'fp', 0.5));
    s = run(s, [
      { type: 'addNode', nodeId: 'drive', nodeType: 'Clamp', params: { min: 0.5, max: 0.5 } },
      {
        type: 'connect',
        from: { node: 'drive', socket: 'out' },
        to: { node: 'fp_influence_location', socket: 'factor' },
      },
    ]);
    expect(influenceOf(s, 'a', 'fp')).toEqual({ kind: 'wired', from: null });
  });
});
