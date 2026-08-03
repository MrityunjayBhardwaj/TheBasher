// #550 RENDER SLICE — the gate for the AUTHORED road: a per-map placement captured
// on the IR must reach the built three.js material, per slot, without ever being
// composed with the shared placement.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS NOT THE IMPORT GATE ────────────────────
//
// `perMapUvCapture.gate.test.ts` proves the IR CARRIES each map's own placement.
// It deliberately proves nothing about the screen — at that point the field had no
// reader at all, which is exactly what made the capture inert. This gate is the
// reader's half: compile → spec → registry → the numbers on the texture clone.
//
// ── THE THREE PROPERTIES, and each is a separate failure ──────────────────────
//
// 1. TRANSLATION. The IR names its slots `albedo/normal/roughness/metalness/
//    emissive/ao`; three names them `map/normalMap/…`. That correspondence already
//    lives in exactly ONE place (`openpbrToThree`, which also already passes the
//    shared `uvTransform` through), so the per-slot bag is translated THERE and both
//    apply roads consume one spelling. A second table in the registry and a third in
//    the glTF overlay is the shape that has already bitten once in this issue
//    (the 6-IR-slots-over-5-glTF-fields mapping) — hence the cross-wiring foil below.
//
// 2. RESOLUTION, NEVER COMPOSITION. A slot listed in `mapUvTransforms` uses its own
//    placement INSTEAD of the shared one — one lookup, `perMap[slot] ?? shared`. The
//    `{tiling, offset, rotation}` family is NOT closed under composition (a rotation
//    after a non-uniform scale is a shear it cannot represent), which is why the
//    representation is replacement; case 3 pins that arithmetically rather than
//    trusting the word "replacement" in a comment.
//
// 3. SHAPE. An IR with no per-map entries must produce a spec with NO such own key.
//    `materialRegistry.keyOf` walks the spec GENERICALLY, so a materialised
//    `mapUvTransforms: undefined` keys differently from an absent one and would
//    re-mint every existing material's GPU instance on first load. Measured at the
//    IR tier before any per-map code existed; this is the same trap one tier down.
//
// The assertions read the BUILT MATERIAL's textures, not the spec — a spec field
// that is keyed but never applied is invisible from the spec side, and "the value
// reached the object I passed in" is not the claim. The claim is that it is drawn.
//
// REF: src/app/material/openpbrToThree.ts (the one slot-name correspondence),
//      src/app/material/uvPlacement.ts (`placeTexture` — resolve + write, shared by
//      both roads, pivot passed in by the caller), src/app/materialRegistry.ts
//      (`build`/`prep`, CENTRE pivot), src/viewport/applyGltfUvTransform.gate.test.ts
//      (the OTHER road, ORIGIN pivot), src/core/import/perMapUvCapture.gate.test.ts
//      (the producer); issues #550, #551 (the pivot axis), #530, #536.

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import type { InlineMaterialMaps, InlineMaterialSpec, UvPlacement } from '../../nodes/types';
import * as materialRegistry from '../materialRegistry';
import { openpbrToThree, type ThreeMaterialMaps } from './openpbrToThree';
import { primitiveMaterialSpec, type ResolvedMaps } from './primitiveMaterialInputs';

/** The correspondence the gate asserts, written out INDEPENDENTLY of the source. */
const THREE_SLOT: Record<keyof InlineMaterialMaps, keyof ThreeMaterialMaps> = {
  albedo: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metalness: 'metalnessMap',
  emissive: 'emissiveMap',
  ao: 'aoMap',
};
const IR_SLOTS = Object.keys(THREE_SLOT) as (keyof InlineMaterialMaps)[];

/** A distinguishable placement per seed — every component differs from every other. */
const placement = (n: number): UvPlacement => ({
  tiling: [n, n * 2],
  offset: [n / 10, n / 20],
  rotation: n / 100,
});

/** The SHARED placement — non-identity, and non-uniform so a composition would shear. */
const SHARED: UvPlacement = { tiling: [3, 1], offset: [0.5, 0.25], rotation: 0.75 };

const ir = (perMap?: Partial<Record<keyof InlineMaterialMaps, UvPlacement>>): InlineMaterialSpec =>
  hydrateInlineMaterial({
    name: 'm',
    uvTransform: SHARED,
    ...(perMap ? { mapUvTransforms: perMap } : {}),
  });

/** Every slot filled, so a per-slot assertion is never vacuous for want of a texture. */
const textures = (): ResolvedMaps => ({
  map: new THREE.Texture(),
  normalMap: new THREE.Texture(),
  roughnessMap: new THREE.Texture(),
  metalnessMap: new THREE.Texture(),
  aoMap: new THREE.Texture(),
  emissiveMap: new THREE.Texture(),
});

const specOf = (spec: InlineMaterialSpec) =>
  primitiveMaterialSpec(openpbrToThree(spec), 'standard', textures());

/** Build through the LIVE road and read back what the slot's texture actually carries. */
function drawn(
  material: THREE.MeshPhysicalMaterial,
  slot: keyof ThreeMaterialMaps,
): {
  tiling: [number, number];
  offset: [number, number];
  rotation: number;
  center: [number, number];
} {
  const t = (material as unknown as Record<string, THREE.Texture | null>)[slot];
  if (!t) throw new Error(`slot ${slot} has no texture — the assertion would be vacuous`);
  return {
    tiling: [t.repeat.x, t.repeat.y],
    offset: [t.offset.x, t.offset.y],
    rotation: t.rotation,
    center: [t.center.x, t.center.y],
  };
}

const asDrawn = (p: UvPlacement, pivot: [number, number]) => ({
  tiling: [p.tiling[0], p.tiling[1]],
  offset: [p.offset[0], p.offset[1]],
  rotation: p.rotation,
  center: pivot,
});

/** The authored road's pivot — see #551; the glTF road uses the UV ORIGIN instead. */
const CENTRE: [number, number] = [0.5, 0.5];

afterEach(() => materialRegistry.clear());

describe('#550 render case 1 — every IR slot reaches ITS three.js slot, and only that one', () => {
  // TWO axes, both ITERATED rather than sampled: the slot that carries its own
  // placement, and (in the same pass) a foil slot that must still carry the shared
  // one. A translation table that cross-wires two slots passes a one-slot spot-check.
  it.each(IR_SLOTS)(
    'slot %s carries its own placement; every other slot carries the shared',
    (slot) => {
      const foil = IR_SLOTS[(IR_SLOTS.indexOf(slot) + 1) % IR_SLOTS.length];
      const own = placement(2);
      const material = materialRegistry.get(specOf(ir({ [slot]: own }))).material;

      expect(drawn(material, THREE_SLOT[slot]), `own slot ${slot}`).toEqual(asDrawn(own, CENTRE));
      expect(drawn(material, THREE_SLOT[foil]), `foil slot ${foil}`).toEqual(
        asDrawn(SHARED, CENTRE),
      );
    },
  );

  it('two slots with DIFFERENT placements land on their own textures (not the last one wins)', () => {
    const material = materialRegistry.get(
      specOf(ir({ albedo: placement(2), emissive: placement(7) })),
    ).material;
    expect(drawn(material, 'map')).toEqual(asDrawn(placement(2), CENTRE));
    expect(drawn(material, 'emissiveMap')).toEqual(asDrawn(placement(7), CENTRE));
    expect(drawn(material, 'normalMap')).toEqual(asDrawn(SHARED, CENTRE));
  });
});

describe('#550 render case 2 — the compile step translates the bag ONCE, keyed by three names', () => {
  it.each(IR_SLOTS)('%s → its three.js slot on the compiled params', (slot) => {
    const own = placement(3);
    const compiled = openpbrToThree(ir({ [slot]: own }));
    expect(compiled.mapUvTransforms?.[THREE_SLOT[slot]], `slot ${slot}`).toEqual(own);
  });

  it('the compiled bag holds EXACTLY the listed slots — an unlisted slot is absent, not identity', () => {
    const compiled = openpbrToThree(ir({ ao: placement(4) }));
    expect(Object.keys(compiled.mapUvTransforms ?? {})).toEqual(['aoMap']);
  });
});

describe('#550 render case 3 — REPLACEMENT, arithmetically (V154: the family is not closed)', () => {
  it('a per-map slot ignores the shared placement entirely — no product, no sum', () => {
    // SHARED is [3,1] non-uniform with a rotation; the per-map value rotates too.
    // Any composition of the two is a SHEAR, which this five-number representation
    // cannot express — so the only representable answer is "the per-map value".
    const own: UvPlacement = { tiling: [2, 2], offset: [0.1, 0.2], rotation: 0.5 };
    const material = materialRegistry.get(specOf(ir({ albedo: own }))).material;
    const got = drawn(material, 'map');

    expect(got.tiling).toEqual([2, 2]); // NOT [6,2] (product) and NOT [5,3] (sum)
    expect(got.offset).toEqual([0.1, 0.2]); // NOT [0.6,0.45]
    expect(got.rotation).toBe(0.5); // NOT 1.25
  });

  it('an identity per-map entry REPLACES a non-identity shared placement', () => {
    // The import slice records a present-but-untransformed slot at identity on
    // purpose: it must not silently move when the shared value is later edited.
    // Under composition this case is indistinguishable from "unlisted"; under
    // replacement it is the opposite of it.
    const identity: UvPlacement = { tiling: [1, 1], offset: [0, 0], rotation: 0 };
    const material = materialRegistry.get(specOf(ir({ normal: identity }))).material;
    expect(drawn(material, 'normalMap')).toEqual(asDrawn(identity, CENTRE));
    expect(drawn(material, 'map')).toEqual(asDrawn(SHARED, CENTRE));
  });
});

describe('#550 render case 4 — the SHAPE rule survives one tier down (the re-mint trap)', () => {
  it('an IR with no per-map entries compiles to params with NO such own key', () => {
    const compiled = openpbrToThree(ir());
    expect(Object.prototype.hasOwnProperty.call(compiled, 'mapUvTransforms')).toBe(false);
  });

  it('…and to a spec with no such own key, so every existing material keeps its key', () => {
    const spec = specOf(ir());
    expect(Object.prototype.hasOwnProperty.call(spec, 'mapUvTransforms')).toBe(false);
  });

  it('an EMPTY bag on the IR compiles to no key either — absence, one representation later', () => {
    // Found by falsification: deleting the empty-bag guard reddened nothing, because
    // `hydrateInlineMaterial` already drops an empty bag, so no fixture built through
    // the hydrator can reach that branch. `openpbrToThree` takes an IR from anywhere —
    // its own contract has to hold, not the hydrator's on its behalf.
    const compiled = openpbrToThree({ ...ir(), mapUvTransforms: {} });
    expect(Object.prototype.hasOwnProperty.call(compiled, 'mapUvTransforms')).toBe(false);
  });

  it('…and a bag whose only slot is empty is the same absence', () => {
    const compiled = openpbrToThree({ ...ir(), mapUvTransforms: { albedo: undefined } });
    expect(Object.prototype.hasOwnProperty.call(compiled, 'mapUvTransforms')).toBe(false);
  });

  it('CONTROL — a per-map IR DOES put the key on the spec (so the absence above is not vacuous)', () => {
    const spec = specOf(ir({ albedo: placement(2) }));
    expect(Object.prototype.hasOwnProperty.call(spec, 'mapUvTransforms')).toBe(true);
  });

  it('the content key separates two materials differing ONLY in a per-map slot', () => {
    const maps = textures();
    const a = primitiveMaterialSpec(openpbrToThree(ir({ albedo: placement(2) })), 'standard', maps);
    const b = primitiveMaterialSpec(openpbrToThree(ir({ albedo: placement(3) })), 'standard', maps);
    expect(materialRegistry.keyOf(a)).not.toBe(materialRegistry.keyOf(b));
  });

  it('…and separates the SAME placement on two DIFFERENT slots', () => {
    const maps = textures();
    const a = primitiveMaterialSpec(openpbrToThree(ir({ albedo: placement(2) })), 'standard', maps);
    const b = primitiveMaterialSpec(openpbrToThree(ir({ normal: placement(2) })), 'standard', maps);
    expect(materialRegistry.keyOf(a)).not.toBe(materialRegistry.keyOf(b));
  });

  it('PAIRED — two identical per-map specs share one key (the separation is not blanket)', () => {
    const maps = textures();
    const a = primitiveMaterialSpec(openpbrToThree(ir({ albedo: placement(2) })), 'standard', maps);
    const b = primitiveMaterialSpec(openpbrToThree(ir({ albedo: placement(2) })), 'standard', maps);
    expect(materialRegistry.keyOf(a)).toBe(materialRegistry.keyOf(b));
  });
});

describe('#550 render case 5 — the behaviour that must NOT change', () => {
  it('a material with no per-map entries places every slot with the shared value', () => {
    const material = materialRegistry.get(specOf(ir())).material;
    for (const slot of IR_SLOTS) {
      expect(drawn(material, THREE_SLOT[slot]), `slot ${slot}`).toEqual(asDrawn(SHARED, CENTRE));
    }
  });

  it('the authored road still pivots about the texture CENTRE (#551 — the pivot rides the road)', () => {
    const material = materialRegistry.get(specOf(ir({ albedo: placement(2) }))).material;
    expect(drawn(material, 'map').center).toEqual([0.5, 0.5]);
    expect(drawn(material, 'normalMap').center).toEqual([0.5, 0.5]);
  });
});
