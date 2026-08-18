// #638 (ns-1b) — the descriptor's face count, in a LEAF.
//
// ── WHY THIS IS ITS OWN MODULE, AND NOT A FUNCTION IN `modifierGeometry.ts` ────────────
//
// It has two consumers that must not be able to reach each other:
//
//   `src/nodes/meshAttributes.ts`  mints a face-domain attribute and needs the count.
//   `src/app/geometryRegistry.ts`  gates the built geometry against the count before it
//                                  derives groups from an index (ns-1b step 4).
//
// While `faceCountOf` lived in `modifierGeometry.ts` those two could not both depend on it.
// `rebuildGeometryRef` (in `modifierGeometry.ts`) has to call `mintMeshAttributes` (in
// `meshAttributes.ts`) to re-mint an attribute component on the overlay road, while
// `meshAttributes.ts` imported `faceCountOf` back out of `modifierGeometry.ts` — a mutual
// cycle. Neither module may own the count; hence this leaf.
//
// ⚠️ The second reason is LEAF SHAPE, and it is deliberately not stated as a cycle, because
// it is not one. `geometryRegistry.ts` imports exactly three things — `three`,
// `BufferGeometryUtils`, and `type GeometryRef`. Importing the count from
// `modifierGeometry.ts` would drag four transitive modules (`evaluator`, `registry`,
// `dataSectionCapability`, `hash`) into a leaf's graph. **Measured: `modifierGeometry.ts`
// does not import `geometryRegistry` at all** — the two textual hits in that file are
// comments — so the shape cost is real and the cycle claim would have been false. Pinned by
// `tools/gates/moduleShape.ts`, so the leaf cannot quietly regrow a graph.
//
// This module imports ONE type and nothing else. That is the invariant it exists to hold.
//
// REF: src/nodes/meshAttributes.ts (the mint); src/app/geometryRegistry.ts (the gate);
//      src/app/faceCount.gate.test.ts (the count is checked against BUILT geometry);
//      issues #633, #638.

import type { GeometryDescriptor } from '../nodes/types';
// ns-2 step 12.5 — a scoped generator's count needs to know how many elements its query
// names. `scopeQuery.ts` is a LEAF with zero value imports, which is what keeps this one a
// leaf too: the property this module holds is not "one import" for its own sake, it is that
// nothing it depends on can depend back on it. `componentSelection.ts` could not have
// served, because it imports this module — a measured cycle, and the reason the language
// moved below all three of its consumers rather than into one of them.
import { scopeSelectedCount, scopeSelection } from '../nodes/scopeQuery';

/**
 * How many FACES a descriptor tessellates to, or `null` when that is not derivable from
 * params alone.
 *
 * #633 — a face-domain attribute must carry exactly as many elements as the geometry has
 * faces, and the mint happens in a node's `evaluate()`: pure, synchronous, and with no
 * business building a `BufferGeometry`. So the count has to come from the descriptor.
 *
 * ⚠️ THIS IS A SECOND SPELLING OF THREE.JS'S TESSELLATION, and a second spelling that agrees
 * today is the whole hazard. It is made safe the only way that works: ONE function, plus
 * `faceCount.gate.test.ts`, which builds each sync-buildable descriptor through the registry
 * and asserts the built triangle count matches this — including at the clamp edges, where
 * three.js quietly raises a sphere's segments to its own minimum.
 *
 * The two `null` arms are the escape hatch and are censused exactly by that gate:
 *   `gltf`  — the buffers live in a loaded asset clone; nothing on the descriptor says how
 *             many triangles they hold.
 *   `baked` — the descriptor carries a vertex count, not a face count, and the authoritative
 *             bytes are in OPFS. Deriving faces from vertices would be a guess about
 *             indexing, which is exactly the kind of agrees-today arithmetic this comment
 *             exists to refuse.
 */
export function faceCountOf(descriptor: GeometryDescriptor): number | null {
  switch (descriptor.kind) {
    case 'box':
      // Six quads, two triangles each — independent of size, and independent of the
      // segment counts the descriptor does not carry.
      return 12;
    case 'sphere': {
      // three.js clamps to its own minimum before tessellating, so this clamps first too;
      // the poles contribute one triangle per column instead of two, hence (h - 1).
      const w = Math.max(3, Math.floor(descriptor.widthSegments));
      const h = Math.max(2, Math.floor(descriptor.heightSegments));
      return 2 * w * (h - 1);
    }
    // ── ns-2 step 12.5 — THE SCOPED ARMS ────────────────────────────────────────────
    //
    // A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET (plan
    // §2.2). So the count is `source + subset x (copies generated)`, and it degenerates to
    // the unscoped product exactly when the subset is the whole input — which is why the
    // unscoped arm is not a special case below, it is `subset === source`.
    //
    // For MIRROR the rule is GROUNDED: Houdini's Mirror SOP documents *Keep Original* —
    // "Preserves the input geometry" — while *Group* is "Primitives to mirror". For ARRAY
    // it is OURS, extended from Mirror by consistency: copy 0 sits at the identity offset
    // and is the preserved input; copies 1..n-1 are generated from the subset. Copy and
    // Transform's page does not decide it, and `subset x count` reads its wording just as
    // well — the row that makes the choice visible rather than assumed is `count = 1`
    // yielding the whole source, which is why it is an exit criterion and not a comment.
    //
    // 🔴 THIS AND THE BUILDER MUST MOVE TOGETHER. They are one claim spelled twice — the
    // arithmetic here, the merge in `geometryRegistry.ts` — and `build()` consults
    // `faceCountMismatch` before deriving a group layout, so a scoped build whose count
    // was left unamended warns and returns the geometry with its MATERIAL GROUPS DROPPED.
    // Parity (`faceCount.gate.test.ts`) catches ONE of them drifting; it is green when
    // NEITHER honours the field, which is why the literal `24` lives beside it in
    // `scopedGeneratorBuild.gate.test.ts`.
    //
    // #644 — BOTH ARMS NOW GO THROUGH {@link faceTilingOf}, and that is not a tidy-up. The
    // per-face material index has to be tiled to match this count exactly, or `build()`
    // trips `faceCountMismatch` and drops the layout. Two functions deriving "the whole
    // source, then N copies of the subset" independently is [[V155]]'s hazard applied to
    // the one arithmetic that must not drift. One statement of the rule, two consumers.
    case 'array':
    case 'mirror': {
      const tiling = faceTilingOf(descriptor);
      if (tiling === null) return null;
      return tiling.sourceFaces + subsetCountOf(tiling.scope, tiling.sourceFaces) * tiling.repeats;
    }
    case 'gltf':
    case 'baked':
      return null;
    default: {
      const unreachable: never = descriptor;
      throw new Error(`faceCountOf: undeclared descriptor kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * How many of a source's `total` elements a generator's scope names — `total` when it is
 * unscoped.
 *
 * The unscoped answer is the SAME expression rather than a branch around it, so the two
 * cases cannot drift: an unscoped generator is one whose subset is everything, which is
 * exactly what makes `source + subset x (count - 1)` collapse back to `source x count`.
 */
function subsetCountOf(scope: string | undefined, total: number): number {
  return scope === undefined ? total : scopeSelectedCount(scope, total);
}

/**
 * How a generator lays its faces out: the WHOLE source, then `repeats` copies of the subset
 * its scope names — or `null` when the descriptor is not a generator, or its source's count
 * is not derivable.
 *
 * ── WHY THIS IS A SEPARATE FUNCTION AND NOT AN EXPRESSION INSIDE `faceCountOf` (#644) ──
 *
 * Two consumers need the same rule at different granularities. {@link faceCountOf} needs the
 * total; the modifier's attribute tiling needs the STRUCTURE — which faces come first, how
 * many times the subset repeats — so it can lay a per-face `material_index` out in exactly
 * the order the builder merges. Those two must agree to the face, because `build()` consults
 * {@link faceCountMismatch} BEFORE deriving a group layout: a tiled index one face out of
 * step makes the registry warn and return the geometry with its groups DROPPED, which is the
 * precise failure #644 exists to remove, re-entering from behind.
 *
 * Stating the rule once and deriving both answers from it is what makes that disagreement
 * unconstructible rather than tested-for.
 *
 * `repeats` is where the two kinds differ and the ONLY place they do:
 *   `array`  — copy 0 is the preserved input and copies `1..n-1` are generated, so `n - 1`.
 *   `mirror` — the original is preserved and the reflection is generated, so exactly `1`.
 *
 * ⚠️ IT DELIBERATELY DOES NOT RETURN THE SUBSET ITSELF. The mask costs an allocation per
 * call and `faceCountOf` runs per operator per evaluate, on the drag road; handing back the
 * query lets the count consumer stay allocation-free while the tiling consumer evaluates it
 * through `scopeSelection` — the ONE evaluation of a query at a length, which is where the
 * "which faces" claim is already spelled once.
 */
// NOT exported, and neither is {@link faceTilingOf}: both consumers of the rule live in this
// module, and an exported symbol with no caller outside it reads as live API to the next
// reader. {@link tiledFaceOrder} is the whole of what the outside needs.
interface FaceTiling {
  /** Faces in the source, all of which are preserved and come FIRST. */
  readonly sourceFaces: number;
  /** The generator's canonical scope query, or `undefined` when it is unscoped. */
  readonly scope: string | undefined;
  /** How many copies of the subset follow the preserved source. */
  readonly repeats: number;
}

function faceTilingOf(descriptor: GeometryDescriptor): FaceTiling | null {
  if (descriptor.kind !== 'array' && descriptor.kind !== 'mirror') return null;
  const sourceFaces = faceCountOf(descriptor.source.descriptor);
  if (sourceFaces === null) return null;
  const repeats = descriptor.kind === 'array' ? Math.max(1, Math.floor(descriptor.count)) - 1 : 1;
  return { sourceFaces, scope: descriptor.scope, repeats };
}

/**
 * Which SOURCE face each face of a generator's built geometry came from — the merge order as
 * a plain array, or `null` when the descriptor is not a generator or its count is not
 * derivable (#644).
 *
 * `order[i] === f` means face `i` of the merged geometry is a copy of source face `f`. So a
 * per-face attribute is propagated by a gather — `tiled[i] = source[order[i]]` — with no
 * arithmetic at the consumer at all.
 *
 * ── WHY THE ORDER LIVES HERE AND NOT WITH THE MINTER THAT NEEDS IT ────────────────────
 *
 * Two reasons, and the second is a hard constraint rather than a preference.
 *
 * 1. It must agree with {@link faceCountOf} exactly — `order.length` IS the face count, and
 *    `build()` drops every material group when they disagree by one. Deriving both from the
 *    same statement of the rule in the same module is what makes that unconstructible.
 *
 * 2. **Turning a query into a set is not a thing a `src/nodes/` module may do.** `scopeSelection`
 *    and `scopeSelectedCount` are the two doors from a query STRING to a SET, and their callers
 *    are pinned by name: the resolver, plus the two descriptor-road consumers — this module and
 *    the registry's scoped build. An operator holds a `canonicalQuery` now, so "cannot interpret
 *    a query" stopped being free and became a claim about imports. The attribute minter needed
 *    the subset; had it imported `scopeSelection` to get it, that guarantee would have been
 *    widened to excuse its first violation. Handing it the resolved ORDER instead keeps the
 *    interpretation on the side of the boundary that already owns it.
 *
 * The subset is evaluated through `scopeSelection` — the same one evaluation the registry's
 * `faceSubset` uses to decide which triangles survive — so the assignment and the geometry
 * cannot disagree about which faces the subset holds.
 *
 * ⚠️ ALLOCATES, which is why {@link faceCountOf} does not call it. The count runs per operator
 * per evaluate and stays allocation-free.
 *
 * 🔴 #689 AMENDS WHAT THIS PARAGRAPH USED TO CLAIM. It said "this runs where an attribute is
 * actually being tiled", implying a rarer road than the count's. That was wrong: the sole
 * consumer is reached from `arrayGeometryRef`, which `ArrayModifier.evaluate` calls — the SAME
 * per-operator-per-evaluate road. Measured on an Array x8: 75 µs per call at 640 merged faces,
 * 389 µs at 7,680, and 1.69 ms at 31,744, against 0.2 µs for the untiled path. So the
 * allocation this module deliberately kept out of `faceCountOf` had been reintroduced one
 * level up. It is memoised now — see {@link tiledFaceOrder}'s cache below.
 *
 * `sourceFaces` is returned ALONGSIDE the order rather than left for the caller to re-derive.
 * The caller needs it to check that the assignment it is about to gather from actually fits
 * its own source, and `faceCountOf` RECURSES through a nested generator chain — so a caller
 * computing it separately would walk the chain twice and would be a second statement of "how
 * many faces does this source have". One walk, one answer.
 */
export interface TiledFaceOrder {
  /** Faces in the SOURCE — what a per-face attribute being gathered from must carry. */
  readonly sourceFaces: number;
  /** `order[i]` is the source face that face `i` of the merged geometry came from. */
  readonly order: readonly number[];
}

/**
 * How many distinct layouts the order cache holds before it is cleared (#689).
 *
 * The ceiling is the RECLAIMER'S CADENCE times the per-entry cost, never the key space times
 * it: an entry is `order.length` numbers, so the largest plausible one — a 64x32 sphere through
 * an Array x8, 31,744 faces — is about 254 KB, and eight of those is ~2 MB. That is the bound,
 * and it does not grow with how long a drag lasts.
 *
 * Eight rather than one because a scene evaluates EVERY operator per frame: a single-entry memo
 * in a project with two array modifiers is evicted by the sibling before it is ever read, which
 * is a cache with a 0% hit rate and the full cost of one.
 */
const ORDER_CACHE_LIMIT = 8;

/**
 * The last few resolved layouts, keyed by the three things a layout actually depends on.
 *
 * ⚠️ THE KEY IS DERIVED FROM {@link FaceTiling}, not written out again from the descriptor.
 * That is the same discipline the rest of this module keeps: `sourceFaces`, `scope` and
 * `repeats` are exactly the fields {@link faceTilingOf} computes, so a fourth thing the layout
 * comes to depend on cannot be added to the rule and forgotten here — it has to pass through
 * that record, and this key destructures the whole of it.
 *
 * `kind` is deliberately ABSENT. `repeats` already carries it (mirror is 1, array is count-1),
 * and where they coincide — an Array with `count: 2` — the two layouts are genuinely identical:
 * the whole source, then one copy of the subset. Sharing an entry there is correct rather than
 * lucky, and `faceCount.gate.test.ts` holds the row that says so.
 */
const orderCache = new Map<string, TiledFaceOrder>();

export function tiledFaceOrder(descriptor: GeometryDescriptor): TiledFaceOrder | null {
  const tiling = faceTilingOf(descriptor);
  if (tiling === null) return null;

  const { sourceFaces, scope, repeats } = tiling;
  // #689 — an offset drag moves NONE of these three, which is why the cache pays. Measured
  // before the fix: 121 frames of a varying offset re-derived the same layout 121 times and
  // added ZERO entries to the attribute store, so the whole per-frame cost bought a key that
  // was already resident.
  //
  // An ANIMATED `count`, by contrast, moves `repeats` every frame and thrashes this — and that
  // is the honest outcome, not a failure of the cache: the layout genuinely differs per frame,
  // so there is no redundancy to exploit and it degrades to exactly the uncached cost.
  const cacheKey = `${sourceFaces}|${scope ?? '*'}|${repeats}`;
  const hit = orderCache.get(cacheKey);
  if (hit !== undefined) return hit;

  // The whole input is preserved and comes FIRST — §2.2's rule, and the reason an unscoped
  // generator is not a special case: its subset is everything.
  const order: number[] = [];
  for (let face = 0; face < sourceFaces; face++) order.push(face);

  const mask = scope === undefined ? null : scopeSelection(scope, sourceFaces).mask;
  for (let copy = 0; copy < repeats; copy++) {
    for (let face = 0; face < sourceFaces; face++) {
      if (mask !== null && mask[face] !== 1) continue;
      order.push(face);
    }
  }
  const resolved: TiledFaceOrder = { sourceFaces, order };

  // Cleared wholesale rather than evicted one at a time. An LRU here would be a second policy
  // to reason about for a cache whose entire purpose is "the last frame looked like this one";
  // clearing costs the next frame one rebuild and keeps the ceiling a single multiplication.
  if (orderCache.size >= ORDER_CACHE_LIMIT) orderCache.clear();
  orderCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * The corner-domain sibling of {@link TiledFaceOrder} — which SOURCE corner each corner of a
 * generator's built geometry came from (#694).
 *
 * ── WHY THIS IS DERIVED FROM THE FACE ORDER AND NOT COMPUTED BESIDE IT ────────────────
 *
 * A corner order is the face order with each face expanded into its corners, and expanding
 * it here rather than re-walking the tiling is what keeps the two from disagreeing about
 * which copies exist. Every decision about the layout — the preserved input first, the
 * subset, how many times it repeats — is still taken exactly once, in {@link tiledFaceOrder}.
 *
 * ── THE PER-FACE CORNER COUNT IS 3, AND THAT IS A FACT ABOUT THE ROAD ─────────────────
 *
 * #694 was filed saying a corner order "cannot [be produced] without the builders' per-face
 * corner counts". Measured, that is not the obstacle: every descriptor this module answers
 * for is TRIANGLE-INDEXED — `faceCountMismatch` right below defines a face as three index
 * entries, and `faceSubset` takes whole triangles — so the per-face corner count is the
 * constant 3 rather than something the builders have to be asked for.
 *
 * 🔴 WINDING IS THE OBSTACLE, AND IT IS A FACT ABOUT THE BUILDERS. `buildMirror` runs
 * `reverseWinding` over its reflected half (`geometryRegistry.ts`), which swaps the 2nd and
 * 3rd corner of every triangle so the reflected faces are not back-facing. Observed on a
 * box: source face 0 is `[0,2,1]` and its mirrored copy is `[0,1,2]`. So a corner order of
 * `3·face + k` would be correct for an Array and would put every mirrored face's corners in
 * the wrong places — silently, because a UV lands somewhere plausible rather than nowhere.
 * `buildArray` applies translations only and never reverses, which is why the array arm is
 * the identity and the mirror arm is not.
 *
 * ⚠️ THE REVERSED COPIES ARE THE ONES AFTER THE SOURCE. `buildMirror` merges
 * `[original, reflected]` and this module puts the preserved source first, so the boundary
 * is `sourceFaces` and the two statements are the same statement.
 */
export interface TiledCornerOrder {
  /** Corners in the SOURCE — what a per-corner attribute being gathered from must carry. */
  readonly sourceCorners: number;
  /** `order[i]` is the source corner that corner `i` of the merged geometry came from. */
  readonly order: readonly number[];
}

/** Corners per face on this road. See the block above — a face IS a triangle here. */
const CORNERS_PER_FACE = 3;

/**
 * Memoised on the FACE order's identity, so this cache cannot outlive the layout it expands
 * and needs no ceiling of its own: an entry becomes collectable the moment `orderCache`
 * above drops that face order. One reclaimer, one stated ceiling — the same reason
 * `meshAttributes`'s own key cache keys on this object rather than on a restatement of it.
 *
 * 🔴 AND THEN KEYED BY WINDING WITHIN THAT, WHICH IS NOT A DETAIL. `orderCache`'s key omits
 * `kind` on purpose — a Mirror and an Array with `count: 2` have the SAME face layout (the
 * whole source, then one copy of the subset) and correctly share one entry. Their CORNER
 * layouts are not the same: the mirror's second copy is wound backwards and the array's is
 * not. So the face order's identity does not determine a corner order, and keying on it
 * alone hands whichever generator built first to both — measured, and it is what the gate's
 * mirrored-corner row reds on.
 */
const cornerOrderCache = new WeakMap<readonly number[], Map<boolean, TiledCornerOrder>>();

export function tiledCornerOrder(descriptor: GeometryDescriptor): TiledCornerOrder | null {
  const faces = tiledFaceOrder(descriptor);
  if (faces === null) return null;

  // Whether the copies AFTER the preserved source are wound backwards. The single fact that
  // separates two corner layouts sharing one face layout, so it is what the cache splits on.
  const reversesCopies = descriptor.kind === 'mirror';

  const perOrder = cornerOrderCache.get(faces.order);
  const hit = perOrder?.get(reversesCopies);
  if (hit !== undefined) return hit;

  const { sourceFaces, order } = faces;
  // Faces at or after this index are copies that `reverseWinding` flipped. `Infinity` rather
  // than a boolean beside the loop so the comparison below is the same shape in both arms.
  const reversedFrom = reversesCopies ? sourceFaces : Infinity;

  const corners: number[] = [];
  for (let face = 0; face < order.length; face++) {
    const base = order[face] * CORNERS_PER_FACE;
    if (face >= reversedFrom) corners.push(base, base + 2, base + 1);
    else corners.push(base, base + 1, base + 2);
  }

  const resolved: TiledCornerOrder = {
    sourceCorners: sourceFaces * CORNERS_PER_FACE,
    order: corners,
  };
  if (perOrder === undefined) {
    cornerOrderCache.set(faces.order, new Map([[reversesCopies, resolved]]));
  } else {
    perOrder.set(reversesCopies, resolved);
  }
  return resolved;
}

/**
 * Why a built geometry disagrees with its descriptor's face count, or `null` when they
 * agree — the refusal ns-1b step 4 consults before deriving groups from an index.
 *
 * A triangle-indexed geometry carries `3 × faceCount` index entries. When it does not, the
 * per-face attribute and the geometry are describing different meshes, and a group layout
 * derived from the index would be silently wrong — covering some other mesh's triangles.
 * Refusing BY NAME is the difference between a message that says which two numbers
 * disagreed and a mesh that renders one material for reasons nobody can reconstruct.
 *
 * Returns `null` — meaning "no objection" — for a descriptor with no derivable count
 * (`gltf` / `baked`), because there is nothing to disagree with, and for a geometry with no
 * index, which is a different condition with a different answer and is not this gate's to
 * refuse.
 */
export function faceCountMismatch(
  descriptor: GeometryDescriptor,
  indexCount: number | null,
): string | null {
  const faces = faceCountOf(descriptor);
  if (faces === null || indexCount === null) return null;
  const expected = faces * 3;
  if (indexCount === expected) return null;
  return `faceCount: descriptor '${descriptor.kind}' derives ${faces} faces (${expected} index entries) but the built geometry carries ${indexCount}`;
}

/**
 * Why a built geometry has no triangles at all, or `null` when it has some (ns-2 D6b).
 *
 * ── WHY THE TRIGGER IS THE BUILT INDEX AND NOT A `null` FROM THE MERGE ────────────────
 *
 * The plan's first revision guarded a different state: *"if `mergeGeometries` returns
 * `null`…"*. Measured, it does not. `merge([full, empty])` returns a valid geometry with
 * index 36 and 48 dead positions; `merge([empty])` returns one with index 0. A valid
 * geometry that draws nothing is quieter than a `null` would have been — the renderer
 * attaches it, nothing errors, and the object is simply not there. So the refusal is
 * written against the state that exists.
 *
 * ⚠️ AND ITS REACHABLE POPULATION IS EMPTY TODAY, WHICH IS SAID HERE RATHER THAN IMPLIED.
 * Under §2.2's rule a scoped generator preserves its WHOLE input, so a scope selecting
 * nothing yields the source unchanged — 12 faces for a box, never 0. No descriptor this
 * phase can construct drives a build to an empty index, and the gate says so with a
 * census. It is kept for two reasons, both stated: it is the detector for a semantic
 * change that makes copy 0 a subset too (the rival reading of Copy and Transform's
 * wording), and an empty draw is the quietest failure this road can produce. Because
 * nothing reaches it, the gate proves the INSTRUMENT works by calling it directly —
 * a guard whose subject never arrives reads as "no objection" forever ([[H360]]).
 *
 * Says nothing for a NON-indexed geometry: that is a different condition with a different
 * answer, and it is the one that makes coverage undefined rather than violated — the same
 * separation {@link faceCountMismatch} already draws.
 */
export function zeroIndexRefusal(
  descriptor: GeometryDescriptor,
  indexCount: number | null,
): string | null {
  if (indexCount === null || indexCount > 0) return null;
  return `faceCount: descriptor '${descriptor.kind}' built a geometry with an EMPTY index (${indexCount} entries) — it would attach and draw nothing`;
}

/**
 * Why a face-domain attribute does not fit a descriptor, or `null` when it does.
 *
 * Separate from {@link faceCountMismatch} because the two catch different mistakes at
 * different moments: this one compares an ATTRIBUTE's element count against the descriptor
 * at mint time; that one compares the BUILT geometry against the descriptor at build time.
 * A single function taking both would let a caller pass one and default the other, which is
 * how a gate silently stops checking half of what it names.
 *
 * ⚠️ NO PRODUCTION CALLER TODAY, AND THAT IS SAID HERE RATHER THAN LEFT TO BE DISCOVERED
 * (#654). Every mint site in this repo derives its element count from {@link faceCountOf} on
 * the same descriptor, so a mint-time disagreement has no constructor — the guard would be
 * comparing a number against itself. The disagreement that IS reachable arrives later, when a
 * handle carries an attribute key its rebuilt or merged geometry no longer fits, and that one
 * is caught by {@link faceCountMismatch} in the registry, against the geometry three.js
 * actually built.
 *
 * So this is the arm for a producer that carries a count from somewhere else — an importer,
 * or a stored set read back against a descriptor — and it stays here, tested, for the moment
 * one exists. What it must NOT be read as is a live check on the mint: a named guard that
 * never runs is worse than an open gap, because a reader who finds it stops looking.
 */
export function faceAttributeMismatch(
  descriptor: GeometryDescriptor,
  attributeCount: number,
): string | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;
  if (attributeCount === faces) return null;
  return `faceCount: descriptor '${descriptor.kind}' derives ${faces} faces but the face-domain attribute carries ${attributeCount}`;
}
