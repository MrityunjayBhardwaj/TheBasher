// #550 — the per-map UV CAPTURE gate (the import half).
//
// The IR half of #550 is already gated (`src/nodes/perMapUvTransform.gate.test.ts`): the
// field exists, both parse roads carry it, it reaches the content key, and an unused one
// stays genuinely absent. This file gates the PRODUCER — that a glTF whose maps carry
// DIFFERING KHR_texture_transforms imports to an IR whose per-slot placements match the
// source, instead of collapsing to identity and leaning on the imported clone.
//
// ── WHY THIS IS A GATE AND NOT A PAIR OF EXAMPLES ─────────────────────────────────────
//
// Everything that can go wrong here is invisible in both review and the viewport:
//
//   1. A slot is captured from the WRONG glTF field. The IR's six slots do not map
//      one-to-one onto glTF's five textureInfos — `roughness` and `metalness` both read
//      the single packed `metallicRoughnessTexture`, and `ao` reads `occlusionTexture`,
//      whose name matches nothing. A cross-wiring renders correctly today (the clone
//      still draws its own transforms) and only surfaces once the render slice applies
//      the captured numbers.
//   2. The UNIFORM case changes. It must not: a material whose maps agree keeps putting
//      its transform in the shared `uvTransform` and must emit NO per-map key at all,
//      because a materialised bag keys differently from an absent one and would re-mint
//      every imported material's identity (H265, the trap #550's replacement semantics
//      defuse).
//   3. Only some components are captured. `scale`/`offset`/`rotation` are three separate
//      reads and a test that varies one is blind to the other two — so every placement
//      here is asserted as a whole object, never component by component.
//
// The slot axis is ITERATED rather than sampled, and each iteration asserts a second,
// DIFFERENT slot in the same material. That shape is deliberate: this gate's sibling
// shipped with a per-slot loop over one parse road and a single spot-check of the other,
// which read as thorough and was measured blind — deleting a slot from one road left it
// green. A property over two axes needs a gate over two axes.
//
// ── THE PIVOT, WHICH IS THE RISK THIS SLICE ACTUALLY INTRODUCES ───────────────────────
//
// The numbers captured here are KHR values: absolute, per slot, pivoting about the UV
// ORIGIN (three's `GLTFLoader.extendTexture` writes offset/rotation/scale onto a per-slot
// clone and never touches `center`, so the pivot is three's default [0,0] —
// node_modules/three/examples/jsm/loaders/GLTFLoader.js:2007-2048). Basher has TWO apply
// roads and they use DIFFERENT pivots, each correct for itself: the glTF overlay road
// pivots about the origin (`SceneFromDAG.tsx`, `applyGltfUvTransform`), the authored road
// about the texture centre (`materialRegistry.ts`, `prep`). Identical numbers therefore
// mean different placements on the two roads for any scale ≠ 1 or rotation ≠ 0.
//
// So the pivot convention travels with the ROAD, not with the value — and the value this
// slice starts writing is origin-pivot. Today nothing reads it at all, which means the
// property holds because nothing is wired, not because anything prevents it. Case 6 is
// that fact written down as an exact census rather than left as an assumption: it fails
// the moment a reader appears, and forces whoever adds one to say which road it is on.
//
// ✅ IT DID FAIL, ON THE FIRST READER (#550's render slice), AND THE ANSWER IS BELOW.
// Four readers appeared at once — the compile step that translates the bag into three's
// slot vocabulary, the two things that carry it down to a road, and the glTF overlay's
// call site. They are declared in `MAY_NAME_PER_MAP` with the road each is on.
//
// The same failure also made the census's OWN blind spot live, exactly as predicted: the
// two modules that actually WRITE a placement onto a texture (`uvPlacement.ts` and
// `applyGltfUvTransform.ts`) never name the field — they take the bag as a parameter — so
// a name-keyed census cannot see them. That is closed by a SECOND census below, keyed on
// the writer instead of on the field: every caller of `placeTexture` must name exactly one
// declared pivot constant. A third apply road cannot appear without answering the pivot
// question in one census or the other.
//
// REF: src/core/import/gltfJsonMaterialToOpenpbr.ts (the subject);
//      src/nodes/perMapUvTransform.gate.test.ts (the IR half of #550);
//      src/nodes/types.ts (`UvPlacement`, `mapUvTransforms` — replacement, not layering);
//      src/viewport/SceneFromDAG.tsx (`applyGltfUvTransform`, origin pivot);
//      src/app/materialRegistry.ts (`prep`, centre pivot);
//      issues #550, #551 (the pivot comment), #181, #217.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles } from '../../../tools/gates/sourceFiles';
import { stripComments } from '../../test-utils/sourceScan';
import { gltfJsonMaterialToOpenpbr, type GltfJsonMaterial } from './gltfJsonMaterialToOpenpbr';
import { MAP_UV_SLOTS } from '../../nodes/materialSchema';
import { materialKeyOf } from '../../nodes/materialKey';
import type { UvPlacement } from '../../nodes/types';

type Slot = (typeof MAP_UV_SLOTS)[number];

/** A KHR_texture_transform payload, all three components always present so no test can
 *  pass by capturing a subset of them. */
interface Khr {
  offset: [number, number];
  scale: [number, number];
  rotation: number;
}

const khr = (n: number): Khr => ({ offset: [n / 10, n / 5], scale: [n, n + 1], rotation: n / 100 });

/** The IR placement a `khr(n)` payload must become — `scale` is `tiling`, the rest verbatim. */
const expected = (n: number): UvPlacement => ({
  tiling: [n, n + 1],
  offset: [n / 10, n / 5],
  rotation: n / 100,
});

const info = (index: number, t: Khr) => ({ index, extensions: { KHR_texture_transform: t } });

/**
 * ORACLE — the glTF field each IR map slot must be captured from.
 *
 * Written out here INDEPENDENTLY of the converter's own table on purpose. Importing the
 * production mapping would make this gate agree with whatever the converter says, which
 * is precisely the claim under test; a test that shares its subject's table can only
 * check that the table was applied consistently, not that it is right.
 */
const SOURCE_OF: Record<Slot, (t: Khr) => GltfJsonMaterial> = {
  albedo: (t) => ({ pbrMetallicRoughness: { baseColorTexture: info(0, t) } }),
  normal: (t) => ({ normalTexture: info(1, t) }),
  // glTF packs roughness (G) and metalness (B) in ONE texture, so both IR slots read it.
  roughness: (t) => ({ pbrMetallicRoughness: { metallicRoughnessTexture: info(2, t) } }),
  metalness: (t) => ({ pbrMetallicRoughness: { metallicRoughnessTexture: info(2, t) } }),
  emissive: (t) => ({ emissiveTexture: info(3, t) }),
  ao: (t) => ({ occlusionTexture: info(4, t) }),
};

/** Deep-merge two material fragments — `pbrMetallicRoughness` holds three of the five
 *  texture slots, so a shallow spread would drop one of any two that share it. */
function merge(a: GltfJsonMaterial, b: GltfJsonMaterial): GltfJsonMaterial {
  const pbr = { ...a.pbrMetallicRoughness, ...b.pbrMetallicRoughness };
  const out: GltfJsonMaterial = { ...a, ...b };
  if (Object.keys(pbr).length > 0) out.pbrMetallicRoughness = pbr;
  return out;
}

describe('#550 case 1 — the slot axis is complete', () => {
  it('the oracle covers exactly the IR map slots, in both directions', () => {
    expect(Object.keys(SOURCE_OF).sort()).toEqual([...MAP_UV_SLOTS].sort());
  });
});

describe('#550 case 2 — every IR slot captures ITS OWN glTF transform', () => {
  // Two slots per material, carrying different transforms: the target under test and a
  // FOIL. Asserting both in the same pass is what catches a cross-wiring — a converter
  // that read the wrong field would either miss the target or hand it the foil's value.
  for (const slot of MAP_UV_SLOTS) {
    const foil: Slot = slot === 'albedo' ? 'normal' : 'albedo';

    it(`${slot} — its own placement, all three components`, () => {
      const mat = merge(SOURCE_OF[slot](khr(2)), SOURCE_OF[foil](khr(7)));
      const ir = gltfJsonMaterialToOpenpbr(mat);

      expect(ir.mapUvTransforms?.[slot], `slot ${slot}`).toEqual(expected(2));
      expect(ir.mapUvTransforms?.[foil], `foil ${foil} (cross-wiring check)`).toEqual(expected(7));
    });
  }

  it('the packed metallicRoughness texture places BOTH slots it feeds', () => {
    const mat = merge(SOURCE_OF.roughness(khr(3)), SOURCE_OF.albedo(khr(8)));
    const ir = gltfJsonMaterialToOpenpbr(mat);
    expect(ir.mapUvTransforms?.roughness).toEqual(expected(3));
    expect(ir.mapUvTransforms?.metalness).toEqual(expected(3));
  });

  it('placement capture reads the material JSON, not the texture tables', () => {
    // The sole production caller always passes tables; the clone-read oracle path does
    // not. A transform is a property of the material either way.
    const mat = merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.ao(khr(5)));
    const withTables = gltfJsonMaterialToOpenpbr(mat, { textures: [], samplers: [] });
    expect(withTables.mapUvTransforms).toEqual(gltfJsonMaterialToOpenpbr(mat).mapUvTransforms);
    expect(withTables.mapUvTransforms?.ao).toEqual(expected(5));
  });
});

describe('#550 case 3 — the UNIFORM case is untouched, and stays keyless', () => {
  const uniform = merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.normal(khr(2)));
  const differing = merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.normal(khr(7)));

  it('maps that agree still land in the SHARED transform', () => {
    expect(gltfJsonMaterialToOpenpbr(uniform).uvTransform).toEqual(expected(2));
  });

  it('and emit no per-map key at all — absent, not empty (an empty bag re-mints)', () => {
    const ir = gltfJsonMaterialToOpenpbr(uniform);
    expect(Object.prototype.hasOwnProperty.call(ir, 'mapUvTransforms')).toBe(false);
  });

  it('an untextured material likewise emits no per-map key', () => {
    expect(
      Object.prototype.hasOwnProperty.call(gltfJsonMaterialToOpenpbr({}), 'mapUvTransforms'),
    ).toBe(false);
  });

  it('PAIRED — the differing material DOES emit it (so the absence above is not vacuous)', () => {
    expect(
      Object.prototype.hasOwnProperty.call(gltfJsonMaterialToOpenpbr(differing), 'mapUvTransforms'),
    ).toBe(true);
  });

  it('the shared transform of a DIFFERING material is unchanged by this slice — identity', () => {
    // Every present slot carries its own absolute placement, so nothing falls back to the
    // shared value; leaving it identity is what keeps the glTF overlay road a no-op and
    // the imported clone rendering exactly as it does today.
    expect(gltfJsonMaterialToOpenpbr(differing).uvTransform).toEqual({
      tiling: [1, 1],
      offset: [0, 0],
      rotation: 0,
    });
  });

  it('capture adds exactly ONE own key to the IR, and it is the per-map one', () => {
    const before = Object.keys(gltfJsonMaterialToOpenpbr(uniform));
    const after = Object.keys(gltfJsonMaterialToOpenpbr(differing));
    expect(after.filter((k) => !before.includes(k))).toEqual(['mapUvTransforms']);
    expect(before.filter((k) => !after.includes(k))).toEqual([]);
  });
});

describe('#550 case 4 — only PRESENT slots are placed', () => {
  it('a two-map material places those two slots and no others', () => {
    const mat = merge(SOURCE_OF.emissive(khr(2)), SOURCE_OF.ao(khr(7)));
    const ir = gltfJsonMaterialToOpenpbr(mat);
    expect(Object.keys(ir.mapUvTransforms ?? {}).sort()).toEqual(['ao', 'emissive']);
  });

  it('a slot with a texture but NO transform is placed at identity, not omitted', () => {
    // Replacement semantics: an untransformed slot in a per-map-differing material must
    // say identity outright, or it would inherit whatever the shared value later becomes.
    const mat = merge(SOURCE_OF.albedo(khr(2)), { normalTexture: { index: 9 } });
    const ir = gltfJsonMaterialToOpenpbr(mat);
    expect(ir.mapUvTransforms?.normal).toEqual({ tiling: [1, 1], offset: [0, 0], rotation: 0 });
  });
});

describe('#550 case 5 — a captured per-map placement reaches the content key', () => {
  it('two imports differing ONLY in one slot placement key differently', () => {
    const a = gltfJsonMaterialToOpenpbr(merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.normal(khr(7))));
    const b = gltfJsonMaterialToOpenpbr(merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.normal(khr(8))));
    expect(materialKeyOf(a)).not.toBe(materialKeyOf(b));
  });

  it('PAIRED — two identical imports share one key', () => {
    const mat = merge(SOURCE_OF.albedo(khr(2)), SOURCE_OF.normal(khr(7)));
    expect(materialKeyOf(gltfJsonMaterialToOpenpbr(mat))).toBe(
      materialKeyOf(gltfJsonMaterialToOpenpbr(mat)),
    );
  });
});

describe('#550 case 6 — the origin-pivot values have no reader, and that is EXACT', () => {
  /**
   * Every non-test module under `src/` that names the per-map field, with WHY it may.
   * Exact in both directions: an entry that stops naming the field is as much a failure
   * as an undeclared reader, because a stale allow-list reads as coverage.
   */
  const MAY_NAME_PER_MAP: Record<string, string> = {
    'src/nodes/types.ts': 'declares the field',
    'src/nodes/materialSchema.ts': 'the two parse roads',
    'src/core/import/gltfJsonMaterialToOpenpbr.ts': 'the producer — captures KHR values',
    // #550 render slice — the readers, each with the road it feeds.
    'src/app/material/openpbrToThree.ts':
      'translates the bag into THREE slot names — road-neutral, the pivot is the caller’s',
    'src/app/material/primitiveMaterialInputs.ts':
      'carries the translated bag onto the spec — AUTHORED road (centre pivot)',
    'src/app/materialRegistry.ts': 'AUTHORED road — resolves per slot, pivots about the centre',
    'src/viewport/SceneFromDAG.tsx': 'glTF OVERLAY road — origin pivot, the captured convention',
  };

  /**
   * The SECOND census, closing the residual the first one cannot see: a module can carry
   * or apply a placement without ever naming the field. Every caller of the shared writer
   * must therefore name exactly one declared pivot — which is the road, stated in code.
   */
  const PIVOT_OF_ROAD: Record<string, 'CENTRE_PIVOT' | 'ORIGIN_PIVOT'> = {
    'src/app/materialRegistry.ts': 'CENTRE_PIVOT',
    'src/viewport/applyGltfUvTransform.ts': 'ORIGIN_PIVOT',
  };

  it('is named by exactly the declared modules', () => {
    const namers = sourceFiles()
      .filter(([, src]) => stripComments(src).includes('mapUvTransforms'))
      .map(([path]) => path)
      .sort();
    expect(namers).toEqual(Object.keys(MAY_NAME_PER_MAP).sort());
  });

  it('CONTROL — the census can actually see a namer (so the list is not empty by accident)', () => {
    const src = stripComments(
      readFileSync(join(__dirname, 'gltfJsonMaterialToOpenpbr.ts'), 'utf8'),
    );
    expect(src.includes('mapUvTransforms')).toBe(true);
  });

  it('every caller of the shared writer names exactly ONE declared pivot', () => {
    const callers = sourceFiles()
      .filter(([, src]) => stripComments(src).includes('placeTexture('))
      .map(([path]) => path)
      .filter((p) => p !== 'src/app/material/uvPlacement.ts') // the writer itself
      .sort();
    expect(callers).toEqual(Object.keys(PIVOT_OF_ROAD).sort());

    for (const [path, pivot] of Object.entries(PIVOT_OF_ROAD)) {
      const src = stripComments(readFileSync(join(__dirname, '../../..', path), 'utf8'));
      const other = pivot === 'CENTRE_PIVOT' ? 'ORIGIN_PIVOT' : 'CENTRE_PIVOT';
      expect(src, `${path} must place about ${pivot}`).toContain(pivot);
      expect(src, `${path} must NOT also use ${other}`).not.toContain(other);
    }
  });

  it('the two roads still disagree about the pivot — the divergence itself, not a spelling', () => {
    // Asserted on the VALUES, so "tidying" the two constants into agreement reds here
    // rather than silently re-placing every imported texture. See #551.
    const src = stripComments(
      readFileSync(join(__dirname, '../../app/material/uvPlacement.ts'), 'utf8'),
    );
    expect(src).toContain('CENTRE_PIVOT = [0.5, 0.5]');
    expect(src).toContain('ORIGIN_PIVOT = [0, 0]');
  });

  // WHAT THE FIELD-NAME CENSUS CANNOT SEE, and why the pivot census above exists: keying
  // on `mapUvTransforms` finds every module that reads or destructures the field, but not
  // one that forwards it under another name — which is precisely what the render slice
  // produced (`uvPlacement.ts` and `applyGltfUvTransform.ts` take it as a parameter). The
  // pivot census closes that by keying on the WRITER instead. What neither can see: a road
  // that places a texture WITHOUT going through `placeTexture`. That is bounded by the
  // registry gate, which asserts the built material carries the spec's placement — a road
  // writing its own numbers would have to be a third builder, not a third spelling.
});
