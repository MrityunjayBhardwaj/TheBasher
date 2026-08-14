// Geometry registry — a derived RUNTIME cache mapping a deterministic
// `GeometryRef.key` to a built three.js BufferGeometry (v0.6 #1, issue #150).
//
// V1-EXEMPTION (the same rationale as the evaluator cache, src/core/dag/evaluator.ts):
//   this is a DERIVED cache, NOT authoritative state. It is keyed by the
//   resolver's deterministic key (producer identity + params, §48), it is
//   NEVER serialized into the DAG, and it never participates in Ops / undo /
//   content-hashing. Heavy BufferGeometry buffers stay HERE (and, for glTF, in
//   the loaded asset clone) — the DAG carries only the structure + a GeometryRef
//   handle (Ousterhout interface-depth: simple ref, deep registry).
//
// Determinism (§48): `get(ref)` builds-on-miss and returns the cached instance
//   on-hit. Two refs with the same `key` resolve to the SAME instance (no churn);
//   two refs with different params produce different keys (no false sharing).
//
// glTF scope (D-02 MINIMAL): the registry does NOT load glTF. A `gltf` descriptor
//   keys the child by (assetRef, childName); the actual BufferGeometry lives in
//   the GltfAsset's loaded three.js clone (GltfAssetR owns it, H45). `get()`
//   returns null for a gltf ref — the consumer reads geometry from the asset
//   clone, not from this registry.
//
// baked scope (Phase 151): a `baked` geometry is AUTHORITATIVE (the product of
//   applyMatrix4 on a clone, NOT rebuildable from params) — its bytes live in
//   OPFS keyed by content hash (bakedGeometryStore.ts). The registry cannot
//   BUILD it synchronously; the OPFS read is async. So `get()` returns the cached
//   buffer on a sync hit, else NULL (a cache MISS the renderer resolves by
//   suspending). `prime(ref, geom)` populates the cache after the async OPFS read
//   completes (the loader hook, bakedGeometryLoader.ts). The pure resolver stays
//   sync — it returns the handle only; the async load lives in the renderer hook
//   (V29 purity preserved; the resolver is NEVER made async).
//
// REF: PLAN.md Wave 1 Tasks 2-3; CONTEXT §C; RESEARCH §C/§Q2; vyapti V1 (exempt),
//      authoritative-baked-store vyapti.

import { BoxGeometry, Matrix4, SphereGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import { MATERIAL_INDEX } from '../nodes/attributes';
import { read } from './attributeStore';
import { faceCountMismatch } from './faceCount';
import { groupsFromMaterialIndex, groupsRefusal } from './materialGroups';

const cache = new Map<string, BufferGeometry>();

// ── GROWTH ATTRIBUTION (#586, P5a) ────────────────────────────────────────────────────
//
// The population is one number and the fix candidates for #544 are not interchangeable, so
// the total cannot decide between them: a refcount can only be placed on a door, and only
// SOME of this cache's entries arrive through a door at all. Counting insertions per ORIGIN
// is what turns "the registry grows" into "the registry grows HERE", which is the question
// the lifetime slice actually has to answer.
//
// `internal` is the one that would otherwise be invisible: `build` resolves an `array` /
// `mirror` source through `get` (in `buildArray` / `buildMirror` — named rather than given as
// line numbers, which were already two hundred lines stale), so a modifier drag caches the box
// alongside the merged result — and nothing ever attaches that source. An attach-door
// refcount would never see it, never count it, and never free it.
//
// Counted on INSERTION only, so the arithmetic sits next to a `new BoxGeometry`/`merge` that
// costs orders of magnitude more; a hit costs nothing. Unconditional rather than DEV-gated
// on purpose — a counter the unit tier cannot read is a counter the unit tier cannot gate,
// and this one is the gate's subject.
//
// ── THE MEASURED GROWTH MODEL (browser, 121 transient writes per arm, #586) ────────────
//
//   arm                              Δ size   attach   read   internal
//   idle, no writes (control)             0        0      0          0
//   drag `size` on a plain box         +120      120      0          0
//   the same drag through an Array     +240      120      0        120
//   the same, over a third range       +240      120      0        120
//   resolve an UNATTACHED object         +1        0      1          0   ← instrument control
//
// Read three ways:
//
//   1. A primitive drag is ENTIRELY the attach door. A refcount there bounds all of it.
//   2. A MODIFIER drag is half attach and half `internal`, and that half is unreachable
//      from any door: it is the source box, cached by `build` on the way to the merged
//      result, released by nobody. The splice puts the modifier between the data and the
//      Object, so the source is a scene child of nothing and no attach site ever names it —
//      unless the same data node is ALSO drawn unmodified elsewhere, which the splice is
//      precisely what removes. Every modifier drag leaves as many orphans as it leaves
//      geometries someone asked for.
//   3. The read doors inserted NO ENTRIES during a drag. Read that as growth and not as
//      traffic: a reader that runs and HITS is invisible here by construction, since only
//      insertions are counted, so this says the read doors are not a growth source on this
//      path — not that no reader ran. The last row is why even that much is readable: the
//      same counter moves on demand, so the zero is a fact about the drag rather than a
//      dead instrument. And the scope is narrower than the path: the probed scene runs no
//      sample source, no UV resolve and no apply-transform while the hand is down, and each
//      of those opens the read door on a key the drag is minting fresh.
//
// (Δ is 120 rather than 121 because the drag's first value is the one the scene was already
// built at — a hit. The unit gate, starting from an empty cache, sees the full 121. The
// drag is driven by transient writes at frame cadence, which is the store a real pointer
// grab is routed into, not a stand-in for it; what is NOT covered is the pointer half —
// hit-testing and gizmo state — which cannot reach this cache.)
export type GeometryGrowthSource = 'attach' | 'read' | 'internal' | 'prime';

const growth: Record<GeometryGrowthSource, number> = {
  attach: 0,
  read: 0,
  internal: 0,
  prime: 0,
};

/**
 * Keys the SWEEP may never evict (#587). See {@link sweep} for why this exists; what
 * matters here is that membership is decided by the ROAD an entry arrived on, not by the
 * shape of its key. `prime` is the async road's only insertion point and
 * `bakedGeometryLoader` is its only caller — held closed by `registryDoors.gate.test.ts` —
 * while `get` never inserts a baked entry at all (it returns null on a baked miss).
 *
 * A `key.startsWith('baked|')` test would have selected the same set today and would have
 * been a naming tier, which is the mistake this module has already catalogued once.
 */
const primed = new Set<string>();

/**
 * Resolve a GeometryRef to a cached three.js BufferGeometry, building on miss.
 *
 * Returns null for a `gltf` ref (the registry does not own loaded glTF geometry —
 * the asset clone does; see header). Returns null for a `baked` MISS — the bytes
 * live in OPFS and must be loaded asynchronously by the renderer hook, then
 * `prime`d (see header). Returns the SAME instance for repeated calls with an
 * identical key (cache hit).
 *
 * `via` records which origin caused an INSERTION (see the block above). It is a
 * diagnostic, never a behavioural input — the two doors resolve identically, and this
 * parameter must not become the thing that makes them differ.
 *
 * DELIBERATELY NOT EXPORTED (#536 S3) — see the two doors below. Every caller
 * outside this module reaches the cache through one of them.
 */
function get(ref: GeometryRef, via: GeometryGrowthSource): BufferGeometry | null {
  if (ref.descriptor.kind === 'gltf') return null;
  const hit = cache.get(ref.key);
  if (hit) return hit;
  if (ref.descriptor.kind === 'baked') return null; // miss → caller suspends + primes; no sync build
  const built = build(ref);
  if (built) {
    cache.set(ref.key, built);
    growth[via]++;
  }
  return built;
}

// ── THE TWO DOORS (#536 S3) ───────────────────────────────────────────────────────────
//
// `get` handed every caller the same thing, so the ONE fact that distinguishes them was
// nowhere in the code: what the caller does with the instance next. That matters here
// because the instance is SHARED by design — two refs with one key resolve to the same
// `BufferGeometry`, which is the whole point of the cache — so "who calls get?" selects
// everybody and discriminates nothing.
//
// The two answers carry incompatible rules, and one of them is where a real bug lived
// (#530/#533: a shared resource adopted by `<primitive>`, which stamps ownership onto the
// object itself). Naming the door moves the answer to the import line, where
// `registryDoors.gate.test.ts` can read it and hold the consumer set closed.
//
// ⚠️ DECLARED LIMIT — these are the same function today, and that is honest rather than
// accidental. Geometry has no refcount (unlike `materialRegistry`), so `getForAttach`
// takes no bookkeeping to do; and `getForRead` CANNOT enforce its no-write rule, because
// a `BufferGeometry` is mutable and every reader must hand the real object to three.js.
// This is a naming tier, not a type tier: it makes intent reviewable and a new consumer's
// door declared, and it stops there. #535 is the behavioural backstop that asks whether
// anything actually leaked.
//
// ⚠️ The two doors now pass DIFFERENT `via` tags to `get`, and that is still not a type
// tier — it is the same resolution with a label attached (#586). Reading the tag as
// "so the doors are distinguishable after all" would re-open exactly the hole that made a
// refcount here unsafe: the tag says which door a caller CHOSE, and the holder that
// attaches through `bakedGeometryLoader` chose neither.

/**
 * Take a shared geometry in order to ATTACH it to the scene graph — a share of ownership.
 *
 * The caller renders with this instance while other meshes hold it simultaneously, so it
 * must be passed as a PROP and never adopted by `<primitive>` (#530/#533). If geometry
 * ever grows a refcount, it belongs on this door and not on {@link getForRead}.
 *
 * Null cases are `get`'s: a `gltf` ref, or a `baked` MISS the caller resolves by
 * suspending and priming.
 */
export function getForAttach(ref: GeometryRef): BufferGeometry | null {
  return get(ref, 'attach');
}

/**
 * Take a shared geometry in order to COMPUTE from it and discard it — no ownership.
 *
 * The rule is that a reader never writes to what it takes. Three production sites break
 * it today, and they are named here rather than left in an issue thread (#541) — the
 * point of a declared exception is that the next reader of this door meets it:
 *
 *   • `src/app/boot.ts:672` — the `__basher_baked_geometry_bounds` dev seam calls
 *     `computeBoundingBox()` on the shared instance, unconditionally.
 *   • `src/viewport/sceneBounds.ts:53` — walks the live scene graph and lazily fills
 *     `boundingBox` on whatever is attached, which includes shared instances.
 *   • `src/render/renderToImage.ts:322` — the same shape as sceneBounds.
 *
 * All three are benign for ONE reason, and it is worth stating precisely because it does
 * not generalise: `boundingBox` is an idempotent derived cache of the geometry's own
 * attribute data, so every writer computes the same answer. That is a property of THAT
 * FIELD, not of this door. The moment anything replaces attribute data on a shared
 * instance in place, a stale `boundingBox` survives on it and these are the readers that
 * would serve it.
 *
 * Two of the three reach the instance off the scene graph (`mesh.geometry`) and import
 * nothing, so no importer census can see them — which is why the set is pinned by a
 * CONTENT sweep in `registryDoors.gate.test.ts` instead.
 */
export function getForRead(ref: GeometryRef): BufferGeometry | null {
  const result = readGeometry(ref);
  return result.status === 'ok' ? result.geometry : null;
}

// ── #630 — WHY THE ABSENCE HAS A REASON, AND WHY THE REASON LIVES HERE ─────────────────
//
// `get` returns null for THREE unrelated reasons, and which one it is changes what the
// caller must do:
//
//   a `gltf` ref        → ALWAYS null. The registry does not own loaded glTF geometry; the
//                         asset clone does. Null means LOOK ELSEWHERE.
//   a `baked` miss      → the authoritative bytes are in OPFS behind an async read that has
//                         not happened yet. Null means WAIT — and it may well arrive.
//   a procedural miss   → the registry builds procedural geometry synchronously on demand,
//                         so a null here means `build` refused. Null means THERE GENUINELY
//                         IS NONE, and waiting will not help.
//
// A caller handed a bare `null` has to re-derive which of the three it got by re-inspecting
// `ref.descriptor.kind` — which means the rule is restated at every call site, and every
// restatement is a place it can be got wrong or quietly fall out of date when a kind is
// added. That is not hypothetical here: `resolveMeshUVSpace.ts` carried its own private copy
// of this exact switch, and its own header records the defect biting before.
//
// The registry is the single producer of the ambiguity — it is the code that branches on
// `ref.descriptor.kind` and decides to return nothing — so it is the correct owner of the reason.
// Consumers read it; nobody re-derives it.
//
// `getForRead` above stays as the narrowing view for callers that genuinely only need
// "geometry or not", and it is DEFINED IN TERMS OF this function rather than beside it. One
// implementation, one rule. A second null-producing path that agreed with this one today
// would pass every behavioural test and diverge the first time a kind was added.

/**
 * How a geometry kind's underlying buffers BECOME available — which is what decides what a
 * registry miss means for it.
 *
 *   'procedural' — the registry builds it synchronously on demand. A miss is a malformed
 *                  descriptor, i.e. there genuinely is no geometry.
 *   'primed'     — authoritative bytes live in OPFS and are primed after an async read.
 *                  A miss is "not read yet".
 *   'clone'      — the buffers live in a loaded glTF asset clone, never in the registry.
 *                  An absent clone is "still loading the asset".
 */
export type GeometryAvailability = 'procedural' | 'primed' | 'clone';

/**
 * The availability class of a geometry kind.
 *
 * Exhaustive, closed by a `never`. Adding an arm to `GeometryDescriptor` without declaring
 * how it becomes available is a COMPILE ERROR rather than a silent default — deliberately,
 * because a default would pick one of the three meanings for the new kind and be right by
 * accident at best.
 *
 * 🔴 THAT SENTENCE USED TO NAME `GeometryRef`, AND IT WAS FALSE (ns-2 D8). The `never` was
 * honest, but the parameter was typed `GeometryRef['kind']` — a hand-written six-member
 * union sitting beside the descriptor and spelled independently of it. A new geometry kind
 * does not arrive there; it arrives in `GeometryDescriptor`, which is where the kind's data
 * has to live. Measured by adding a seventh descriptor arm before the field was removed:
 * `faceCountOf` and `rebuildGeometryRef` both failed to compile and this function compiled
 * clean, while its comment promised the opposite in capitals. The parameter is now
 * `GeometryDescriptor['kind']`, so the guarantee holds for the first time — the fix was not
 * to the `never`, which was always correct, but to the union it closed on.
 */
export function availabilityOf(kind: GeometryDescriptor['kind']): GeometryAvailability {
  switch (kind) {
    case 'box':
    case 'sphere':
    case 'array':
    case 'mirror':
      return 'procedural';
    case 'baked':
      return 'primed';
    case 'gltf':
      return 'clone';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * The result of a read: either the geometry, or the reason there isn't one.
 *
 * Discriminated on `status` so a consumer cannot read a geometry off an empty result, and
 * cannot treat "wait" as "none" without writing the word down.
 */
export type GeometryReadResult =
  | { readonly status: 'ok'; readonly geometry: BufferGeometry }
  /** Look elsewhere — this kind's buffers never live in the registry. */
  | { readonly status: 'elsewhere'; readonly availability: GeometryAvailability }
  /** Wait — the bytes exist but have not been read in yet. */
  | { readonly status: 'pending'; readonly availability: GeometryAvailability }
  /** There genuinely is none, and waiting will not help. */
  | { readonly status: 'none'; readonly availability: GeometryAvailability };

/**
 * Read a geometry, or say why there isn't one. The reason-carrying door (#630).
 *
 * Same cache, same instance, same no-write contract as {@link getForRead} — this is not a
 * second way to reach the resource, it is the same read with its absence typed.
 */
export function readGeometry(ref: GeometryRef): GeometryReadResult {
  const availability = availabilityOf(ref.descriptor.kind);
  const geometry = get(ref, 'read');
  if (geometry) return { status: 'ok', geometry };
  switch (availability) {
    case 'clone':
      return { status: 'elsewhere', availability };
    case 'primed':
      return { status: 'pending', availability };
    case 'procedural':
      return { status: 'none', availability };
    default: {
      const unreachable: never = availability;
      return unreachable;
    }
  }
}

/**
 * Populate the cache with an asynchronously-loaded baked geometry. Called by the
 * loader hook (bakedGeometryLoader.ts) after the OPFS read resolves, so a
 * subsequent `get(ref)` is a sync cache hit. Idempotent: a repeat prime for the
 * same key keeps the first instance (no churn; identical key → identical bytes).
 */
export function prime(ref: GeometryRef, geom: BufferGeometry): BufferGeometry {
  const existing = cache.get(ref.key);
  if (existing) {
    if (existing !== geom) geom.dispose();
    return existing;
  }
  cache.set(ref.key, geom);
  primed.add(ref.key); // exempt from the sweep — see `primed` and {@link sweep}
  growth.prime++;
  return geom;
}

/** What one {@link sweep} did. Every field is a count so a gate can refuse to pass vacuously. */
export interface GeometrySweepResult {
  /** Entries in the cache when the sweep began. */
  scanned: number;
  /** Entries skipped because they are on the async road (see `primed`). */
  exempt: number;
  /** Entries found attached in the live set — kept. */
  attached: number;
  /** Entries evicted AND disposed. The only number that frees anything. */
  disposed: number;
}

/**
 * Evict and dispose every cached geometry that no live `Mesh` is drawing (#587, #544).
 *
 * THE RULE, and why it is a sweep rather than a refcount. An entry is garbage iff its
 * INSTANCE is attached to nothing — a question about the object, not about which function
 * a caller happened to import. That distinction is the whole design: `getForAttach` and
 * `getForRead` are the same function, one real holder reaches an attached instance through
 * neither (`bakedGeometryLoader` → `prime`), and half of a modifier drag's entries are minted
 * by `build`'s own recursion, which no consumer calls at all (#586's model, above). A
 * refcount can only ever see the doors. Attachment sees everything, and cannot be fooled by
 * the route taken.
 *
 * ⚠️ `live` IS THE CALLER'S RESPONSIBILITY, AND IT IS THE DANGEROUS ARGUMENT. An empty set
 * is indistinguishable here from "the scene is genuinely empty", and the two want opposite
 * responses — dispose everything, versus refuse. This function cannot tell them apart and
 * does not try: it has no access to a scene and no opinion about where the set came from.
 * The guard lives at the only caller (`geometrySweep.ts`), which collects the set from a
 * scene that R3F guarantees is mounted, so a null root is unrepresentable rather than
 * checked.
 *
 * Disposal is immediate rather than deferred. `materialRegistry` defers to a microtask
 * because a handoff looks like a drop THROUGH A COUNT (`materialRegistry.ts:55-59`) — one
 * holder's cleanup runs before another's effect, and the count legitimately touches zero in
 * between. There is no count here: the question is asked of the live scene at a moment when
 * React has already committed, so a handoff's new holder is attached before the sweep can
 * look. The precedent's reason does not transfer, and neither should its mechanism.
 */
export function sweep(live: ReadonlySet<BufferGeometry>): GeometrySweepResult {
  const result: GeometrySweepResult = {
    scanned: cache.size,
    exempt: 0,
    attached: 0,
    disposed: 0,
  };
  for (const [key, geom] of Array.from(cache)) {
    if (primed.has(key)) {
      result.exempt++;
      continue;
    }
    if (live.has(geom)) {
      result.attached++;
      continue;
    }
    cache.delete(key);
    geom.dispose();
    result.disposed++;
  }
  return result;
}

/**
 * Build the instance, then give it its group layout — the ONE place in this repo that
 * calls `addGroup` or `clearGroups` (#638, ns-1b step 4).
 *
 * ── WHY HERE, AND WHY THAT MAKES THE COLLISION UNCONSTRUCTIBLE ────────────────────────
 *
 * A group layout lives on the `BufferGeometry` INSTANCE, and this cache hands ONE instance
 * to every ref with the same key. Writing groups anywhere else — at attach, per object —
 * would be a per-object write to a shared resource, which is the defect #530/#533 already
 * cost this repo once. Written here it cannot be: groups are a pure function of the index,
 * the index is in the key, the instance is keyed by that key, and the write happens before
 * the instance has ever been handed to a caller. So the layout on a shared instance is
 * correct for EVERY holder, by construction — no ordering discipline to remember, no
 * clear-on-a-shared-instance hazard.
 *
 * ── WHY `clearGroups()` RUNS UNCONDITIONALLY ──────────────────────────────────────────
 *
 * A stock `BoxGeometry` arrives with SIX groups — one per cube side — and three.js honours
 * them whether or not anything meant them as material slots. Clearing only when there is a
 * layout to write would leave those six alive on exactly the refs most likely to be wrong:
 * an unfolded handle, a store miss, a stale key. The difference matters: a box that keeps
 * its stock six under a two-length material array draws TWELVE of thirty-six triangles —
 * quiet, plausible, visible only in pixels — while one with no groups at all under the same
 * array draws nothing, which is loud.
 *
 * Consequence, stated rather than discovered: a box's stock six-side layout is removed on
 * every build. Nothing in this repo reads it, it encodes cube sides rather than materials,
 * and removing it makes an unattributed box look exactly like a sphere — `groups.length`
 * zero — so the heterogeneity that hid the granularity error is gone for every geometry the
 * registry builds.
 */
function build(ref: GeometryRef): BufferGeometry | null {
  const built = buildFromDescriptor(ref.descriptor);
  if (built === null) return null;
  built.clearGroups();

  if (ref.attributeKey === undefined) return built;
  const index = read(ref.attributeKey)?.[MATERIAL_INDEX];
  if (index === undefined) return built;

  // Two refusals, both by name, because a silently skipped derivation is indistinguishable
  // from a mesh that genuinely has one material — the two states this phase exists to tell
  // apart. `faceCountMismatch` catches the BUILT geometry disagreeing with its descriptor;
  // `groupsRefusal` (inside the derivation) catches the index disagreeing with the geometry,
  // and declines a non-indexed geometry, where groups address a different buffer entirely.
  const indexCount = built.getIndex()?.count ?? null;
  const disagreement = faceCountMismatch(ref.descriptor, indexCount);
  if (disagreement !== null) {
    console.warn(disagreement);
    return built;
  }

  const groups = groupsFromMaterialIndex(index.data, indexCount);
  if (groups === null) {
    const why = groupsRefusal(index.data, indexCount);
    if (why !== null) console.warn(why);
    return built;
  }
  for (const g of groups) built.addGroup(g.start, g.count, g.materialIndex);
  return built;
}

/**
 * Build the geometry a descriptor describes, or `null` when this registry is not the place
 * it is built.
 *
 * ── ns-2 step 8b — WHY THIS IS A `switch` CLOSED BY A `never` ─────────────────────────
 *
 * It was an if-chain ending in a bare `return null`, and that terminal line was doing two
 * unrelated jobs at once. For `gltf` and `baked` the null is the DECLARED answer — their
 * buffers live in an asset clone and in OPFS, and this function is not their builder. For a
 * descriptor kind nobody taught this function about, the same null means "I have no idea
 * what this is", and the two were indistinguishable to every caller and to every reader.
 *
 * A new geometry operator therefore had a silent site here: register the node, add the union
 * arm, teach `faceCountOf` and `availabilityOf` because they refuse to compile, and this
 * function returns null forever. The renderer draws nothing, the registry warns nothing, and
 * the descriptor kind that nobody built looks exactly like a glTF child still loading.
 *
 * The two answers are now separate: `gltf`/`baked` are cases that return null on purpose,
 * and the seventh kind is a compile error at the `never`.
 *
 * 🔴 THE LIMIT, STATED HERE BECAUSE A LATER STEP DEPENDS ON KNOWING IT. A `never` closes over
 * the union's DISCRIMINANT. It catches a new KIND and it is completely blind to a new FIELD:
 * adding `scope` to the existing `array` arm compiles clean through this switch, because the
 * discriminant did not move. That is not a gap in this closure, it is what this closure is —
 * and it is why the step that adds such a field owes a count-parity gate rather than
 * inheriting this one. Reading this `never` as covering "changes to the descriptor" is the
 * covered-but-unhonoured mistake, one abstraction level up.
 *
 * The runtime arm is unreachable by any typed caller and reachable through a cast, which is
 * how the standing census constructs it. ⚠️ The two `never` closures UPSTREAM of this one in
 * the same file — `availabilityOf` and `readGeometry` — still return `undefined` from their
 * runtime arms, so a cast-built handle reaches this named refusal and still reads back with an
 * out-of-vocabulary status. That is #675, deliberately not folded in here: it changes a read
 * door's contract on the render path. It refuses BY NAME through the same channel the
 * module's other two refusals use — `console.error` rather than their `console.warn`, and the
 * severity difference is deliberate: `faceCountMismatch` and `groupsRefusal` report DATA
 * disagreeing with data, which is recoverable and expected in the wild, while an undeclared
 * kind reaching here is a defect in this file that no scene can cause.
 */
function buildFromDescriptor(d: GeometryDescriptor): BufferGeometry | null {
  switch (d.kind) {
    case 'box':
      return new BoxGeometry(d.size[0], d.size[1], d.size[2]);
    case 'sphere':
      return new SphereGeometry(d.radius, d.widthSegments, d.heightSegments);
    case 'array':
      return buildArray(d);
    case 'mirror':
      return buildMirror(d);
    // Declared nulls, not unknowns: the buffers are somewhere else on purpose (gltf in the
    // loaded asset clone, baked in OPFS behind an async read that `prime` completes).
    case 'gltf':
    case 'baked':
      return null;
    default: {
      const unreachable: never = d;
      console.error(
        `geometryRegistry: no build arm for descriptor kind ${JSON.stringify(
          (unreachable as { kind?: unknown }).kind,
        )} — the union grew and this switch did not`,
      );
      return null;
    }
  }
}

/**
 * SOP / modifier (#209): recursively build the source handle, then merge `count` CLONES each
 * translated by i*offset (local space). Clone, never mutate the cached source instance (other
 * refs share it). A source that can't build sync (gltf MISS / baked MISS → null) makes the
 * whole array unbuildable here — return null (a follow-up; the renderer renders nothing).
 * `internal`: this caches the SOURCE box/sphere, which no consumer attaches (#586).
 */
function buildArray(d: Extract<GeometryDescriptor, { kind: 'array' }>): BufferGeometry | null {
  const source = get(d.source, 'internal');
  if (!source) return null;
  const copies: BufferGeometry[] = [];
  for (let i = 0; i < d.count; i++) {
    const m = new Matrix4().makeTranslation(d.offset[0] * i, d.offset[1] * i, d.offset[2] * i);
    copies.push(source.clone().applyMatrix4(m));
  }
  const merged = mergeGeometries(copies);
  for (const c of copies) c.dispose(); // mergeGeometries copies the buffers out
  return merged; // null only if the copies mismatch attributes (same source → never)
}

/**
 * SOP / modifier (#209): reflect the source across the local-origin plane whose normal is
 * `axis`, then merge the reflection back with the ORIGINAL (a symmetric whole, 2× the verts —
 * Blender's Mirror). Clone both halves — never mutate the cached source (H111). The reflection
 * matrix has determinant −1, which flips triangle winding: `applyMatrix4` reflects the normal
 * attribute (via the normal matrix), but the index winding would now disagree with those
 * normals → front-faces become back-faces (the mirrored half renders inside-out). Reverse the
 * reflected copy's winding so winding and normals agree again.
 * `internal`: caches the SOURCE, which no consumer attaches (#586) — as `array` does.
 */
function buildMirror(d: Extract<GeometryDescriptor, { kind: 'mirror' }>): BufferGeometry | null {
  const source = get(d.source, 'internal');
  if (!source) return null;
  // Reflection across the plane perpendicular to `axis` at `offset` along it:
  // p' = 2·offset − p on that axis (a scale of −1 plus a translation of 2·offset).
  const reflect = new Matrix4().makeScale(
    d.axis === 'x' ? -1 : 1,
    d.axis === 'y' ? -1 : 1,
    d.axis === 'z' ? -1 : 1,
  );
  const t = 2 * d.offset;
  reflect.setPosition(d.axis === 'x' ? t : 0, d.axis === 'y' ? t : 0, d.axis === 'z' ? t : 0);
  const original = source.clone();
  const reflected = reverseWinding(source.clone().applyMatrix4(reflect));
  const merged = mergeGeometries([original, reflected]);
  original.dispose();
  reflected.dispose();
  return merged; // null only on attribute mismatch (same source → never)
}

/**
 * Reverse the triangle winding of `geom` in place (swap the 2nd & 3rd vertex of
 * each triangle). Needed after a reflection (determinant −1): the reflected
 * positions/normals are correct, but the index order would still imply the OLD
 * orientation, so without this the mirrored faces are back-facing. Handles indexed
 * geometry (box/sphere — the v1 sources) and falls back to swapping attribute
 * triplets for the non-indexed case. Returns `geom` for chaining.
 */
function reverseWinding(geom: BufferGeometry): BufferGeometry {
  const index = geom.getIndex();
  if (index) {
    const arr = index.array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
    return geom;
  }
  for (const attr of Object.values(geom.attributes)) {
    const data = attr.array;
    const n = attr.itemSize;
    for (let i = 0; i + 2 < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const o1 = (i + 1) * n + k;
        const o2 = (i + 2) * n + k;
        const tmp = data[o1];
        data[o1] = data[o2];
        data[o2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
  return geom;
}

/** Test seam: drop every cached geometry (disposing GPU-less CPU buffers). */
export function clear(): void {
  for (const geom of cache.values()) geom.dispose();
  cache.clear();
  primed.clear();
  resetGrowth();
}

/** Test/diagnostic seam: current number of cached geometries. */
export function size(): number {
  return cache.size;
}

/**
 * Test/diagnostic seam (#588): how many bytes of typed-array storage the cache is holding.
 *
 * WHY A SECOND SIZE. {@link size} counts entries, and #587's declared limit is stated in
 * entries — "up to one growth budget of dead ones waits for the next churn". That unit
 * cannot decide anything: 64 leftover boxes are a rounding error and 64 leftover results of
 * an array modifier over a dense mesh are not, because each of those is the MERGED geometry
 * and scales with the modifier's count. Whether the residue is worth a second sweep cadence
 * is a question about bytes, so this is the number that fork gets to be taken on.
 *
 * ⚠️ IT COUNTS EACH UNDERLYING `ArrayBuffer` ONCE, AT THE BUFFER'S FULL LENGTH — not each
 * attribute, and not each view's length. Attributes routinely share one buffer (interleaved
 * data, and `subarray`/`clone` views), and the two obvious shortcuts are wrong in opposite
 * directions: summing per attribute double-counts storage that dropping an entry does not
 * release, while deduping but adding the VIEW's length under-reports a buffer only partly
 * viewed. Both are answers to a question nobody asked. What a residue costs is *how much
 * storage goes away if all of this goes away*, so: distinct buffers, whole lengths.
 *
 * ⚠️ AND IT IS CPU-SIDE STORAGE, not VRAM. The two track each other for this geometry (every
 * attribute gets uploaded) but they are not the same number, and only `dispose()` returns the
 * GPU side — `renderer.info.memory.geometries` stays the instrument for THAT, as in #587.
 * This one answers what the cache is holding, which is what a residue is made of.
 */
export function residentBytes(): number {
  const seen = new Set<ArrayBufferLike>();
  let bytes = 0;
  const account = (attr: { array?: ArrayBufferView } | null): void => {
    const array = attr?.array;
    if (!array) return;
    if (seen.has(array.buffer)) return;
    seen.add(array.buffer);
    bytes += array.buffer.byteLength;
  };
  for (const geom of cache.values()) {
    for (const attr of Object.values(geom.attributes)) account(attr);
    for (const targets of Object.values(geom.morphAttributes)) {
      for (const attr of targets) account(attr);
    }
    account(geom.index);
  }
  return bytes;
}

/**
 * Test/diagnostic seam (#586): how many entries each origin INSERTED, cumulatively.
 *
 * Read the sum against {@link size} rather than assuming they agree — `prime` can replace
 * nothing and `clear` resets both together, but a future eviction would separate them, and
 * the gap is then the number of entries freed.
 */
export function growthBySource(): Readonly<Record<GeometryGrowthSource, number>> {
  return { ...growth };
}

/** Test/diagnostic seam (#586): zero the counters WITHOUT touching the cache. */
export function resetGrowth(): void {
  growth.attach = 0;
  growth.read = 0;
  growth.internal = 0;
  growth.prime = 0;
}
