// primitiveMaterialInputs — everything a shared primitive material is made of, derived
// in ONE pure place, together with the identity key the registry caches it under (#536 S2).
//
// ── WHAT MOVED HERE, AND WHY IT IS NOT IN THE COMPONENT ─────────────────────────────
//
// `usePrimitiveMaterial` used to compose the override, compile the IR, assemble the spec
// and hand it to the registry, which then re-derived identity by deep-walking that spec.
// The derivation is pure; only the six texture loads are hooks. Pulling the pure half out
// is what makes the invariant below testable at all — inside a component it had no tier
// beneath a browser.
//
// ── THE KEY IS NOT `materialKey` ALONE, AND THAT IS MEASURED ────────────────────────
//
// #536 S1 mints `materialKey` on the evaluated value, and the epic's plan read S2 as
// "the registry keys on it, delete the spec walk". Measured at S1's head, the rendered
// material depends on THREE things the evaluator never sees:
//
//   1. the scene-band `MaterialOverride` — `MaterialOverrideR` pushes it down the render
//      tree as an inherited prop and it is composed HERE, at render time, so it is not in
//      the evaluated value. Keyed on `materialKey` alone, two objects with one base
//      material under different override wrappers collide onto ONE instance and repaint
//      an object nobody overrode. That is the regression the material registry was
//      introduced to prevent, and the road had no gate until
//      `p536-override-band-instance-split.spec.ts`.
//   2. the global shading mode — `wireframe` comes from the viewport store, not the graph.
//   3. the RESOLVED textures — the IR carries map refs; the suspense hooks turn them into
//      instances, and keying on the instance is deliberate so that a slot still loading
//      and a slot loaded are distinct materials rather than one material at two moments.
//   4. the DRAWN MESH'S LAYER LIST (#1062) — a material names the UV and colour layers it
//      reads, and whether a name resolves is a fact about the mesh, not the material. Two
//      objects sharing one material over meshes with different layers must not share an
//      instance. It is the RESOLVED answer that is keyed, not the list — see the key itself.
//
// So the key is `materialKey ⊕ override ⊕ shading ⊕ resolved textures ⊕ resolved layers`.
// The win is not deleting the downstream hash — it is that the EVALUATED half stops being
// re-derived by the renderer (the invariant's first clause), and the render-time
// contributions become named inputs instead of leaves buried in a generic walk.
//
// ── THE INVARIANT THIS MODULE OWES, AND WHO CHECKS IT ───────────────────────────────
//
// **Same key ⇒ same spec.** The old design got this structurally: the key was a total
// function of the spec, so it could not collide. Naming the inputs gives that property up
// unless something re-establishes it, so `primitiveMaterialInputs.test.ts` holds the
// registry's own `keyOf` as an ORACLE and asserts, over a perturbation corpus, that this
// key separates every pair `keyOf` separates. A field added to `PrimitiveMaterialSpec`
// that is not derived from these inputs turns that gate red instead of silently sharing
// two materials that render differently.
//
// ⚠️ A DECLARED LIMIT, verified rather than assumed: passing the minted key and passing
// `null` are BEHAVIOURALLY IDENTICAL, because the fallback is the same function over the
// same IR. The inverse edit was run — `mintedKey` forced to `null` at the call site — and
// it reddened NOTHING: 3622 unit tests and all six browser sharing gates stayed green. So
// "the renderer uses the identity evaluation minted" has no behavioural tier and must not
// be given a fake one. It is a COST claim, and it was measured instead (20k iterations,
// one run, a fully-populated IR with an override):
//
//   keyOf(spec) — what the registry did before   2.528 µs
//   this key, with the evaluator's minted id     0.482 µs   ← 5.2× cheaper
//   this key, re-deriving the id at render       1.282 µs   ← the fallback path
//
// Two independent savings, worth separating: dropping the per-leaf `JSON.stringify` and
// the per-level sort accounts for 2.528 → 1.282, and using the minted key rather than
// re-walking the IR accounts for 1.282 → 0.482. The second is what the wiring buys, and
// it is the one no test can see. Per acquire, per mesh, per render.
//
// The reverse direction is deliberately NOT required: this key may separate two inputs
// that compile to the same spec (two IRs differing only where the compile drops them).
// That is a lost dedup — a perf cost, invisible on screen — never a wrong picture.
// #532 was the case in point and is now HALF closed, deliberately. `alphaTest` and
// `doubleSided` were compiled, keyed and then ignored by the build — measured in a
// browser, toggling them minted a fresh material instance that drew the same picture.
// They are now on the spec and applied, so that split is justified rather than wasted.
// `vertexColors` WAS the remaining case and is no longer one (#1062): it used to ask for a
// geometry attribute a shared material could not promise, and a material that NAMES its
// layer can be resolved against the mesh it will draw on before the spec is assembled. It is
// specced, keyed and applied now, so that split is justified like the other two. The reason
// the old refusal was right, and what exactly changed, is written where the spec is
// (`materialRegistry.ts`). This direction is therefore empty of KNOWN cases — which is a
// statement about today's compile, not a property, and the next field dropped by
// `openpbrToThree` will re-open it.
//
// REF: src/nodes/materialKey.ts (the evaluator's half); src/app/materialRegistry.ts
//      (`keyOf`, now the gate's oracle); src/viewport/SceneFromDAG.tsx
//      (`usePrimitiveMaterial`, `MaterialOverrideR`); issues #530, #532, #536.

import type * as THREE from 'three';
import { materialKeyOf } from '../../nodes/materialKey';
import { threeSideFor } from './threeSide';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { MAP_SLOTS, type PrimitiveMaterialSpec } from '../materialRegistry';
import {
  COLOUR_BUFFER,
  cornerLayerBufferOf,
  uvChannelOf,
  type NamedCornerLayer,
} from '../cornerLayerNames';
import { composeMaterial } from './composeMaterial';
import { flattenedMaterial, flattens } from './flattenMaterial';
import { openpbrToThree, type ThreeMaterialParams } from './openpbrToThree';

/** The six map slots after the suspense hooks have resolved them. */
export type ResolvedMaps = PrimitiveMaterialSpec['textures'];

/**
 * Compose the scene-band override onto the IR and compile it. ONE spelling, shared by
 * the renderer and by the gate — the map refs this returns are what the caller suspends
 * on, which is why compiling and assembling cannot be a single function.
 *
 * #1076 — a FLATTEN override is the one case that does not compose: it replaces the source
 * with a new material built from the override alone (`flattenMaterial.ts`), so its maps
 * compile to null and nothing is loaded. It is branched here, before the compile, because
 * every native mesh (box, sphere, native import, modified mesh) reaches its material
 * through this function — one branch covers them all.
 */
export function compilePrimitiveMaterial(
  ir: InlineMaterialSpec,
  override: MaterialValue | undefined,
): ThreeMaterialParams {
  if (flattens(override)) return openpbrToThree(flattenedMaterial(override));
  return openpbrToThree(override ? composeMaterial(ir, override, 'map-aware') : ir);
}

/**
 * The evaluated half of identity.
 *
 * `minted` is `MeshDataValue.materialKey`, handed down by the evaluator. There is none for
 * value kinds S1 did not reach (`ModifiedDataValue`) or for the fallback material a
 * materialless data node draws, so it falls back to the SAME function the evaluator used
 * rather than to a second spelling of identity — a second spelling is how the two halves
 * would drift apart without any test noticing.
 *
 * #545 — the product now always STATES that absence as `null`: `usePrimitiveMaterial`'s
 * parameter is required, so `undefined` can no longer arrive from any caller. The arm
 * survives in the type because it is the equality this whole design rests on, and the
 * cheapest place to keep saying so is a test that can still pass `undefined`
 * (`primitiveMaterialInputs.test.ts` — `irKeyFor(ir, null) === irKeyFor(ir, undefined)`).
 * Narrowing it would delete that control, which is worth more than the dead width costs.
 */
export function irKeyFor(ir: InlineMaterialSpec, minted: string | null | undefined): string {
  return minted ?? materialKeyOf(ir);
}

/**
 * The identity key. `materialKey` covers the fold; the other three cover what the
 * evaluator cannot see (see the header).
 *
 * Keyed on the shading MODE, not on the `wireframe` boolean it currently reduces to: the
 * mode is the input, so a future mode that changes more of the spec is already covered.
 * It costs nothing in practice — shading is global, so every mesh carries the same value
 * at any instant.
 */
export function primitiveMaterialKey(parts: {
  readonly irKey: string;
  readonly override: MaterialValue | undefined;
  readonly shading: string;
  readonly textures: ResolvedMaps;
  /** The compiled params — the source of the layer NAMES this key resolves. */
  readonly compiled: ThreeMaterialParams;
  /** The ordered layer list of the mesh this material will draw on. */
  readonly layers: readonly NamedCornerLayer[];
}): string {
  const maps = MAP_SLOTS.map((slot) => parts.textures[slot]?.uuid ?? 'n').join(',');
  // #1062 — THE FIFTH THING THE EVALUATOR CANNOT SEE: which layers the mesh this material
  // will draw on actually carries. Two objects with one material over meshes with different
  // layer lists compile the same IR and must NOT share an instance, because the resolution
  // differs — one draws its colour layer and the other cannot.
  //
  // 🔴 KEYED ON THE RESOLVED ANSWER, NOT ON THE LAYER LIST. The list is an input to the
  // resolution, not a property of the material: two meshes carrying wildly different layers
  // that resolve a material's names identically DO draw the same material and should share
  // one. Keying the raw list would split them for nothing — and, worse, would re-key every
  // material in the app the moment any mesh gained a layer its materials never named. This
  // way a material naming nothing contributes a constant, which is what keeps the existing
  // population's keys unchanged.
  const resolved = resolveNamedLayers(parts.compiled, parts.layers);
  const channels = MAP_SLOTS.map((slot) => resolved.mapUvChannels?.[slot] ?? 0).join(',');
  return `${parts.irKey}|${materialKeyOf(parts.override)}|${parts.shading}|${maps}|${resolved.vertexColors ? 'c' : 'n'}:${channels}`;
}

/**
 * The spec the registry builds from — every field derived from the compiled params, the
 * shading mode, or the resolved textures, and nothing read from anywhere else. That
 * closure is what makes the key above sufficient.
 */
export function primitiveMaterialSpec(
  compiled: ThreeMaterialParams,
  shading: string,
  textures: ResolvedMaps,
  layers: readonly NamedCornerLayer[],
): PrimitiveMaterialSpec {
  const resolved = resolveNamedLayers(compiled, layers);
  return {
    color: compiled.color,
    roughness: compiled.roughness,
    metalness: compiled.metalness,
    opacity: compiled.opacity,
    transparent: compiled.transparent,
    emissive: compiled.emissive,
    emissiveIntensity: compiled.emissiveIntensity,
    ior: compiled.ior,
    clearcoat: compiled.clearcoat,
    clearcoatRoughness: compiled.clearcoatRoughness,
    transmission: compiled.transmission,
    thickness: compiled.thickness,
    wireframe: shading === 'wireframe',
    // #532 — the render-mode flags the native build can honour. The spec speaks the
    // build's vocabulary end to end, so `doubleSided` becomes `side` here rather than in
    // the build: a field whose spec name did not match its material property is exactly
    // what the build's enumeration cannot check. The mapping is shared with the glTF
    // road (`threeSide.ts`). `vertexColors` is deliberately NOT here — see below.
    alphaTest: compiled.alphaTest,
    side: threeSideFor(compiled.doubleSided),
    uvTransform: compiled.uvTransform,
    // #550 — per-slot placement, already in THREE's vocabulary. OMITTED when the
    // compile produced none: the spec's content key is a generic walk over own
    // enumerable keys, so a materialised empty bag would re-key every material.
    ...(compiled.mapUvTransforms ? { mapUvTransforms: compiled.mapUvTransforms } : {}),
    // #1062 — the layer names, RESOLVED against the mesh this material will draw on. Spread
    // from one object so the spec and the key below cannot state the resolution differently.
    ...resolved,
    textures,
  };
}

/**
 * Turn the material's LAYER NAMES into what three can act on, against the ordered layer list
 * of the mesh this material is being built for (#1062).
 *
 * 🔴 THE NAME IS LOOKED UP, NEVER PARSED — `cornerLayerNames.ts` carries the argument, and
 * `uvLayerIndex`'s doc carries the counter-example (`UVProject` is a real layer name with
 * no number in it). A name that does not resolve is DROPPED, not guessed at: the material
 * then draws its base colour through channel 0 rather than the black Blender would give.
 *
 * Both halves come back ABSENT when they are the default, because `PrimitiveMaterialSpec` is
 * walked generically for identity and a materialised empty bag re-keys every cached material
 * — except `vertexColors`, which is a plain boolean the build always assigns and so is always
 * present.
 */
function resolveNamedLayers(
  compiled: ThreeMaterialParams,
  layers: readonly NamedCornerLayer[],
): Pick<PrimitiveMaterialSpec, 'vertexColors'> &
  Partial<Pick<PrimitiveMaterialSpec, 'mapUvChannels'>> {
  const colour = compiled.colorLayer;
  // Resolved through the BUFFER rather than by asking whether the name is in the list, so a
  // `float2` layer that happens to share a colour layer's name cannot switch colours on.
  const vertexColors =
    colour !== undefined && cornerLayerBufferOf(layers, colour) === COLOUR_BUFFER;

  const channels: { -readonly [K in keyof ResolvedMaps]?: number } = {};
  for (const slot of MAP_SLOTS) {
    const name = compiled.mapUvLayers?.[slot];
    if (name === undefined) continue;
    const channel = uvChannelOf(layers, name);
    // Channel 0 is three's default and the build leaves an absent slot alone, so recording a
    // resolved 0 would be a no-op that changes the key. Absent covers both "named nothing"
    // and "named the first layer", which draw identically.
    if (channel !== null && channel !== 0) channels[slot] = channel;
  }

  return {
    vertexColors,
    ...(Object.keys(channels).length > 0 ? { mapUvChannels: channels } : {}),
  };
}

/** Convenience for callers that already hold resolved textures: both halves at once. */
export function primitiveMaterialInputs(args: {
  readonly ir: InlineMaterialSpec;
  readonly mintedKey: string | null | undefined;
  readonly override: MaterialValue | undefined;
  readonly shading: string;
  readonly compiled: ThreeMaterialParams;
  readonly textures: ResolvedMaps;
  /**
   * #1062 — the ordered corner layers of the mesh this material will draw on
   * (`cornerLayerNamesOf`). Empty for geometry that carries no layer list, which is the
   * answer that makes every named layer decline to resolve.
   */
  readonly layers: readonly NamedCornerLayer[];
}): { readonly spec: PrimitiveMaterialSpec; readonly key: string } {
  return {
    spec: primitiveMaterialSpec(args.compiled, args.shading, args.textures, args.layers),
    key: primitiveMaterialKey({
      irKey: irKeyFor(args.ir, args.mintedKey),
      override: args.override,
      shading: args.shading,
      textures: args.textures,
      compiled: args.compiled,
      layers: args.layers,
    }),
  };
}

/** Re-exported so a caller never has to reach past this module for the texture type. */
export type { THREE };
