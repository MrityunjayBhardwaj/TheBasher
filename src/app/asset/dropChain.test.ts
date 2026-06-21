import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests, registerAllNodes } from '../../nodes/registerAll';
import { useDagStore } from '../../core/dag/store';
import { __resetDropCounterForTests, buildAssetDropOps } from './dropChain';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  registerAllNodes();
  __resetDropCounterForTests();
  useDagStore.setState({
    state: emptyDagState(),
    undoStack: [],
    redoStack: [],
    activity: [],
    pendingDiffs: [],
  });
});

describe('buildAssetDropOps', () => {
  it('emits the 4-op chain (2 addNode + 2 connect) — Group is the transformable root (#222)', () => {
    const ops = buildAssetDropOps({
      assetRef: 'assets/cube.gltf',
      sceneNodeId: 'n_scene',
      position: [1, 2, 3],
      ids: { gltf: 'g', group: 'r' },
    });
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ type: 'addNode', nodeType: 'GltfAsset', nodeId: 'g' });
    // The Group carries the drop transform directly — no separate Transform node.
    expect(ops[1]).toMatchObject({
      type: 'addNode',
      nodeType: 'Group',
      nodeId: 'r',
      params: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
    });
    expect(ops[2]).toMatchObject({
      type: 'connect',
      from: { node: 'g', socket: 'out' },
      to: { node: 'r', socket: 'children' },
    });
    expect(ops[3]).toMatchObject({
      type: 'connect',
      from: { node: 'r', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    });
  });

  it('threads the assetRef into the GltfAsset params', () => {
    const ops = buildAssetDropOps({
      assetRef: 'assets/cube.gltf',
      sceneNodeId: 'n_scene',
      ids: { gltf: 'g', group: 'r' },
    });
    const first = ops[0];
    expect(first.type).toBe('addNode');
    if (first.type !== 'addNode') return;
    expect((first.params as { assetRef: string }).assetRef).toBe('assets/cube.gltf');
  });
});

describe('drop chain → DAG', () => {
  function buildSeedState(): DagState {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_scene',
      nodeType: 'Scene',
      params: {},
    }).next;
    return state;
  }

  it('applies the chain via dispatchAtomic and undoes as one entry', () => {
    const seed = buildSeedState();
    useDagStore.setState({
      state: seed,
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
    const ops = buildAssetDropOps({
      assetRef: 'assets/cube.gltf',
      sceneNodeId: 'n_scene',
      ids: { gltf: 'g', group: 'r' },
    });
    useDagStore.getState().dispatchAtomic(ops, 'user', 'import asset');

    // After the drop: 2 new nodes (GltfAsset + Group) plus the seed Scene = 3.
    const after = useDagStore.getState().state;
    expect(Object.keys(after.nodes).sort()).toEqual(['g', 'n_scene', 'r']);
    expect(after.nodes.n_scene.inputs.children).toEqual([{ node: 'r', socket: 'out' }]);

    // Undo stack has exactly one entry (atomic group).
    expect(useDagStore.getState().undoStack).toHaveLength(1);

    // One undo reverts the entire chain.
    useDagStore.getState().undo();
    const reverted = useDagStore.getState().state;
    expect(Object.keys(reverted.nodes)).toEqual(['n_scene']);
    expect(reverted.nodes.n_scene.inputs.children).toBeUndefined();
  });

  it('two drops produce two distinct asset chains under Scene.children', () => {
    const seed = buildSeedState();
    useDagStore.setState({
      state: seed,
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
    useDagStore.getState().dispatchAtomic(
      buildAssetDropOps({
        assetRef: 'assets/cube.gltf',
        sceneNodeId: 'n_scene',
        ids: { gltf: 'g1', group: 'r1' },
      }),
      'user',
    );
    useDagStore.getState().dispatchAtomic(
      buildAssetDropOps({
        assetRef: 'assets/sphere.gltf',
        sceneNodeId: 'n_scene',
        ids: { gltf: 'g2', group: 'r2' },
      }),
      'user',
    );
    const state = useDagStore.getState().state;
    expect(state.nodes.n_scene.inputs.children).toEqual([
      { node: 'r1', socket: 'out' },
      { node: 'r2', socket: 'out' },
    ]);
    expect(useDagStore.getState().undoStack).toHaveLength(2);
  });
});
