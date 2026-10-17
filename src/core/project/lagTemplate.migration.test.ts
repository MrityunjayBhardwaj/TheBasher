// #1559 — v23 → v24: each Lag node becomes an instance of the built-in Lag template, under its own
// id, and computes what the Lag computed, frame for frame. Through the real load door.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOps, type DagState } from '../dag';
import { buildDefaultDagState } from './default';
import { evaluate } from '../dag/evaluator';
import { useDagStore } from '../dag/store';
import { syncTemplateTypes, templatesOf } from '../dag/templates';
import type { Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { builtinDefinition, placeBuiltin } from '../../app/builtinTemplates';
import { MemoryStorage } from '../storage';
import { loadProject } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  syncTemplateTypes({ nodes: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const FRAMES = Array.from({ length: 61 }, (_, f) => f);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }) as Op;
const value = (s: DagState, id: string, frame: number) =>
  evaluate(s, id, { ctx: { time: { frame, seconds: frame / 60, normalized: 0 } } }).value;

/** Two Lags as v22 saved them: one trailing a controller, read by a driver; one reading `in`. */
function v22(): DagState {
  return applyOps(buildDefaultDagState(), [
    node('nul', 'Null', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    wire('nul', 'n_scene', 'children'),
    node('nul_tx', 'KeyframeChannelVec3', {
      name: 'position',
      target: 'nul',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 0.5, value: [6, 0, 0], easing: 'linear' },
        { time: 1, value: [-3, 0, 0], easing: 'linear' },
      ],
    }),
    node('lag', 'Lag', {
      factor: 0.3,
      seedFrame: 5,
      sourceTransform: { node: 'nul', channel: 'tx' },
    }),
    node('box', 'BoxData', { size: [1, 1, 1] }),
    node('drv', 'ParamDriver', {
      target: 'box',
      paramPath: 'size.0',
      blendMode: 'replace',
      order: 0,
    }),
    wire('lag', 'drv', 'in'),
    node('four', 'Fit', { outMin: 4, outMax: 4 }),
    node('lag2', 'Lag', { factor: 0.5 }),
    wire('four', 'lag2', 'in'),
  ]).next;
}

/** `state` as a file saved at `formatVersion`, loaded through the whole ladder. A v22 file
 *  takes the camera-cut step (#1668) and then this one; a v23 file, as the launch build saved it
 *  before the two lines merged, takes this one alone. */
async function loadAs(formatVersion: number, state: DagState) {
  const saved = {
    formatVersion,
    id: 'p',
    name: 'old lags',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: Object.fromEntries(Object.values(state.nodes).map((n) => [n.type, n.version])),
    state: JSON.parse(JSON.stringify(state)),
  };
  const storage = new MemoryStorage();
  await storage.write('projects/p/project.json', new TextEncoder().encode(JSON.stringify(saved)));
  const loaded = await loadProject(storage, 'p');
  useDagStore.getState().hydrate(loaded.state);
  return loaded;
}

describe('#1559 — v23 → v24: a Lag node becomes a Lag instance', () => {
  it('the app writes v24', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(24);
  });

  it('a project the launch build saved at v23 still has its Lags migrated', async () => {
    // The renumbering is for this file: #1668 also took v23, and the launch build saved projects
    // at it with their Lag nodes untouched. Were this step still 22 → 23 they would load as Lags.
    const loaded = await loadAs(23, v22());
    expect(loaded.formatVersion).toBe(24);
    const s = useDagStore.getState().state;
    expect(Object.values(s.nodes).filter((n) => n.type === 'Lag')).toEqual([]);
    expect(s.nodes.lag.type).toBe('template.Lag');
  });

  it('each Lag becomes an instance under its own id, holding what it held', async () => {
    const loaded = await loadAs(22, v22());
    expect(loaded.formatVersion).toBe(24);
    const s = useDagStore.getState().state;
    expect(Object.values(s.nodes).filter((n) => n.type === 'Lag')).toEqual([]);
    expect(s.nodes.lag.type).toBe('template.Lag');
    expect(s.nodes.lag.params).toMatchObject({
      locked: true,
      factor: 0.3,
      seedFrame: 5,
      sourceTransform: { node: 'nul', channel: 'tx' },
    });
    expect(s.nodes.lag2.inputs.in).toEqual({ node: 'four', socket: 'out' });
    expect(s.nodes.drv.inputs.in).toEqual({ node: 'lag', socket: 'out' });
    expect(templatesOf(s).get('template.Lag')!.definition).toEqual(builtinDefinition('Lag'));
  });

  it('and computes what the Lag computed, frame for frame', async () => {
    const before = v22();
    const lag = FRAMES.map((f) => value(before, 'lag', f));
    const lag2 = FRAMES.map((f) => value(before, 'lag2', f));
    expect(new Set(lag).size).toBeGreaterThan(10);
    await loadAs(22, before);
    const s = useDagStore.getState().state;
    expect(FRAMES.map((f) => value(s, 'lag', f))).toEqual(lag);
    expect(FRAMES.map((f) => value(s, 'lag2', f))).toEqual(lag2);
  });

  it('a Lag added afterwards reuses the migrated definition', async () => {
    await loadAs(22, v22());
    const r = placeBuiltin(useDagStore.getState().state, 'Lag', 'later');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        r.ops.filter((op) => op.type === 'addNode' && op.nodeType === 'TemplateDefinition'),
      ).toEqual([]);
  });
});
