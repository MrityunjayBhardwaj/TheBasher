// #1562 — node positions: stored by `setMeta`, derived per level for a node without one.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../project/default';
import { buildAllExampleProjects } from '../project/examples';
import { composeProject, loadProject, saveProject } from '../project/io';
import { MemoryStorage } from '../storage/MemoryStorage';
import { rawSpringOps } from '../../test-utils/rawSpring';
import { applyOp, applyOps } from './ops';
import type { DagState } from './state';
import { layoutOf, levelOf, LAYOUT_ROW, positionOf } from './layout';
import { subnetworkOf } from './subnetworks';

beforeAll(() => registerAllNodes());

/** A project with a Solver whose body is nine nodes: two levels. */
function withSpring(): DagState {
  const base = applyOps(buildDefaultDagState(), [
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
  return applyOps(
    base,
    rawSpringOps(base, { targetId: 'n_box', controllerId: 'ctl', idFor: (k) => `s_${k}` }),
  ).next;
}

/** "Readable", as a property: in each level no two nodes share a spot, and every wire between
 *  two nodes of one level runs from left to right. */
function readability(state: DagState): { overlaps: string[]; backwards: string[] } {
  const layout = layoutOf(state);
  const level = levelOf(state);
  const overlaps: string[] = [];
  const backwards: string[] = [];
  const seen = new Map<string, string>();
  for (const id of Object.keys(state.nodes)) {
    const p = layout.get(id)!;
    const spot = `${level.get(id)}@${p[0]},${p[1]}`;
    if (seen.has(spot)) overlaps.push(`${seen.get(spot)} & ${id}`);
    seen.set(spot, id);
    for (const binding of Object.values(state.nodes[id].inputs)) {
      for (const ref of Array.isArray(binding) ? binding : [binding]) {
        if (level.get(ref.node) !== level.get(id)) continue;
        if (layout.get(ref.node)![0] >= p[0]) backwards.push(`${ref.node} → ${id}`);
      }
    }
  }
  return { overlaps, backwards };
}

describe('#1562 — every node has a position', () => {
  it('a project saved with none opens laid out readably, the default and every example', async () => {
    const states = [
      buildDefaultDagState(),
      withSpring(),
      ...(await buildAllExampleProjects()).map((p) => p.state as DagState),
    ];
    let nodes = 0;
    for (const state of states) {
      nodes += Object.keys(state.nodes).length;
      expect(layoutOf(state).size).toBe(Object.keys(state.nodes).length);
      expect(readability(state)).toEqual({ overlaps: [], backwards: [] });
    }
    expect(nodes).toBeGreaterThan(50);
  });

  it('a sub-network is its own level, at its nearest owner', () => {
    const state = withSpring();
    const level = levelOf(state);
    const body = subnetworkOf(state, 's_solver');
    expect(body.size).toBeGreaterThan(3);
    for (const id of body) expect(level.get(id)).toBe('s_solver');
    expect(level.get('s_solver')).toBeNull();
    expect(level.get('n_scene')).toBeNull();
  });

  it('a stored position wins, and the unplaced nodes of its level go below it', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', position: [5000, 7000] }).next;
    expect(positionOf(state, 'n_scene')).toEqual([5000, 7000]);
    for (const [id, p] of layoutOf(state)) {
      if (id === 'n_scene') continue;
      expect(p[1]).toBeGreaterThanOrEqual(7000 + LAYOUT_ROW);
    }
  });
});

describe('#1562 — setMeta writes a position', () => {
  it('writes it alone, keeps the name, and undoes to no position', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', name: 'Stage' }).next;
    const { next, inverse } = applyOp(state, {
      type: 'setMeta',
      nodeId: 'n_scene',
      position: [10, 20],
    });
    expect(next.nodes.n_scene.meta).toEqual({ name: 'Stage', position: [10, 20] });
    expect(inverse).toEqual({ type: 'setMeta', nodeId: 'n_scene', position: null });
    const undone = applyOp(next, inverse).next;
    expect(undone.nodes.n_scene).toEqual(state.nodes.n_scene);
  });

  it('a position survives a save and a load', async () => {
    const state = applyOp(buildDefaultDagState(), {
      type: 'setMeta',
      nodeId: 'n_scene',
      position: [12.5, -40],
    }).next;
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state }));
    const loaded = await loadProject(storage, 'p');
    expect(loaded.state.nodes.n_scene.meta).toEqual({ position: [12.5, -40] });
  });

  it('undoing a move puts the node back where it was', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', position: [1, 2] }).next;
    const { next, inverse } = applyOp(state, {
      type: 'setMeta',
      nodeId: 'n_scene',
      position: [3, 4],
    });
    expect(applyOp(next, inverse).next.nodes.n_scene.meta).toEqual({ position: [1, 2] });
  });

  it('a rename keeps the position', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', position: [1, 2] }).next;
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', name: 'Stage' }).next;
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene' }).next;
    expect(state.nodes.n_scene.meta).toEqual({ position: [1, 2] });
  });

  it('a move back to the same spot changes nothing, and a name with a position is refused', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, { type: 'setMeta', nodeId: 'n_scene', position: [1, 2] }).next;
    expect(applyOp(state, { type: 'setMeta', nodeId: 'n_scene', position: [1, 2] }).next).toBe(
      state,
    );
    expect(() =>
      applyOp(state, { type: 'setMeta', nodeId: 'n_scene', name: 'x', position: [0, 0] }),
    ).toThrow(/on its own/);
  });
});
