// #1668 — deleting a camera leaves every shot that did not use it on its own camera.
//
// A cut names its camera (the id), not its place in the camera switch's list. Before this, the
// switch picked by POSITION, so deleting any camera moved every later camera up one place while
// the keys kept their old numbers: in a five-camera, four-cut film, deleting the first camera put
// four of five shots on a different camera, silently.
//
// The outcome for a shot whose own camera is deleted is Blender's (`BKE_scene_camera_switch_find`
// skips a marker whose camera is gone): the shot before runs on through it. Its key is left as it
// was, so one undo of the delete brings the camera and its cut back together. (#1669 is the final
// version: delete the cut with its camera.)
//
// Run through the app's own delete (`buildDeleteNodesOps`) and the real store, and read back as
// shots (`shotsOf` — the rows read each camera through the render's resolver).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { useDagStore } from '../core/dag/store';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildCutOps } from './shotOps';
import { shotsOf } from './shots';
import { buildDeleteNodesOps } from './sceneNodeActions';
import { selectActiveCameraNode } from './activeCamera';

beforeAll(() => registerAllNodes());

const run = (s: DagState, ops: Op[] | null): DagState => {
  expect(ops, 'the edit was refused').not.toBeNull();
  for (const op of ops!) s = applyOp(s, op).next;
  return s;
};

/**
 * Five cameras (n_camera + cam2..cam5) and cuts at 2, 4, 6 and 8 s. The switch lists them in the
 * order they were made — [n_camera, cam2, cam3, cam4, cam5] — and the shots use them out of that
 * order. The three deletes below are chosen so the shot before the deleted one is never the switch's
 * first camera: a cut naming a missing camera would otherwise land on the right answer by falling
 * back to the first camera, and the test would pass without the skip.
 */
function film(): DagState {
  let s = buildDefaultDagState();
  for (let i = 2; i <= 5; i++) {
    s = makeSplitCamera(s, { objectId: `cam${i}`, position: [i * 10, 0, 0] }).state;
  }
  s = run(s, buildCutOps(s, 2, 'cam3'));
  s = run(s, buildCutOps(s, 4, 'cam5'));
  s = run(s, buildCutOps(s, 6, 'cam2'));
  s = run(s, buildCutOps(s, 8, 'cam4'));
  return s;
}

const shotCameras = (s: DagState) => shotsOf(s, 10).shots.map((x) => `${x.start}:${x.cameraId}`);

/** What PLAYS, sampled mid-second through the render's resolver — the rows start only at live
 *  cuts, so they never sample inside the span of a cut whose camera is gone; this does. */
const playing = (s: DagState) =>
  Array.from({ length: 10 }, (_, i) => selectActiveCameraNode(s, i + 0.5)?.id);

/** Delete `id` the way the app does: one atomic commit through the store. */
function deleteCamera(id: string): DagState {
  const s = useDagStore.getState().state;
  useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, [id]), 'user', `delete ${id}`);
  return useDagStore.getState().state;
}

beforeEach(() => {
  useDagStore.setState({ state: film(), undoStack: [], redoStack: [] } as never);
});

describe('#1668 — deleting a camera leaves every other shot on its own camera', () => {
  it('control: the film before any delete', () => {
    const view = shotsOf(useDagStore.getState().state, 10);
    expect(view.cameraIds).toEqual(['n_camera', 'cam2', 'cam3', 'cam4', 'cam5']);
    expect(shotCameras(useDagStore.getState().state)).toEqual([
      '0:n_camera',
      '2:cam3',
      '4:cam5',
      '6:cam2',
      '8:cam4',
    ]);
  });

  it('delete the camera at the FRONT of the list: the film opens on the first live cut camera, every other shot unchanged', () => {
    // n_camera films shot 1 only. With it gone, the film opens on the first live cut's camera.
    const s = deleteCamera('n_camera');
    expect(s.nodes.n_camera).toBeUndefined();
    expect(shotCameras(s)).toEqual(['0:cam3', '4:cam5', '6:cam2', '8:cam4']);
    expect(playing(s)).toEqual([
      'cam3',
      'cam3',
      'cam3',
      'cam3',
      'cam5',
      'cam5',
      'cam2',
      'cam2',
      'cam4',
      'cam4',
    ]);
  });

  it('delete a camera in the MIDDLE of the list: its shot runs on from the shot before', () => {
    // cam2 (second in the list) films shot 4 (6–8 s). Shot 3 (cam5) runs on through it; every
    // camera after cam2 in the list moves up a place, and no other shot changes camera.
    const s = deleteCamera('cam2');
    expect(shotCameras(s)).toEqual(['0:n_camera', '2:cam3', '4:cam5', '8:cam4']);
    expect(playing(s)).toEqual([
      'n_camera',
      'n_camera',
      'cam3',
      'cam3',
      'cam5',
      'cam5',
      'cam5',
      'cam5',
      'cam4',
      'cam4',
    ]);
  });

  it('delete the camera at the END of the list: only its own shot changes', () => {
    // cam5 (last in the list) films shot 3 (4–6 s); shot 2 (cam3) runs on through it.
    const s = deleteCamera('cam5');
    expect(shotCameras(s)).toEqual(['0:n_camera', '2:cam3', '6:cam2', '8:cam4']);
    expect(playing(s)).toEqual([
      'n_camera',
      'n_camera',
      'cam3',
      'cam3',
      'cam3',
      'cam3',
      'cam2',
      'cam2',
      'cam4',
      'cam4',
    ]);
  });

  it('delete a camera no shot uses: no shot changes', () => {
    let s = useDagStore.getState().state;
    s = makeSplitCamera(s, { objectId: 'cam6', position: [60, 0, 0] }).state;
    s = run(s, [
      {
        type: 'connect',
        from: { node: 'cam6', socket: 'out' },
        to: { node: shotsOf(s, 10).selectId!, socket: 'cameras' },
      },
    ]);
    useDagStore.setState({ state: s, undoStack: [], redoStack: [] } as never);
    const before = shotCameras(s);
    expect(shotCameras(deleteCamera('cam6'))).toEqual(before);
  });

  it.each(['n_camera', 'cam2', 'cam5'])(
    'one undo of deleting %s restores the camera and every cut',
    (id) => {
      const before = useDagStore.getState().state;
      deleteCamera(id);
      expect(useDagStore.getState().undoStack).toHaveLength(1);
      useDagStore.getState().undo();
      const after = useDagStore.getState().state;
      expect(after.nodes[id]).toBeDefined();
      expect(shotCameras(after)).toEqual(shotCameras(before));
    },
  );
});
