// MaskModifier — the THIRD geometry MODIFIER, #668 over #671's `subset` substrate.
//
// Proves the arithmetic, not just the wiring. The registration and declaration gates already
// assert that this operator exists, declares a total chain, lands in the modifier stack and
// emits something DIFFERENT for a subset. None of them says WHICH faces survive or HOW MANY,
// and that is exactly the pair `faceCount.ts` warns must move together:
//
//     the count (`faceCountOf`) and the build (`faceSubset`) are ONE claim spelled twice,
//     and parity between them is GREEN WHEN NEITHER honours the field.
//
// So the numbers below are LITERALS, measured from the fixture rather than computed through
// the production arithmetic they exist to check. A box tessellates to 12 triangles; every
// figure here is derived from that by hand.
//
// REF: src/nodes/MaskModifier.ts; src/nodes/types.ts (the `subset` descriptor);
//      src/app/geometryRegistry.ts (`buildSubset` / `faceSubset`); src/app/faceCount.ts
//      (the count and the subset face order); issues #668, #671.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from './registerAll';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import * as geometryRegistry from '../app/geometryRegistry';
import { boxGeometryRef, subsetGeometryRef, descriptorParamFields } from '../app/modifierGeometry';
import { faceCountOf, tiledFaceOrder } from '../app/faceCount';

/** The box fixture's face count — three.js tessellates a box to 6 quads = 12 triangles. */
const BOX_FACES = 12;

const box = () => boxGeometryRef([1, 1, 1], null);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  geometryRegistry.clear();
});

describe('#671 — the subset descriptor: how many faces survive', () => {
  it('🔴 KEEPING a 4-face selection of a 12-face box derives 4 — THE NUMBER 4', () => {
    // `0-3` names four faces (0,1,2,3). Deliberately NOT half: a scope selecting exactly
    // half would let `keep` and its complement agree, and the row below could not tell the
    // two polarities apart.
    expect(faceCountOf(subsetGeometryRef(box(), '0-3', true).descriptor)).toBe(4);
  });

  it('🔴 …and DROPPING the same selection derives 8, which is the asymmetry that separates them', () => {
    expect(faceCountOf(subsetGeometryRef(box(), '0-3', false).descriptor)).toBe(8);
    // Stated rather than implied: the two polarities partition the source exactly, so a
    // defect that returned the selection's count for both would show up here as 4 + 4.
    expect(4 + 8).toBe(BOX_FACES);
  });

  it('the BUILT geometry carries exactly three index entries per derived face', () => {
    // The other half of the pair. `faceCountOf` above is the descriptor's claim; this is what
    // three.js actually holds after `faceSubset` ran. Parity between them is what `build()`
    // consults before deriving a group layout, and a disagreement of one silently drops every
    // material group.
    const kept = geometryRegistry.getForRead(subsetGeometryRef(box(), '0-3', true));
    const dropped = geometryRegistry.getForRead(subsetGeometryRef(box(), '0-3', false));
    expect(kept?.getIndex()?.count).toBe(4 * 3);
    expect(dropped?.getIndex()?.count).toBe(8 * 3);
  });

  it('the two polarities are two GEOMETRIES, not one shared build', () => {
    // The key folds `keep` beside the query. Without it both spellings key alike and the
    // cache hands back whichever built first — and both are valid meshes, so it is silent.
    const a = subsetGeometryRef(box(), '0-3', true);
    const b = subsetGeometryRef(box(), '0-3', false);
    expect(a.key).not.toBe(b.key);
    expect(geometryRegistry.getForRead(a)).not.toBe(geometryRegistry.getForRead(b));
  });

  it('two spellings of ONE selection share a build, because the key folds the canonical form', () => {
    expect(subsetGeometryRef(box(), '0-3', true).key).toBe(
      subsetGeometryRef(box(), '0,1,2,3', true).key,
    );
  });

  it('🔴 a BLANK scope is REFUSED, because it would delete the whole mesh', () => {
    // The state has no constructor rather than being caught downstream. A blank query
    // resolves to the empty set, so a `keep` subset over it would emit nothing at all — an
    // object that silently vanishes the moment an unconfigured mask joins a stack.
    expect(() => subsetGeometryRef(box(), '', true)).toThrow(/needs a selection/);
    expect(() => subsetGeometryRef(box(), '   ', false)).toThrow(/needs a selection/);
  });

  it('exposes `scope` and `keep` as param-fed descriptor fields, and nothing else', () => {
    // The overlay finds what to fold by asking the descriptor for its own field names, and
    // the correspondence it rests on is that a field is named exactly like the param feeding
    // it. `source` and `kind` are excluded structurally.
    expect(descriptorParamFields(subsetGeometryRef(box(), '0-3', true).descriptor)).toEqual([
      'scope',
      'keep',
    ]);
  });
});

describe('#668 — the per-face attribute survives a mask', () => {
  it('🔴 the face ORDER names the surviving SOURCE faces, so a per-face attribute can be gathered', () => {
    // Without an order the gather is skipped and a masked mesh renders with ONE material
    // where its source had several — a plausible screen, no error, and the wrong answer
    // relied on. The order is what makes `tiled[i] = source[order[i]]` work here as it does
    // for a generator.
    const kept = tiledFaceOrder(subsetGeometryRef(box(), '0-3', true).descriptor);
    expect(kept).toEqual({ sourceFaces: BOX_FACES, order: [0, 1, 2, 3] });

    // The complement, and it is the surviving faces IN SOURCE ORDER — not a re-index.
    const dropped = tiledFaceOrder(subsetGeometryRef(box(), '0-3', false).descriptor);
    expect(dropped).toEqual({ sourceFaces: BOX_FACES, order: [4, 5, 6, 7, 8, 9, 10, 11] });
  });

  it('the order length IS the derived face count, for both polarities', () => {
    // The two are one claim, and this is the row that says so rather than leaving it to
    // agree by accident.
    for (const keep of [true, false]) {
      const d = subsetGeometryRef(box(), '0-3', keep).descriptor;
      expect(tiledFaceOrder(d)!.order.length).toBe(faceCountOf(d));
    }
  });
});

describe('#668 — the node', () => {
  const meshInput = () => ({
    kind: 'MeshData' as const,
    geometry: box(),
    material: { color: '#808080' },
  });

  it('🔴 an unconfigured mask is TRANSPARENT — it does not delete anything', () => {
    // A blank scope resolves to a total selection whose `canonicalQuery` is null. Read
    // naively that is "every face selected", which under `keep: false` would empty the mesh
    // the moment the node was dropped into a stack. Both polarities pass the source through
    // until a selection exists.
    for (const keep of [true, false]) {
      const src = meshInput();
      const out = evaluateNodeAlone('MaskModifier', { keep, muted: false, scope: '' }, {
        target: src,
      } as never);
      expect(out).toBe(src);
    }
  });

  it('with a scope it emits ModifiedData carrying a subset handle, and INHERITS the material', () => {
    const src = meshInput();
    const out = evaluateNodeAlone('MaskModifier', { keep: true, muted: false, scope: '0-3' }, {
      target: src,
    } as never) as { kind: string; geometry: { descriptor: { kind: string } }; material: unknown };

    expect(out.kind).toBe('ModifiedData');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'subset', scope: '0-3', keep: true });
    expect(out.material).toEqual(src.material);
    expect(faceCountOf(out.geometry.descriptor)).toBe(4);
  });
});
