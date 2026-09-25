// #1062 DRAW SLICE — a material NAMES the layers it reads, and the drawn material honours
// that name only when the mesh in hand actually carries it.
//
// ── THE DIVERGENCE THIS PINS, AND WHY IT IS DELIBERATE ────────────────────────────────
//
// Measured against Blender 4.5.9 LTS, headless, Cycles first pixel: a material naming a
// colour or UV layer the mesh does NOT have draws **black** (`0, 0, 0`). The documented
// fallback in those shader nodes is for an EMPTY name — "use the active layer" — not for a
// name that fails to resolve.
//
// We do the opposite ON PURPOSE, and this file is where that choice is held to:
//
//   | a named layer the mesh lacks | Blender 4.5.9 | here                        |
//   | ---------------------------- | ------------- | --------------------------- |
//   | colour layer                 | black         | the material's base colour  |
//   | UV layer on a map            | black         | channel 0                   |
//
// Two reasons, both structural rather than preference. There is no ACTIVE-LAYER notion in
// this substrate, so there is nothing for an empty name to fall back TO and the two cases
// Blender distinguishes collapse into one here. And a silently black mesh is precisely the
// failure #1062 exists to remove — the old refusal was there because applying `vertexColors`
// to geometry without the attribute rendered a black box.
//
// 🔴 THE ASSERTIONS READ THE BUILT MATERIAL, NEVER THE SPEC. A field that is specced and
// keyed but never applied is invisible from the spec side, and "the value reached the object
// I passed in" is not the claim being made. The claim is that it is DRAWN.
//
// REF: ref/GROUND_TRUTH_BLENDER_ATTRIBUTE_NAMING.md (the measurement + `file:line` for the
//      empty-name fallback); src/app/cornerLayerNames.ts (the lookup);
//      src/app/materialRegistry.ts (the spec + build); issues #1062, #1117, #881.

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import type { InlineMaterialSpec } from '../../nodes/types';
import { COLOR_LAYER, UV_MAP, UV_PROJECT, uvLayerName } from '../../nodes/attributes';
import * as materialRegistry from '../materialRegistry';
import type { NamedCornerLayer } from '../cornerLayerNames';
import { openpbrToThree } from './openpbrToThree';
import {
  primitiveMaterialKey,
  primitiveMaterialSpec,
  type ResolvedMaps,
} from './primitiveMaterialInputs';

/** The layer list of a mesh carrying two UV sets and a colour — the #1062 shape. */
const RICH: readonly NamedCornerLayer[] = [
  { name: UV_MAP, type: 'float2' },
  { name: uvLayerName(1), type: 'float2' },
  { name: COLOR_LAYER, type: 'float4' },
];
/** A mesh with one UV set and NO colour — the "names a layer I lack" subject. */
const BARE: readonly NamedCornerLayer[] = [{ name: UV_MAP, type: 'float2' }];

const BASE_COLOR = '#c81e5a';

function ir(geometry?: { colorLayer?: string }, mapUvLayers?: Record<string, string>) {
  return hydrateInlineMaterial({
    name: 'm',
    base: { color: BASE_COLOR },
    ...(geometry ? { geometry } : {}),
    ...(mapUvLayers ? { mapUvLayers } : {}),
  });
}

/**
 * ONE instance per slot, shared by every call. Fresh `THREE.Texture`s would carry fresh
 * uuids, and the key's texture half would then differ between two calls that mean to differ
 * only in their layers — a helper that makes every key comparison below vacuously true.
 */
const SHARED_TEXTURES: ResolvedMaps = {
  map: new THREE.Texture(),
  normalMap: new THREE.Texture(),
  roughnessMap: new THREE.Texture(),
  metalnessMap: new THREE.Texture(),
  aoMap: new THREE.Texture(),
  emissiveMap: new THREE.Texture(),
};
const textures = (): ResolvedMaps => SHARED_TEXTURES;

/** Build through the LIVE registry road and hand back what will actually be drawn. */
function drawn(
  spec: InlineMaterialSpec,
  layers: readonly NamedCornerLayer[],
): THREE.MeshPhysicalMaterial {
  const compiled = openpbrToThree(spec);
  const built = primitiveMaterialSpec(compiled, 'standard', textures(), layers);
  // Keyed per call so each row builds its own instance rather than reading a sibling row's
  // cached material — the content key would otherwise share across rows that mean to differ.
  return materialRegistry.get(built, `k-${Math.random()}`).material;
}

function keyOf(spec: InlineMaterialSpec, layers: readonly NamedCornerLayer[]): string {
  const compiled = openpbrToThree(spec);
  return primitiveMaterialKey({
    irKey: 'IR',
    override: undefined,
    shading: 'standard',
    textures: textures(),
    compiled,
    layers,
  });
}

afterEach(() => materialRegistry.clear());

describe('#1062 — a material naming a layer the mesh HAS draws it', () => {
  it('turns vertex colours on when the named colour layer is there', () => {
    expect(drawn(ir({ colorLayer: COLOR_LAYER }), RICH).vertexColors).toBe(true);
  });

  it('samples the UV set the map names, not the first one', () => {
    const material = drawn(ir(undefined, { albedo: uvLayerName(1) }), RICH);
    // `uv1` is channel 1 — resolved by POSITION in the mesh's layer list, not by reading the
    // `.001` out of the name.
    expect(material.map?.channel).toBe(1);
  });

  it("leaves a map naming the FIRST layer on three's own default", () => {
    const material = drawn(ir(undefined, { albedo: UV_MAP }), RICH);
    expect(material.map?.channel).toBe(0);
  });
});

describe('#1062 — a material naming a layer the mesh LACKS is not honoured, and never black', () => {
  it('draws its base colour rather than multiplying by an absent colour attribute', () => {
    // THE DIVERGENCE. Blender draws `0,0,0` here; we draw the material.
    const material = drawn(ir({ colorLayer: COLOR_LAYER }), BARE);
    expect(material.vertexColors).toBe(false);
    expect(`#${material.color.getHexString()}`).toBe(BASE_COLOR);
  });

  it('samples channel 0 for a map naming a UV set this mesh does not have', () => {
    const material = drawn(ir(undefined, { albedo: uvLayerName(1) }), BARE);
    expect(material.map?.channel).toBe(0);
  });

  it('declines every name when the geometry carries no layer list at all', () => {
    // `[]` is the clone road's and the bake's answer — no list, so nothing resolves.
    const material = drawn(ir({ colorLayer: COLOR_LAYER }, { albedo: uvLayerName(1) }), []);
    expect(material.vertexColors).toBe(false);
    expect(material.map?.channel).toBe(0);
  });

  it('stops resolving the source UV set once a projection has replaced it', () => {
    // 🔴 WHY THE NAME IS LOOKED UP AND NEVER PARSED ([[V515]]). A projected mesh's first
    // `float2` is `UVProject`; a material still naming `UVMap` names a layer that is gone,
    // and honouring it by parsing "UVMap → 0" would sample the projection while claiming to
    // sample the source's UVs.
    const projected: readonly NamedCornerLayer[] = [{ name: UV_PROJECT, type: 'float2' }];
    expect(drawn(ir(undefined, { albedo: UV_MAP }), projected).map?.channel).toBe(0);
    // And the projection's own name DOES resolve, on the same mesh.
    expect(drawn(ir(undefined, { albedo: UV_PROJECT }), projected).map?.channel).toBe(0);
  });

  it('refuses to sample a COLOUR layer as if it were UVs', () => {
    // `color` is not a UV buffer, so this name does not resolve and the map falls to 0.
    //
    // 🔴 MEASURED INTERLEAVED, AND THAT IS THE WHOLE POINT OF THE FIXTURE. Over RICH — where
    // the colour is LAST — "declined" and "resolved to channel 0" are the same observable, and
    // a row written that way cannot fail: falsification confirmed it, an implementation that
    // happily resolved a colour to channel 0 kept it green. Here the colour sits at INDEX 1 of
    // the list while the second UV set sits at index 2, so the two commonest wrong answers —
    // the layer's list INDEX, and the next UV channel — are both non-zero and both visible.
    const interleaved: readonly NamedCornerLayer[] = [
      { name: UV_MAP, type: 'float2' },
      { name: COLOR_LAYER, type: 'float4' },
      { name: uvLayerName(1), type: 'float2' },
    ];
    expect(drawn(ir(undefined, { albedo: COLOR_LAYER }), interleaved).map?.channel).toBe(0);
    // The control: on that SAME mesh a real UV name still resolves, so the row above is a
    // refusal rather than a resolver that has stopped working.
    expect(drawn(ir(undefined, { albedo: uvLayerName(1) }), interleaved).map?.channel).toBe(1);

    // ⚠️ A DECLARED LIMIT, found by falsification rather than assumed. `uvChannelOf`
    // returning `null` for a colour buffer and returning `0` are NOT distinguishable at any
    // tier here, and a mutant making that swap stays green: the build omits a channel-0 slot
    // either way, so the two implementations draw the same pixels. The `null` is kept because
    // it states the honest answer ("this name is not a UV layer") rather than a coincidence,
    // and it is the answer that stays correct if channel 0 ever stops meaning "absent" — but
    // it must not be given a fake tier by a row that would pass against both.
  });
});

describe('#1062 — the layer signature reaches the identity key', () => {
  it('splits one material across meshes that resolve it differently', () => {
    // The sharing objection the old refusal rested on, answered: these two meshes draw the
    // same IR and MUST NOT share an instance, because one has the colour layer and one does
    // not. Same key here would mean one of them draws the other's answer.
    expect(keyOf(ir({ colorLayer: COLOR_LAYER }), RICH)).not.toBe(
      keyOf(ir({ colorLayer: COLOR_LAYER }), BARE),
    );
  });

  it('splits two maps that resolve to different UV channels', () => {
    expect(keyOf(ir(undefined, { albedo: uvLayerName(1) }), RICH)).not.toBe(
      keyOf(ir(undefined, { albedo: UV_MAP }), RICH),
    );
  });

  it('keeps one key for meshes whose layers the material never names', () => {
    // 🔴 THE POPULATION-WIDE COST TEST. Nearly every material in the app names no layer, and
    // if the raw layer list were keyed, those materials would split per mesh — re-minting the
    // GPU cache for nothing. Keying the RESOLVED answer is what keeps this equal.
    expect(keyOf(ir(), RICH)).toBe(keyOf(ir(), BARE));
    expect(keyOf(ir(), RICH)).toBe(keyOf(ir(), []));
  });

  it('does not re-key a material that names a layer it cannot resolve anywhere', () => {
    // An unresolvable name draws exactly like no name at all, so it must KEY like one too —
    // otherwise a saved material naming a since-renamed layer silently doubles the cache.
    expect(keyOf(ir({ colorLayer: 'NoSuchColour' }), RICH)).toBe(keyOf(ir(), RICH));
  });
});
