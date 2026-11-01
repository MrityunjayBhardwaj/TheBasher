// #1762 (part of #487) — v25 → v26: a camera's aim moves off its lens onto a Track-To.
// The gate: every camera's resolved pose is the same before and after the step, at every time
// sampled, for every example project and for fixtures covering each case the step handles.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from './default';
import { CAPTURED_EXAMPLE_IDS, EXAMPLE_PROJECT_IDS, buildExampleProject } from './examples';
import { migrateCameraAimToTrackTo } from './migrations';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { enumerateCameraNodeIds, resolveCameraPoseAt } from '../../app/activeCamera';
import { cameraOrientationTuple } from '../../app/cameraOrientation';
import v25Poses from './__fixtures__/cameraAim.v25poses.json';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const run = (s: DagState, ops: object[]) => {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
};
const migrate = (s: DagState): DagState => {
  const out = migrateCameraAimToTrackTo({ formatVersion: 25, state: s }) as {
    formatVersion: number;
    state: DagState;
  };
  expect(out.formatVersion).toBe(26);
  return out.state;
};
/** A node's params, read loosely: the fixtures check fields across node types. */
const paramsOf = (n: { params?: unknown }) => n.params as Record<string, unknown>;
const keys = (pairs: [number, unknown][]) =>
  pairs.map(([time, value]) => ({ time, value, easing: 'linear' }));
const TIMES = [0, 0.25, 0.5, 1, 1.5, 2, 3];

type PoseRead = Pick<
  ReturnType<typeof resolveCameraPoseAt>,
  'position' | 'quaternion' | 'lookAt' | 'roll' | 'fov'
>;
/** #1760 — the v25 side of each fixture, recorded by the code that last read a lens look-at
 *  (provenance inside the file): since the look-at stopped turning a camera, the v25 state can no
 *  longer be posed live, so what it posed is read from the recording instead. */
const V25 = (v25Poses as unknown as { poses: Record<string, Record<string, PoseRead[]>> }).poses;
const calls: Record<string, number> = {};

/**
 * Every camera in `b` (the converted state) poses as `a` (the saved one) did, at every sampled
 * time. A fixture's `a` is read from the recording; an example's (built at v26 already) live.
 */
function expectSamePoses(a: DagState, b: DagState) {
  const test = (expect.getState().currentTestName ?? '').split(' > ').slice(1).join(' > ');
  const n = (calls[test] = (calls[test] ?? 0) + 1);
  const recorded = V25[`${test} #${n}`];
  const ids = enumerateCameraNodeIds(a);
  expect(ids.length).toBeGreaterThan(0);
  if (recorded) expect(Object.keys(recorded).sort(), 'recorded cameras').toEqual([...ids].sort());
  for (const id of ids)
    TIMES.forEach((t, i) => {
      const pa: PoseRead = recorded ? recorded[id][i] : resolveCameraPoseAt(a, id, t);
      const pb = resolveCameraPoseAt(b, id, t);
      const label = `${id} @ ${t}s`;
      pa.position.forEach((v, j) => expect(pb.position[j], `${label} position`).toBeCloseTo(v, 9));
      // The orientation the pose carries, the one value readers turn the camera with: the same
      // rotation (q and −q are one), which is the same view direction and the same roll.
      const dot = pa.quaternion.reduce((acc, v, j) => acc + v * pb.quaternion[j], 0);
      expect(Math.abs(dot), `${label} orientation`).toBeCloseTo(1, 9);
      const dist = (p: PoseRead) => Math.hypot(...p.lookAt.map((v, j) => v - p.position[j]));
      expect(dist(pb), `${label} aim distance (ortho size, focus)`).toBeCloseTo(dist(pa), 9);
      expect(pb.fov, `${label} fov`).toBe(pa.fov);
      // While readers still take `lookAt`/`roll`, they must give the orientation carried.
      const q = cameraOrientationTuple(pb.position, pb.lookAt, pb.roll);
      const d = q.reduce((acc, v, j) => acc + v * pb.quaternion[j], 0);
      expect(Math.abs(d), `${label} orientation = aim`).toBeCloseTo(1, 9);
    });
}

/** A camera at `position` in a Group turned 90°, aimed by its lens, made active. */
function nestedLensCamera(lens: Record<string, unknown>): DagState {
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
  s = makeSplitCamera(s, { objectId: 'cam', position: [1, 0, 2], lens }).state;
  return run(s, [
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
  ]);
}
const lensId = (s: DagState) =>
  Object.values(s.nodes).find(
    (n) => n.type === 'CameraData' && n.id.includes('cam') && n.id !== 'n_camera_data',
  )!.id;

describe('#1762 — v25 → v26 moves a camera’s aim onto a Track-To', () => {
  it('a plain lens aim and roll: a parent-space Track-To carries them; the lens roll is 0', () => {
    const s = nestedLensCamera({ lookAt: [0, 0, -4], roll: 12 });
    const m = migrate(s);
    const tt = Object.values(m.nodes).find(
      (n) => n.type === 'TrackTo' && paramsOf(n).target === 'cam',
    )!;
    expect(tt.params).toMatchObject({
      aimPoint: [0, 0, -4],
      aimSpace: 'parent',
      roll: 12,
      aimNode: '',
    });
    expect(paramsOf(m.nodes[lensId(m)]).roll).toBe(0);
    expectSamePoses(s, m);
  });

  it('a keyed look-at and roll: the keys move onto the Track-To, unchanged', () => {
    let s = nestedLensCamera({ lookAt: [0, 0, -4], roll: 0 });
    const lens = lensId(s);
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'k_aim',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'lookAt',
          target: lens,
          paramPath: 'lookAt',
          keyframes: keys([
            [0, [0, 0, -4]],
            [2, [6, 3, -1]],
          ]),
        },
      },
      {
        type: 'addNode',
        nodeId: 'k_roll',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'roll',
          target: lens,
          paramPath: 'roll',
          keyframes: keys([
            [0, 0],
            [2, 35],
          ]),
        },
      },
    ]);
    const m = migrate(s);
    const tt = Object.values(m.nodes).find(
      (n) => n.type === 'TrackTo' && paramsOf(n).target === 'cam',
    )!;
    expect(m.nodes.k_aim.params).toMatchObject({
      target: tt.id,
      paramPath: 'aimPoint',
      name: 'aimPoint',
    });
    expect(m.nodes.k_roll.params).toMatchObject({ target: tt.id, paramPath: 'roll' });
    expectSamePoses(s, m);
  });

  it('a driven roll: the driver moves onto the Track-To', () => {
    let s = nestedLensCamera({ lookAt: [0, 0, -4] });
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: {
          target: lensId(s),
          paramPath: 'roll',
          sourceTransform: {
            node: 'n_box',
            channel: 'tx',
            remap: { inMin: -1, inMax: 1, outMin: -20, outMax: 20 },
          },
        },
      },
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0.5, 0, 0] },
    ]);
    const m = migrate(s);
    expect((paramsOf(m.nodes.drv).target as string).startsWith('cam_aim')).toBe(true);
    // The saved camera really was rolled by the driver: the recording says 10°.
    expect(V25['a driven roll: the driver moves onto the Track-To #1'].cam[0].roll).toBeCloseTo(
      10,
      6,
    );
    expectSamePoses(s, m);
  });

  it('an existing Track-To keeps winning, carries the lens roll, and muting it shows the old look-at', () => {
    let s = nestedLensCamera({ lookAt: [0, 0, -4], roll: 7 });
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'old_tt',
        nodeType: 'TrackTo',
        params: { target: 'cam', aimNode: 'n_box' },
      },
    ]);
    const m = migrate(s);
    expect(paramsOf(m.nodes.old_tt).roll).toBe(7);
    const aim = Object.values(m.nodes).find(
      (n) => n.type === 'TrackTo' && paramsOf(n).target === 'cam' && n.id !== 'old_tt',
    )!;
    expect(paramsOf(aim).order as number).toBeLessThan(
      (paramsOf(m.nodes.old_tt).order as number) ?? 0,
    );
    expectSamePoses(s, m);
    const mute = (x: DagState) =>
      run(x, [{ type: 'setParam', nodeId: 'old_tt', paramPath: 'mute', value: true }]);
    expectSamePoses(mute(s), mute(m));
  });

  it('a keyed lens roll under an existing Track-To is copied onto it', () => {
    let s = nestedLensCamera({ lookAt: [0, 0, -4] });
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'old_tt',
        nodeType: 'TrackTo',
        params: { target: 'cam', aimNode: 'n_box' },
      },
      {
        type: 'addNode',
        nodeId: 'k_roll',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'roll',
          target: lensId(s),
          paramPath: 'roll',
          keyframes: keys([
            [0, 0],
            [2, 35],
          ]),
        },
      },
    ]);
    expectSamePoses(s, migrate(s));
  });

  // A captured example is stored already converted (re-captured through this step for #1762), so
  // only the ones built from ops here meet it fresh.
  for (const id of EXAMPLE_PROJECT_IDS.filter((x) => !CAPTURED_EXAMPLE_IDS.includes(x)))
    it(`example "${id}": every camera poses the same before and after`, async () => {
      const s = (await buildExampleProject(id)).state;
      if (enumerateCameraNodeIds(s).length === 0) return;
      expectSamePoses(s, migrate(s));
    });

  it('the captured example is stored converted: its camera aims by a parent-space Track-To', async () => {
    for (const id of CAPTURED_EXAMPLE_IDS) {
      const s = (await buildExampleProject(id)).state;
      for (const cam of enumerateCameraNodeIds(s))
        expect(
          Object.values(s.nodes).some(
            (n) =>
              n.type === 'TrackTo' &&
              paramsOf(n).target === cam &&
              paramsOf(n).aimSpace === 'parent',
          ),
          `${id} ${cam}`,
        ).toBe(true);
    }
  });
});
