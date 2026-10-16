// #1595 — the shots panel's edits, read back through `shotsOf` (what the panel and the render see).
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildCutOps, buildRemoveCutOps, buildSetShotCameraOps } from './shotOps';
import { shotsOf } from './shots';
import { selectActiveCameraNode } from './activeCamera';

beforeAll(() => registerAllNodes());

/** The default scene (one camera, wired directly) plus two more cameras, none listed anywhere. */
function threeLooseCameras(): DagState {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  return s;
}

const run = (s: DagState, ops: Op[] | null): DagState => {
  expect(ops, 'the edit was refused').not.toBeNull();
  for (const op of ops!) s = applyOp(s, op).next;
  return s;
};
const rows = (s: DagState) => shotsOf(s, 10).shots.map((x) => [x.start, x.end, x.cameraId]);

describe('#1595 — shots panel edits', () => {
  it('the first cut, from a single directly wired camera, keeps that camera before it', () => {
    const s = run(threeLooseCameras(), buildCutOps(threeLooseCameras(), 2, 'cam3'));
    expect(rows(s)).toEqual([
      [0, 2, 'n_camera'],
      [2, 10, 'cam3'],
    ]);
    // What plays agrees with the rows, frame by frame.
    expect(selectActiveCameraNode(s, 1.99)?.id).toBe('n_camera');
    expect(selectActiveCameraNode(s, 2)?.id).toBe('cam3');
  });

  it('a second cut adds a third shot; the camera list grows only by the camera used', () => {
    let s = threeLooseCameras();
    s = run(s, buildCutOps(s, 2, 'cam3'));
    s = run(s, buildCutOps(s, 5, 'cam2'));
    expect(rows(s)).toEqual([
      [0, 2, 'n_camera'],
      [2, 5, 'cam3'],
      [5, 10, 'cam2'],
    ]);
  });

  it("changing a shot's camera re-keys its start; the other shots are untouched", () => {
    let s = threeLooseCameras();
    s = run(s, buildCutOps(s, 2, 'cam3'));
    s = run(s, buildCutOps(s, 5, 'cam2'));
    s = run(s, buildSetShotCameraOps(s, 2, 'n_camera'));
    expect(rows(s)).toEqual([
      [0, 2, 'n_camera'],
      [2, 5, 'n_camera'],
      [5, 10, 'cam2'],
    ]);
    s = run(s, buildSetShotCameraOps(s, 0, 'cam3'));
    expect(rows(s)[0]).toEqual([0, 2, 'cam3']);
  });

  it('removing a cut lets the shot before it run on', () => {
    let s = threeLooseCameras();
    s = run(s, buildCutOps(s, 2, 'cam3'));
    s = run(s, buildCutOps(s, 5, 'cam2'));
    s = run(s, buildRemoveCutOps(s, 2));
    expect(rows(s)).toEqual([
      [0, 5, 'n_camera'],
      [5, 10, 'cam2'],
    ]);
    expect(buildRemoveCutOps(s, 3), 'no cut at 3 s').toBeNull();
  });

  it('every key the panel writes is a step', () => {
    let s = threeLooseCameras();
    s = run(s, buildCutOps(s, 2, 'cam3'));
    s = run(s, buildCutOps(s, 5, 'cam2'));
    const ch = Object.values(s.nodes).find((n) => n.type === 'KeyframeChannelNumber')!;
    const easings = (ch.params as { keyframes: { easing: string }[] }).keyframes.map(
      (k) => k.easing,
    );
    expect(easings).toEqual(['constant', 'constant', 'constant']);
  });

  it('a scene with one camera has nothing to cut to', () => {
    expect(buildCutOps(buildDefaultDagState(), 2, 'n_camera')).toBeNull();
  });
});
