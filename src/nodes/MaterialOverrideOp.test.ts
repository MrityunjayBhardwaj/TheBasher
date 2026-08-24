// #682 — the override composes onto the SELECTED faces only, and the faces outside the
// selection keep the material they arrived with.
//
// ── WHY THE SLOT-0 ASSERTION IS THE ONE THAT MATTERS ──────────────────────────────────
//
// The honouring cross-check (`operatorScopeHonouring.gate.test.ts`) asks only whether a
// subset selection makes the output MOVE. That is the right question for a census over every
// scoped operator, and it is satisfied by any arm that emits something different — including
// one that composes onto the wrong faces, or one that quietly re-materials the whole mesh
// and merely changes the key. So the rows below assert WHICH faces changed, by reading the
// slot table the append arm emits: slot 0 must be the source's own material, untouched.
//
// REF: src/nodes/MaterialOverrideOp.ts (the two arms); src/nodes/SetMaterialOp.ts (the
//      index-and-slot-table road this reuses); src/nodes/meshAttributes.ts
//      (`mintTargetedAttributes`); issue #682, ns-2 step 17.

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveComponentSelection, SCOPE_PARAM } from './componentSelection';
import { registerAllNodes } from './registerAll';
import { MaterialOverrideOpNode, MaterialOverrideOpParams } from './MaterialOverrideOp';
import { boxDescriptor, boxGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { SetMaterialOpNode } from './SetMaterialOp';
import { modifierDataSource } from '../app/modifierDataSource';
import type { MeshDataValue, ModifiedDataValue, ObjectData } from './types';

const SOURCE_MATERIAL = hydrateInlineMaterial(null, '#ff0000');

function boxData(): MeshDataValue {
  // Folded through the producer's own mint, never hand-built — a stand-in that skipped the
  // fold would hand this a source whose key carries no component ([[H328]]).
  const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], key),
    material: SOURCE_MATERIAL,
    materialKey: null,
    attributeKey: key,
  };
}

/** Run the operator exactly as the evaluator does — the resolver produces the selection. */
function evalOp(params: Record<string, unknown>, src: ObjectData): unknown {
  const parsed = MaterialOverrideOpParams.parse({
    color: '#00ff00',
    overridden: { color: true },
    ...params,
  });
  return MaterialOverrideOpNode.evaluate(
    parsed,
    { target: src } as never,
    undefined as never,
    resolveComponentSelection(src, parsed as unknown as Record<string, unknown>, 'face'),
  );
}

beforeEach(() => {
  registerAllNodes();
});

describe('#682 — a scoped override composes onto the selection only', () => {
  it('🔴 THE DISCRIMINATING ROW — slot 0 keeps the SOURCE material, slot 1 wears the override', () => {
    // A box is twelve faces. Scoping to six is a proper subset, so the append arm runs and
    // the two slots must say different things: the faces outside the selection are still
    // wearing what they arrived in. An implementation that composed onto everything and only
    // re-keyed the geometry would pass the honouring cross-check and red here.
    const out = evalOp({ [SCOPE_PARAM]: '0-5' }, boxData()) as ModifiedDataValue;

    expect(out.materialSlots).toBeDefined();
    expect(out.materialSlots).toHaveLength(2);
    // Slot 0 is the source's own material, by identity — not a copy, and not a hydrated
    // stand-in. Composing onto it would be the defect this row exists to catch.
    expect(out.materialSlots![0]).toBe(SOURCE_MATERIAL);
    // Slot 1 wears the override, and it is NOT the source material.
    expect(out.materialSlots![1]).not.toBe(SOURCE_MATERIAL);
    expect(out.material).toBe(out.materialSlots![1]);
    // The geometry is re-minted so two differently-scoped objects cannot collide on one
    // cached build — the group layout lives on the shared instance.
    expect(out.attributeKey).toBeDefined();
    expect(out.geometry.key).not.toBe(boxData().geometry.key);
  });

  it('a TOTAL selection takes the replace arm, byte-identical to the unscoped emission', () => {
    // The invariance that keeps this from being a semantics change to a shipped node: blank
    // is the same authoring state as absent, both mean every face, and every face receiving
    // the composition is exactly what this operator did before it honoured anything.
    const blank = evalOp({ [SCOPE_PARAM]: '' }, boxData()) as ModifiedDataValue;

    expect(Object.keys(blank).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(blank.materialSlots).toBeUndefined();
    // The geometry rides through UNTOUCHED — over a total selection this operator still has
    // an opinion about the material only.
    expect(blank.geometry).toBe(blank.geometry);
    expect(blank.geometry.key).toBe(boxData().geometry.key);
  });

  it('an explicit TOTAL query is the same answer as a blank one — the arm is the coverage', () => {
    // `0-11` names every face of a box, so it is a total selection spelled the long way. The
    // arm is chosen from the COVERAGE and not from whether a query was authored, which is
    // what stops a director who typed the full range from getting a slot table nobody needs.
    const explicit = evalOp({ [SCOPE_PARAM]: '0-11' }, boxData()) as ModifiedDataValue;
    expect(explicit.materialSlots).toBeUndefined();
    expect(Object.keys(explicit).sort()).toEqual(['geometry', 'kind', 'material']);
  });

  it('a source with no derivable face count takes the replace arm, and the AUTHORED case throws upstream', () => {
    // Declared limit, shared with `SetMaterialOp`: a glTF handle's buffers live in an asset
    // clone, so there is no domain to scope over. Emitting a table with no index behind it
    // would report one used slot and the override would silently vanish from a mesh the
    // director just styled.
    //
    // 🔴 THE SCOPE HERE IS BLANK, AND THAT IS NOT AN ARBITRARY FIXTURE CHOICE — IT IS THE
    // ONLY WAY THIS ARM IS REACHABLE. Measured: an AUTHORED scope over a glTF source never
    // arrives, because the resolver refuses it first by name ("has no derivable face count
    // … so the authored scope '0-5' cannot be honoured"). So `targeted === null` inside
    // `evaluate` means a TOTAL selection over an underivable source, never a narrowed one,
    // and the second half of that is asserted below rather than assumed.
    const gltfSource: MeshDataValue = {
      kind: 'MeshData',
      geometry: {
        key: 'gltf|asset-x|child-y',
        descriptor: { kind: 'gltf', assetRef: 'asset-x', childName: 'child-y' },
      },
      material: SOURCE_MATERIAL,
      materialKey: null,
      attributeKey: null,
    };
    const out = evalOp({ [SCOPE_PARAM]: '' }, gltfSource) as ModifiedDataValue;

    expect(Object.keys(out).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(out.geometry).toBe(gltfSource.geometry);

    // The authored case, refused upstream — so the limit is enforced where the director can
    // be told about it, not silently absorbed into an arm that drops the scope.
    expect(() => evalOp({ [SCOPE_PARAM]: '0-5' }, gltfSource)).toThrow(
      /has no derivable face count/,
    );
  });

  it('refuses an absent selection by name — the declaration and the refusal are one claim', () => {
    // The runtime half of `scope: { kind: 'target' }`. `vitest` checks no types and
    // `typecheck` excludes test files, so both standing gates are blind to a caller that
    // omits the argument; the refusal is the only thing between that and a silent
    // "scope everything" ([[H327]]).
    expect(() =>
      MaterialOverrideOpNode.evaluate(
        MaterialOverrideOpParams.parse({}),
        { target: boxData() } as never,
        undefined as never,
        undefined as never,
      ),
    ).toThrow(/MaterialOverrideOp\.evaluate was called with no resolved selection/);
  });
});

const WIRED = [
  {
    kind: 'OpenPBRMaterial',
    spec: openpbrMaterialSchema().parse({ name: 'wired', base: { color: '#0000ff' } }),
  },
];

/** Run `SetMaterialOp` the way the evaluator does — the twin, for the mixed-stack rows. */
function evalSet(params: { scope?: string }, src: ObjectData): ObjectData {
  const full = { muted: false, scope: '', ...params };
  return SetMaterialOpNode.evaluate(
    full,
    { target: src, material: WIRED },
    undefined as never,
    resolveComponentSelection(src, full, 'face'),
  ) as ObjectData;
}

describe('#699 — the declared limit this shares with SetMaterialOp, pinned on THIS side too', () => {
  // The twin has carried a row for this since #638; this operator was collapsing identically
  // with neither a declaration nor a row. The point is not that two slots is RIGHT — it is
  // that the number is a DECISION (#647 owes the merge rule) and must not drift into
  // something else in silence, on one operator and not the other.
  //
  // ⚠️ THE REASON IS NOT THAT THE SOURCE CANNOT CARRY A TABLE. #691 widened
  // `ModifierDataSource` with `materialSlots` and `modifierDataSource` forwards the pair
  // whole, so the lower op's table IS reachable here. The append arm does not read it.

  it('override OVER override — two slots, not three, and the ORIGINAL base is gone', () => {
    const first = evalOp({ [SCOPE_PARAM]: '0-5' }, boxData()) as ModifiedDataValue;
    expect(first.materialSlots).toHaveLength(2);
    expect(first.materialSlots![0]).toBe(SOURCE_MATERIAL);

    // A DISJOINT scope on the second op — the case a director reaches for wanting three
    // materials. Disjoint matters: overlapping ranges could yield two slots for a reason
    // with nothing to do with the collapse, and the row would pin the wrong thing.
    const second = evalOp({ [SCOPE_PARAM]: '6-11' }, first) as ModifiedDataValue;
    expect(second.materialSlots).toHaveLength(2);

    // 🔴 THE DISCRIMINATING ASSERTION. Slot 0 is now the FIRST op's composed material, so the
    // material the mesh originally arrived in is no longer anywhere in the table. Faces 0-5,
    // which the first op deliberately left untouched, now index a slot wearing the first
    // override. That is the collapse, stated rather than discovered.
    expect(second.materialSlots![0]).not.toBe(SOURCE_MATERIAL);
    expect(second.materialSlots![0]).toBe(first.material);
    // 🔑 AND THE TABLE WAS REACHABLE — read through the SAME classifier the operator calls,
    // not off the value, because what is in question is the second op's VIEW of its source.
    // This is what makes the collapse a choice rather than an inability, and it is the
    // assertion that reds if a future `modifierDataSource` ever stops forwarding the pair.
    expect(modifierDataSource(first)!.materialSlots).toHaveLength(2);
  });

  it('override over a SetMaterialOp collapses the same way — the mixed stack is not special', () => {
    const set = evalSet({ scope: '0-5' }, boxData()) as ModifiedDataValue;
    expect(set.materialSlots).toHaveLength(2);

    const over = evalOp({ [SCOPE_PARAM]: '6-11' }, set) as ModifiedDataValue;
    expect(over.materialSlots).toHaveLength(2);
    expect(over.materialSlots![0]).toBe(set.material);
    expect(over.materialSlots![0]).not.toBe(SOURCE_MATERIAL);
  });

  it('and the reverse order collapses too — SetMaterialOp over an override', () => {
    // Both orders, because a merge rule landing on one operator would leave the other free
    // to disagree about what stacking means, and nothing today would red.
    const over = evalOp({ [SCOPE_PARAM]: '0-5' }, boxData()) as ModifiedDataValue;
    const set = evalSet({ scope: '6-11' }, over) as ModifiedDataValue;

    expect(set.materialSlots).toHaveLength(2);
    expect(set.materialSlots![0]).toBe(over.material);
    expect(set.materialSlots![0]).not.toBe(SOURCE_MATERIAL);
  });
});
