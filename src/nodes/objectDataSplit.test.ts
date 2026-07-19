// #361 — Object↔data split, Phase 1. The byte-identical pin.
//
// An `Object → BoxData` pair must build the SAME geometry handle + material spec the box
// always had. "Render" reduces to two facts the renderer consumes: the geometry HANDLE (a
// deterministic `GeometryRef` key → one registry build → the same BufferGeometry) and the
// material spec (→ the same three.js material). This test pins both at the value level
// through the real DAG evaluate path, plus that the Object composes its TRS over the data.
//
// #365 Phase 5a (Slice 2): the fused `BoxMesh` value kind is retired, so the pin is now
// against the CANONICAL box→handle projection (`boxGeometryRef` — the one the fused box also
// used) and the canonical OpenPBR default material, not a live fused evaluate. Old-save
// byte-identity through the migration is proven separately by migrations.test.ts.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §7 (Phase 1) / §9 (test strategy).

import { describe, it, expect } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { registerAllNodes } from './registerAll';
import { boxGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import type { DagState, Op } from '../core/dag/types';
import type { MeshDataValue, ObjectValue } from './types';

// The box's default color — the value BoxData (and the retired fused box) seed the OpenPBR IR
// with. Kept in sync with BoxData.ts / the former BoxMesh.ts.
const BOX_DEFAULT_COLOR = '#5af07a';

registerAllNodes();

const SIZE: [number, number, number] = [2, 3, 4];
const POS: [number, number, number] = [1, 2, 3];

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

describe('object↔data split (#361) — Object+BoxData ≡ a fused BoxMesh', () => {
  it('the Object→BoxData geometry handle is the canonical box handle', () => {
    const dataState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const obj = evaluate(dataState, 'o').value as ObjectValue;
    expect(obj.kind).toBe('Object');
    const data = obj.data as MeshDataValue;
    expect(data.kind).toBe('MeshData');

    // boxGeometryRef is the ONE box→handle projection the renderer/registry builds from —
    // the same one the retired fused box used. Identical key ⇒ one shared registry build ⇒
    // byte-identical BufferGeometry.
    const canonicalRef = boxGeometryRef(SIZE);
    expect(data.geometry.key).toBe(canonicalRef.key);
    expect(data.geometry).toEqual(canonicalRef);
  });

  it('the Object→BoxData material is the canonical OpenPBR default', () => {
    const dataState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
    ]);
    const data = evaluate(dataState, 'd').value as MeshDataValue;

    // The same OpenPBR schema + hydrate the box always used (formerly BoxMesh, now BoxData) —
    // a complete, byte-identical inline material spec.
    const expectedMaterial = hydrateInlineMaterial(
      openpbrMaterialSchema(BOX_DEFAULT_COLOR).parse(undefined),
      BOX_DEFAULT_COLOR,
    );
    expect(data.material).toEqual(expectedMaterial);
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
