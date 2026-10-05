// #1451 — an import has no wrapper Group to carry an offset, so `offsetTopLevel` moves what the
// import hangs straight under the scene, with its position keys and their handles, as a parent's
// offset would carry them. What hangs below rides along untouched; zero leaves the ops as they are.
import { describe, expect, it } from 'vitest';
import type { Op } from '../dag/types';
import { offsetTopLevel, parentEdge } from './modelImport';

const ops: Op[] = [
  { type: 'addNode', nodeId: 'top', nodeType: 'Object', params: { position: [1, 2, 3] } },
  { type: 'addNode', nodeId: 'bare', nodeType: 'Group', params: {} },
  { type: 'addNode', nodeId: 'child', nodeType: 'Object', params: { position: [5, 5, 5] } },
  {
    type: 'addNode',
    nodeId: 'top_keys',
    nodeType: 'KeyframeChannelVec3',
    params: {
      target: 'top',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], outHandle: { time: 0.5, value: [1, 0, 0] } },
        { time: 1, value: [0, 1, 0], inHandle: { time: 0.5, value: [0, 1, 1] } },
      ],
    },
  },
  {
    type: 'addNode',
    nodeId: 'child_keys',
    nodeType: 'KeyframeChannelVec3',
    params: { target: 'child', paramPath: 'position', keyframes: [{ time: 0, value: [0, 0, 0] }] },
  },
  parentEdge('top', 'scene'),
  parentEdge('bare', 'scene'),
  parentEdge('child', 'top'),
];
const params = (out: Op[], id: string) =>
  (out.find((o) => o.type === 'addNode' && o.nodeId === id) as { params: Record<string, unknown> })
    .params;

describe('#1451 — offsetTopLevel', () => {
  const out = offsetTopLevel(ops, 'scene', [10, 0, -1]);

  it('moves each node the scene holds, a bare one from the origin', () => {
    expect(params(out, 'top').position).toEqual([11, 2, 2]);
    expect(params(out, 'bare').position).toEqual([10, 0, -1]);
  });

  it('moves their position keys and handles with them', () => {
    expect(params(out, 'top_keys').keyframes).toEqual([
      { time: 0, value: [10, 0, -1], outHandle: { time: 0.5, value: [11, 0, -1] } },
      { time: 1, value: [10, 1, -1], inHandle: { time: 0.5, value: [10, 1, 0] } },
    ]);
  });

  it('leaves what hangs below them, and its keys, where the file puts it', () => {
    expect(params(out, 'child').position).toEqual([5, 5, 5]);
    expect(params(out, 'child_keys')).toEqual(params(ops, 'child_keys'));
  });

  it('an offset of zero returns the ops as they are', () => {
    expect(offsetTopLevel(ops, 'scene', [0, 0, 0])).toEqual(ops);
  });
});
