// A scoped material operator carries its source's attributes forward (#722).
//
// ── WHAT THIS GATE IS FOR ─────────────────────────────────────────────────────────────
//
// `targetedMaterialAttributes` used to mint a set of EXACTLY ONE entry and hand it to the
// operator's append arm, which then folded it onto the outgoing handle in place of the
// source's own. So a scoped `SetMaterialOp` or `MaterialOverrideOp` returned a mesh whose
// per-face slots were right and whose every other attribute — at every class — was gone,
// while the same operator one param value away (no scope, hence the replace arm, hence the
// source handle riding through untouched) preserved all of them. A behaviour that varies
// across an operator's PARAM SPACE cannot be seen by a census that probes the default.
//
// ── WHY THIS ROAD CARRIES VERBATIM AND THE GENERATOR ROAD DOES NOT ────────────────────
//
// `CLASS_CARRIAGE` states what the TILED road does per class, and it has to: a generator
// merges copies, so every attribute needs an ORDER to be gathered through, and `point` and
// `edge` have none. A material operator merges nothing. Its geometry rides through with the
// same descriptor and the same element counts, so every carried attribute still fits its own
// domain element-for-element and the correct carriage is the identity — no order, no gather,
// no per-class verdict to take. That is why the rows below assert OBJECT IDENTITY for the
// carried attributes: a re-derivation that happened to produce equal values would still be
// this road inventing an answer it has no business having.
//
// Four properties, each failing differently:
//
//   1. THE OTHER CLASSES SURVIVE — corner, point and edge come out the far side, by identity.
//   2. `material_index` IS REPLACED, NEVER MERGED WITH — the source carried one too, and the
//      one that leaves must be the operator's, not the source's and not some blend.
//   3. A SOURCE CARRYING NOTHING IS UNCHANGED — the one-entry set is still exactly that, so
//      this is a widening and not a new mint shape for the existing population.
//   4. 🔴 IT REACHES THE OUTPUT — driven through both operators' real `evaluate`, with the
//      selection produced by the real resolver, and read back out of the store through the
//      key the emitted handle actually carries. A derivation being called is not its answer
//      reaching the output; rows 1-3 alone would pass while the operator dropped the key.
//      ⚠️ AND THE KEY NAMES ARE NOT ENOUGH TO SAY SO. The source carries the same four names,
//      so an operator that folds its SOURCE handle through — never reaching the minter — emits
//      a set that matches a names-only assertion exactly. Measured: that inverse edit passed
//      this row before it asserted the written assignment. These rows check the VALUE.
//
// REF: src/nodes/meshAttributes.ts (`targetedMaterialAttributes`, `mintTargetedAttributes`);
//      src/nodes/SetMaterialOp.ts + src/nodes/MaterialOverrideOp.ts (the append arms);
//      src/nodes/classCarriage.gate.test.ts (the tiled road's per-class census);
//      issues #722, #715, #717, #389.

import { beforeEach, describe, expect, it } from 'vitest';
import { insert, read } from '../app/attributeStore';
import { boxGeometryRef } from '../app/modifierGeometry';
import { mintAttributes } from './attributeKey';
import { MATERIAL_INDEX, type AttributeData, type AttributeSet } from './attributes';
import { mintTargetedAttributes } from './meshAttributes';
import { resolveComponentSelection } from './componentSelection';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { registerAllNodes } from './registerAll';
import { MaterialOverrideOpNode, MaterialOverrideOpParams } from './MaterialOverrideOp';
import { SetMaterialOpNode } from './SetMaterialOp';
import type { GeometryRef, MeshDataValue, ModifiedDataValue, ObjectData } from './types';

const BOX: [number, number, number] = [1, 1, 1];

/** A box is 12 triangles and 36 corners — the two counts this road can derive. */
const FACES = 6; // #770 — a box's six POLYGONS; the twelve was its triangles.
const CORNERS = 36;
/** The renderer's split buffer, which is what `point` still means in this build (#716). */
const POINTS = 24;
// Nothing on this road resolves an edge count — there is no producer and no consumer, so the
// figure is not load-bearing here. 18 is what a box's triangle edges measure; whether a face
// becomes an n-gon (and the count 12) is #718's open decision, and this fixture does not take it.
const EDGES = 18;

const named = (domain: AttributeData['domain'], count: number, fill: number): AttributeData => ({
  domain,
  type: 'int',
  count,
  data: Int32Array.from({ length: count }, () => fill),
});

/**
 * A box source carrying one attribute in EACH atom class, plus a `material_index` of its own.
 *
 * The source's index is all ONES on purpose: the targeted index the operator writes is 1 only
 * inside the selection, so a replace that silently kept the source's would be visible as the
 * unselected faces reading 1 rather than 0. Two sets that differ only where the bug lives.
 */
function sourceWithEveryClass(): { readonly ref: GeometryRef; readonly set: AttributeSet } {
  const minted = mintAttributes({
    [MATERIAL_INDEX]: named('face', FACES, 1),
    zz_corner: named('corner', CORNERS, 7),
    zz_point: named('point', POINTS, 8),
    zz_edge: named('edge', EDGES, 9),
  });
  if (minted === null) throw new Error('fixture: the four-class source failed to mint');
  // ⚠️ THE RESIDENT SET, not the one just minted. The store is content-keyed and `insert`
  // returns whatever already lives under the key — so the second row to build this fixture
  // gets the FIRST row's objects back, and its own `minted.set` is thrown away. Anchoring
  // the identity assertions on the local mint made them compare across fixture instances:
  // they held for whichever row ran first and failed for the rest, saying nothing about the
  // product. `insert`'s return value is the only object the rest of the run can see.
  const resident = insert(minted.key, minted.set, 'evaluate');
  return { ref: boxGeometryRef(BOX, minted.key), set: resident };
}

/** Read a set back through the key something actually emitted, never through the fixture's. */
function fromStore(key: string | null | undefined, what: string): AttributeSet {
  expect(key, `${what} emitted no attribute key`).toBeTruthy();
  const set = read(key!);
  expect(set, `${what} emitted key ${String(key)}, which is not in the store`).not.toBeNull();
  return set!;
}

const WIRED = [
  {
    kind: 'OpenPBRMaterial',
    spec: openpbrMaterialSchema().parse({ name: 'wired', base: { color: '#00ff00' } }),
  },
];

/** The source value in the shape a socket carries it, over the four-class geometry. */
function meshOver(ref: GeometryRef): MeshDataValue {
  return {
    kind: 'MeshData',
    geometry: ref,
    material: hydrateInlineMaterial(null, '#ff0000'),
    materialKey: null,
    // `null`, not the ref's `undefined`: a mesh VALUE spells "no attributes" as null while
    // a handle spells it as an absent field, and the two are different objects to the hash.
    attributeKey: ref.attributeKey ?? null,
  };
}

beforeEach(() => {
  registerAllNodes();
});

describe('#722 — a scoped material operator carries its source forward', () => {
  it('1 — corner, point and edge attributes survive, BY IDENTITY', () => {
    const source = sourceWithEveryClass();
    // Faces 0-5 only, so this is the append arm — the one road that mints.
    const targeted = mintTargetedAttributes(
      source.ref,
      resolveComponentSelection(meshOver(source.ref), { scope: '0-2' }, 'face'),
      'evaluate',
    );
    const out = fromStore(targeted?.key, 'the targeted minter');

    expect(Object.keys(out).sort()).toEqual([MATERIAL_INDEX, 'zz_corner', 'zz_edge', 'zz_point']);
    // The SAME objects, not equal ones. This road re-lays nothing out, so a carried attribute
    // that arrived as a new object would mean something here derived what it should forward.
    expect(out.zz_corner).toBe(source.set.zz_corner);
    expect(out.zz_point).toBe(source.set.zz_point);
    expect(out.zz_edge).toBe(source.set.zz_edge);
  });

  it('2 — `material_index` is REPLACED by the operator’s, not kept and not blended', () => {
    const source = sourceWithEveryClass();
    const targeted = mintTargetedAttributes(
      source.ref,
      resolveComponentSelection(meshOver(source.ref), { scope: '0-2' }, 'face'),
      'evaluate',
    );
    const out = fromStore(targeted?.key, 'the targeted minter');

    const index = out[MATERIAL_INDEX];
    expect(index.domain).toBe('face');
    expect(index.count).toBe(FACES);
    // 1 inside the selection, 0 outside it. The source's own index was all ones, so this row
    // reds if the carry-forward spread the wrong way round and kept the source's entry.
    expect(Array.from(index.data)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(index).not.toBe(source.set[MATERIAL_INDEX]);
    // And the coverage the operator chooses its arm from still counts the operator's faces.
    expect(targeted?.covered).toBe(3);
    expect(targeted?.faces).toBe(FACES);
  });

  it('3 — a source carrying NOTHING still mints exactly the one-entry set', () => {
    const bare = boxGeometryRef(BOX, null);
    const targeted = mintTargetedAttributes(
      bare,
      resolveComponentSelection(meshOver(bare), { scope: '0-2' }, 'face'),
      'evaluate',
    );
    expect(Object.keys(fromStore(targeted?.key, 'the bare-source mint'))).toEqual([MATERIAL_INDEX]);
  });

  it('4 — 🔴 IT REACHES THE OUTPUT of a scoped SetMaterialOp', () => {
    const source = sourceWithEveryClass();
    const src = meshOver(source.ref);
    const params = { muted: false, scope: '0-2' };
    const out = SetMaterialOpNode.evaluate(
      params,
      { target: src, material: WIRED },
      undefined as never,
      resolveComponentSelection(src, params, 'face'),
    ) as ModifiedDataValue;

    // Read through the key the EMITTED handle carries, not through the one minted above:
    // the minter can be right and the operator can still fold the wrong key onto its ref.
    const carried = fromStore(out.geometry.attributeKey, 'the scoped SetMaterialOp');
    expect(Object.keys(carried).sort()).toEqual([
      MATERIAL_INDEX,
      'zz_corner',
      'zz_edge',
      'zz_point',
    ]);
    // 🔴 THE VALUE, not just the key names. The source carries a `material_index` of its own
    // and three attributes under the same names, so an operator that folded the SOURCE handle
    // onto its output — never reaching the minter's answer at all — emits a set with exactly
    // this key list. Measured: that inverse edit passes a names-only row. The assignment the
    // operator exists to write is the only thing that tells the two apart.
    expect(Array.from(carried[MATERIAL_INDEX].data)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(carried.zz_corner).toBe(source.set.zz_corner);
    // The append arm is the one under test — two slots is what says so.
    expect(out.materialSlots).toHaveLength(2);
  });

  it('5 — 🔴 IT REACHES THE OUTPUT of a scoped MaterialOverrideOp', () => {
    const source = sourceWithEveryClass();
    const src: ObjectData = meshOver(source.ref);
    const params = MaterialOverrideOpParams.parse({
      color: '#00ff00',
      overridden: { color: true },
      scope: '0-2',
    });
    const out = MaterialOverrideOpNode.evaluate(
      params,
      { target: src } as never,
      undefined as never,
      resolveComponentSelection(src, params as unknown as Record<string, unknown>, 'face'),
    ) as ModifiedDataValue;

    const carried = fromStore(out.geometry.attributeKey, 'the scoped MaterialOverrideOp');
    expect(Object.keys(carried).sort()).toEqual([
      MATERIAL_INDEX,
      'zz_corner',
      'zz_edge',
      'zz_point',
    ]);
    // 🔴 THE VALUE — same reason as the row above: the source's own set wears the same four
    // names, so only the written assignment distinguishes the minter's answer from the source's.
    expect(Array.from(carried[MATERIAL_INDEX].data)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(carried.zz_corner).toBe(source.set.zz_corner);
    expect(out.materialSlots).toHaveLength(2);
  });
});
