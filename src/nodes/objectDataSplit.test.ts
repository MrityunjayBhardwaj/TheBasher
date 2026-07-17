// #361 — Object↔data split, Phase 1. The byte-identical pin.
//
// An `Object → BoxData` pair must render byte-identically to a fused `BoxMesh`.
// "Render" reduces to two facts the renderer consumes: the geometry HANDLE (a
// deterministic `GeometryRef` key → one registry build → the same BufferGeometry)
// and the material spec (→ the same three.js material). This test pins both at the
// value level through the real DAG evaluate path, plus that the Object composes
// its TRS over the data. If a later change makes the Object build a different
// geometry key or a different material than the fused box, this goes red.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §7 (Phase 1) / §9 (test strategy).

import { describe, it, expect } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { registerAllNodes } from './registerAll';
import { sourceGeometryRef } from '../app/modifierGeometry';
import type { DagState, Op } from '../core/dag/types';
import type { BoxMeshValue, MeshDataValue, ObjectValue } from './types';

registerAllNodes();

const SIZE: [number, number, number] = [2, 3, 4];
const POS: [number, number, number] = [1, 2, 3];

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

describe('object↔data split (#361) — Object+BoxData ≡ a fused BoxMesh', () => {
  it('the Object→BoxData geometry handle is identical to the fused box handle', () => {
    // The data half.
    const dataState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const obj = evaluate(dataState, 'o').value as ObjectValue;
    expect(obj.kind).toBe('Object');
    const data = obj.data as MeshDataValue;
    expect(data.kind).toBe('MeshData');

    // The fused box, same size — its downstream geometry handle is what the
    // renderer/registry would build. sourceGeometryRef is the ONE box→handle
    // projection both roads share.
    const fusedState = build([
      { type: 'addNode', nodeId: 'b', nodeType: 'BoxMesh', params: { size: SIZE } },
    ]);
    const box = evaluate(fusedState, 'b').value as BoxMeshValue;
    const fusedRef = sourceGeometryRef(box);

    // Identical key ⇒ one shared registry build ⇒ byte-identical BufferGeometry.
    expect(data.geometry.key).toBe(fusedRef?.key);
    expect(data.geometry).toEqual(fusedRef);
  });

  it('the Object→BoxData material equals the fused box material', () => {
    const dataState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
    ]);
    const data = evaluate(dataState, 'd').value as MeshDataValue;

    const fusedState = build([
      { type: 'addNode', nodeId: 'b', nodeType: 'BoxMesh', params: { size: SIZE } },
    ]);
    const box = evaluate(fusedState, 'b').value as BoxMeshValue;

    // Same OpenPBR schema, same default color, same hydrate — byte-identical spec.
    expect(data.material).toEqual(box.material);
  });

  it('the Object owns the transform and points at its data (posable by construction)', () => {
    const state = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const obj = evaluate(state, 'o').value as ObjectValue;
    expect(obj.position).toEqual(POS);
    expect(obj.rotation).toEqual([0, 0, 0]);
    expect(obj.scale).toEqual([1, 1, 1]);
    expect((obj.data as MeshDataValue).kind).toBe('MeshData');
  });

  it('an Object with no data is an Empty (renders nothing, still posable)', () => {
    const state = build([
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
    ]);
    const obj = evaluate(state, 'o').value as ObjectValue;
    expect(obj.kind).toBe('Object');
    expect(obj.data).toBeNull();
    expect(obj.position).toEqual(POS);
  });
});
