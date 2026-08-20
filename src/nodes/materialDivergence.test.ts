// #645 — TWO BRANCHES OVER ONE GEOMETRY NODE WEAR DIFFERENT MATERIALS, AND STILL SHARE ONE
// `BufferGeometry`. The capability #645 asks for, measured on the shipped operator road.
//
// ── WHY THESE ROWS EXIST AT ALL ───────────────────────────────────────────────────────
//
// #645 proposes an object-level slot table so two Objects sharing one data node can wear
// different materials, citing Blender's `material_slots[n].link = OBJECT`. Before building a
// mechanism it was worth asking whether the road already carries the capability. It does —
// and these rows keep it carried, because nothing else asserts it end to end: the operator
// tests stop at the emitted value and never resolve a `BufferGeometry`.
//
// ── THE REFERENCE, AND THE ONE ROW WHERE WE DIVERGE FROM IT ───────────────────────────
//
// `ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md` §6 measured Blender re-pointing one
// object's slot while two others keep the shared material:
//
//   A's effective material   -> the override      (they differ)
//   B, C effective material  -> the shared one    (untouched)
//   shared material datablock-> NEVER written
//   A's eval instance is B's -> False   ← Blender LOSES instance sharing for the diverging one
//   B's eval instance is C's -> True
//
// Basher matches every row except the fourth, and matches it BETTER: both branches resolve to
// ONE `BufferGeometry`, because the slot table is not part of the geometry key — only the
// attribute INDEX is. Divergence in the table is therefore free of the geometry cache, which
// is the property the object/data split was drawn to preserve.
//
// ⚠️ WHAT THESE ROWS DO NOT SHOW, STATED SO THE GREEN IS NOT READ AS MORE THAN IT IS. Two
// Object nodes reading ONE data node receive the identical value; the divergence here is
// built by putting an operator in each branch, which makes them two data VALUES. The
// authoring affordance #645 is really about — diverging without an operator per branch — is
// not shown here and is not shipped.
//
// REF: ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md §6 (the re-point probe) and §7.2
//      (the instrument trap: a data-side read agrees for every non-overridden object);
//      src/app/geometryRegistry.ts (the key -> instance cache); src/nodes/MaterialOverrideOp.ts
//      (the append arm); issues #645, #638.

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveComponentSelection, SCOPE_PARAM } from './componentSelection';
import { registerAllNodes } from './registerAll';
import { MaterialOverrideOpNode, MaterialOverrideOpParams } from './MaterialOverrideOp';
import { boxDescriptor, boxGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { hydrateInlineMaterial } from './materialSchema';
import { getForRead } from '../app/geometryRegistry';
import type { MeshDataValue, ModifiedDataValue, ObjectData } from './types';

const SOURCE_MATERIAL = hydrateInlineMaterial(null, '#ff0000');

/** ONE data node. Both branches below read this same value — that is the point. */
function sharedBoxData(): MeshDataValue {
  const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], key),
    material: SOURCE_MATERIAL,
    materialKey: null,
    attributeKey: key,
  };
}

function evalOverride(color: string, scope: string, src: ObjectData): ModifiedDataValue {
  const parsed = MaterialOverrideOpParams.parse({
    color,
    overridden: { color: true },
    [SCOPE_PARAM]: scope,
  });
  return MaterialOverrideOpNode.evaluate(
    parsed,
    { target: src } as never,
    undefined as never,
    resolveComponentSelection(src, parsed as unknown as Record<string, unknown>),
  ) as ModifiedDataValue;
}

beforeEach(() => {
  registerAllNodes();
});

describe('#645 — divergent materials over one shared geometry', () => {
  it('the two branches wear DIFFERENT materials, and the shared one is never written', () => {
    const shared = sharedBoxData();
    const a = evalOverride('#00ff00', '0-5', shared);
    const b = evalOverride('#0000ff', '0-5', shared);

    // They differ where the override landed.
    expect(a.materialSlots?.[1]).not.toEqual(b.materialSlots?.[1]);

    // 🔴 AND THE SHARED RESOURCE IS UNTOUCHED — Blender §6's "shared material datablock:
    // never written". By IDENTITY, not equality: a composed copy that merely looked the same
    // would mean the override had reached the source, which is the defect this asserts away.
    expect(a.materialSlots?.[0]).toBe(SOURCE_MATERIAL);
    expect(b.materialSlots?.[0]).toBe(SOURCE_MATERIAL);
  });

  it('🔑 AND THEY STILL RESOLVE TO ONE BufferGeometry — the row Blender cannot match', () => {
    const shared = sharedBoxData();
    const a = evalOverride('#00ff00', '0-5', shared);
    const b = evalOverride('#0000ff', '0-5', shared);

    // The key is the same because the TABLE is not in it — only the attribute index is.
    expect(a.geometry.key).toBe(b.geometry.key);

    const ga = getForRead(a.geometry);
    const gb = getForRead(b.geometry);
    expect(ga).not.toBeNull();
    // Instance identity, the translation of Blender's `A's eval instance is B's`. There it is
    // False; here it must be True, and a regression to one-build-per-branch reds here.
    expect(ga).toBe(gb);

    // The scoping genuinely landed rather than the table riding along unused: a box is 12
    // faces / 36 index entries, and faces 0-5 must sit at slot 1.
    expect(ga!.groups).toEqual([
      { start: 0, count: 18, materialIndex: 1 },
      { start: 18, count: 18, materialIndex: 0 },
    ]);
  });

  it('differently-scoped branches re-mint, so two scopes cannot collide on one build', () => {
    const shared = sharedBoxData();
    const a = evalOverride('#00ff00', '0-5', shared);
    const c = evalOverride('#00ff00', '6-11', shared);

    // Same colour, different faces — if the key ignored the index these would share a build
    // and one of the two would draw the other's groups.
    expect(a.geometry.key).not.toBe(c.geometry.key);
  });
});
