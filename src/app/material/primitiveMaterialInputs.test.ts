// #536 S2 — the gate that replaces a structural guarantee with a checked one.
//
// Before S2 the registry's key was a total function of the spec it built from, so "two
// materials that render differently share an instance" was impossible by construction.
// Anchoring the key on the evaluator's `materialKey` gives that up: the key is now a
// function of NAMED INPUTS, and anything the build reads that is not derived from those
// inputs is silently unkeyed.
//
// So the old walk survives as an ORACLE. The claim is one-directional and that is
// deliberate:
//
//   SAME composed key  ⇒  SAME spec        ← REQUIRED. A violation shares one GPU
//                                            material between two meshes that should
//                                            render differently — repainting an object
//                                            nobody edited, which is the bug the
//                                            registry exists to prevent.
//   SAME spec          ⇒  SAME composed key  ← NOT required. The key may separate two
//                                            inputs that compile alike; that is a lost
//                                            dedup, a perf cost invisible on screen.
//
// The corpus perturbs one thing at a time, and every perturbation is chosen to land on a
// DIFFERENT field of `PrimitiveMaterialSpec`, so a key that dropped any one field is
// caught by the pair it fails to separate rather than by a count.
//
// REF: src/app/material/primitiveMaterialInputs.ts; src/app/materialRegistry.ts (`keyOf`);
//      tests/e2e/p536-override-band-instance-split.spec.ts (the same claim, in a browser);
//      issues #530, #532, #536.

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { BoxDataNode, BoxDataParams } from '../../nodes/BoxData';
import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { keyOf } from '../materialRegistry';
import {
  compilePrimitiveMaterial,
  irKeyFor,
  primitiveMaterialKey,
  primitiveMaterialSpec,
  type ResolvedMaps,
} from './primitiveMaterialInputs';

/** A stand-in for a decoded texture: both the oracle and the key read only these two. */
const tex = (uuid: string) => ({ isTexture: true, uuid }) as unknown as THREE.Texture;

const NO_MAPS: ResolvedMaps = {
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

const BASE_IR = hydrateInlineMaterial({
  name: 'base',
  base: { color: '#2244ff', metalness: 0.25 },
  specular: { roughness: 0.72, ior: 1.5 },
});

/** One lobe replaced, everything else identical — the perturbation is the discriminator. */
const irWith = (patch: Record<string, unknown>): InlineMaterialSpec =>
  hydrateInlineMaterial({
    name: 'base',
    base: { color: '#2244ff', metalness: 0.25 },
    specular: { roughness: 0.72, ior: 1.5 },
    ...patch,
  });

const override = (patch: Partial<MaterialValue>): MaterialValue =>
  ({
    kind: 'Material',
    name: 'ovr',
    color: '#ff8800',
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    emissive: '#000000',
    emissiveIntensity: 0,
    overridden: { color: true },
    ignoreSourceMaterial: false,
    ...patch,
  }) as MaterialValue;

interface World {
  readonly name: string;
  readonly ir: InlineMaterialSpec;
  readonly override?: MaterialValue;
  readonly shading: string;
  readonly textures: ResolvedMaps;
}

const world = (name: string, patch: Partial<Omit<World, 'name'>> = {}): World => ({
  name,
  ir: BASE_IR,
  override: undefined,
  shading: 'material',
  textures: NO_MAPS,
  ...patch,
});

function derive(w: World) {
  const compiled = compilePrimitiveMaterial(w.ir, w.override);
  return {
    spec: primitiveMaterialSpec(compiled, w.shading, w.textures),
    key: primitiveMaterialKey({
      irKey: irKeyFor(w.ir, null),
      override: w.override,
      shading: w.shading,
      textures: w.textures,
    }),
  };
}

/**
 * Each entry moves exactly one field of the built spec (or, for the last few, one of the
 * render-time contributions the evaluator cannot see). `thickness` has no entry of its
 * own: the compile derives it from `transmission`, so the transmission perturbation is
 * the only way to reach it.
 */
const CORPUS: readonly World[] = [
  world('base'),
  world('color', { ir: irWith({ base: { color: '#00ff44', metalness: 0.25 } }) }),
  world('metalness', { ir: irWith({ base: { color: '#2244ff', metalness: 0.9 } }) }),
  world('roughness', { ir: irWith({ specular: { roughness: 0.13, ior: 1.5 } }) }),
  world('ior', { ir: irWith({ specular: { roughness: 0.72, ior: 1.9 } }) }),
  world('clearcoat', { ir: irWith({ coat: { weight: 0.8, roughness: 0.1 } }) }),
  world('clearcoatRoughness', { ir: irWith({ coat: { weight: 0.8, roughness: 0.4 } }) }),
  world('transmission+thickness+transparent', { ir: irWith({ transmission: { weight: 0.6 } }) }),
  world('emissive', { ir: irWith({ emission: { color: '#ff0000', luminance: 1 } }) }),
  world('emissiveIntensity', { ir: irWith({ emission: { color: '#ff0000', luminance: 5 } }) }),
  world('opacity+transparent', { ir: irWith({ geometry: { opacity: 0.4 } }) }),
  // #532 — the three render-mode flags. Each has to reach the SPEC, not just the
  // compile: the vacuity check below asserts every world produces a DIFFERENT spec, so
  // a flag the spec drops makes its world a duplicate of `base` and reds there. That is
  // the whole gate for the missing half — no separate assertion states it twice.
  world('alphaTest', { ir: irWith({ geometry: { opacity: 1, alphaCutoff: 0.5 } }) }),
  world('vertexColors', { ir: irWith({ geometry: { opacity: 1, vertexColors: true } }) }),
  world('side (doubleSided)', { ir: irWith({ geometry: { opacity: 1, doubleSided: true } }) }),
  world('uvTransform', {
    ir: irWith({ uvTransform: { tiling: [2, 3], offset: [0.25, 0], rotation: 0.5 } }),
  }),
  world('wireframe (shading)', { shading: 'wireframe' }),
  world('override present', { override: override({}) }),
  world('override, different colour', { override: override({ color: '#00ffaa' }) }),
  world('one map resolved', { textures: { ...NO_MAPS, map: tex('t1') } }),
  world('a different texture instance', { textures: { ...NO_MAPS, map: tex('t2') } }),
  world('a different slot', { textures: { ...NO_MAPS, normalMap: tex('t1') } }),
];

describe('#536 S2 — the composed key is at least as discriminating as the spec walk', () => {
  it('never gives two DIFFERENT specs the same key', () => {
    const rows = CORPUS.map((w) => ({ name: w.name, ...derive(w) }));
    const collisions: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const differentSpec = keyOf(rows[i].spec) !== keyOf(rows[j].spec);
        if (differentSpec && rows[i].key === rows[j].key) {
          collisions.push(`${rows[i].name} ↔ ${rows[j].name}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('the corpus actually separates specs, or the claim above is vacuous', () => {
    // Without this, a corpus of identical worlds passes the collision check for free.
    // EQUALITY, not a floor: every entry was chosen to land on a different spec field,
    // and that was measured rather than assumed. A floor would let a future entry that
    // silently duplicates an existing one shrink the corpus's reach without a red.
    const specKeys = new Set(CORPUS.map((w) => keyOf(derive(w).spec)));
    expect(specKeys.size).toBe(CORPUS.length);
  });

  it('is not a constant, and dedups what it should', () => {
    const keys = CORPUS.map((w) => derive(w).key);
    expect(new Set(keys).size).toBe(CORPUS.length);
    // Two structurally-equal worlds built independently must land on ONE key, or the
    // registry would hand every mesh its own material and every sharing claim above
    // would be satisfied by a cache that never hits.
    expect(derive(world('a')).key).toBe(derive(world('b')).key);
  });
});

describe('#536 S2 — the evaluator’s key is used, and the fallback is the same function', () => {
  it('prefers the minted key over re-deriving one', () => {
    expect(irKeyFor(BASE_IR, 'minted-by-the-evaluator')).toBe('minted-by-the-evaluator');
  });

  it('falls back to the evaluator’s own key function, not a second spelling', () => {
    // The fallback path (ModifiedData, and the fallback IR a materialless node draws)
    // must agree with what the evaluator would have minted for the same IR — otherwise
    // the two halves of identity drift with nothing to notice.
    expect(irKeyFor(BASE_IR, null)).toBe(irKeyFor(BASE_IR, undefined));
    const sameContent = hydrateInlineMaterial({
      name: 'a different label entirely',
      base: { color: '#2244ff', metalness: 0.25 },
      specular: { roughness: 0.72, ior: 1.5 },
    });
    // `name` is excluded from render identity (the S1 corollary), so a relabelled but
    // otherwise identical material must not lose its share of the instance.
    expect(irKeyFor(sameContent, null)).toBe(irKeyFor(BASE_IR, null));
  });

  it('lands a keyed and an unkeyed road on ONE instance for the same material (#542)', () => {
    // The cross-road claim §4's reach paragraph rests on, and NOT covered by the two cases
    // above: those compare the fallback with itself. This one compares the fallback with
    // what the EVALUATOR actually mints, taken from `BoxData.evaluate` rather than by
    // calling the key function here — writing `irKeyFor(ir, materialKeyOf(ir))` was the
    // first attempt and it is equal by construction, so it could never have failed.
    //
    // It matters because `ModifiedData` carries no minted key while sharing the very same
    // registry: an arrayed cube (fallback road) and a plain cube (minted road) with equal
    // materials must draw ONE instance. If the evaluator ever minted with a different
    // function, the two roads would silently stop sharing — a lost dedup, invisible on
    // screen and impossible to see from either road on its own.
    const params = BoxDataParams.parse({
      size: [1, 1, 1],
      material: { base: { color: '#2244ff' } },
    });
    const evaluated = BoxDataNode.evaluate(
      params,
      { material: [] },
      {
        time: { frame: 0, seconds: 0, normalized: 0 },
      },
    ) as MeshDataValue;
    expect(evaluated.materialKey, 'the evaluator must mint one at all').toBeTruthy();
    expect(irKeyFor(evaluated.material as InlineMaterialSpec, evaluated.materialKey)).toBe(
      irKeyFor(evaluated.material as InlineMaterialSpec, null),
    );
  });

  it('a map REF change moves the key even when the resolved textures are equal', () => {
    // The safe direction, stated rather than discovered later: the key may separate two
    // inputs whose specs match. Here the IR points at a different image while the
    // caller supplies the same (empty) resolved slots.
    const a = world('ref a', { ir: irWith({ maps: { albedo: null } }) });
    const b = world('ref b', {
      ir: irWith({ maps: { albedo: { hash: 'zzz', colorSpace: 'srgb' } } }),
    });
    expect(keyOf(derive(a).spec)).toBe(keyOf(derive(b).spec));
    expect(derive(a).key).not.toBe(derive(b).key);
  });
});
