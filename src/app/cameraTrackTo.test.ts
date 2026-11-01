// #1766 — a camera inside a moving group, aimed by a Track-To, looks at what the Track-To names.
// The Track-To resolves to a WORLD point; the camera's lookAt is in its parent's space. Measured
// before the fix: a camera at world [5, 1, 0] (local origin, group moved there) tracking the world
// origin was drawn looking down -Z; with the group also turned 90°, down -X.

import { beforeAll, describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { resolveActiveCameraPoseAt } from './activeCamera';
import { cameraOrientationQuat } from './cameraOrientation';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { bindLookAtTargetOps } from './CameraLookAtTarget';
import { splitCameraDataId } from '../test-utils/splitCamera';

beforeAll(() => registerAllNodes());

type V3 = [number, number, number];
const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** A camera at local origin in a Group at `position`/`rotation`, active, Track-To'd at the
 *  world origin (or at a node, when `aimNode` is given). */
function nested(position: V3, rotation: V3, aimNode = ''): DagState {
  let s = buildDefaultDagState();
  const run = (op: object) => (s = applyOp(s, op as never).next);
  run({ type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: { position, rotation } });
  run({
    type: 'connect',
    from: { node: 'grp', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  s = makeSplitCamera(s, {
    objectId: 'cam',
    position: [0, 0, 0],
    lens: { lookAt: [0, 0, -1] },
  }).state;
  run({
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'grp', socket: 'children' },
  });
  run({
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'n_scene', socket: 'camera' },
    replace: true,
  });
  run({
    type: 'addNode',
    nodeId: 'track',
    nodeType: 'TrackTo',
    params: { target: 'cam', aimNode, aimPoint: [0, 0, 0] },
  });
  return s;
}

const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l) as V3;
};
const expectDir = (got: V3, want: V3) =>
  unit(got).forEach((x, i) => expect(x, `axis ${i}`).toBeCloseTo(unit(want)[i], 6));

const CASES: { name: string; position: V3; rotation: V3 }[] = [
  { name: 'a group at the origin (control)', position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'a moved group', position: [5, 1, 0], rotation: [0, 0, 0] },
  { name: 'a moved and turned group', position: [5, 1, 0], rotation: [0, 90, 0] },
];

describe('#1766 — a nested camera tracks in world space', () => {
  for (const c of CASES) {
    it(`the drawn camera looks at the world origin, in ${c.name}`, () => {
      const pose = resolveActiveCameraPoseAt(nested(c.position, c.rotation), 0);
      const fwd: V3 = [
        pose.lookAt[0] - pose.position[0],
        pose.lookAt[1] - pose.position[1],
        pose.lookAt[2] - pose.position[2],
      ];
      expectDir(fwd, [-pose.position[0], -pose.position[1], -pose.position[2]]);
    });
  }

  it('the rotation read is the drawn orientation, in the camera’s parent space', () => {
    const s = nested([5, 1, 0], [0, 90, 0]);
    const t = resolveEvaluatedTransform(s, 'cam', CTX)!;
    const local = new Quaternion().setFromEuler(
      new Euler(...(t.rotation!.map((d) => (d * Math.PI) / 180) as V3), 'XYZ'),
    );
    // World forward = group rotation · local forward. Group turned 90° about Y.
    const world = new Vector3(0, 0, -1)
      .applyQuaternion(local)
      .applyQuaternion(new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)));
    expectDir([world.x, world.y, world.z], [-5, -1, 0]);
  });

  it('clearing the target freezes the aim where it was: still at the world origin', () => {
    const s = nested([5, 1, 0], [0, 90, 0]);
    const { ops } = bindLookAtTargetOps(
      s,
      { nodeId: splitCameraDataId('cam'), poseNodeId: 'cam' },
      '',
      CTX,
    );
    let after = s;
    for (const op of ops) after = applyOp(after, op).next;
    expect(after.nodes.track, 'the Track-To is gone').toBeUndefined();
    const pose = resolveActiveCameraPoseAt(after, 0);
    const fwd: V3 = [
      pose.lookAt[0] - pose.position[0],
      pose.lookAt[1] - pose.position[1],
      pose.lookAt[2] - pose.position[2],
    ];
    expectDir(fwd, [-pose.position[0], -pose.position[1], -pose.position[2]]);
  });

  // #1759 — a Track-To's roll adds to the camera's: the read includes it, and a clear keeps it.
  it('the rotation read includes the Track-To’s roll', () => {
    const s = nested([0, 0, 0], [0, 0, 0]);
    const rolled = applyOp(s, {
      type: 'setParam',
      nodeId: 'track',
      paramPath: 'roll',
      value: 25,
    }).next;
    const pose = resolveActiveCameraPoseAt(rolled, 0);
    const t = resolveEvaluatedTransform(rolled, 'cam', CTX)!;
    const read = new Quaternion().setFromEuler(
      new Euler(...(t.rotation!.map((d) => (d * Math.PI) / 180) as V3), 'XYZ'),
    );
    const drawn = cameraOrientationQuat(pose.position, pose.lookAt, pose.roll);
    expect(Math.abs(read.dot(drawn))).toBeCloseTo(1, 6);
    expect(pose.roll).toBe(25);
  });

  it('clearing the target folds its roll into the lens roll, so the camera does not level out', () => {
    const s = applyOp(nested([5, 1, 0], [0, 90, 0]), {
      type: 'setParam',
      nodeId: 'track',
      paramPath: 'roll',
      value: 25,
    }).next;
    const before = resolveActiveCameraPoseAt(s, 0).roll;
    const { ops } = bindLookAtTargetOps(
      s,
      { nodeId: splitCameraDataId('cam'), poseNodeId: 'cam' },
      '',
      CTX,
    );
    let after = s;
    for (const op of ops) after = applyOp(after, op).next;
    expect(resolveActiveCameraPoseAt(after, 0).roll).toBeCloseTo(before, 6);
  });
});
