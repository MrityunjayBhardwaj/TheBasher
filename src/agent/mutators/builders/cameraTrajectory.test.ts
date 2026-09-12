// #774 — a named shot arrives wired and aimed, and a second request re-points it.
//
// The properties here are the ones the A3 audit and trial said decide whether this is a
// shot or a spline. Each has its LOSING alternative present, so no constant answer
// satisfies the file.

import { describe, expect, it } from 'vitest';
import { cameraTrajectoryMutator } from './cameraTrajectory';
import { applyOp } from '../../../core/dag/ops';
import { buildDefaultDagState } from '../../../core/project/default';
import { registerAllNodes } from '../../../nodes/registerAll';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

type AddNodeOp = {
  type: 'addNode';
  nodeId: string;
  nodeType: string;
  params: Record<string, unknown>;
};
type ConnectOp = {
  type: 'connect';
  from: { node: string; socket: string };
  to: { node: string; socket: string };
};
type SetParamOp = { type: 'setParam'; nodeId: string; paramPath: string; value: unknown };

const PATH: [number, number, number][] = [
  [4, 2, 3],
  [0, 2, 5],
  [-4, 2, 3],
];

/** The default project: a camera (split Object + CameraData), a light, a cube, a Scene. */
function scene(): DagState {
  registerAllNodes();
  return buildDefaultDagState();
}

function cameraId(state: DagState): string {
  const id = Object.keys(state.nodes).find(
    (k) =>
      state.nodes[k].type === 'Object' &&
      (state.nodes[k].params as { name?: string }).name?.toLowerCase().includes('camera'),
  );
  return id ?? 'n_camera';
}

function run(state: DagState, spec: Record<string, unknown>): Op[] {
  const parsed = cameraTrajectoryMutator.spec.parse(spec);
  const pre = cameraTrajectoryMutator.preconditions(parsed, {} as never, state);
  expect(pre.ok, `preconditions refused: ${pre.ok ? '' : pre.reason}`).toBe(true);
  return cameraTrajectoryMutator.build(parsed, {} as never, state);
}

function apply(state: DagState, ops: Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('#774 — a prompt becomes a wired, aimed camera trajectory', () => {
  it('mints the path, wires it into the scene, and puts BOTH bands on the camera', () => {
    const s0 = scene();
    const cam = cameraId(s0);
    const ops = run(s0, { cameraId: cam, subjectId: 'n_box', points: PATH, name: 'arc' });
    const s1 = apply(s0, ops);

    const added = ops.filter((o): o is AddNodeOp => o.type === 'addNode');
    const byType = (t: string) => added.find((o) => o.nodeType === t);
    expect(byType('CurveData'), 'no curve was minted').toBeDefined();
    expect(byType('Object'), 'the curve has no Object to pose it').toBeDefined();
    expect(byType('FollowPath'), 'the camera was given no path to travel').toBeDefined();
    expect(
      byType('TrackTo'),
      'the camera was given nothing to aim at — that is a spline, not a shot',
    ).toBeDefined();

    // The curve is IN THE SCENE, which is what makes its points draggable — and
    // dragging a point is the whole discriminating observation of this phase.
    const sceneNode = s1.outputs.scene!.node;
    const intoScene = ops.find(
      (o): o is ConnectOp =>
        o.type === 'connect' &&
        o.to.node === sceneNode &&
        o.to.socket === 'children' &&
        o.from.node === byType('Object')!.nodeId,
    );
    expect(
      intoScene,
      'the path is not wired into the scene, so nobody can see or grab it',
    ).toBeDefined();

    // Both constraints name the CAMERA as their target, and the follow names the curve.
    expect((byType('FollowPath')!.params as { target: string }).target).toBe(cam);
    expect((byType('FollowPath')!.params as { curve: string }).curve).toBe(
      byType('Object')!.nodeId,
    );
    expect((byType('TrackTo')!.params as { target: string }).target).toBe(cam);
    expect((byType('TrackTo')!.params as { aimNode: string }).aimNode).toBe('n_box');
  });

  it('puts the points in verbatim and the curve Object at the ORIGIN, so world stays world', () => {
    // The doubling this prevents: CurveData.points are LOCAL to the owning Object,
    // and a model told "the subject is at [3,0,-4]" emits world points. If the
    // Object were placed anywhere else the two readings would compose.
    const s0 = scene();
    const ops = run(s0, { cameraId: cameraId(s0), subjectId: 'n_box', points: PATH });
    const added = ops.filter((o): o is AddNodeOp => o.type === 'addNode');
    const data = added.find((o) => o.nodeType === 'CurveData')!;
    const obj = added.find((o) => o.nodeType === 'Object')!;

    expect((data.params.points as { co: number[] }[]).map((p) => p.co)).toEqual(PATH);
    expect(obj.params.position, 'the curve Object must sit at the origin').toEqual([0, 0, 0]);
    expect(obj.params.rotation).toEqual([0, 0, 0]);
    expect(obj.params.scale).toEqual([1, 1, 1]);
    // Every point carries a stable id, or a later drag/undo cannot refer to one.
    const ids = (data.params.points as { id: string }[]).map((p) => p.id);
    expect(new Set(ids).size, 'point ids must be unique').toBe(PATH.length);
  });

  it('a SECOND shot re-points the constraints it already has instead of stacking a rival', () => {
    // Two Follow-Paths on one camera both write the POSITION band; the fold is
    // last-writer-wins by `order` and the loser still renders in the panel — a
    // displayed-≠-rendered split authored by a road that looked like it worked.
    const s0 = scene();
    const cam = cameraId(s0);
    const s1 = apply(s0, run(s0, { cameraId: cam, subjectId: 'n_box', points: PATH, name: 'arc' }));

    const second: [number, number, number][] = [
      [0, 1, 8],
      [0, 1, 2],
    ];
    const ops2 = run(s1, { cameraId: cam, subjectId: 'n_box', points: second, name: 'dolly' });
    const s2 = apply(s1, ops2);

    const count = (st: DagState, t: string) =>
      Object.values(st.nodes).filter((n) => n.type === t).length;
    expect(count(s2, 'FollowPath'), 'a second call stacked a rival Follow-Path').toBe(1);
    expect(count(s2, 'TrackTo'), 'a second call stacked a rival Track-To').toBe(1);
    // ...and it is the NEW curve the surviving constraint follows.
    const newObj = ops2
      .filter((o): o is AddNodeOp => o.type === 'addNode')
      .find((o) => o.nodeType === 'Object')!;
    const follow = Object.values(s2.nodes).find((n) => n.type === 'FollowPath')!;
    expect((follow.params as { curve: string }).curve).toBe(newObj.nodeId);
    // The superseded curve is still there — visible and deletable, not removed
    // underneath a director who may want it back.
    expect(count(s2, 'CurveData'), 'the first path was destroyed rather than superseded').toBe(2);
    // The re-point is a setParam, not an addNode: this is the mechanism, asserted.
    expect(
      ops2.some((o): o is SetParamOp => o.type === 'setParam' && o.paramPath === 'curve'),
    ).toBe(true);
  });

  it('refuses a camera with nothing to aim at, and a subject that is the camera', () => {
    const s0 = scene();
    const cam = cameraId(s0);
    const check = (spec: Record<string, unknown>) => {
      const parsed = cameraTrajectoryMutator.spec.parse(spec);
      return cameraTrajectoryMutator.preconditions(parsed, {} as never, s0);
    };
    // The unrepresentable state: a camera riding a path aiming nowhere.
    const noAim = check({ cameraId: cam, points: PATH });
    expect(noAim.ok).toBe(false);
    expect(noAim.ok === false && noAim.reason).toMatch(/aim/i);
    // Both given: Track-To reads aimNode and ignores aimPoint, so accepting both
    // would silently discard one.
    const both = check({ cameraId: cam, points: PATH, subjectId: 'n_box', aimPoint: [0, 0, 0] });
    expect(both.ok).toBe(false);
    // Aiming at itself derives a rotation from its own world.
    const selfAim = check({ cameraId: cam, points: PATH, subjectId: cam });
    expect(selfAim.ok).toBe(false);
    // A missing subject is named rather than silently dropped.
    expect(check({ cameraId: cam, points: PATH, subjectId: 'nope' }).ok).toBe(false);
    // ...and the LOSING alternative: the well-formed spec is accepted, or every
    // row above would pass against a mutator that refuses everything.
    expect(check({ cameraId: cam, points: PATH, subjectId: 'n_box' }).ok).toBe(true);
    expect(check({ cameraId: cam, points: PATH, aimPoint: [0, 1, 0] }).ok).toBe(true);
  });

  it('refuses a target that is not a camera, by possession rather than by type', () => {
    const s0 = scene();
    // `n_box` is an Object, exactly as a split camera is — so a `node.type` test
    // could not tell them apart, and `isCameraNode` reaches for the CameraData.
    const parsed = cameraTrajectoryMutator.spec.parse({
      cameraId: 'n_box',
      subjectId: 'n_light',
      points: PATH,
    });
    const res = cameraTrajectoryMutator.preconditions(parsed, {} as never, s0);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/CameraData|camera/i);
  });

  it('lands the constraints on TOP of a stack the camera already carries', () => {
    const s0 = scene();
    const cam = cameraId(s0);
    // An unrelated constraint already on the camera, at order 0.
    const s1 = apply(s0, [
      {
        type: 'addNode',
        nodeId: 'existing_aim',
        nodeType: 'TrackTo',
        params: { target: cam, aimNode: 'n_box', order: 0 },
      } as Op,
    ]);
    const ops = run(s1, { cameraId: cam, aimPoint: [0, 0, 0], points: PATH });
    const follow = ops
      .filter((o): o is AddNodeOp => o.type === 'addNode')
      .find((o) => o.nodeType === 'FollowPath')!;
    expect(
      (follow.params as { order: number }).order,
      'the new path took a slot already in use',
    ).toBeGreaterThan(0);
    // ...and the Track-To already there was RE-POINTED rather than duplicated.
    expect(
      ops.filter((o) => o.type === 'addNode' && (o as AddNodeOp).nodeType === 'TrackTo'),
    ).toHaveLength(0);
  });
});
