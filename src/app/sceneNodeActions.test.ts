import { describe, it, expect } from 'vitest';
import { buildDeleteNodesOps, buildDuplicateNodeOps } from './sceneNodeActions';
import type { DagState } from '../core/dag/state';

// Minimal fake DAG — the builders read only node.type / params / inputs and emit
// ops; they don't validate schema, so a plain object suffices for unit coverage.
function fakeState(): DagState {
  return {
    nodes: {
      scene: {
        id: 'scene',
        type: 'Scene',
        params: {},
        inputs: {
          children: [
            { node: 'box', socket: 'out' },
            { node: 'grp', socket: 'out' },
          ],
        },
      },
      box: { id: 'box', type: 'BoxMesh', params: { size: [1, 1, 1] }, inputs: {} },
      grp: {
        id: 'grp',
        type: 'Group',
        params: { position: [5, 0, 0] },
        inputs: { children: [{ node: 'inner', socket: 'out' }] },
      },
      inner: { id: 'inner', type: 'BoxMesh', params: { size: [2, 2, 2] }, inputs: {} },
    },
    outputs: { scene: { node: 'scene' } },
  } as unknown as DagState;
}

// A fake DAG with a free-floating KeyframeChannel targeting `box` via
// params.target (V57) — an input to nothing, reached outside the edge graph.
function animatedState(): DagState {
  const s = fakeState();
  (s.nodes as Record<string, unknown>).ch = {
    id: 'ch',
    type: 'KeyframeChannelVec3',
    params: {
      target: 'box',
      paramPath: 'position',
      keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
    },
    inputs: {},
  };
  return s;
}

describe('buildDeleteNodesOps', () => {
  it('disconnects every consumer edge before removing the node', () => {
    const ops = buildDeleteNodesOps(fakeState(), ['box']);
    expect(ops).toEqual([
      {
        type: 'disconnect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
      { type: 'removeNode', nodeId: 'box' },
    ]);
  });

  it('#365 also removes a split Object’s orphaned BoxData', () => {
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'obj', socket: 'out' }] },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: { id: 'data', type: 'BoxData', params: { size: [1, 1, 1] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    const ops = buildDeleteNodesOps(state, ['obj']);
    // The Object is removed AND its now-orphaned BoxData too (no save bloat).
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'obj' });
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'data' });
    // Order: the data node's removeNode comes AFTER the Object's (its only consumer
    // must be gone first, else removeNode refuses).
    const idxObj = ops.findIndex((o) => o.type === 'removeNode' && o.nodeId === 'obj');
    const idxData = ops.findIndex((o) => o.type === 'removeNode' && o.nodeId === 'data');
    expect(idxData).toBeGreaterThan(idxObj);
  });

  it('#365 KEEPS a shared BoxData when a sibling Object still points at it', () => {
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: {
            children: [
              { node: 'objA', socket: 'out' },
              { node: 'objB', socket: 'out' },
            ],
          },
        },
        objA: {
          id: 'objA',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        objB: {
          id: 'objB',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: { id: 'data', type: 'BoxData', params: { size: [1, 1, 1] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    const ops = buildDeleteNodesOps(state, ['objA']);
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'objA' });
    // objB still consumes `data` → it must survive (fan-out, not orphaned).
    expect(ops.some((o) => o.type === 'removeNode' && o.nodeId === 'data')).toBe(false);
  });

  it('[[H136]] also removes a free-floating channel targeting the deleted node', () => {
    const ops = buildDeleteNodesOps(animatedState(), ['box']);
    // channel `ch` targets `box` via params.target (no edge) — must be removed too.
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'ch' });
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'box' });
    // it has no consumer edge, so no disconnect op is emitted for it.
    expect(
      ops
        .filter((o) => o.type === 'disconnect')
        .some((o) => (o as { from: { node: string } }).from.node === 'ch'),
    ).toBe(false);
  });
});

describe('buildDuplicateNodeOps', () => {
  it('duplicates a leaf as a sibling right after the original', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'box');
    expect(res?.newRootId).toBe('box_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'box_copy', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      {
        type: 'connect',
        from: { node: 'box_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 1,
      },
    ]);
  });

  it('deep-copies a Group subtree, re-wiring internal edges to the clones', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'grp');
    expect(res?.newRootId).toBe('grp_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'grp_copy', nodeType: 'Group', params: { position: [5, 0, 0] } },
      { type: 'addNode', nodeId: 'inner_copy', nodeType: 'BoxMesh', params: { size: [2, 2, 2] } },
      // internal edge points at the CLONE child, not the original.
      {
        type: 'connect',
        from: { node: 'inner_copy', socket: 'out' },
        to: { node: 'grp_copy', socket: 'children' },
        index: 0,
      },
      // new root wired after the original (grp was index 1 → copy at 2).
      {
        type: 'connect',
        from: { node: 'grp_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 2,
      },
    ]);
  });

  it('deep-copies a split Object: the clone gets its OWN, independent BoxData (#365)', () => {
    // A split Object owns its geometry/material through `data`. Duplicating it must
    // clone the BoxData too and point clone.data at the clone — NOT the original
    // (which would be a linked copy: recolour one, both change). Blender Shift+D.
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'obj', socket: 'out' }] },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: { position: [0, 0, 0] },
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: {
          id: 'data',
          type: 'BoxData',
          params: { size: [1, 1, 1], material: { base: { color: '#ff0000' } } },
          inputs: {},
        },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;

    const res = buildDuplicateNodeOps(state, 'obj')!;
    expect(res.newRootId).toBe('obj_copy');
    expect(res.ops).toEqual([
      { type: 'addNode', nodeId: 'obj_copy', nodeType: 'Object', params: { position: [0, 0, 0] } },
      {
        type: 'addNode',
        nodeId: 'data_copy',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: { base: { color: '#ff0000' } } },
      },
      // clone.data → the CLONED BoxData, not the original 'data' (independence).
      {
        type: 'connect',
        from: { node: 'data_copy', socket: 'out' },
        to: { node: 'obj_copy', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'obj_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 1,
      },
    ]);
  });

  it('[[H136]] clones a free-floating channel re-targeted to the duplicate', () => {
    const res = buildDuplicateNodeOps(animatedState(), 'box')!;
    const chAdd = res.ops.find(
      (o) => o.type === 'addNode' && (o as { nodeType: string }).nodeType === 'KeyframeChannelVec3',
    ) as { nodeId: string; params: { target: string; paramPath: string } } | undefined;
    expect(chAdd).toBeDefined();
    // the clone points at the duplicate, not the original.
    expect(chAdd!.params.target).toBe('box_copy');
    expect(chAdd!.params.paramPath).toBe('position');
    // the clone gets a fresh id.
    expect(chAdd!.nodeId).not.toBe('ch');
  });

  it('deep-copies the cloned channel params (mutating the clone op does not touch the source)', () => {
    const state = animatedState();
    const res = buildDuplicateNodeOps(state, 'box')!;
    const chAdd = res.ops.find(
      (o) => o.type === 'addNode' && (o as { nodeType: string }).nodeType === 'KeyframeChannelVec3',
    ) as { params: { keyframes: { value: number[] }[] } };
    chAdd.params.keyframes[0].value[0] = 99;
    expect(
      (state.nodes.ch.params as { keyframes: { value: number[] }[] }).keyframes[0].value[0],
    ).toBe(0);
  });

  it('returns null for a node that is not wired into the scene', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).box;
    expect(buildDuplicateNodeOps(state, 'box')).toBeNull();
  });

  it('cloned params are a deep copy (mutating the clone op does not touch the source)', () => {
    const state = fakeState();
    const res = buildDuplicateNodeOps(state, 'box')!;
    const addOp = res.ops[0] as { params: { size: number[] } };
    addOp.params.size[0] = 99;
    expect((state.nodes.box.params as { size: number[] }).size[0]).toBe(1);
  });
});
