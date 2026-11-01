// #1753 — a param's evaluated read runs on the clock its node runs on, as the render does.
//
// `resolveEvaluatedParam` sampled every channel at the context's time, which every reader builds
// from scene time. A camera runs on the playhead (#1594), so with the scene slowed its keyed aim
// row read a different moment from the one drawn: aim row 1, camera aiming at 2.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { useTimeStore } from './stores/timeStore';

beforeAll(() => registerAllNodes());
const initial = useTimeStore.getState();
afterEach(() => useTimeStore.setState(initial, true));

const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};
const ramp = (id: string, target: string, paramPath: string, to: number[]): Op =>
  ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: paramPath,
      target,
      paramPath,
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 2, value: to, easing: 'linear' },
      ],
    },
  }) as Op;
/** The scene at half speed, aim and box keyed linearly 0 → 2 over 0–2 s. */
const slowed = () =>
  run(buildDefaultDagState(), [
    { type: 'setParam', nodeId: 'n_scene', paramPath: 'timeSpeed', value: 0.5 } as Op,
    ramp('aim', 'n_camera_data', 'lookAt', [2, 0, 0]),
    // #1760 — what turns a camera is its own rotation (V665): the drawn value these tests read.
    ramp('turn', 'n_camera', 'rotation', [0, 90, 0]),
    ramp('box', 'n_box', 'scale', [2, 2, 2]),
  ]);
type V3 = [number, number, number];
/** True when XYZ euler degrees `e` and quaternion `q` are one orientation. */
const sameTurn = (e: V3, q: readonly number[]): boolean => {
  const qe = new Quaternion().setFromEuler(
    new Euler(...(e.map((d) => (d * Math.PI) / 180) as V3), 'XYZ'),
  );
  return Math.abs(qe.x * q[0] + qe.y * q[1] + qe.z * q[2] + qe.w * q[3]) > 1 - 1e-9;
};
/** The playhead at 2 s, which is 1 s of scene time, as the time store holds it. */
const atPlayhead2 = { time: { frame: 60, seconds: 1, normalized: 0 } };

describe('#1753 — an evaluated param is read on its own node’s clock', () => {
  it('a camera’s keyed rotation reads the playhead’s moment, as the camera is drawn', () => {
    const s = slowed();
    useTimeStore.setState({ seconds: 1, filmSeconds: 2 } as never);
    const drawn = resolveCameraPoseAt(s, 'n_camera', 2).quaternion;
    // Playhead 2 s: turned the whole 90° (scene time would be halfway, 45°).
    expect(drawn[1]).toBeCloseTo(Math.SQRT1_2, 9);
    const row = resolveEvaluatedParam(s, 'n_camera', 'rotation', atPlayhead2)?.value as V3;
    expect(sameTurn(row, drawn)).toBe(true);
  });

  it('a camera’s keyed lens param (its look-at) reads the playhead’s moment too', () => {
    const s = slowed();
    useTimeStore.setState({ seconds: 1, filmSeconds: 2 } as never);
    const row = resolveEvaluatedParam(s, 'n_camera_data', 'lookAt', atPlayhead2)?.value as V3;
    expect(row[0]).toBeCloseTo(2, 6);
  });

  it('a node on the scene’s clock still reads scene time', () => {
    const s = slowed();
    useTimeStore.setState({ seconds: 1, filmSeconds: 2 } as never);
    expect(resolveEvaluatedParam(s, 'n_box', 'scale', atPlayhead2)?.value).toEqual([1, 1, 1]);
  });

  it('a context already on the playhead is not re-timed twice', () => {
    const s = slowed();
    const onFilm = { time: { frame: 120, seconds: 2, normalized: 0 }, scene: 1, film: 2 };
    expect(
      (resolveEvaluatedParam(s, 'n_camera_data', 'lookAt', onFilm)?.value as number[])[0],
    ).toBeCloseTo(2, 6);
  });
});

// #1753 item 2 — an aim animated by a strip pushed down onto the camera Object is seen by the aim
// row: the row asks the read (`overridesOnly`), and the read reaches the posing Object's strips.
describe('#1753 — an aim on a strip placed on the camera Object reaches the aim row', () => {
  const withStrip = () =>
    run(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'aim_act',
        nodeType: 'Action',
        params: {
          name: 'aim_act',
          channels: [
            {
              valueType: 'vec3',
              paramPath: 'rotation',
              keyframes: [
                { time: 0, value: [0, 0, 0] },
                { time: 2, value: [0, 180, 0] },
              ],
            },
          ],
        },
      } as Op,
      {
        type: 'addNode',
        nodeId: 'aim_strip',
        nodeType: 'Strip',
        params: { name: 'aim_strip', action: 'aim_act', target: 'n_camera' },
      } as Op,
      {
        type: 'addNode',
        nodeId: 'aim_track',
        nodeType: 'Track',
        params: { name: 'aim_track', strips: ['aim_strip'], order: 0 },
      } as Op,
    ]);
  const at1 = { time: { frame: 60, seconds: 1, normalized: 0 }, scene: 1, film: 1 };

  it('the camera is drawn turning along the strip', () => {
    // 1 s of 0 → 180° over 2 s: turned 90° about +Y.
    expect(resolveCameraPoseAt(withStrip(), 'n_camera', 1).quaternion[1]).toBeCloseTo(
      Math.SQRT1_2,
      6,
    );
  });

  it('the rotation row, asking only for an override, reads what is drawn', () => {
    const s = withStrip();
    const r = resolveEvaluatedParam(s, 'n_camera', 'rotation', at1, undefined, undefined, true);
    expect(sameTurn(r?.value as V3, resolveCameraPoseAt(s, 'n_camera', 1).quaternion)).toBe(true);
  });

  it('control: with no strip the row is told nothing overrides it', () => {
    const s = buildDefaultDagState();
    expect(
      resolveEvaluatedParam(s, 'n_camera', 'rotation', at1, undefined, undefined, true),
    ).toBeNull();
  });
});
