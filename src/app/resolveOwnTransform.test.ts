// #1776 — an object's OWN transform, the one Insert Keyframe keys: its keys, drivers and held
// edits, without what its constraints derive. Blender 5.1.1's I keys a constrained object's own
// location/rotation/scale; only opt-in visual keying records a constraint's result.
//
// Each case puts a constraint on the object that moves the drawn transform away from the own
// one, so a read that returned the drawn value is told apart.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { resolveEvaluatedTransform, resolveOwnTransform } from './resolveEvaluatedTransform';

type Vec3 = [number, number, number];
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const OWN_ROT: Vec3 = [10, 20, 30];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const op = (s: DagState, o: Parameters<typeof applyOp>[1]) => applyOp(s, o).next;

function withBoxRotation(rotation: Vec3): DagState {
  return op(buildDefaultDagState(), {
    type: 'setParam',
    nodeId: 'n_box',
    paramPath: 'rotation',
    value: rotation,
  });
}

function addTrackTo(s: DagState, target: string): DagState {
  return op(s, {
    type: 'addNode',
    nodeId: 'tt',
    nodeType: 'TrackTo',
    params: { target, aimPoint: [3, -2, -5], aimNode: '' },
  });
}

function addFollowedBox(s: DagState): DagState {
  s = op(s, {
    type: 'addNode',
    nodeId: 'crv_data',
    nodeType: 'CurveData',
    params: {
      points: withIds([
        [0, 0, 0],
        [12, 0, 0],
      ]),
      closed: false,
      resolution: 32,
    },
  });
  s = op(s, { type: 'addNode', nodeId: 'crv', nodeType: 'Object', params: {} });
  s = op(s, {
    type: 'connect',
    from: { node: 'crv_data', socket: 'out' },
    to: { node: 'crv', socket: 'data' },
  });
  s = op(s, {
    type: 'connect',
    from: { node: 'crv', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  return op(s, {
    type: 'addNode',
    nodeId: 'fp',
    nodeType: 'FollowPath',
    params: { name: 'fp', target: 'n_box', curve: 'crv', evalTime: 1, offset: 0 },
  });
}

const close = (got: readonly number[] | null | undefined, want: readonly number[]) => {
  expect(got).not.toBeNull();
  want.forEach((v, i) => expect(got![i]).toBeCloseTo(v, 5));
};

describe('resolveOwnTransform (#1776)', () => {
  it('a Track-To aims a cube: the own read keeps its rotation; the drawn read is the aim', () => {
    const s = addTrackTo(withBoxRotation(OWN_ROT), 'n_box');
    const drawn = resolveEvaluatedTransform(s, 'n_box', ctx)!;
    const own = resolveOwnTransform(s, 'n_box', ctx)!;
    // The aim moved the drawn rotation away from the own one (else the case proves nothing).
    expect(Math.hypot(...drawn.rotation!.map((v, i) => v - OWN_ROT[i]))).toBeGreaterThan(1);
    close(own.rotation, OWN_ROT);
    close(own.position, drawn.position);
  });

  it('a Follow-Path moves a cube: the own read keeps its position; the drawn read is on the path', () => {
    const s = addFollowedBox(buildDefaultDagState());
    const drawn = resolveEvaluatedTransform(s, 'n_box', ctx)!;
    const own = resolveOwnTransform(s, 'n_box', ctx)!;
    close(drawn.position, [12, 0, 0]);
    close(own.position, [0, 0, 0]);
  });

  it('in quaternion mode, the own quaternion is the node’s, not the aim’s', () => {
    const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    let s = addTrackTo(withBoxRotation(OWN_ROT), 'n_box');
    s = op(s, {
      type: 'setParam',
      nodeId: 'n_box',
      paramPath: 'rotationMode',
      value: 'quaternion',
    });
    s = op(s, { type: 'setParam', nodeId: 'n_box', paramPath: 'quaternion', value: q });
    const drawn = resolveEvaluatedTransform(s, 'n_box', ctx)!;
    const own = resolveOwnTransform(s, 'n_box', ctx)!;
    const dot = (a: readonly number[], b: readonly number[]) =>
      Math.abs(a.reduce((acc, v, i) => acc + v * b[i], 0));
    expect(dot(drawn.quaternion!, q)).toBeLessThan(0.999);
    expect(dot(own.quaternion!, q)).toBeCloseTo(1, 6);
  });

  it('a camera a Track-To aims: the own read is its own rotation, the drawn read where it looks', () => {
    let s = op(buildDefaultDagState(), {
      type: 'setParam',
      nodeId: 'n_camera',
      paramPath: 'rotation',
      value: OWN_ROT,
    });
    s = addTrackTo(s, 'n_camera');
    const drawn = resolveEvaluatedTransform(s, 'n_camera', ctx)!;
    const own = resolveOwnTransform(s, 'n_camera', ctx)!;
    expect(Math.hypot(...drawn.rotation!.map((v, i) => v - OWN_ROT[i]))).toBeGreaterThan(1);
    close(own.rotation, OWN_ROT);
  });

  it('with no constraint the two reads agree', () => {
    const s = withBoxRotation(OWN_ROT);
    expect(resolveOwnTransform(s, 'n_box', ctx)).toEqual(
      resolveEvaluatedTransform(s, 'n_box', ctx),
    );
  });
});
