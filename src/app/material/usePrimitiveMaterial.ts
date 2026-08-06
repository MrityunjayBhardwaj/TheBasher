// usePrimitiveMaterial — the ATTACH door on `materialRegistry`, and the only one.
//
// ── WHY THIS IS ITS OWN MODULE (#536 S3) ──────────────────────────────────────────────
//
// This function is the sole production consumer of a shared `THREE.Material` instance:
// it asks the registry to build one, retains a holder for as long as a mesh is mounted
// with it, and releases on unmount. That is a share of OWNERSHIP, and it is a different
// relationship from every other way a module can touch material data (composing a spec,
// reading `MAP_SLOTS`, naming the spec type) — none of which take an instance out.
//
// While it lived inside `SceneFromDAG.tsx` that distinction was unstatable. The file
// imported the registry as a namespace, so the import line said only "this 4,000-line
// component touches materials somewhere", and no structural gate could tell the accessor
// surface apart from the spec surface. Extracting the function moves the answer to an
// import line: `src/app/material/usePrimitiveMaterial.ts` names `get`/`retain`/`release`,
// and `registryDoors.gate.test.ts` can then assert that NOTHING ELSE does.
//
// It closes over nothing but its imports, so this is a move rather than a rewrite — the
// body below is unchanged, and the two call sites (`ModifiedMeshR` and `ObjectR`'s data
// road, both in `SceneFromDAG.tsx`) now import it.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────
//
// v0.6 #2 (#178, W2) — the ONE shared primitive material builder for Box+Sphere.
// Mirrors BakedMeshR's imperative useMemo build (single writer V20): compile the
// OpenPBR IR via openpbrToThree (the one mapping site, V29) → MeshPhysicalMaterial.
// Standard→Physical is PERF-SAFE: at coat.weight=0/transmission.weight=0 the
// compiled shader carries no clearcoat/transmission GLSL — three gates the defines
// on `> 0` (WebGLPrograms.js:130,134 HAS_CLEARCOAT/HAS_TRANSMISSION; the setters
// MeshPhysicalMaterial.js:104,176 only recompile across the 0 boundary). roughness
// and clearcoatRoughness are set EXPLICITLY (three defaults are 1 and 0 — D-03).
// A MaterialOverride decorator (#99/#124) composes onto the IR through the ONE
// shared rule (`composeMaterial`, #394 S3b) BEFORE the compile, so the override
// is map-aware here exactly as it is on the glTF road: a roughness/metalness map
// on the primitive's own material defends its channel unless the director
// explicitly authored that field. It used to win WHOLESALE on all 7 scalars, on
// the premise "a primitive has no source map" — false since MaterialEditor grew
// map rows (NPanel.tsx:1395) and this very function started loading them below.
// coat/transmission/ior/maps still always come from the IR (the override carries
// no opinion on them), and `transparent` now comes from the compile rather than
// being re-derived as `opacity < 1`.
//
// #530 — the built material is no longer per-component. Two meshes whose material
// RESOLVES to the same thing now draw the same `THREE.Material` instance, via the
// content-keyed `materialRegistry` (PERFORMANCE.md Lever 5). Everything the build
// reads travels in one spec object, and the key is taken over that spec, so a mesh
// carrying an override composes to a different spec and correctly gets its own
// instance — clone-on-override is preserved by construction rather than by a rule
// the registry has to be told.
// #536 S2 — `mintedKey` is `MeshDataValue.materialKey`, the identity the EVALUATOR
// decided (the fold: param → socket → operator lane). Pass it and the renderer stops
// re-deriving that half. Only `MeshData` carries one today: `ModifiedMeshR`'s value kind
// has none, and a materialless data node draws the fallback IR, which the evaluator never
// keyed. Both fall back to the SAME function the evaluator used, never to a second
// spelling of identity.
//
// ── #545 — WHY THIS PARAMETER IS REQUIRED AND NOT OPTIONAL ────────────────────────────
//
// #545 asked whether `ModifiedData` should mint a key, and the answer measured out as NO:
// the fallback IS the evaluator's own function over the evaluator's own IR, so there is no
// second spelling that could drift. What that answer leaves behind is a scheduling hazard
// rather than a defect. #545 names three conditions that would turn the fallback from
// sufficient into wrong, and the third is "a second unkeyed road starts sharing the
// registry" — which, while this argument was optional, a new road satisfied by simply not
// writing it. An omission is not a decision, and it leaves no trace for anyone to review.
//
// It cannot be caught below the type system either, and that is the whole reason for the
// climb. Omitting the argument yields `irKeyFor(ir, undefined) === materialKeyOf(ir)`,
// which is exactly what a correct minted key equals today — so an omitting caller is
// EQUAL BY CONSTRUCTION to a correct one, and no test at any tier can red on it. The
// constraint has no runtime instrument available to hold it; the signature is the only
// place it can live.
//
// Required, so every caller states which road it is on. `null` is the escape hatch, and
// it is counted EXACTLY by `materialKeyReach.gate.test.ts` case D — a floor would let the
// unkeyed set grow one quiet caller at a time, which is the failure this is here to stop.
// Passing `null` is a claim: THIS road has no minted identity and the downstream fallback
// is the right answer for it. Adding a second such caller must be an argument someone
// makes, not a default they inherit.
//
// REF: src/app/materialRegistry.ts (the subject); src/app/registryDoors.gate.test.ts
//      (the gate that keeps this the only accessor consumer);
//      src/app/material/primitiveMaterialInputs.ts (the pure half — spec AND key);
//      docs/RENDER-RESOURCE-IDENTITY-DESIGN.md S3; issues #530, #533, #535, #536.

import { useLayoutEffect } from 'react';
import type * as THREE from 'three';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { useBakedTexture } from '../asset/bakedTextureLoader';
// The accessor surface, imported by NAME. `import * as materialRegistry` would name the
// module and never the binding, which is exactly the door this seam exists to declare —
// see `registryDoors.gate.test.ts` case 1, which refuses the namespace form outright.
import { get as getMaterial, release, retain } from '../materialRegistry';
import { compilePrimitiveMaterial, primitiveMaterialInputs } from './primitiveMaterialInputs';

export function usePrimitiveMaterial(
  ir: InlineMaterialSpec,
  override: MaterialValue | undefined,
  shading: string,
  mintedKey: string | null,
): THREE.MeshPhysicalMaterial {
  const compiled = compilePrimitiveMaterial(ir, override);
  // v0.6 #2 (#178, W5) — suspense-load the 6 map slots UNCONDITIONALLY (rules-of-
  // hooks safe; useBakedTexture(null) is a no-op). The OPFS read + decode lives in
  // the loader hook, never in the resolver (V29). The ref carries the colorspace;
  // re-assert it per slot in the registry's build (M5 — a data map as sRGB washes
  // out), mirroring BakedMeshR's sRGB/linear split. This is why compiling and
  // assembling are two calls: the refs to suspend on come out of the compile.
  const mapTex = useBakedTexture(compiled.maps.map);
  const normalTex = useBakedTexture(compiled.maps.normalMap);
  const roughnessTex = useBakedTexture(compiled.maps.roughnessMap);
  const metalnessTex = useBakedTexture(compiled.maps.metalnessMap);
  const aoTex = useBakedTexture(compiled.maps.aoMap);
  const emissiveTex = useBakedTexture(compiled.maps.emissiveMap);
  // Both halves from one pure place, so "same key ⇒ same spec" has a tier below the
  // browser to be checked at. v0.6 #3 (#181, W2)'s ONE shared UV placement travels on
  // the spec and is applied to all 6 map clones by the build.
  const { spec, key } = primitiveMaterialInputs({
    ir,
    mintedKey,
    override,
    shading,
    compiled,
    textures: {
      map: mapTex,
      normalMap: normalTex,
      roughnessMap: roughnessTex,
      metalnessMap: metalnessTex,
      aoMap: aoTex,
      emissiveMap: emissiveTex,
    },
  });
  // The registry builds and owns the material AND its texture clones (V20 single
  // writer, moved one level out). `get` deliberately does not count holders — a
  // render can be discarded, and StrictMode runs every render twice, so a count
  // taken here would over-count on both. The commit phase counts instead.
  const { material } = getMaterial(spec, key);
  // LAYOUT effect, not passive: it runs synchronously inside the commit, so there
  // is no window between this mesh rendering with the shared instance and this
  // mesh being counted as a holder of it. A passive effect leaves that window open
  // for another mesh's release to evict the instance out from under this one.
  useLayoutEffect(() => {
    retain(key);
    return () => release(key);
  }, [key]);
  return material;
}
