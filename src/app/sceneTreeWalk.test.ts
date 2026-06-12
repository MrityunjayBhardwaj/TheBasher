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

  it('expands a GltfAsset into nested GltfChild rows (Option A, #91 Wave D)', () => {
    // Asset with two children: a parent "bone0" and its child "bone1".
    // nodeNameMap: childKey → GltfChild node id; childHierarchy: parent → children.
    let state = buildSceneOnly();
    state = applyAll(state, [
      {
        type: 'addNode',
        nodeId: 'gltf',
        nodeType: 'GltfAsset',
        params: {
          assetRef: 'assets/skinned-bar.glb',
          nodeNameMap: { bone0: 'child_b0', bone1: 'child_b1' },
          childHierarchy: { bone0: ['bone1'] },
        },
      },
      {
        type: 'addNode',
        nodeId: 'child_b0',
        nodeType: 'GltfChild',
        params: {
          assetRef: 'assets/skinned-bar.glb',
          childName: 'bone0',
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      {
        type: 'addNode',
        nodeId: 'child_b1',
        nodeType: 'GltfChild',
        params: {
          assetRef: 'assets/skinned-bar.glb',
          childName: 'bone1',
          position: [0, 1, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      {
        type: 'connect',
        from: { node: 'gltf', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    const rows = buildSceneTreeRows(state);
    // Scene → GltfAsset → bone0 (depth 2) → bone1 (depth 3).
    expect(rows.map((r) => r.nodeType)).toEqual(['Scene', 'GltfAsset', 'GltfChild', 'GltfChild']);
    const gltfRow = rows[1];
    const bone0Row = rows[2];
    const bone1Row = rows[3];
    expect(gltfRow.nodeType).toBe('GltfAsset');
    // bone0 is a root child → directly under the asset.
    expect(bone0Row.display).toBe('bone0');
    expect(bone0Row.depth).toBe(gltfRow.depth + 1);
    expect(bone0Row.nodeId).toBe('child_b0'); // click selects the GltfChild node
    expect(bone0Row.parent).toBeUndefined(); // non-reorderable: no scene edge
    // bone1 nests one deeper under bone0.
    expect(bone1Row.display).toBe('bone1');
    expect(bone1Row.depth).toBe(bone0Row.depth + 1);
    expect(bone1Row.nodeId).toBe('child_b1');
    expect(bone1Row.parent).toBeUndefined();
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

describe('buildSceneTreeRows — row.display identity (outliner labels)', () => {
  function sceneWithBox(): DagState {
    let state = buildSceneOnly();
    state = applyAll(state, [
      { type: 'addNode', nodeId: 'n_box_2', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      {
        type: 'connect',
        from: { node: 'n_box_2', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    return state;
  }

  function patchNode(state: DagState, id: string, patch: Record<string, unknown>): DagState {
    return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes[id]!, ...patch } } };
  }

  it('falls back to the node id (NOT the bare type) for an unnamed node', () => {
    // Two unnamed BoxMesh used to both read "BoxMesh" — indistinct in the tree
    // while the inspector showed "n_box_2". The label now carries identity.
    const box = buildSceneTreeRows(sceneWithBox()).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('n_box_2');
    expect(box?.display).not.toBe('BoxMesh');
  });

  it('prefers meta.name (matches the inspector identity)', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', { meta: { name: 'Hero' } }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Hero');
  });

  it('uses params.name (Shot / AnimationClip / Character semantic label) over the id', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', { params: { size: [1, 1, 1], name: 'Intro' } }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Intro');
  });

  it('meta.name wins over params.name', () => {
    const box = buildSceneTreeRows(
      patchNode(sceneWithBox(), 'n_box_2', {
        meta: { name: 'Hero' },
        params: { size: [1, 1, 1], name: 'Intro' },
      }),
    ).find((r) => r.nodeId === 'n_box_2');
    expect(box?.display).toBe('Hero');
  });
});
