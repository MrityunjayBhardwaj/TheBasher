// #1791 — Follow Path keeps the object's own position as an offset from the path, as Blender
// 5.1.1 does (`followpath_evaluate`, constraint.cc: owner = curveWorld · T(point) · owner). On the
// chain (#1811) the step draws `point + L · below`, where L is the curve object's turn and scale.
// The cases are the ones the Follow Path offset PR measured in Blender 5.1.1: an object following a
// straight path from the origin to (10, 0, 0), at its end unless said otherwise. Each is read off
// the chain's drawn world, what the viewport draws.

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluate, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../test-utils/committedApplyOp';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

type Vec3 = [number, number, number];
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};

interface Rig {
  own?: Vec3;
  curve?: { position?: Vec3; rotation?: Vec3; scale?: Vec3 };
  /** The follower hangs from a Group at this position (turned by `parentRotation`). */
  parentAt?: Vec3;
  parentRotation?: Vec3;
  evalTime?: number;
}

/** A cube `f` at its own position `own`, following curve object `crv` (origin → (10, 0, 0)). */
function rig({ own = [0, 4, 0], curve = {}, parentAt, parentRotation, evalTime = 1 }: Rig) {
  let s = makeSplitCube(buildDefaultDagState(), {
    objectId: 'f',
    position: own,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
  if (parentAt) {
    // #1824 — a child names its parent through its own parent input.
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: parentAt, rotation: parentRotation ?? [0, 0, 0] },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'world' },
        to: { node: 'f', socket: 'parent' },
      },
    ]);
  }
  return run(s, [
    {
      type: 'addNode',
      nodeId: 'crv_data',
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
    {
      type: 'addNode',
      nodeId: 'crv',
      nodeType: 'Object',
      params: {
        position: curve.position ?? [0, 0, 0],
        rotation: curve.rotation ?? [0, 0, 0],
        scale: curve.scale ?? [1, 1, 1],
      },
    },
    {
      type: 'connect',
      from: { node: 'crv_data', socket: 'out' },
      to: { node: 'crv', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'crv', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { name: 'fp', target: 'f', curve: 'crv', evalTime, offset: 0 },
    },
  ]);
}

const close = (got: readonly number[] | null | undefined, want: readonly number[]) => {
  expect(got).not.toBeNull();
  want.forEach((v, i) => expect(got![i], `[${i}] of ${got}`).toBeCloseTo(v, 6));
};
/** The drawn world position, off the chain's end. */
const drawn = (s: DagState): number[] => {
  const m = evaluate(s, 'f', { socket: 'world', ctx }).value as number[];
  return [m[12], m[13], m[14]];
};

describe('Follow Path keeps the own position as an offset (#1791, Blender 5.1.1)', () => {
  it('the premise: the step is on the cube’s chain', () => {
    const s = rig({});
    expect(s.nodes.f.inputs.constraints).toBeDefined();
    expect(s.nodes.fp.inputs.in).toBeDefined();
  });

  it('own (0, 4, 0) at the end of the path: drawn at (10, 4, 0)', () => {
    const s = rig({});
    close(drawn(s), [10, 4, 0]);
    // The drawn transform (inspector, gizmo) is the same point.
    close(resolveEvaluatedTransform(s, 'f', ctx)!.position, [10, 4, 0]);
  });

  it('own at the origin: on the path, (10, 0, 0)', () => {
    close(drawn(rig({ own: [0, 0, 0] })), [10, 0, 0]);
  });

  it('halfway along: (5, 4, 0)', () => {
    close(drawn(rig({ evalTime: 0.5 })), [5, 4, 0]);
  });

  it('the curve object moved to (5, 0, 3): (15, 4, 3)', () => {
    close(drawn(rig({ curve: { position: [5, 0, 3] } })), [15, 4, 3]);
  });

  it('the curve object turned 90° about Z: the offset turns with it, (−4, 10, 0)', () => {
    close(drawn(rig({ curve: { rotation: [0, 0, 90] } })), [-4, 10, 0]);
  });

  it('the curve object scaled 2: the offset scales with it, (20, 8, 0)', () => {
    close(drawn(rig({ curve: { scale: [2, 2, 2] } })), [20, 8, 0]);
  });

  it('the curve moved, turned and scaled together: (−3, 20, 3)', () => {
    close(
      drawn(rig({ curve: { position: [5, 0, 3], rotation: [0, 0, 90], scale: [2, 2, 2] } })),
      [-3, 20, 3],
    );
  });

  // #1812 (decided) — a parent's position adds to the path, as the parent world feeds the chain.
  it('parented under a Group at (0, 0, 5): the offset is the world position, (10, 4, 5)', () => {
    const s = rig({ parentAt: [0, 0, 5] });
    close(drawn(s), [10, 4, 5]);
  });

  it('parented under a Group turned 90° about Z at (0, 0, 5): (6, 0, 5)', () => {
    close(drawn(rig({ parentAt: [0, 0, 5], parentRotation: [0, 0, 90] })), [6, 0, 5]);
  });

  it('a muted Follow Path: the object stays at its own position', () => {
    const s = run(rig({}), [{ type: 'setParam', nodeId: 'fp', paramPath: 'mute', value: true }]);
    close(drawn(s), [0, 4, 0]);
    close(resolveEvaluatedTransform(s, 'f', ctx)!.position, [0, 4, 0]);
  });
});
