// #1566 — every project we can build survives a save and a load whole. `project.test.ts` checks
// the mechanism on one test node type; this runs the real registry over real projects.
//
// Three checks, because each sees what the others miss:
// - the graph in memory equals what the first save wrote: a save that drops something writes
//   the same bytes both times, so the second check alone cannot see it (the control below);
// - a second save is byte-identical to the first;
// - `relationsOf` answers the same for every node, so no wire, reference, name link or
//   sub-network membership is lost or gained on the way.
//
// Not yet here (#1566 stays open): one fixture holding every relationship kind the registry
// declares, including the owned strip list of an NLA Track and the `sourceTransform`
// reference, which none of these projects contains.

import { beforeAll, describe, expect, it } from 'vitest';
import { placeBuiltin } from '../../app/builtinTemplates';
import { registerAllNodes } from '../../nodes/registerAll';
import { rawSpringOps } from '../../test-utils/rawSpring';
import { relationsOf } from '../dag/idRefSweep';
import { applyOp, applyOps } from '../dag/ops';
import type { DagState } from '../dag/state';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildDefaultDagState } from './default';
import { buildAllExampleProjects } from './examples';
import { composeProject, loadProject, projectPath, saveProject } from './io';

beforeAll(() => registerAllNodes());

/** Keys sorted and `undefined` fields left out, as JSON writes them. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => [k, canonical(o[k])]),
  );
}

async function roundTrip(state: DagState) {
  const storage = new MemoryStorage();
  const header = { id: 'p', name: 'p', createdAt: 1, updatedAt: 2 };
  const read = async () => new TextDecoder().decode(await storage.read(projectPath('p')));
  await saveProject(storage, composeProject({ ...header, state }));
  const first = await read();
  const loaded = (await loadProject(storage, 'p')).state as DagState;
  await saveProject(storage, composeProject({ ...header, state: loaded }));
  const second = await read();
  return {
    memoryIsFirstSave:
      JSON.stringify(canonical(state)) === JSON.stringify(canonical(JSON.parse(first).state)),
    secondSaveIsFirst: first === second,
    relationsChanged: Object.keys(state.nodes).filter(
      (id) =>
        !loaded.nodes[id] ||
        JSON.stringify(relationsOf(state, id)) !== JSON.stringify(relationsOf(loaded, id)),
    ),
  };
}

const WHOLE = { memoryIsFirstSave: true, secondSaveIsFirst: true, relationsChanged: [] };

/** A controller Null in the default scene, for the rigs below to trail. */
function withController(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'ctl', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]).next;
}

function projects(): Array<[string, () => DagState | Promise<DagState>]> {
  return [
    ['the default project', buildDefaultDagState],
    [
      'a Spring Solver, with its sub-network',
      () => {
        const s = withController();
        return applyOps(
          s,
          rawSpringOps(s, { targetId: 'n_box', controllerId: 'ctl', idFor: (k) => `s_${k}` }),
        ).next;
      },
    ],
    [
      'a Lag template instance, with its definition',
      () => {
        const s = withController();
        const placed = placeBuiltin(s, 'Lag', 'lag1', {});
        if (!placed.ok) throw new Error(placed.reason);
        return applyOps(s, placed.ops).next;
      },
    ],
    [
      'a stored position, a name and a second render output bound',
      () =>
        applyOps(buildDefaultDagState(), [
          { type: 'setMeta', nodeId: 'n_box', position: [10, 20] },
          { type: 'setMeta', nodeId: 'n_box', name: 'Hero' },
          {
            type: 'addNode',
            nodeId: 'n_render_2',
            nodeType: 'RenderOutput',
            params: { postFx: { tonemap: 'Linear', smaa: false }, width: 640, height: 480 },
            inputs: { scene: { node: 'n_scene', socket: 'out' } },
          },
          { type: 'setOutput', name: 'render', ref: { node: 'n_render_2', socket: 'out' } },
        ]).next,
    ],
  ];
}

describe('#1566 — a project survives a save and a load whole', () => {
  for (const [name, build] of projects()) {
    it(name, async () => {
      expect(await roundTrip(await build())).toEqual(WHOLE);
    });
  }

  it('every example project', async () => {
    const examples = await buildAllExampleProjects();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect({ id: example.id, ...(await roundTrip(example.state as DagState)) }).toEqual({
        id: example.id,
        ...WHOLE,
      });
    }
  });

  it('a key the first save drops is seen, though both saves agree', async () => {
    const state = buildDefaultDagState();
    const stray = {
      ...state,
      nodes: { ...state.nodes, n_box: { ...state.nodes.n_box, stray: 1 } as never },
    };
    expect(await roundTrip(stray)).toEqual({ ...WHOLE, memoryIsFirstSave: false });
  });

  it('a node with nothing changed still compares equal after the trip', async () => {
    // The control's twin: the same project without the stray key is whole, so the control
    // above reds for the key and not for the project.
    const state = applyOp(buildDefaultDagState(), {
      type: 'setMeta',
      nodeId: 'n_box',
      name: 'Hero',
    }).next;
    expect(await roundTrip(state)).toEqual(WHOLE);
  });
});
