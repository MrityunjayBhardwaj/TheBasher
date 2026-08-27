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
import { resolveComponentSelection, SCOPE_PARAM } from './componentSelection';
import { registerAllNodes } from './registerAll';
import { SetMaterialOpNode, SetMaterialOpParams } from './SetMaterialOp';
import { boxDescriptor, boxGeometryRef, sphereDescriptor } from '../app/modifierGeometry';
import { faceRangeMaterialAttributes, mintMeshAttributes } from './meshAttributes';
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

const evalOp = (params: { muted?: boolean; scope?: string }, target: ObjectData | undefined) => {
  // ns-2 step 9b — the fourth argument goes through the ONE resolver, exactly as the
  // evaluator does; see `ArrayModifier.test.ts` for why this helper stays a DIRECT call.
  const full = { muted: false, scope: '', ...params };
  return SetMaterialOpNode.evaluate(
    full,
    { target, material: WIRED },
    undefined as never,
    resolveComponentSelection(target, full, 'face'),
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
  registerAllNodes();
});

describe('#638 SetMaterialOp — the full range still REPLACES, byte for byte', () => {
  it('emits exactly the pre-range shape: no table, no index, the source geometry itself', () => {
    const src = boxData();
    const out = evalOp({}, src) as ModifiedDataValue;

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
    const sentinel = evalOp({}, src);
    const bounds = evalOp({ scope: '0-11' }, src); // a box is 12 triangles
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
        { muted: true, scope: '0-1' },
        { target: src, material: WIRED },
      ),
    ).toBe(src);
    expect(
      SetMaterialOpNode.evaluate(
        { muted: false, scope: '0-1' },
        { target: src, material: [] },
        undefined as never,
        resolveComponentSelection(src, { muted: false, scope: '0-1' }, 'face'),
      ),
    ).toBe(src);
  });
});

describe('#638 SetMaterialOp — a partial range APPENDS, which nothing could express before', () => {
  it('two slots, the source material on slot 0, and an index that names the range', () => {
    const src = boxData();
    const out = evalOp({ scope: '0-1' }, src) as ModifiedDataValue;

    expect(out.materialSlots).toHaveLength(2);
    expect(out.materialSlots![0]).toBe(SOURCE_MATERIAL); // slot 0 keeps the source's
    expect(out.materialSlots![1]).toMatchObject({ base: { color: '#00ff00' } });
    expect(out.attributeKey).toEqual(expect.any(String));

    // The index itself — faces 0 and 1 on slot 1, the other four on slot 0. A query range is
    // INCLUSIVE at both ends (Houdini's group ranges are), so `0-1` is two faces, not one.
    const index = readAttributes(out.attributeKey!)![MATERIAL_INDEX];
    expect([...index.data]).toEqual([1, 1, 0, 0, 0, 0]);
    expect(index.count).toBe(6);
    expect(index.domain).toBe('face');
  });

  it('the geometry is RE-MINTED, so two assignments cannot collide on one cached build', () => {
    const src = boxData();
    const a = evalOp({ scope: '0-1' }, src) as ModifiedDataValue;
    const b = evalOp({ scope: '0-2' }, src) as ModifiedDataValue;

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
    const out = evalOp({ scope: '^0' }, boxData()) as ModifiedDataValue;
    const index = readAttributes(out.attributeKey!)![MATERIAL_INDEX];
    expect([...index.data].every((v) => v === 0)).toBe(true);
  });

  it('a source whose face count is not derivable REPLACES — the declared limit, pinned', () => {
    // A glTF handle has no descriptor the face count can be read from, so there is no
    // domain to write an assignment onto. Replacing is the honest answer: the director's
    // wired material still reaches the mesh. A table with no index behind it would report
    // one used slot and drop the wired material silently.
    //
    // 🔴 THE SUBJECT IS THE UNSCOPED CASE, AND STEP 14 IS WHERE THAT STOPPED BEING A DETAIL.
    // This row used to author `faceFrom: 0, faceTo: 1` here, because a literal range over a
    // countless source was INERT — it could not be honoured and nothing said so. An authored
    // SCOPE over the same source is a named THROW instead (the row at the end of this file),
    // which is step 12's deliberate sharpening of this very limit. So the two are not
    // interchangeable and the range could not simply be respelled: what this row is about is
    // "no assignment is authored, and the count is not derivable", and that is what it now
    // says. The state it used to cover — a partial assignment over a countless source,
    // silently ignored — is gone from the vocabulary, which is the point rather than a loss.
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
    const out = evalOp({}, gltfSource) as ModifiedDataValue;
    expect(Object.keys(out).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(out.geometry).toBe(gltfSource.geometry);
  });

  it('ONLY THE LOWEST op in a stack contributes a table — the declared limit, pinned', () => {
    // A director stacking two ops expecting three slots gets two, and this is the test
    // that reds if that ever changes silently rather than by decision.
    //
    // ⚠️ THE REASON MATTERS AND IT IS NOT THE ONE THIS ROW USED TO GIVE (#698). It said
    // `modifierDataSource` "carries `{geometry, material}` and nothing else, so the first
    // op's table is not visible to it". #691 widened that source: `materialSlots` rides
    // through, so the first op's table IS visible. The second op discards it — the
    // emission builds a fresh two-entry table from `source.material` alone. So what this
    // row pins is a REPLACE choice made in the absence of a merge rule (#647), not an
    // expressive limit of the contract. Read that way, the assertions below still hold
    // for exactly the reason they are written.
    const first = evalOp({ scope: '0-1' }, boxData()) as ModifiedDataValue;
    expect(first.materialSlots).toHaveLength(2);

    const second = evalOp({ scope: '2-3' }, first) as ModifiedDataValue;
    expect(second.materialSlots).toHaveLength(2);
    // And the first op's own slot 0 — the original source material — is gone from the
    // table, replaced by the first op's single `material` field.
    expect(second.materialSlots![0]).not.toBe(SOURCE_MATERIAL);
  });
});

describe('#638 the growth measurement step 4 could not take', () => {
  it('a SCOPE drag adds one attribute set per distinct range, not per frame', () => {
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

    // A drag over the query's upper bound, `0-0` → `0-11`: 121 frames' worth of evaluation,
    // but only 12 distinct
    // integer bounds. The store is content-keyed, so what it grows by is the number of
    // DISTINCT sets, not the number of evaluations — which is the unit the deferral of
    // eviction is stated in, and the unit a per-frame number would have falsified.
    for (let frame = 0; frame < 121; frame++) {
      evalOp({ scope: `0-${frame % 12}` }, src);
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

// ── ns-2 STEP 12 — THE FIRST OPERATOR THAT READS ITS RESOLVED SELECTION ──────────────
//
// Every assertion below is anchored on `faceRangeMaterialAttributes`, the #638 producer,
// which this step does not touch. That matters more than it looks: the claim is "the
// selection road and the range road name the same faces", and a parity assertion whose two
// sides both run through the code under test cannot see that code change ([[V189]]). The
// range producer is the side the new derivation cannot reach.
describe('ns-2 step 12 — the selection reaches the assignment', () => {
  /** The #638 producer's key for a contiguous range — the side step 12 cannot influence. */
  const rangeKey = (from: number, to: number): string =>
    faceRangeMaterialAttributes(boxDescriptor([1, 1, 1]), from, to)!.key;

  it('🔴 A SAVED FACE RANGE STILL EMITS THE SAME BYTES — through the migration now', () => {
    // 🔴 THE INVARIANCE THIS WHOLE PHASE RESTS ON, AND STEP 14 IS WHERE IT STOPPED BEING
    // FREE. Until the accommodation was deleted, `faceFrom: 6, faceTo: 11` was read straight
    // out of params and intersected with a total selection, so an already-authored graph kept
    // its output by doing nothing. The params are gone; the claim is not. What carries it now
    // is the v1 → v2 migration, and this row is what makes that carrying checkable.
    //
    // Asserted against `faceRangeMaterialAttributes` — the untouched #638 producer — rather
    // than against a value this road computes. A parity assertion whose two sides both run
    // through the code under test cannot see that code change, and the range producer is the
    // side neither the selection road nor the migration can reach.
    const migrated = SetMaterialOpNode.migrations![1]({
      muted: false,
      faceFrom: 6,
      faceTo: 11,
    }) as Record<string, unknown>;
    // The retired keys are GONE, not merely ignored — a migration that left them behind would
    // pass every behavioural row below while re-introducing the field on the next save.
    expect(Object.keys(migrated).sort()).toEqual(['muted', 'scope']);
    expect(migrated[SCOPE_PARAM]).toBe('6-11');

    const out = evalOp({ scope: migrated[SCOPE_PARAM] as string }, boxData()) as ModifiedDataValue;
    expect(out.materialSlots).toHaveLength(2);
    expect(out.attributeKey).toBe(rangeKey(6, 11));
  });

  it('🔴 a SCOPE alone names the faces — with the range left at its default', () => {
    // The step's whole point, and the row that reds if the fourth argument is discarded:
    // the default range covers everything, so an operator ignoring its selection would take
    // the REPLACE arm and emit one material. Two slots here means the query reached the
    // assignment, and the KEY means it reached the right faces.
    const out = evalOp({ scope: '6-11' }, boxData()) as ModifiedDataValue;
    expect(out.materialSlots).toHaveLength(2);
    expect(out.attributeKey).toBe(rangeKey(6, 11));
  });

  it('🔴 …and the migration is TOTAL — all four shapes of the retired range, as literals', () => {
    // The four cases, each asserted as the string rather than through the helper that
    // produces it. Two of them are only expressible because the query language happens to
    // have the right operator, and both were measured against the parser before being
    // written down — an open-ended range needs a COMPLEMENT and an empty one needs a
    // REMOVAL, and neither is guessable from the range's own vocabulary.
    const migrate = (faceFrom: number, faceTo: number): unknown =>
      (
        SetMaterialOpNode.migrations![1]({ muted: false, faceFrom, faceTo }) as Record<
          string,
          unknown
        >
      )[SCOPE_PARAM];

    expect(migrate(0, -1)).toBe(''); //  the default — every face, which blank already means
    expect(migrate(3, 11)).toBe('3-11'); //  a closed range, the ordinary case
    expect(migrate(3, -1)).toBe('!0-2'); //  open-ended: everything EXCEPT what precedes it
    expect(migrate(5, 2)).toBe('^0'); //  inverted, i.e. no faces at all
    expect(migrate(0, -5)).toBe('^0'); //  `to` below the sentinel is the same empty state

    // 🔴 EVERY ONE OF THOSE MUST SURVIVE THE SCHEMA, which is not a free consequence of
    // being correct: the params are refined with the parser, so a migration emitting a
    // spelling the language refuses would produce a project that cannot load. `7-3` is
    // exactly such a spelling, which is why the inverted case is `^0` and not itself.
    for (const q of ['', '3-11', '!0-2', '^0']) {
      expect(SetMaterialOpParams.safeParse({ [SCOPE_PARAM]: q }).success, q).toBe(true);
    }
    expect(SetMaterialOpParams.safeParse({ [SCOPE_PARAM]: '7-3' }).success).toBe(false);

    // An ALREADY-AUTHORED scope wins and the range is dropped, because the two cannot be
    // composed: the shipped semantics intersected them on the resolved MASK and the query
    // language has union and difference but no intersection. Unreachable in any project that
    // exists — `scope` never shipped to `main` — and stated anyway, because a migration
    // ladder outlives the knowledge that made it.
    const both = SetMaterialOpNode.migrations![1]({
      muted: false,
      faceFrom: 6,
      faceTo: 11,
      [SCOPE_PARAM]: '0-8',
    }) as Record<string, unknown>;
    expect(both[SCOPE_PARAM]).toBe('0-8');
    expect(Object.keys(both).sort()).toEqual(['muted', 'scope']);
  });

  it('a scope naming EVERY face is the replace arm — coverage decides, not the params', () => {
    // A box is 12 triangles, so `0-11` is total by extension while being a partial-looking
    // query. The three-clause test over the retired face range would have called this
    // partial and emitted a two-slot table whose second slot covers the whole mesh.
    const src = boxData();
    const out = evalOp({ scope: '0-11' }, src) as ModifiedDataValue;
    expect(Object.keys(out).sort()).toEqual(['geometry', 'kind', 'material']);
    expect(out.geometry).toBe(src.geometry);
  });

  it('a scope selecting NOTHING lands exactly where an INVERTED RANGE already landed', () => {
    // 🔴 MEASURED, AND MY FIRST EXPECTATION HERE WAS WRONG — recorded because the wrong one
    // is the tempting one. "Nothing is selected" reads like the replace arm, but the shipped
    // node has always taken APPEND for an empty assignment: an inverted range mints an
    // all-zero index and emits a table whose second slot covers no face, which downstream
    // reports as one used slot and draws as a single material. The row above it in this file
    // pins that for the range, and it says so in its own name: *needs no arm anywhere to say
    // so*.
    //
    // So the scope road must land in the same place, and the value of asserting it is that
    // the two roads AGREE — a step that quietly gave the selection a different answer for
    // the empty case would be a semantics change hiding inside a rewrite.
    const scoped = evalOp({ scope: '^0-11' }, boxData()) as ModifiedDataValue;
    const inverted = evalOp({ scope: '^0' }, boxData()) as ModifiedDataValue;
    expect(scoped.attributeKey).toBe(inverted.attributeKey);
    const index = readAttributes(scoped.attributeKey!)![MATERIAL_INDEX];
    expect([...index.data].every((v) => v === 0)).toBe(true);
  });

  it('🔴 an AUTHORED scope over a source with no derivable count THROWS BY NAME', () => {
    // Declared limit 3, and step 12 sharpens it rather than inheriting it. Without a scope
    // a glTF source REPLACES — the row above pins that and it still holds. WITH one, the
    // author has asked for something the system cannot honour, and quietly writing the
    // material onto the whole mesh is the loudest wrong answer wearing the quietest
    // failure. The refusal comes from the resolver, before `evaluate` runs at all.
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
    expect(() => evalOp({ scope: '0-5' }, gltfSource)).toThrow(/cannot be honoured/);
  });

  it('an unparseable query cannot be AUTHORED, so it never reaches the resolver', () => {
    // The other half of the decision, asked of the schema. `setParam` rejects what the
    // schema will not take, so the parser's throw has no path to the render walk.
    expect(SetMaterialOpParams.safeParse({ [SCOPE_PARAM]: 'arm*' }).success).toBe(false);
    expect(SetMaterialOpParams.safeParse({ [SCOPE_PARAM]: '5-2' }).success).toBe(false);
    expect(SetMaterialOpParams.safeParse({ [SCOPE_PARAM]: '0-5 ^2' }).success).toBe(true);
    // Blank is the absent state, not an invalid one — it must stay authorable.
    expect(SetMaterialOpParams.safeParse({}).data?.[SCOPE_PARAM]).toBe('');
  });
});

describe('#681 — what a MIGRATED range does when it meets a COUNTLESS source', () => {
  // The migration ladder is already pinned shape by shape above. What was never pinned is the
  // CONSEQUENCE, and it is the one direction that got worse: over a glTF or baked handle the
  // retired range was INERT (the operator could not build an assignment, so it took the
  // replace arm and the range did nothing), while an authored scope over the same source is a
  // named refusal — deliberately, because silently writing the material onto the whole mesh is
  // the loudest wrong answer wearing the quietest failure.
  //
  // So the migration can turn a silent no-op into a viewport-down throw, and a migration
  // cannot avoid it: it sees PARAMS and never the spine value, so it cannot know the source is
  // countless. These rows exist to state exactly which saved projects that reaches, because
  // "arguably empty" is not a population and cannot be reasoned with later.
  //
  // 🔑 THE SET IS CLOSED AND CAN ONLY SHRINK. The v1 -> v2 migration fires only for projects
  // saved at version 1, and the range is retired, so nothing can ever enter this set again.
  // That is the fact that makes documenting it the proportionate answer rather than a
  // load-path repair.

  /** A glTF handle: its buffers live in an asset clone, so no domain is derivable. */
  const countlessSource = (): MeshDataValue => ({
    kind: 'MeshData',
    geometry: {
      key: 'gltf|asset-x|child-y',
      descriptor: { kind: 'gltf', assetRef: 'asset-x', childName: 'child-y' },
    },
    material: SOURCE_MATERIAL,
    materialKey: null,
    attributeKey: null,
  });

  const migrate = (v1: Record<string, unknown>): Record<string, unknown> =>
    SetMaterialOpNode.migrations![1](v1) as Record<string, unknown>;

  it('the COMMON project migrates to a scope that is still inert — no throw', () => {
    // A project with no range at all, and one holding the explicit default, both migrate to
    // blank. Blank is total, and a total selection over an underivable source resolves to
    // `null` rather than refusing — which is what keeps the overwhelming majority of saved
    // projects out of this issue entirely.
    for (const v1 of [{ muted: false }, { muted: false, faceFrom: 0, faceTo: -1 }]) {
      const migrated = migrate(v1);
      expect(migrated[SCOPE_PARAM]).toBe('');
      expect(resolveComponentSelection(countlessSource(), migrated, 'face')).toBeNull();
    }
  });

  it('🔴 an AUTHORED range is the one that migrates into a refusal', () => {
    const migrated = migrate({ muted: false, faceFrom: 0, faceTo: 1 });
    expect(migrated[SCOPE_PARAM]).toBe('0-1');

    // Named, and naming the query — the refusal a director can act on, not a stack trace.
    expect(() => resolveComponentSelection(countlessSource(), migrated, 'face')).toThrow(
      /has no derivable face count/,
    );
  });

  it('CONTROL — the same migrated scope over a COUNTABLE source resolves cleanly', () => {
    // Without this row the one above is satisfied by a migration that produced nonsense: a
    // scope that throws over EVERY source would pass it and mean something entirely different.
    // The control is what makes the refusal attributable to the SOURCE.
    const migrated = migrate({ muted: false, faceFrom: 0, faceTo: 1 });
    const sel = resolveComponentSelection(boxData(), migrated, 'face');
    expect(sel).not.toBeNull();
    // Field by field rather than deep-equality: the resolved selection also carries a `has`
    // PREDICATE, which a JSON-shaped expectation cannot see — the probe that drafted this row
    // stringified the value and the function vanished from the picture entirely.
    expect(sel!.domain).toBe('face');
    expect(sel!.length).toBe(6);
    expect(sel!.count).toBe(2);
    expect(sel!.canonicalQuery).toBe('0-1');
    // And the predicate agrees with the range it was migrated from: faces 0 and 1, no others.
    expect([0, 1, 2, 11].map((i) => sel!.has(i))).toEqual([true, true, false, false]);
  });
});
