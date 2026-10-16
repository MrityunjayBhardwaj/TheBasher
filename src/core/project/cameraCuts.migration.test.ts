// #1668 — v22 → v23: a camera switch and its cuts name their cameras.
//
// A v22 file stored `CameraSelect.active`, and every key cutting it, as an INDEX into the switch's
// `cameras` wires. The pass turns each into the id of the camera that index picked, read through
// the wires as saved, so every shot keeps the camera it showed — and from then on a delete no
// longer moves cuts onto other cameras.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../dag';
import type { Node, Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { buildDefaultDagState } from './default';
import { loadProject } from './io';
import { migrateCameraCutsToIds, migrateProjectFormat } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { buildSetActiveCameraOps } from '../../app/setActiveCamera';
import { shotsOf } from '../../app/shots';
import { buildDeleteNodesOps } from '../../app/sceneNodeActions';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const run = (s: DagState, ops: Op[] | null) =>
  (ops ?? []).reduce((a, op) => applyOp(a, op).next, s);

/** Five cameras behind a switch listing [n_camera, cam2, cam3, cam4, cam5]. */
function fiveCameras(): DagState {
  let s = buildDefaultDagState();
  for (let i = 2; i <= 5; i++)
    s = makeSplitCamera(s, { objectId: `cam${i}`, position: [i * 10, 0, 0] }).state;
  return run(s, buildSetActiveCameraOps(s, 'cam2'));
}
const selectOf = (s: DagState) => Object.values(s.nodes).find((n) => n.type === 'CameraSelect')!;

/** The file v22 wrote: `active` an index, the cuts a NUMBER channel of indices. */
function asV22(s: DagState, active: number, cuts: [number, number][]) {
  const sel = selectOf(s);
  const nodes: Record<string, Node> = {
    ...s.nodes,
    [sel.id]: { ...sel, version: 1, params: { active } },
    cuts: {
      id: 'cuts',
      type: 'KeyframeChannelNumber',
      version: 2,
      params: {
        name: 'active',
        target: sel.id,
        paramPath: 'active',
        mute: false,
        keyframes: cuts.map(([time, value]) => ({ time, value, easing: 'constant' })),
        extendBefore: 'constant',
      },
      inputs: {},
    } as Node,
  };
  return JSON.parse(JSON.stringify({ formatVersion: 22, state: { ...s, nodes } }));
}

const shotCameras = (s: DagState) => shotsOf(s, 10).shots.map((x) => `${x.start}:${x.cameraId}`);

describe('#1668 — v22 → v23: camera cuts name their cameras', () => {
  it('the app writes v23', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(23);
  });

  it('each index becomes the camera it picked; the cut channel becomes a text channel of camera ids', () => {
    const s = fiveCameras();
    const out = migrateCameraCutsToIds(
      asV22(s, 3, [
        [0, 0],
        [2, 2],
        [4, 4],
        [6, 1],
        [8, 3],
      ]),
    ) as { formatVersion: number; state: DagState };
    expect(out.formatVersion).toBe(23);
    const sel = selectOf(out.state);
    expect(sel.version).toBe(2);
    expect(sel.params).toEqual({ active: 'cam4' });
    const cuts = out.state.nodes.cuts;
    expect(cuts.type).toBe('KeyframeChannelText');
    expect(cuts.params).toEqual({
      target: sel.id,
      paramPath: 'active',
      name: 'active',
      mute: false,
      keyframes: [
        { time: 0, value: 'n_camera', easing: 'constant' },
        { time: 2, value: 'cam3', easing: 'constant' },
        { time: 4, value: 'cam5', easing: 'constant' },
        { time: 6, value: 'cam2', easing: 'constant' },
        { time: 8, value: 'cam4', easing: 'constant' },
      ],
    });
  });

  it('an index resolves exactly as v22 read it: rounded, and clamped into the list', () => {
    const s = fiveCameras();
    const out = migrateCameraCutsToIds(
      asV22(s, 9, [
        [0, -1],
        [1, 1.4],
        [2, 1.6],
        [3, 7],
      ]),
    ) as { state: DagState };
    expect(selectOf(out.state).params).toEqual({ active: 'cam5' });
    const values = (
      out.state.nodes.cuts.params as { keyframes: { value: string }[] }
    ).keyframes.map((k) => k.value);
    expect(values).toEqual(['n_camera', 'cam2', 'cam3', 'cam5']);
  });

  it('a project with no camera switch only moves its stamp', () => {
    const raw = JSON.parse(JSON.stringify({ formatVersion: 22, state: buildDefaultDagState() }));
    const out = migrateCameraCutsToIds(raw) as { formatVersion: number; state: unknown };
    expect(out.formatVersion).toBe(23);
    expect(out.state).toEqual(raw.state);
  });

  it('a saved v22 film loads through the real door with every shot on its camera, and a delete then leaves the other shots alone', async () => {
    const s = fiveCameras();
    const saved = {
      ...asV22(s, 0, [
        [0, 0],
        [2, 2],
        [4, 4],
        [6, 1],
        [8, 3],
      ]),
      id: 'p',
      name: 'old film',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { CameraSelect: 1, KeyframeChannelNumber: 2 },
    };
    const storage = new MemoryStorage();
    await storage.write('projects/p/project.json', new TextEncoder().encode(JSON.stringify(saved)));
    const loaded = await loadProject(storage, 'p');
    expect(loaded.formatVersion).toBe(23);
    const state = loaded.state as DagState;
    expect(shotCameras(state)).toEqual(['0:n_camera', '2:cam3', '4:cam5', '6:cam2', '8:cam4']);
    // The bug this closes: deleting cam2 (second in the list) used to move cam3..cam5's shots.
    const after = run(state, buildDeleteNodesOps(state, ['cam2']));
    expect(shotCameras(after)).toEqual(['0:n_camera', '2:cam3', '4:cam5', '8:cam4']);
  });

  it('runs on the ladder from v22', () => {
    const out = migrateProjectFormat(asV22(fiveCameras(), 1, [])) as {
      formatVersion: number;
      state: DagState;
    };
    expect(out.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(selectOf(out.state).params).toEqual({ active: 'cam2' });
  });
});
