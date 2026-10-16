// #1595 — the shots are read off the keys on the active camera, and each row names the camera the
// resolver puts on screen at the shot's start.
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { shotsOf } from './shots';

beforeAll(() => registerAllNodes());

/** The default scene plus two cameras, every one made active once so all three are listed. */
function threeCameras(): { state: DagState; order: string[]; select: string } {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) {
    for (const op of buildSetActiveCameraOps(s, id) ?? []) s = applyOp(s, op).next;
  }
  const view = shotsOf(s, 10);
  return { state: s, order: [...view.cameraIds], select: view.selectId! };
}

/** The cut channel (#1668): a text channel on `active`, each key naming its camera. */
function keyed(state: DagState, select: string, keys: [number, string][]): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: 'cuts',
    nodeType: 'KeyframeChannelText',
    params: {
      name: 'active',
      target: select,
      paramPath: 'active',
      keyframes: keys.map(([time, value]) => ({ time, value, easing: 'constant' })),
    },
  }).next;
}

const rows = (s: DagState, end = 10) =>
  shotsOf(s, end).shots.map((x) => [x.start, x.end, x.cameraId, x.keyTime]);

describe('#1595 — shots from the camera cuts', () => {
  it('one camera wired directly is one shot over the whole film', () => {
    const view = shotsOf(buildDefaultDagState(), 10);
    expect(view.selectId).toBeNull();
    expect(view.shots.map((x) => [x.start, x.end, x.cameraId])).toEqual([[0, 10, 'n_camera']]);
  });

  it('several cameras and no keys: one shot, on the camera that is active', () => {
    const { state, order } = threeCameras();
    expect(order).toHaveLength(3);
    expect(rows(state)).toEqual([[0, 10, 'n_camera', null]]);
  });

  it('keys at 0 and 2 make two shots, each on the camera its key picks', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [2, 'cam3'],
    ]);
    expect(rows(s)).toEqual([
      [0, 2, 'n_camera', 0],
      [2, 10, 'cam3', 2],
    ]);
  });

  it('before the first key its camera holds, so a first key after 0 is not a cut', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [1, 'cam2'],
      [3, 'cam3'],
    ]);
    expect(rows(s)).toEqual([
      [0, 3, 'cam2', null],
      [3, 10, 'cam3', 3],
    ]);
  });

  it('a key at or past the end of the film starts no shot', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [4, 'cam2'],
      [12, 'cam3'],
    ]);
    expect(rows(s, 10)).toEqual([
      [0, 4, 'n_camera', 0],
      [4, 10, 'cam2', 4],
    ]);
  });

  it('#1668 — a key whose camera is no longer in the switch starts no shot; the shot before runs on', () => {
    const { state, select } = threeCameras();
    let s = keyed(state, select, [
      [0, 'n_camera'],
      [2, 'cam2'],
      [4, 'cam3'],
    ]);
    s = applyOp(s, {
      type: 'disconnect',
      from: { node: 'cam2', socket: 'out' },
      to: { node: select, socket: 'cameras' },
    }).next;
    expect(rows(s)).toEqual([
      [0, 4, 'n_camera', 0],
      [4, 10, 'cam3', 4],
    ]);
  });
});
