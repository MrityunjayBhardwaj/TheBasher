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
import {
  boxDescriptor,
  boxGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
} from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import type { DagState, Op } from '../core/dag/types';
import type { MeshDataValue, ObjectValue } from './types';

// #394 D7 — THE standard base colour, spelled as a LITERAL on purpose.
//
// This used to be two constants (box green, sphere blue) and the expectations were built by
// calling the schema under test — so each assertion read `schema == schema` and could not fail
// when the colour moved. Measured: changing every new primitive's colour left all 3206 tests
// green. Writing the literal is what makes these assertions able to fail.
const STANDARD_BASE_COLOR = '#cccccc';

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
    // #638 — the canonical handle now folds the attribute component in, so the canonical
    // call has to answer the attribute question the same way the producer does. Passing
    // `null` here would compare the producer's folded key against an unfolded one and red
    // for the fold rather than for drift; passing the mint keeps the assertion about what
    // it was always about — that there is ONE projection.
    const canonicalRef = boxGeometryRef(SIZE, mintMeshAttributes(boxDescriptor(SIZE)));
    expect(data.geometry.key).toBe(canonicalRef.key);
    expect(data.geometry).toEqual(canonicalRef);
  });

  it('the Object→BoxData material is the canonical OpenPBR default', () => {
    const dataState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
    ]);
    const data = evaluate(dataState, 'd').value as MeshDataValue;

    // The colour is asserted as a literal — the part that can actually fail (#394 D7).
    expect(data.material!.base.color).toBe(STANDARD_BASE_COLOR);
    // The remaining lobes are a complete, byte-identical inline material spec.
    const expectedMaterial = hydrateInlineMaterial(openpbrMaterialSchema().parse(undefined));
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

// #384 (Stage C · C1) — the sphere's data half. Same byte-identity pin as the box:
// SphereData produces the canonical `MeshData` value + the canonical `sphereGeometryRef`
// handle the fused `SphereMesh` (and the read road) build, so an Object→SphereData pair
// renders byte-identically to a fused sphere. SphereMesh still coexists in Slice 1.
describe('object↔data split (#384) — Object+SphereData ≡ a fused SphereMesh', () => {
  // Non-default geometry params on purpose: a dropped param would still read the 0.5/24/16
  // defaults and pass vacuously (H180). These prove the params actually flow into the handle.
  const RADIUS = 1.3;
  const WIDTH_SEGMENTS = 32;
  const HEIGHT_SEGMENTS = 20;

  it('the Object→SphereData geometry handle is the canonical sphere handle', () => {
    const dataState = build([
      {
        type: 'addNode',
        nodeId: 'd',
        nodeType: 'SphereData',
        params: { radius: RADIUS, widthSegments: WIDTH_SEGMENTS, heightSegments: HEIGHT_SEGMENTS },
      },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const obj = evaluate(dataState, 'o').value as ObjectValue;
    expect(obj.kind).toBe('Object');
    const data = obj.data as MeshDataValue;
    expect(data.kind).toBe('MeshData');

    // sphereGeometryRef is the ONE sphere→handle projection the renderer/registry builds
    // from — the same one the fused sphere + the read road use. Identical key ⇒ one shared
    // registry build ⇒ byte-identical BufferGeometry (H40, no drift).
    // #638 — folded, for the reason spelled out on the box case above.
    const sphereDesc = sphereDescriptor(RADIUS, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
    const canonicalRef = sphereGeometryRef(
      RADIUS,
      WIDTH_SEGMENTS,
      HEIGHT_SEGMENTS,
      mintMeshAttributes(sphereDesc),
    );
    expect(data.geometry.key).toBe(canonicalRef.key);
    expect(data.geometry).toEqual(canonicalRef);
  });

  it('a default SphereData yields the canonical default sphere handle key', () => {
    const dataState = build([{ type: 'addNode', nodeId: 'd', nodeType: 'SphereData', params: {} }]);
    const data = evaluate(dataState, 'd').value as MeshDataValue;
    // The defaults SphereMesh always shipped: radius 0.5, 24×16 segments — and, since
    // #638, the attribute component the producer folds in. The BASE is still asserted as
    // a literal, because that is the half a param change can break; the component is
    // asserted as the mint's own output rather than as a hash literal nobody can check.
    expect(data.geometry.key).toBe(
      `sphere|0.5|24|16|a:${mintMeshAttributes(sphereDescriptor(0.5, 24, 16))}`,
    );
  });

  it('the Object→SphereData material is the canonical OpenPBR default', () => {
    const dataState = build([{ type: 'addNode', nodeId: 'd', nodeType: 'SphereData', params: {} }]);
    const data = evaluate(dataState, 'd').value as MeshDataValue;

    expect(data.material!.base.color).toBe(STANDARD_BASE_COLOR);
    const expectedMaterial = hydrateInlineMaterial(openpbrMaterialSchema().parse(undefined));
    expect(data.material).toEqual(expectedMaterial);
  });

  // #394 D7 — the reference's answer, asserted directly. Measured on Blender 5.1.1:
  // `primitive_cube_add` and `primitive_uv_sphere_add` produce IDENTICAL material state
  // (`data.materials == []`, `slot_count == 0`). No reference gives a primitive a special
  // material. This is the assertion a re-introduced per-primitive colour has to break.
  it('a new box and a new sphere carry the SAME material — there is no per-primitive colour', () => {
    const boxState = build([
      { type: 'addNode', nodeId: 'b', nodeType: 'BoxData', params: { size: SIZE } },
    ]);
    const sphereState = build([
      { type: 'addNode', nodeId: 's', nodeType: 'SphereData', params: {} },
    ]);
    const box = evaluate(boxState, 'b').value as MeshDataValue;
    const sphere = evaluate(sphereState, 's').value as MeshDataValue;
    expect(box.material).toEqual(sphere.material);
    expect(box.material!.base.color).toBe(STANDARD_BASE_COLOR);
  });
});
