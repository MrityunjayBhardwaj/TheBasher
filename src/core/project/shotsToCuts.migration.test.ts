// #1666 — v24 → v25: a saved `Shot` becomes cuts on the camera switch, and a `Cut` is dropped.
//
// The two types are gone, so the file is written as v24 saved it — raw nodes of the old types — and
// loaded through the real load door. What the load must show: the film cuts to the Shot's camera at
// its start and back at its end (read through the resolver the render uses), no node of either type
// is left, and no wire still names one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, type DagState } from '../dag';
import { buildDefaultDagState } from './default';
import { useDagStore } from '../dag/store';
import { syncTemplateTypes } from '../dag/templates';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { selectActiveCameraNode } from '../../app/activeCamera';
import { shotsOf } from '../../app/shots';
import { MemoryStorage } from '../storage';
import { loadProject } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  syncTemplateTypes({ nodes: {} });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type RawNode = { id: string; type: string; version: number; params: object; inputs: object };
const ref = (node: string) => ({ node, socket: 'out' });

/** The default scene plus a second camera, `cam2`. Nothing is keyed: `n_camera` films throughout. */
function twoCameras(): DagState {
  return makeSplitCamera(buildDefaultDagState(), { objectId: 'cam2', position: [10, 0, 0] }).state;
}

/** `state` plus `extra` raw nodes, saved at v24 and loaded through the whole ladder. */
async function loadV24(state: DagState, extra: RawNode[]) {
  const nodes = JSON.parse(JSON.stringify(state.nodes)) as Record<string, RawNode>;
  for (const n of extra) nodes[n.id] = n;
  const saved = {
    formatVersion: 24,
    id: 'p',
    name: 'old shots',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: Object.fromEntries(Object.values(state.nodes).map((n) => [n.type, n.version])),
    state: { ...JSON.parse(JSON.stringify(state)), nodes },
  };
  const storage = new MemoryStorage();
  await storage.write('projects/p/project.json', new TextEncoder().encode(JSON.stringify(saved)));
  const loaded = await loadProject(storage, 'p');
  useDagStore.getState().hydrate(loaded.state);
  return loaded;
}

const shot = (id: string, camera: string | null, startTime: number, endTime: number): RawNode => ({
  id,
  type: 'Shot',
  version: 1,
  params: { name: id, startTime, endTime },
  inputs: { ...(camera ? { camera: ref(camera) } : {}), scene: ref('n_scene') },
});
const cut = (id: string, from: string, to: string): RawNode => ({
  id,
  type: 'Cut',
  version: 1,
  params: { transitionFrame: 0 },
  inputs: { from: ref(from), to: ref(to) },
});

const onScreen = (s: DagState, t: number) => selectActiveCameraNode(s, t)?.id ?? null;

describe('#1666 — v24 → v25: a Shot becomes cuts, a Cut is dropped', () => {
  it('the app writes v25', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(25);
  });

  it('a saved Shot is on screen from its start to its end, and the film around it is unchanged', async () => {
    const before = twoCameras();
    expect([1, 3, 5].map((t) => onScreen(before, t))).toEqual(['n_camera', 'n_camera', 'n_camera']);

    const loaded = await loadV24(before, [shot('shot_1', 'cam2', 2, 4)]);
    expect(loaded.formatVersion).toBe(25);
    const s = useDagStore.getState().state;
    expect([1, 3, 5].map((t) => onScreen(s, t))).toEqual(['n_camera', 'cam2', 'n_camera']);
    // The Shots panel reads the same keys: three rows, the middle one on cam2.
    expect(shotsOf(s, 6).shots.map((r) => `${r.start}-${r.end}:${r.cameraId}`)).toEqual([
      '0-2:n_camera',
      '2-4:cam2',
      '4-6:n_camera',
    ]);
  });

  it('no Shot or Cut is left, and no wire names a removed node', async () => {
    await loadV24(twoCameras(), [
      shot('shot_1', 'cam2', 2, 4),
      shot('shot_2', 'n_camera', 4, 6),
      cut('cut_1', 'shot_1', 'shot_2'),
    ]);
    const s = useDagStore.getState().state;
    expect(Object.values(s.nodes).filter((n) => n.type === 'Shot' || n.type === 'Cut')).toEqual([]);
    const dangling = Object.values(s.nodes).flatMap((n) =>
      Object.values(n.inputs)
        .flatMap((b) => (Array.isArray(b) ? b : [b]))
        .filter((r) => r && !s.nodes[r.node])
        .map((r) => `${n.id} <- ${r.node}`),
    );
    expect(dangling).toEqual([]);
  });

  it('shots apply in start order, so a later shot wins where two overlap', async () => {
    // Saved out of order on purpose: [3, 5] on n_camera inside [1, 6] on cam2.
    await loadV24(twoCameras(), [shot('late', 'n_camera', 3, 5), shot('early', 'cam2', 1, 6)]);
    const s = useDagStore.getState().state;
    expect([0.5, 2, 4, 5.5, 7].map((t) => onScreen(s, t))).toEqual([
      'n_camera',
      'cam2',
      'n_camera',
      'cam2',
      'n_camera',
    ]);
  });

  it('a Shot with no camera is dropped and counted, and so is a Cut', async () => {
    await loadV24(twoCameras(), [shot('blind', null, 1, 2), cut('c', 'blind', 'blind')]);
    const s = useDagStore.getState().state;
    expect(onScreen(s, 1.5)).toBe('n_camera');
    expect(Object.keys(s.nodes)).not.toContain('blind');
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('#1666'));
    expect(line).toContain('0 Shot(s) are now cuts');
    expect(line).toContain('1 Shot(s) with no camera');
    expect(line).toContain('1 Cut node(s) were dropped');
  });

  it('a project with no Shot or Cut loads unchanged', async () => {
    const before = twoCameras();
    await loadV24(before, []);
    const s = useDagStore.getState().state;
    expect(Object.keys(s.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
    expect(warn.mock.calls.some((c) => String(c[0]).includes('#1666'))).toBe(false);
  });
});
