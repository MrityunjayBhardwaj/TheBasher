// #638 (ns-1b step 6) — the FIRST authoring surface for a per-face material assignment,
// and the invariance that keeps it from being a semantics change to a shipped node.
//
// ── WHY THE FULL-RANGE ASSERTION IS WRITTEN THE WAY IT IS ─────────────────────────────
//
// The claim is *"given the same source value, a full-range op emits what it emitted before
// the range existed"*, and it has to be written in that form or it is unsatisfiable: the
// SOURCE value's own geometry key changed one step earlier, when the attribute component
// folded into it. Conflating the two makes the assertion fail for a reason that has nothing
// to do with this step. So the expectation here is a FROZEN LITERAL — the exact shape, and
// the exact key set — rather than a comparison against another call of the same code. A
// parity assertion whose two sides both run through the function under test cannot see that
// function change; the frozen side is the one the derivation cannot reach.
//
// REF: src/nodes/SetMaterialOp.ts (the two arms); src/nodes/meshAttributes.ts (the range
//      mint); src/app/modifierGeometry.ts (`refWithAttributeKey`);
//      src/app/attributeStore.ts (the growth counters); issues #638, #394.

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { resolveComponentSelection } from './componentSelection';
import { __reseedAllNodesForTests } from './registerAll';
import { SetMaterialOpNode } from './SetMaterialOp';
import { boxDescriptor, boxGeometryRef, sphereDescriptor } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { hydrateInlineMaterial } from './materialSchema';
import { openpbrMaterialSchema } from './materialSchema';
import {
  growthBySource,
  read as readAttributes,
  residentCount,
  resetGrowth,
} from '../app/attributeStore';
import { MATERIAL_INDEX } from './attributes';
import { rebuildGeometryRef } from '../app/modifierGeometry';
import { sphereGeometryRef } from '../app/modifierGeometry';
import type { MeshDataValue, ModifiedDataValue, ObjectData } from './types';

/** The wired Material value, in the shape the socket carries it. */
const WIRED = [
  {
    kind: 'OpenPBRMaterial',
    spec: openpbrMaterialSchema().parse({ name: 'wired', base: { color: '#00ff00' } }),
  },
];

const SOURCE_MATERIAL = hydrateInlineMaterial(null, '#ff0000');

function boxData(): MeshDataValue {
  // Folded through the producer's own mint, never hand-built: a stand-in that skipped the
  // fold would hand this step a source whose key carries no component, and the assertions
  // below would then be about a value no producer emits.
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')),
    material: SOURCE_MATERIAL,
    materialKey: null,
    attributeKey: mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate'),
  };
}

const evalOp = (
  params: { muted?: boolean; faceFrom?: number; faceTo?: number },
  target: ObjectData | undefined,
) => {
  // ns-2 step 9b — the fourth argument goes through the ONE resolver, exactly as the
  // evaluator does; see `ArrayModifier.test.ts` for why this helper stays a DIRECT call.
  const full = { muted: false, faceFrom: 0, faceTo: -1, ...params };
  return SetMaterialOpNode.evaluate(
    full,
    { target, material: WIRED },
    undefined as never,
    resolveComponentSelection(target, full),
  ) as ObjectData;
};

// The store never removes entries (its own declared limit), so only the COUNTERS reset
// between cases. Every growth case below therefore uses a source whose sets no earlier case
// can have made resident — otherwise a content-keyed hit would report as zero growth and the
// measurement would be about test ORDER rather than about the fold.
beforeEach(() => {
  resetGrowth();
  // The mute is honoured by the evaluator now (ns-2 step 5), and the evaluator resolves
  // the definition through the registry — so this file needs the registry seeded, which
  // a definition-only test never did before.
  __reseedAllNodesForTests();
});

describe('#638 SetMaterialOp — the full range still REPLACES, byte for byte', () => {
  it('emits exactly the pre-range shape: no table, no index, the source geometry itself', () => {
    const src = boxData();
    const out = evalOp({ faceTo: -1 }, src) as ModifiedDataValue;

    // The FIELD SET, frozen. A table appearing here is the semantics change this split
    // exists to prevent, and it would be invisible to a field-by-field check that only
    // looks at the fields it knows about.
    expect(Object.keys(out).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(out.kind).toBe('ModifiedData');
    // The SAME handle object, not an equal one — a full-range op has no opinion about
    // geometry, so it must not re-mint one.
    expect(out.geometry).toBe(src.geometry);
    expect(out.material).toMatchObject({ base: { color: '#00ff00' } });
  });

  it('a range that covers every face is the SAME replace arm — bounds, not just the sentinel', () => {
    const src = boxData();
    const sentinel = evalOp({ faceFrom: 0, faceTo: -1 }, src);
    const bounds = evalOp({ faceFrom: 0, faceTo: 11 }, src); // a box is 12 triangles
    expect(Object.keys(bounds).sort()).toEqual(Object.keys(sentinel).sort());
    expect((bounds as ModifiedDataValue).geometry).toBe(src.geometry);
  });

  it('mute and an unwired socket are untouched by the range existing', () => {
    const src = boxData();
    // The mute goes THROUGH THE EVALUATOR (ns-2 step 5, #660): it is declared in
    // `chain.bypass` and honoured by the machinery, so `evaluate` never runs when muted.
    // The unwired-socket arm below is the operator's OWN guard and stays a direct call —
    // the two used to sit side by side and are now genuinely different kinds of claim.
    expect(
      evaluateNodeAlone(
        'SetMaterialOp',
        { muted: true, faceFrom: 0, faceTo: 1 },
        { target: src, material: WIRED },
      ),
    ).toBe(src);
    expect(
      SetMaterialOpNode.evaluate(
        { muted: false, faceFrom: 0, faceTo: 1 },
        { target: src, material: [] },
        undefined as never,
        resolveComponentSelection(src, { muted: false, faceFrom: 0, faceTo: 1 }),
      ),
    ).toBe(src);
  });
});

describe('#638 SetMaterialOp — a partial range APPENDS, which nothing could express before', () => {
  it('two slots, the source material on slot 0, and an index that names the range', () => {
    const src = boxData();
    const out = evalOp({ faceFrom: 0, faceTo: 1 }, src) as ModifiedDataValue;

    expect(out.materialSlots).toHaveLength(2);
    expect(out.materialSlots![0]).toBe(SOURCE_MATERIAL); // slot 0 keeps the source's
    expect(out.materialSlots![1]).toMatchObject({ base: { color: '#00ff00' } });
    expect(out.attributeKey).toEqual(expect.any(String));

    // The index itself — faces 0 and 1 on slot 1, the other ten on slot 0. `faceTo` is
    // INCLUSIVE (Houdini's group ranges are), so `0..1` is two faces, not one.
    const index = readAttributes(out.attributeKey!)![MATERIAL_INDEX];
    expect([...index.data]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(index.count).toBe(12);
    expect(index.domain).toBe('face');
  });

  it('the geometry is RE-MINTED, so two assignments cannot collide on one cached build', () => {
    const src = boxData();
    const a = evalOp({ faceFrom: 0, faceTo: 1 }, src) as ModifiedDataValue;
    const b = evalOp({ faceFrom: 0, faceTo: 5 }, src) as ModifiedDataValue;

    expect(a.geometry.key).not.toBe(src.geometry.key);
    expect(a.geometry.key).not.toBe(b.geometry.key);
    // The component REPLACES the source's, never stacks on it: two components in one key
    // would name a geometry with two answers about what its faces are made of.
    expect(a.geometry.key.match(/\|a:/g)).toHaveLength(1);
    expect(a.geometry.key.startsWith('box|1,1,1|a:')).toBe(true);
    // Same descriptor, different key — the build is the same shape with a different layout.
    expect(a.geometry.descriptor).toEqual(src.geometry.descriptor);
    expect(a.geometry.attributeKey).toBe(a.attributeKey);
  });

  it('an INVERTED range assigns nothing, and needs no arm anywhere to say so', () => {
    const out = evalOp({ faceFrom: 5, faceTo: 2 }, boxData()) as ModifiedDataValue;
    const index = readAttributes(out.attributeKey!)![MATERIAL_INDEX];
    expect([...index.data].every((v) => v === 0)).toBe(true);
  });

  it('a source whose face count is not derivable REPLACES — the declared limit, pinned', () => {
    // A glTF handle has no descriptor the face count can be read from, so there is no
    // domain to write a range onto. Replacing is the honest answer: the director's wired
    // material still reaches the mesh. A table with no index behind it would report one
    // used slot and drop the wired material silently.
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
    const out = evalOp({ faceFrom: 0, faceTo: 1 }, gltfSource) as ModifiedDataValue;
    expect(Object.keys(out).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(out.geometry).toBe(gltfSource.geometry);
  });

  it('ONLY THE LOWEST op in a stack contributes a table — the declared limit, pinned', () => {
    // The second op reads its source through `modifierDataSource`, which carries
    // `{geometry, material}` and nothing else, so the first op's table is not visible to
    // it. A director stacking two ops expecting three slots gets two, and this is the test
    // that reds if that ever changes silently rather than by decision.
    const first = evalOp({ faceFrom: 0, faceTo: 1 }, boxData()) as ModifiedDataValue;
    expect(first.materialSlots).toHaveLength(2);

    const second = evalOp({ faceFrom: 2, faceTo: 3 }, first) as ModifiedDataValue;
    expect(second.materialSlots).toHaveLength(2);
    // And the first op's own slot 0 — the original source material — is gone from the
    // table, replaced by the first op's single `material` field.
    expect(second.materialSlots![0]).not.toBe(SOURCE_MATERIAL);
  });
});

describe('#638 the growth measurement step 4 could not take', () => {
  it('a faceTo DRAG adds one attribute set per distinct range, not per frame', () => {
    // 🔑 THIS IS THE DISCRIMINATING NUMBER OF THE WHOLE PHASE. Step 4 measured ZERO
    // growth and recorded that as the expected finding: every producer that existed then
    // wrote a UNIFORM assignment, whose key is a function of the face count alone, so the
    // fold could not add an entry no matter how many geometries were built. This is the
    // first producer whose attribute set varies with a dragged param, so it is the first
    // population on which the fold has anything to add.
    // An 80-face sphere, not the 12-face box every case above uses: those cases have
    // already made the box's range sets resident, and a content-keyed hit would report as
    // zero growth — a measurement about test order wearing the costume of a result.
    const src: MeshDataValue = {
      kind: 'MeshData',
      geometry: sphereGeometryRef(
        1,
        8,
        6,
        mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate'),
      ),
      material: SOURCE_MATERIAL,
      materialKey: null,
      attributeKey: mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate'),
    };
    const before = residentCount();
    resetGrowth();

    // A drag over `faceTo` 0→11: 121 frames' worth of evaluation, but only 12 distinct
    // integer bounds. The store is content-keyed, so what it grows by is the number of
    // DISTINCT sets, not the number of evaluations — which is the unit the deferral of
    // eviction is stated in, and the unit a per-frame number would have falsified.
    for (let frame = 0; frame < 121; frame++) {
      evalOp({ faceFrom: 0, faceTo: frame % 12 }, src);
    }

    const grown = growthBySource();
    expect(grown.evaluate).toBe(12);
    expect(grown.overlay).toBe(0);
    expect(residentCount()).toBe(before + 12);
  });

  it('a segment DRAG grows the OVERLAY origin, and the two stay countable apart', () => {
    // D7's road: the animation overlay rebuilds a sphere handle when a channel writes
    // `widthSegments`, and re-mints the attribute set at the new face count. Separating
    // the two origins is what makes both numbers readable at all — before the origin was
    // threaded, one counter reported for two producers and neither could be quoted.
    const ref = sphereGeometryRef(
      1,
      8,
      6,
      mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate'),
    );
    resetGrowth();

    for (let frame = 0; frame < 121; frame++) {
      rebuildGeometryRef(ref, { widthSegments: 8 + (frame % 25) });
    }

    const grown = growthBySource();
    expect(grown.overlay).toBeGreaterThan(0);
    // Bounded by DISTINCT segment counts (25 of them), never by the 121 frames.
    expect(grown.overlay).toBeLessThanOrEqual(25);
    expect(grown.evaluate).toBe(0);
  });
});
