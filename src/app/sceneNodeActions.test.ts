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

describe('buildDeleteNodesOps', () => {
  it('disconnects every consumer edge before removing the node', () => {
    const ops = buildDeleteNodesOps(fakeState(), ['box']);
    expect(ops).toEqual([
      { type: 'disconnect', from: { node: 'box', socket: 'out' }, to: { node: 'scene', socket: 'children' } },
      { type: 'removeNode', nodeId: 'box' },
    ]);
  });
});

describe('buildDuplicateNodeOps', () => {
  it('duplicates a leaf as a sibling right after the original', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'box');
    expect(res?.newRootId).toBe('box_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'box_copy', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
      { type: 'connect', from: { node: 'box_copy', socket: 'out' }, to: { node: 'scene', socket: 'children' }, index: 1 },
    ]);
  });

  it('deep-copies a Group subtree, re-wiring internal edges to the clones', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'grp');
    expect(res?.newRootId).toBe('grp_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'grp_copy', nodeType: 'Group', params: { position: [5, 0, 0] } },
      { type: 'addNode', nodeId: 'inner_copy', nodeType: 'BoxMesh', params: { size: [2, 2, 2] } },
      // internal edge points at the CLONE child, not the original.
      { type: 'connect', from: { node: 'inner_copy', socket: 'out' }, to: { node: 'grp_copy', socket: 'children' }, index: 0 },
      // new root wired after the original (grp was index 1 → copy at 2).
      { type: 'connect', from: { node: 'grp_copy', socket: 'out' }, to: { node: 'scene', socket: 'children' }, index: 2 },
    ]);
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
