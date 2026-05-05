import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { __reseedAllNodesForTests, registerAllNodes } from '../nodes/registerAll';
import { buildSceneTreeRows } from './sceneTreeWalk';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  registerAllNodes();
});

function applyAll(state: DagState, ops: Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

function buildSceneOnly(): DagState {
  const state = applyAll(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} },
  ]);
  return { ...state, outputs: { scene: { node: 'n_scene', socket: 'out' } } };
}

describe('buildSceneTreeRows — projection (THESIS.md §12)', () => {
  it('returns the Scene row for an empty project', () => {
    const rows = buildSceneTreeRows(buildSceneOnly());
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeType).toBe('Scene');
    expect(rows[0].depth).toBe(0);
    expect(rows[0].parent).toBeUndefined();
  });

  it('walks Group children with parent linkage', () => {
    let state = buildSceneOnly();
    state = applyAll(state, [
      { type: 'addNode', nodeId: 'box', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'grp', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const rows = buildSceneTreeRows(state);
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'Group', 'BoxMesh']);
    expect(rows[1].parent).toEqual({ nodeId: 'n_scene', socket: 'children', index: 0 });
    expect(rows[2].parent).toEqual({ nodeId: 'grp', socket: 'children', index: 0 });
  });

  it('walks Transform → child via target socket', () => {
    let state = buildSceneOnly();
    state = applyAll(state, [
      { type: 'addNode', nodeId: 'box', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'tx', nodeType: 'Transform', params: { position: [1, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'tx', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'tx', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const rows = buildSceneTreeRows(state);
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'Transform', 'BoxMesh']);
    expect(rows[2].parent).toEqual({ nodeId: 'tx', socket: 'target', index: 0 });
  });

  it('produces the same tree shape for two non-identical DAGs that evaluate the same hierarchy', () => {
    // DAG A: Scene → Group → BoxMesh
    let a = buildSceneOnly();
    a = applyAll(a, [
      { type: 'addNode', nodeId: 'box', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'grp', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'grp', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    // DAG B: same shape but the Group has different params (passes through),
    // and node ids differ. The TYPE sequence must match (projection equality).
    let b = buildSceneOnly();
    b = applyAll(b, [
      { type: 'addNode', nodeId: 'aa', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'bb', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'aa', socket: 'out' },
        to: { node: 'bb', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'bb', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const ta = buildSceneTreeRows(a).map((r) => `${r.depth}:${r.nodeType}`);
    const tb = buildSceneTreeRows(b).map((r) => `${r.depth}:${r.nodeType}`);
    expect(ta).toEqual(tb);
  });
});
