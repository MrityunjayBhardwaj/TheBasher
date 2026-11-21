// #1708 — a shot's colour is its camera's: the cameras of the film take the palette in the order
// they first come on screen, so a camera that returns in a later shot keeps its colour, and a
// camera that films no shot has none.
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { shotsOf } from './shots';
import { SHOT_COLORS, liveShotAt, shotCameraColors, shotColorOfCamera } from './shotColors';

beforeAll(() => registerAllNodes());

function threeCameras(): { state: DagState; select: string } {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) {
    for (const op of buildSetActiveCameraOps(s, id) ?? []) s = applyOp(s, op).next;
  }
  return { state: s, select: shotsOf(s, 10).selectId! };
}

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

describe('#1708 — shot colours', () => {
  it('gives each camera the palette in the order it first comes on screen', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'cam3'],
      [2, 'n_camera'],
      [4, 'cam3'],
      [6, 'cam2'],
    ]);
    const colors = shotCameraColors(shotsOf(s, 10).shots);
    expect([...colors.entries()]).toEqual([
      ['cam3', SHOT_COLORS[0]],
      ['n_camera', SHOT_COLORS[1]],
      ['cam2', SHOT_COLORS[2]],
    ]);
    expect(shotColorOfCamera(s, 'cam3')).toBe(SHOT_COLORS[0]);
    expect(shotColorOfCamera(s, 'cam2')).toBe(SHOT_COLORS[2]);
  });

  it('leaves a camera that films no shot without a colour', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [3, 'cam2'],
    ]);
    expect(shotColorOfCamera(s, 'cam3')).toBeNull();
    expect(shotColorOfCamera(s, 'n_camera')).toBe(SHOT_COLORS[0]);
  });

  it('one camera wired directly is the one shot, in the first colour', () => {
    expect(shotColorOfCamera(buildDefaultDagState(), 'n_camera')).toBe(SHOT_COLORS[0]);
  });

  it('wraps the palette past its length', () => {
    const shots = Array.from({ length: SHOT_COLORS.length + 1 }, (_, i) => ({
      index: i,
      start: i,
      end: i + 1,
      cameraId: `c${i}`,
      keyTime: i,
    }));
    expect(shotCameraColors(shots).get(`c${SHOT_COLORS.length}`)).toBe(SHOT_COLORS[0]);
  });

  it('names the shot live at the playhead, its camera and its range', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [3, 'cam2'],
    ]);
    const live = liveShotAt(s, 3.5)!;
    expect([live.index, live.cameraId, live.start]).toEqual([1, 'cam2', 3]);
    expect(liveShotAt(s, 0)!.cameraId).toBe('n_camera');
  });
});
