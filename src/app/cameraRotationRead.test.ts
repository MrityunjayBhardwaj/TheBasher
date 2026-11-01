// #1753 — a camera's rotation, read by a driver or any reader of the evaluated transform, is the
// orientation the camera is drawn with.
//
// A camera is oriented by its aim: position → lookAt with roll (`cameraOrientationQuat`), the
// lookAt on its lens data or taken over by a Track-To. The render reads no rotation off the
// camera Object. The evaluated transform still returned the Object's typed rotation, so a driver
// reading a camera's `ry` saw a value the camera was never drawn at.

import { beforeAll, describe, expect, it } from 'vitest';
import { Euler } from 'three';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';
import { cameraOrientationQuat } from './cameraOrientation';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { linkedDataNodeId } from './resolveDataParamOwner';
import { sceneClockOf } from './sceneClock';
import { clockedCtx } from './subjectClock';
import { readTransformChannelAt } from './transformChannelSource';

beforeAll(() => registerAllNodes());

const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};
const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});

/** The default camera at (0, 0, 5) with a typed rotation the render never reads, aimed by its
 *  lens data, with a roll. */
function camera(lookAt: [number, number, number], roll = 0): { s: DagState; data: string } {
  const s0 = buildDefaultDagState();
  const data = linkedDataNodeId(s0, 'n_camera')!;
  const s = run(s0, [
    set('n_camera', 'position', [0, 0, 5]),
    set('n_camera', 'rotation', [10, 20, 30]),
    set(data, 'lookAt', lookAt),
    set(data, 'roll', roll),
  ]);
  return { s, data };
}

/** XYZ degrees of the orientation the render draws the camera with at playhead `film`. */
function drawnDeg(s: DagState, film: number): [number, number, number] {
  const pose = resolveCameraPoseAt(s, 'n_camera', film);
  const e = new Euler().setFromQuaternion(
    cameraOrientationQuat(pose.position, pose.lookAt, pose.roll),
    'XYZ',
  );
  return [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI) as [number, number, number];
}
const ctxAt = (s: DagState, film: number) => clockedCtx(sceneClockOf(s).sceneAt(film), film);
const channels = ['rx', 'ry', 'rz'] as const;

describe('#1753 — a camera reads back the orientation it is drawn with', () => {
  it('aimed down +X, the rotation is the aim, not the typed rotation', () => {
    const { s } = camera([5, 0, 5]);
    const drawn = drawnDeg(s, 0);
    expect(drawn[1], 'the fixture yaws the camera').toBeCloseTo(-90, 4);
    const xf = resolveEvaluatedTransform(s, 'n_camera', ctxAt(s, 0))!;
    xf.rotation!.forEach((v, i) => expect(v, `rotation[${i}]`).toBeCloseTo(drawn[i], 4));
    channels.forEach((ch, i) =>
      expect(readTransformChannelAt(s, { node: 'n_camera', channel: ch }, ctxAt(s, 0))).toBeCloseTo(
        drawn[i],
        4,
      ),
    );
  });

  it('a roll banks the rotation as it banks the drawn camera', () => {
    const { s } = camera([0, 3, 0], 25);
    const drawn = drawnDeg(s, 0);
    const xf = resolveEvaluatedTransform(s, 'n_camera', ctxAt(s, 0))!;
    xf.rotation!.forEach((v, i) => expect(v, `rotation[${i}]`).toBeCloseTo(drawn[i], 4));
  });

  it('a keyed aim with the scene slowed reads the moment drawn at the playhead', () => {
    const { s: s0, data } = camera([0, 0, 0]);
    const s = run(s0, [
      set('n_scene', 'timeSpeed', 0.5),
      {
        type: 'addNode',
        nodeId: 'aim_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'lookAt',
          target: data,
          paramPath: 'lookAt',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [10, 0, 5], easing: 'linear' },
          ],
        },
      },
    ]);
    // Playhead 2 s: the camera (on the playhead) aims at the last key; the scene is at 1 s.
    const drawn = drawnDeg(s, 2);
    expect(drawn[1], 'the aim has turned all the way').toBeCloseTo(-90, 4);
    expect(readTransformChannelAt(s, { node: 'n_camera', channel: 'ry' }, ctxAt(s, 2))).toBeCloseTo(
      drawn[1],
      4,
    );
  });

  it('a Track-To takes the aim over, in the read as on screen', () => {
    const { s: s0 } = camera([0, 0, 0]);
    const s = run(s0, [
      set('n_box', 'position', [-5, 0, 5]),
      {
        type: 'addNode',
        nodeId: 'cam_track',
        nodeType: 'TrackTo',
        params: { target: 'n_camera', aimNode: 'n_box' },
      },
    ]);
    const drawn = drawnDeg(s, 0);
    expect(drawn[1], 'the camera turns to the box').toBeCloseTo(90, 3);
    const xf = resolveEvaluatedTransform(s, 'n_camera', ctxAt(s, 0))!;
    xf.rotation!.forEach((v, i) => expect(v, `rotation[${i}]`).toBeCloseTo(drawn[i], 4));
  });
});
