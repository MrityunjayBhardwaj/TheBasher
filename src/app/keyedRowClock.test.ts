// #1753 — a param's evaluated read runs on the clock its node runs on, as the render does.
//
// `resolveEvaluatedParam` sampled every channel at the context's time, which every reader builds
// from scene time. A camera runs on the playhead (#1594), so with the scene slowed its keyed aim
// row read a different moment from the one drawn: aim row 1, camera aiming at 2.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
    ramp('box', 'n_box', 'scale', [2, 2, 2]),
  ]);
/** The playhead at 2 s, which is 1 s of scene time, as the time store holds it. */
const atPlayhead2 = { time: { frame: 60, seconds: 1, normalized: 0 } };

describe('#1753 — an evaluated param is read on its own node’s clock', () => {
  it('a camera’s keyed aim reads the playhead’s moment, as the camera is drawn', () => {
    const s = slowed();
    useTimeStore.setState({ seconds: 1, filmSeconds: 2 } as never);
    const drawn = resolveCameraPoseAt(s, 'n_camera', 2).lookAt;
    expect(drawn[0]).toBeCloseTo(2, 6);
    expect(resolveEvaluatedParam(s, 'n_camera_data', 'lookAt', atPlayhead2)?.value).toEqual(drawn);
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
