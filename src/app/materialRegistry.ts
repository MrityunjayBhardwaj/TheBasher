// Material registry — a derived RUNTIME cache mapping the CONTENT of a built
// primitive material to a single shared `THREE.MeshPhysicalMaterial` (#530,
// PERFORMANCE.md Lever 5).
//
// Mirrors `geometryRegistry.ts` and carries the same V1-EXEMPTION: this is a
// DERIVED cache, NOT authoritative state. It is keyed by content, it is NEVER
// serialized into the DAG, and it never participates in Ops / undo / content
// hashing. The DAG carries the material IR; the compiled three.js instance lives
// only here.
//
// ── WHY CONTENT, AND NOT THE MATERIAL NODE'S ID ─────────────────────────────────
//
// Two objects linked to one Material node were the case that prompted this, and
// keying on that node's id would serve exactly that case and nothing else. It
// would also be WRONG in the direction that matters: the material a mesh draws is
// the output of a fold — the node's param, superseded by its `material` socket,
// composed with every operator in its lane, then with the scene-band wrapper. Two
// objects linked to one Material node whose stacks differ must NOT share, and two
// objects that never heard of each other but resolve to the same material may.
// The identity that decides sharing is therefore the RESOLVED material, which is
// what this key is taken over. Measured: linked-to-one-node resolves to two deeply
// equal IRs (distinct objects — `resolveNodeMaterial` hydrates a fresh one per
// evaluation), so reference identity was never available as a key anyway.
//
// ── WHERE THE KEY COMES FROM (CHANGED BY #536 S2) ───────────────────────────────
//
// Originally `keyOf` walked every leaf of the spec, and since the spec is also the
// builder's ONLY input, "two materials that render differently share an instance"
// had no way in — the guarantee was structural.
//
// S2 moved the EVALUATED half of that identity upstream: the caller now passes a
// key anchored on `MeshDataValue.materialKey`, which the evaluator mints after the
// fold, combined with the three things the evaluator cannot see (the scene-band
// override, composed at render time; the global shading mode; the RESOLVED
// textures). See `material/primitiveMaterialInputs.ts` for the composition and the
// measurements behind it.
//
// That trades the structural guarantee for a checked one, so it is checked:
// `primitiveMaterialInputs.test.ts` holds `keyOf` as an ORACLE and asserts the
// composed key separates every pair the walk separates. `keyOf` also remains this
// module's DEFAULT, so a caller that passes no key gets the old behaviour rather
// than a weaker one.
//
// ── LIFETIME: REFCOUNTED, AND EVICTION IS DEFERRED BY ONE TICK ──────────────────
//
// Unlike a geometry, a material owns per-material texture CLONES (the UV placement
// is applied to a clone, since the decoded textures are shared by hash), so it
// cannot simply be cached forever — the clones would accumulate for every material
// variant an edit session ever produced. So holders retain and release.
//
// `get` does NOT count. Counting happens in the commit phase (see
// `usePrimitiveMaterial`), because a render can be thrown away and StrictMode runs
// effects twice; a count taken during render leaks on both.
//
// Eviction at zero is deferred to a microtask because a HANDOFF looks like a drop:
// when one mesh unmounts and another mounts in the same commit, React runs every
// cleanup before any effect, so the count legitimately touches zero in between.
// Re-checking a tick later sees the new holder and keeps the instance.
//
// DECLARED, not overlooked: only a RELEASE can queue an eviction, so an entry built
// by a render that never commits is never counted and never evicted — it lingers
// until `clear`. That is the geometry registry's behaviour for every entry, and it
// is bounded here by the number of distinct materials a discarded render produced.
// The alternative — sweeping uncounted entries on a timer — would race the commit
// that is about to retain them, which is the more expensive failure.
//
// ── WHAT IS DELIBERATELY NOT ON THE SPEC ────────────────────────────────────────
//
// `openpbrToThree` also compiles `alphaTest`, `vertexColors` and `doubleSided`. The
// native road has never applied them (#532), so they are absent here rather than
// carried unused: the spec is the set of fields the build APPLIES, and keying on a
// field nobody applies would split the cache while changing nothing on screen.
// Whoever fixes #532 adds them here, and the key follows for free.
//
// REF: docs/PERFORMANCE.md Lever 5; src/app/geometryRegistry.ts (the mirrored
//      pattern); issue #530.

import * as THREE from 'three';
import { CENTRE_PIVOT, placeTexture, resolveSlotPlacement } from './material/uvPlacement';
import type { SlotPlacements } from './material/uvPlacement';

/**
 * Everything a shared primitive material is made of — and the builder's ONLY
 * input, so that the key (taken over this whole object) cannot miss a field the
 * build reads.
 *
 * Scalar field names match their `MeshPhysicalMaterial` property exactly. That is
 * load-bearing rather than tidy: it is what lets the gate assert, for every field
 * on the spec, that the built material actually carries it — a field that is
 * specced and keyed but never applied would otherwise be invisible.
 */
export interface PrimitiveMaterialSpec {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly transparent: boolean;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  readonly ior: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly transmission: number;
  readonly thickness: number;
  readonly wireframe: boolean;
  /** The shared UV placement — used by every slot that has none of its own (v0.6 #3). */
  readonly uvTransform: {
    readonly tiling: readonly [number, number];
    readonly offset: readonly [number, number];
    readonly rotation: number;
  };
  /**
   * #550 — per-slot placement, in THREE's slot vocabulary (translated once, by
   * `openpbrToThree`). A slot listed here REPLACES the shared placement above; a
   * slot not listed uses it. Never composed — see `material/uvPlacement.ts`.
   *
   * 🔴 ABSENT, not `undefined`, when there is nothing per-map: {@link keyOf} walks
   * this spec generically, so a materialised empty bag keys differently from an
   * absent one and would re-mint every cached material on first load.
   */
  readonly mapUvTransforms?: SlotPlacements<keyof PrimitiveMaterialSpec['textures']>;
  /**
   * The RESOLVED map textures (already decoded + shared by hash), not the refs.
   * Resolution happens above this module, in the suspense hooks; keying on the
   * instance means a slot that is still loading and one that has loaded are
   * distinct materials rather than the same one at two moments.
   */
  readonly textures: {
    readonly map: THREE.Texture | null;
    readonly normalMap: THREE.Texture | null;
    readonly roughnessMap: THREE.Texture | null;
    readonly metalnessMap: THREE.Texture | null;
    readonly aoMap: THREE.Texture | null;
    readonly emissiveMap: THREE.Texture | null;
  };
}

/** sRGB for colour maps, linear for data maps (M5 — a data map as sRGB washes out). */
const MAP_COLOR_SPACE: Record<keyof PrimitiveMaterialSpec['textures'], THREE.ColorSpace> = {
  map: THREE.SRGBColorSpace,
  normalMap: THREE.LinearSRGBColorSpace,
  roughnessMap: THREE.LinearSRGBColorSpace,
  metalnessMap: THREE.LinearSRGBColorSpace,
  aoMap: THREE.LinearSRGBColorSpace,
  emissiveMap: THREE.SRGBColorSpace,
};

/**
 * The map slots, in one order. Derived from {@link MAP_COLOR_SPACE} rather than written
 * out again, so a seventh slot cannot be added to the spec and forgotten by a caller
 * assembling the texture half of an identity key (#536 S2).
 */
export const MAP_SLOTS = Object.keys(
  MAP_COLOR_SPACE,
) as (keyof PrimitiveMaterialSpec['textures'])[];

interface Entry {
  readonly material: THREE.MeshPhysicalMaterial;
  /** Committed holders. `get` never touches this — only `retain` / `release`. */
  count: number;
  /** An eviction is already queued for this entry (do not queue a second). */
  evicting: boolean;
}

const cache = new Map<string, Entry>();

/**
 * The content key. Walks the spec GENERICALLY — sorted keys so declaration order
 * cannot matter, textures reduced to their uuid — so that a field added to
 * `PrimitiveMaterialSpec` is keyed without anyone remembering to key it.
 *
 * #536 S2 — this is no longer what production keys on. The renderer now supplies a key
 * anchored on the identity the EVALUATOR minted (`materialKey`) combined with the three
 * contributions the evaluator cannot see, so identity stops being rediscovered here.
 * This function survives in two roles, both deliberate:
 *
 *   · the DEFAULT for {@link get}, so a caller that supplies no key falls back to the
 *     old, structurally-safe behaviour rather than to something weaker;
 *   · the ORACLE for `primitiveMaterialInputs.test.ts`, which asserts that the composed
 *     key separates every pair this walk separates. That is what keeps "a field added to
 *     the spec is keyed for free" true after the key stopped being a function of the spec.
 */
export function keyOf(spec: PrimitiveMaterialSpec): string {
  return serialize(spec);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (typeof value === 'object') {
    const tex = value as { isTexture?: boolean; uuid?: string };
    if (tex.isTexture) return `tex:${tex.uuid}`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${k}:${serialize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Resolve a spec to its shared material, building on miss.
 *
 * Does NOT change the refcount — a render may never commit. The caller retains in
 * the commit phase and releases on unmount. Returns the key alongside so the
 * caller can key that effect without re-deriving it.
 *
 * `key` is the caller's identity for this spec (#536 S2 — `primitiveMaterialInputs`
 * composes it from the evaluator's `materialKey` plus what the evaluator cannot see).
 * It carries ONE obligation: two specs the build would render differently must never
 * share a key. Omitting it falls back to {@link keyOf}, which satisfies that obligation
 * structurally — so a forgetful caller lands on the old behaviour, not on a weaker one.
 */
export function get(
  spec: PrimitiveMaterialSpec,
  key: string = keyOf(spec),
): {
  key: string;
  material: THREE.MeshPhysicalMaterial;
} {
  const hit = cache.get(key);
  if (hit) return { key, material: hit.material };
  const material = build(spec);
  cache.set(key, { material, count: 0, evicting: false });
  return { key, material };
}

/** Register a committed holder. Safe on a key this registry has forgotten (no-op). */
export function retain(key: string): void {
  const entry = cache.get(key);
  if (entry) entry.count += 1;
}

/**
 * Drop a committed holder. At zero the entry is queued for eviction one tick
 * later — a mesh unmounting and another mounting in the same commit passes
 * through zero, and that is a handoff, not a drop (see the header).
 */
export function release(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0 || entry.evicting) return;
  entry.evicting = true;
  queueMicrotask(() => {
    entry.evicting = false;
    if (entry.count > 0) return; // a new holder arrived — this was a handoff
    if (cache.get(key) !== entry) return; // already replaced
    cache.delete(key);
    dispose(entry.material);
  });
}

function build(spec: PrimitiveMaterialSpec): THREE.MeshPhysicalMaterial {
  // Textures are cached & SHARED by hash (bakedTextureLoader), so CLONE before
  // applying the UV transform — mutating the shared instance would cross-
  // contaminate every other material using that image. The clone shares the image
  // source; this registry owns + disposes the clones (V20 single writer), which is
  // exactly why the cache is refcounted rather than permanent.
  const clones: THREE.Texture[] = [];
  const prep = (
    t: THREE.Texture | null,
    slot: keyof PrimitiveMaterialSpec['textures'],
    colorSpace: THREE.ColorSpace,
  ) => {
    if (!t) return null;
    const c = t.clone();
    c.colorSpace = colorSpace; // re-assert per slot (M5 — a data map as sRGB washes out)
    // #550 — the slot's OWN placement if it has one, else the shared one. One lookup,
    // never a composition of the two (`material/uvPlacement.ts`). This road pivots
    // about the texture CENTRE — our authoring convention, not glTF/Blender parity,
    // which both pivot about the UV origin (#551). The pivot rides the ROAD.
    placeTexture(
      c,
      resolveSlotPlacement(spec.uvTransform, spec.mapUvTransforms, slot),
      CENTRE_PIVOT,
    );
    clones.push(c);
    return c;
  };

  const m = new THREE.MeshPhysicalMaterial();
  m.color = new THREE.Color(spec.color);
  m.roughness = spec.roughness; // explicit — three default is 1 (D-03)
  m.metalness = spec.metalness;
  m.opacity = spec.opacity;
  m.transparent = spec.transparent;
  m.emissive = new THREE.Color(spec.emissive);
  m.emissiveIntensity = spec.emissiveIntensity;
  m.ior = spec.ior;
  m.clearcoat = spec.clearcoat;
  m.clearcoatRoughness = spec.clearcoatRoughness; // explicit — three default is 0
  m.transmission = spec.transmission;
  m.thickness = spec.thickness;
  m.wireframe = spec.wireframe;
  for (const slot of Object.keys(MAP_COLOR_SPACE) as (keyof typeof MAP_COLOR_SPACE)[]) {
    m[slot] = prep(spec.textures[slot], slot, MAP_COLOR_SPACE[slot]);
  }
  m.userData.__uvClones = clones;
  return m;
}

function dispose(material: THREE.MeshPhysicalMaterial): void {
  material.dispose();
  // Material.dispose does NOT free textures, and these clones are ours.
  (material.userData.__uvClones as THREE.Texture[] | undefined)?.forEach((t) => t.dispose());
}

/** Test seam: drop every cached material, whatever its count. */
export function clear(): void {
  for (const entry of cache.values()) dispose(entry.material);
  cache.clear();
}

/** Test/diagnostic seam: current number of cached materials. */
export function size(): number {
  return cache.size;
}

/** Test/diagnostic seam: committed holders of a key (0 when unknown). */
export function holders(key: string): number {
  return cache.get(key)?.count ?? 0;
}
