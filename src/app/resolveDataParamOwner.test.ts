// resolveDataParamOwner — the object↔data split's "who owns this data param?" reach.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveDataParamOwner } from './resolveDataParamOwner';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** An Object (transform) pointing at a BoxData (geometry + material) via `data`. */
function splitPair(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'data',
    nodeType: 'BoxData',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'obj',
    nodeType: 'Object',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'data', socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  return s;
}

function fusedBox(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  }).next;
  return s;
}

describe('resolveDataParamOwner', () => {
  it('reaches through an Object to the BoxData for material + size', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'material')).toBe('data');
    expect(resolveDataParamOwner(s, 'obj', 'size')).toBe('data');
  });

  it('returns the Object itself for a transform param it owns', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'position')).toBe('obj');
    expect(resolveDataParamOwner(s, 'obj', 'scale')).toBe('obj');
  });

  it('returns the node itself for a fused mesh that owns the param directly', () => {
    const s = fusedBox();
    expect(resolveDataParamOwner(s, 'box', 'size')).toBe('box');
  });

  it('returns null when neither the node nor its data carries the param', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'radius')).toBeNull();
    expect(resolveDataParamOwner(s, 'missing', 'material')).toBeNull();
  });
});
