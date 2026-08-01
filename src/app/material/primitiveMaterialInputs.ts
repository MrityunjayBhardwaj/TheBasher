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
//
// So the key is `materialKey ⊕ override ⊕ shading ⊕ resolved textures`. The win is not
// deleting the downstream hash — it is that the EVALUATED half stops being re-derived by
// the renderer (the invariant's first clause), and the three render-time contributions
// become named inputs instead of leaves buried in a generic walk.
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
// That is a lost dedup — a perf cost, invisible on screen — never a wrong picture. #532
// is the case in point: `alphaTest` / `vertexColors` / `doubleSided` are compiled and
// then ignored by the native build, so materials differing only there share today and
// would stop sharing here. That is the safe direction, and it becomes correct rather
// than merely safe once #532 makes the build apply them.
//
// REF: src/nodes/materialKey.ts (the evaluator's half); src/app/materialRegistry.ts
//      (`keyOf`, now the gate's oracle); src/viewport/SceneFromDAG.tsx
//      (`usePrimitiveMaterial`, `MaterialOverrideR`); issues #530, #532, #536.

import type * as THREE from 'three';
import { materialKeyOf } from '../../nodes/materialKey';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { MAP_SLOTS, type PrimitiveMaterialSpec } from '../materialRegistry';
import { composeMaterial } from './composeMaterial';
import { openpbrToThree, type ThreeMaterialParams } from './openpbrToThree';

/** The six map slots after the suspense hooks have resolved them. */
export type ResolvedMaps = PrimitiveMaterialSpec['textures'];

/**
 * Compose the scene-band override onto the IR and compile it. ONE spelling, shared by
 * the renderer and by the gate — the map refs this returns are what the caller suspends
 * on, which is why compiling and assembling cannot be a single function.
 */
export function compilePrimitiveMaterial(
  ir: InlineMaterialSpec,
  override: MaterialValue | undefined,
): ThreeMaterialParams {
  return openpbrToThree(override ? composeMaterial(ir, override, 'map-aware') : ir);
}

/**
 * The evaluated half of identity.
 *
 * `minted` is `MeshDataValue.materialKey`, handed down by the evaluator. It is absent for
 * value kinds S1 did not reach (`ModifiedDataValue`) and for the fallback material a
 * materialless data node draws, so it falls back to the SAME function the evaluator used
 * rather than to a second spelling of identity — a second spelling is how the two halves
 * would drift apart without any test noticing.
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
}): string {
  const maps = MAP_SLOTS.map((slot) => parts.textures[slot]?.uuid ?? 'n').join(',');
  return `${parts.irKey}|${materialKeyOf(parts.override)}|${parts.shading}|${maps}`;
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
): PrimitiveMaterialSpec {
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
    uvTransform: compiled.uvTransform,
    textures,
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
}): { readonly spec: PrimitiveMaterialSpec; readonly key: string } {
  return {
    spec: primitiveMaterialSpec(args.compiled, args.shading, args.textures),
    key: primitiveMaterialKey({
      irKey: irKeyFor(args.ir, args.mintedKey),
      override: args.override,
      shading: args.shading,
      textures: args.textures,
    }),
  };
}

/** Re-exported so a caller never has to reach past this module for the texture type. */
export type { THREE };
