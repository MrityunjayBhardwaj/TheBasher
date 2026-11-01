// #1759 — a Track-To gains a roll about its aim axis and a space for its fixed aim point.
// Defaults (roll 0, world) leave every aim as it was; the rest of the suite holds that, and the
// first case below pins that the absent fields read as the defaults.

import { beforeAll, describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveConstraintRotation } from './nodeConstraints';
import { resolveActiveCameraPoseAt } from './activeCamera';

beforeAll(() => registerAllNodes());

type V3 = [number, number, number];
const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const quat = (deg: V3) =>
  new Quaternion().setFromEuler(new Euler(...(deg.map((d) => (d * Math.PI) / 180) as V3), 'XYZ'));
const apply = (q: Quaternion, v: V3): V3 => new Vector3(...v).applyQuaternion(q).toArray() as V3;
const expectVec = (got: V3, want: V3, label: string) =>
  got.forEach((x, i) => expect(x, `${label}[${i}]`).toBeCloseTo(want[i], 6));

function run(s: DagState, ops: object[]): DagState {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
}

/** The default box with a Track-To at `aimPoint` (top level, box at the origin). */
const boxTracked = (track: Record<string, unknown>) =>
  run(buildDefaultDagState(), [
    { type: 'addNode', nodeId: 'tt', nodeType: 'TrackTo', params: { target: 'n_box', ...track } },
  ]);

/** A box Object inside a Group at [5, 1, 0] turned 90° about Y, at the group's origin. */
function boxInTurnedGroup(track: Record<string, unknown>): DagState {
  let s = run(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'grp',
      nodeType: 'Group',
      params: { position: [5, 1, 0], rotation: [0, 90, 0] },
    },
    {
      type: 'connect',
      from: { node: 'grp', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]);
  s = makeSplitCube(s, {
    objectId: 'obj',
    position: [0, 0, 0],
    connectTo: { node: 'grp', socket: 'children' },
  }).state;
  return run(s, [
    { type: 'addNode', nodeId: 'tt', nodeType: 'TrackTo', params: { target: 'obj', ...track } },
  ]);
}

const GROUP_Q = quat([0, 90, 0]);
/** The box's world forward (-Z) and up (+Y): its local rotation under the group's. */
const worldAxes = (local: V3, parent = new Quaternion()) => {
  const q = parent.clone().multiply(quat(local));
  return { fwd: apply(q, [0, 0, -1]), up: apply(q, [0, 1, 0]) };
};

describe('#1759 — Track-To roll', () => {
  it('absent roll and space read as 0 and world: the aim is unchanged', () => {
    const plain = resolveConstraintRotation(boxTracked({ aimPoint: [10, 0, 0] }), 'n_box', CTX);
    const explicit = resolveConstraintRotation(
      boxTracked({ aimPoint: [10, 0, 0], roll: 0, aimSpace: 'world' }),
      'n_box',
      CTX,
    );
    expect(explicit).toEqual(plain);
  });

  it('rolls an object about its aim axis: the forward stays, the up turns', () => {
    const r = resolveConstraintRotation(
      boxTracked({ aimPoint: [10, 0, 0], roll: 30 }),
      'n_box',
      CTX,
    )!;
    const { fwd, up } = worldAxes(r);
    expectVec(fwd, [1, 0, 0], 'forward');
    // +Y turned 30° about +X (the aim axis), the camera's roll convention.
    expectVec(up, [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], 'up');
  });

  it('adds to a camera’s own roll', () => {
    let s = makeSplitCamera(buildDefaultDagState(), {
      objectId: 'cam',
      position: [0, 0, 5],
      lens: { lookAt: [0, 0, 0], roll: 10 },
    }).state;
    s = run(s, [
      {
        type: 'connect',
        from: { node: 'cam', socket: 'out' },
        to: { node: 'n_scene', socket: 'camera' },
        replace: true,
      },
    ]);
    expect(resolveActiveCameraPoseAt(s, 0).roll).toBe(10);
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'tt',
        nodeType: 'TrackTo',
        params: { target: 'cam', aimPoint: [1, 0, 0], roll: 20 },
      },
    ]);
    expect(resolveActiveCameraPoseAt(s, 0).roll).toBe(30);
  });
});

describe('#1759 — Track-To aim-point space', () => {
  it('world: the point is where it is typed, wherever the object hangs', () => {
    const r = resolveConstraintRotation(boxInTurnedGroup({ aimPoint: [0, 0, -1] }), 'obj', CTX)!;
    // Box at world [5, 1, 0] aiming at world [0, 0, -1].
    const want = new Vector3(-5, -1, -1).normalize().toArray() as V3;
    expectVec(worldAxes(r, GROUP_Q).fwd, want, 'forward');
  });

  it('parent: the point rides with the group — local [0, 0, -1] is world [4, 1, 0]', () => {
    const r = resolveConstraintRotation(
      boxInTurnedGroup({ aimPoint: [0, 0, -1], aimSpace: 'parent' }),
      'obj',
      CTX,
    )!;
    expectVec(worldAxes(r, GROUP_Q).fwd, [-1, 0, 0], 'forward');
  });

  it('parent, on a camera in a turned group: the drawn camera looks along the group’s -Z', () => {
    let s = buildDefaultDagState();
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: [5, 1, 0], rotation: [0, 90, 0] },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    s = makeSplitCamera(s, {
      objectId: 'cam',
      position: [0, 0, 0],
      lens: { lookAt: [0, 0, -1] },
    }).state;
    s = run(s, [
      {
        type: 'connect',
        from: { node: 'cam', socket: 'out' },
        to: { node: 'grp', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'cam', socket: 'out' },
        to: { node: 'n_scene', socket: 'camera' },
        replace: true,
      },
      {
        type: 'addNode',
        nodeId: 'tt',
        nodeType: 'TrackTo',
        params: { target: 'cam', aimPoint: [0, 0, -3], aimSpace: 'parent' },
      },
    ]);
    const pose = resolveActiveCameraPoseAt(s, 0);
    const fwd = new Vector3(...pose.lookAt)
      .sub(new Vector3(...pose.position))
      .normalize()
      .toArray() as V3;
    expectVec(fwd, [-1, 0, 0], 'camera forward');
  });
});
