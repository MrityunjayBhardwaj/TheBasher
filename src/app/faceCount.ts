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
// This module imports two LEAVES and one type. The invariant it exists to hold is not a
// number — it is that nothing it depends on can depend back on it, which the leaf gate checks
// by pinning both the set and the emptiness of what each member imports.
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
// #770 — the ARITY of a generated polygon, which is where the polygon claim is grounded.
// `polygonLayout.ts` imports one TYPE and nothing else, so this edge cannot come back: the
// property this module holds is not a number of imports, it is that nothing it depends on can
// depend back on it. The leaf gate carries the same reasoning beside its widened literal.
import { polygonArityOf, polygonCornersOf, reversedCornerAt } from './polygonLayout';
// 🔴 THE OTHER HALF OF AN IMPORT CYCLE — `faceCount -> bevelLayout -> edgeIdentity -> faceCount`.
// It closes at `faceCountOf('bevel')` and cannot be moved away; `bevelLayout.ts`'s header states
// why and states the one rule that keeps it safe (nothing in the ring reads an import at module
// level). Every use below is inside a function body, which is where a cycle is already resolved.
import { bevelLayoutOf } from './bevelLayout';

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
      // #770 — SIX, and it read 12 until this phase. A box is six quads; the twelve was the
      // triangle count, which is now what those six quads MATERIALISE to rather than what
      // they are. Independent of size, and independent of the segment counts the descriptor
      // does not carry.
      return 6;
    case 'sphere': {
      // three.js clamps to its own minimum before tessellating, so this clamps first too.
      //
      // ⚠️ `w * h`, NOT `w * (h - 1)`, AND THE SUBTRACTION IS WHAT THE OLD TRIANGLE FORMULA
      // MEANT. Every grid cell yields exactly one polygon; a cell in a pole row yields a
      // TRIANGLE rather than nothing, so the pole rows are counted rather than subtracted.
      // The old `2 * w * (h - 1)` was the triangle total — two per cell, minus the one each
      // pole cell skips — and it is now `faceArityOf`'s sum, checked against the built buffer
      // by the parity gate rather than restated here.
      const w = Math.max(3, Math.floor(descriptor.widthSegments));
      const h = Math.max(2, Math.floor(descriptor.heightSegments));
      return w * h;
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
    // #671 — THE SUBSET ARM, AND IT IS NOT A GENERATOR'S. The arms above are
    // `source + subset x repeats` because a scoped generator PRESERVES its whole input.
    // A subset emits the selection and nothing else, so the source term is absent — which
    // is the same 54-vs-36 distinction the descriptor's own comment draws, in arithmetic.
    case 'subset': {
      const sourceFaces = faceCountOf(descriptor.source.descriptor);
      if (sourceFaces === null) return null;
      const selected = scopeSelectedCount(descriptor.scope, sourceFaces);
      // The complement is derived rather than counted a second way: `scopeSelectedCount` is
      // the ONE door from a query to a count, and inverting its answer keeps it that way.
      return descriptor.keep ? selected : sourceFaces - selected;
    }
    // #814 — `F + E + V`, and none of the three terms is the source's face count alone. This is
    // the first arm here whose answer is LARGER than any tiling of its source, because it is the
    // first operator that mints: an edge becomes a quad and a point becomes an n-gon, and neither
    // came from a source face.
    case 'bevel': {
      const verdict = bevelLayoutOf(descriptor);
      return verdict.kind === 'laid-out' ? verdict.layout.faceOrder.length : null;
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
/**
 * Which source face an output face came from, or `null` when it came from NONE — the face was
 * MINTED by the operator rather than mapped from its input (#812).
 *
 * ⚠️ `null` RATHER THAN A NUMERIC SENTINEL, AND THE COMPILER IS THE REASON. Blender spells the
 * same absence `ORIGINDEX_NONE = -1` (`customdata.cc:1079-1081`) because C has no option type.
 * Ours has one, and the difference is not cosmetic: a `-1` is a VALID-LOOKING INDEX. Every site
 * that reads an entry here indexes straight into a source array with it, so a numeric sentinel
 * would land on a real element and hand back a plausible wrong answer with nothing thrown.
 * Widening this type to `null` turned five of those sites into compile errors instead.
 *
 * What IS worth taking from that reference is the shape around the sentinel: the layer carrying
 * it is given no interpolation function at all (`customdata.cc:1549-1555`), so a provenance
 * mapping can never be averaged into a plausible false one. The equivalent here is that a hole
 * never reaches a gather — {@link mappedFacesOf} refuses at the boundary instead.
 */
export type SourceFace = number | null;

export interface TiledFaceOrder {
  /** Faces in the SOURCE — what a per-face attribute being gathered from must carry. */
  readonly sourceFaces: number;
  /**
   * `order[i]` is the source face that face `i` of the merged geometry came from, or `null` if
   * face `i` was minted and came from no source face at all.
   */
  readonly order: readonly SourceFace[];
}

/**
 * The order with every entry named, or `null` if ANY face was minted (#812).
 *
 * ── WHY EVERY CONSUMER GOES THROUGH ONE FUNCTION ──────────────────────────────────────
 *
 * Four sites derive an output property by indexing a source array with an order entry: an
 * arity, a corner count, a corner order, and a rim. None of them can answer for a minted face,
 * because what they are asking is *"what did this come FROM"* and the answer is *nothing*. Four
 * separate hole checks would be four chances to spell the refusal differently, and the failure
 * they are guarding against is not loud — a wrong arity builds a mesh that draws.
 *
 * ── WHY BOTH-OR-NEITHER, RATHER THAN PER-FACE ─────────────────────────────────────────
 *
 * The same rule `mintTiledModifierAttributes` states for a misfit set: answering for the faces
 * that happen to map and dropping the rest is *"indistinguishable from the bug"*. A partial
 * arity array is a length that no longer matches the face count, which every size check
 * downstream compares against and fails on for the wrong reason.
 *
 * ⚠️ NO EXISTING KIND CAN MAKE THIS RETURN `null`. `array`, `mirror` and `subset` map every
 * output face to a source face by construction, so in production today this narrowing is
 * always the identity. That is exactly why the gate drives a SYNTHETIC holed order through
 * every one of the four consumers: an arm with no reader can be wrong and green at the same
 * time, and this one has no reader until a minting kind exists.
 */
export function mappedFacesOf(order: readonly SourceFace[]): readonly number[] | null {
  // 🔴 NARROWED IN PLACE, NEVER COPIED, AND A GATE ALREADY HELD THIS. The first version built a
  // new array and `classCarriage.gate.test.ts` row 4 red instantly — it asserts with `toBe` that
  // a laid-out class resolves to the order its verdict NAMES, identity and all. Two reasons that
  // is the right assertion: `arityCache`, `cornerOrderCache` and `tiledKeyCache` are all keyed on
  // the order OBJECT, so a fresh array per call silently misses every memo; and this sits on the
  // per-evaluate road #689 measured at 75 µs to 1.69 ms per operator, where an allocation per
  // attribute per build is exactly the cost those memos exist to avoid.
  //
  // The predicate narrows `readonly SourceFace[]` to `readonly number[]` without a cast, so the
  // "every entry is a number" claim is checked by the compiler rather than asserted by a comment.
  return order.every((face): face is number => face !== null) ? order : null;
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

/**
 * The subset's face order (#671). Separate from {@link faceTilingOf} because a subset is not
 * a tiling: there are no repeats and no preserved input, so it has none of the three fields
 * that record actually carries. Sharing the record would have meant a `repeats: 0` that reads
 * as "generates nothing" rather than "emits the selection".
 *
 * 🔴 IT EXISTS AT ALL SO A MASK DOES NOT SILENTLY DROP PER-FACE MATERIALS. Without an order,
 * `tiledFaceOrder` returns null for a subset, the attribute is not re-gathered, and a masked
 * mesh quietly renders with one material where its source had several — a plausible screen,
 * no error, and the wrong answer relied on. The order makes the gather `tiled[i] =
 * source[order[i]]` exactly as it is for a generator.
 */
function subsetFaceOrder(
  d: Extract<GeometryDescriptor, { kind: 'subset' }>,
): TiledFaceOrder | null {
  const sourceFaces = faceCountOf(d.source.descriptor);
  if (sourceFaces === null) return null;

  // Prefixed so it cannot collide with a generator's `${sourceFaces}|${scope}|${repeats}`,
  // and carrying `keep` because the two polarities are different layouts over one query.
  const cacheKey = `subset|${sourceFaces}|${d.scope}|${d.keep}`;
  const hit = orderCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const { mask } = scopeSelection(d.scope, sourceFaces);
  const order: number[] = [];
  // The SAME survival test the registry's `faceSubset` applies, so the attribute and the
  // geometry cannot disagree about which faces survived.
  for (let face = 0; face < sourceFaces; face++) {
    if ((mask[face] === 1) !== d.keep) continue;
    order.push(face);
  }
  const resolved: TiledFaceOrder = { sourceFaces, order };
  if (orderCache.size >= ORDER_CACHE_LIMIT) orderCache.clear();
  orderCache.set(cacheKey, resolved);
  return resolved;
}

export function tiledFaceOrder(descriptor: GeometryDescriptor): TiledFaceOrder | null {
  if (descriptor.kind === 'subset') return subsetFaceOrder(descriptor);
  // #814 — THE FIRST ORDER THAT ACTUALLY CONTAINS A HOLE. Every arm below maps each output face
  // to a source face by construction, so #812's widening was the identity for all of them; this
  // one lays down the source's faces and then `E + V` entries of `null`. It is not cached here
  // because `bevelLayoutOf` already caches the whole layout on the source handle.
  if (descriptor.kind === 'bevel') {
    const verdict = bevelLayoutOf(descriptor);
    if (verdict.kind !== 'laid-out') return null;
    const { sourceFaces, faceOrder } = verdict.layout;
    return { sourceFaces, order: faceOrder };
  }
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
 * How many triangles each FACE materialises to, in build order — or `null` when that is not
 * derivable from params alone (#770).
 *
 * ── WHY THIS EXISTS AT ALL, AND WHY IT IS THE THING THAT MADE THE FLIP ATOMIC ──────────
 *
 * A face is a POLYGON now, and the index buffer is what a polygon materialises to. Every
 * consumer that used to multiply a face count by three needs this instead, because the three
 * is no longer a constant: a quad fans to two triangles and a sphere's pole cell to one.
 * Four of them, all in this commit — {@link faceCountMismatch} for how many index entries a
 * descriptor should build to, `materialGroups` for where a run of polygons starts and ends,
 * `faceSubset` for which triangles a kept polygon owns, and {@link tiledCornerOrder} for how
 * many corners a face carries.
 *
 * ── IT COMPOSES THROUGH THE DERIVED ARMS BY GATHER, NOT BY A SECOND DERIVATION ─────────
 *
 * `polygonLayoutOf` refuses `array`, `mirror` and `subset`, and that refusal is correct and
 * does not obstruct this: it is a refusal to state a RIM in a merged geometry's vertex
 * numbering, which needs a split vertex count nothing descriptor-side has. An arity carries no
 * vertex numbering, so it rides through the SAME face order a per-face attribute is already
 * gathered through — `arity[i] = sourceArity[order[i]]`. Measured against the geometry three
 * actually builds, at five shapes: an Array x3 of a box gives 18 polygons / 36 triangles / 108
 * index entries against a built 108, a Mirror of a sphere w=8 h=6 gives 96 / 160 / 480 against
 * a built 480, and the parity gate holds the rest.
 *
 * ⚠️ AND THE SUM IS DELIBERATELY NOT WHAT {@link faceCountOf} RETURNS. That one answers how
 * many faces there are and stays allocation-free because it runs per operator per evaluate on
 * the drag road; this one allocates an array per distinct layout and runs on the BUILD road.
 * They are two spellings of one tessellation, which is the hazard this module already names
 * for `faceCountOf` against three.js itself, and it is held the same way: `faceCount.gate.test.ts`
 * asserts `faceCountOf(d) === faceArityOf(d).length` and `sum x 3 === built index.count` for
 * every sync-buildable descriptor, rather than either being trusted.
 */
const arityCache = new WeakMap<
  readonly SourceFace[],
  WeakMap<readonly number[], readonly number[]>
>();

export function faceArityOf(descriptor: GeometryDescriptor): readonly number[] | null {
  const generated = polygonArityOf(descriptor);
  if (generated !== null) return generated;

  // #814 — A MINTED FACE'S ARITY IS A PROPERTY OF THE OPERATOR, NOT OF ANY SOURCE FACE, which
  // is why this arm is here rather than riding the gather below. A bevel's edge quad has four
  // corners because it is a quad, and its vertex n-gon has as many as that point had incident
  // faces; neither number exists anywhere in the source's arity array. The gather road cannot
  // express that at all — it would ask `mappedFacesOf` for a source face and be told there is
  // none, and answer `null` for the whole descriptor.
  if (descriptor.kind === 'bevel') {
    const verdict = bevelLayoutOf(descriptor);
    // 🔴 `corners - 2`, BECAUSE THIS FUNCTION ANSWERS IN TRIANGLES AND THE LAYOUT SPEAKS IN
    // CORNERS. A quad fans to 2, not 4. Handing the corner counts straight through built a
    // well-formed index buffer of the wrong length — 96 triangles claimed against 44 built for
    // a bevelled cube — and every count-shaped check upstream of the buffer passed, because
    // both quantities are plausible per-face integers. The subtraction lives here, at the one
    // boundary between the two vocabularies.
    return verdict.kind === 'laid-out' ? verdict.layout.corners.map((n) => n - 2) : null;
  }

  // Narrowed explicitly rather than inferred from a non-null order: `tiledFaceOrder` answers
  // for exactly these three kinds, but that is its invariant and not something the type system
  // carries back out here — the same narrowing `mintTiledModifierAttributes` writes, for the
  // same reason.
  if (descriptor.kind !== 'array' && descriptor.kind !== 'mirror' && descriptor.kind !== 'subset')
    return null;
  const sourceArity = faceArityOf(descriptor.source.descriptor);
  if (sourceArity === null) return null;
  const tiled = tiledFaceOrder(descriptor);
  if (tiled === null) return null;

  // 🔴 KEYED ON BOTH IDENTITIES, AND ONE WOULD HAVE BEEN A SILENT WRONG ANSWER. `orderCache`
  // above keys on `sourceFaces|scope|repeats` and deliberately omits the source's KIND,
  // because two descriptors with the same face count genuinely share a face LAYOUT. They do
  // not share an arity: a box and a sphere at w=3 h=2 both have six faces and hand back the
  // same `order` object, but the box is six quads and the sphere six pole triangles. Keying
  // this memo on the order alone would serve whichever built first to both — the same trap
  // the corner cache below documents, one domain over.
  const perOrder = arityCache.get(tiled.order);
  const hit = perOrder?.get(sourceArity);
  if (hit !== undefined) return hit;

  // #812 — a minted face's arity is a property of the OPERATOR, not of any source face, so
  // there is nothing here to derive it from. Refused as a whole rather than per face; see
  // {@link mappedFacesOf}.
  const mapped = mappedFacesOf(tiled.order);
  if (mapped === null) return null;

  const arity = mapped.map((face) => sourceArity[face]);
  if (perOrder === undefined) arityCache.set(tiled.order, new WeakMap([[sourceArity, arity]]));
  else perOrder.set(sourceArity, arity);
  return arity;
}

/**
 * How many CORNERS each face has, in build order — or `null` when params alone cannot say.
 *
 * A corner is a POLYGON corner since #776 — Blender's loop, Houdini's vertex, Maya's
 * face-vertex. A box has 24 and not 36, which is the number `MeshElementCounts` has declared
 * for a box since ns-1 and the number `tiledCornerOrder` disagreed with until #776.
 *
 * ── IT COMPOSES THE WAY AN ARITY DOES, FOR THE SAME REASON ────────────────────────────
 *
 * A corner COUNT carries no vertex numbering, so it rides the face order a per-face attribute
 * already gathers through — `corners[i] = sourceCorners[order[i]]`. That is the whole of the
 * derived arm, and it is why `polygonLayoutOf`'s refusal (#777) does not obstruct this any
 * more than it obstructed {@link faceArityOf}. A corner's IDENTITY is a different question and
 * a harder one; this answers how many there are.
 *
 * ⚠️ NOT MEMOISED, DELIBERATELY, AND THE ACCESS PATTERN IS WHY RATHER THAN THE COST. The
 * generated arm is already cached on the layout's identity by `polygonCornersOf`; what is left
 * is one `map` over the face order. Its two callers are {@link tiledCornerOrder}, which is
 * itself memoised and therefore reaches this only on a miss, and `componentCountOf`'s `corner`
 * arm, which no operator can reach because `ScopeDomain` is still `['face']`. So this is not on
 * the drag road, and a cache installed now would be sized for a guess — the same reading
 * `edgeIdentity` recorded for `edgeSetOf`, and `tiledFaceOrder` measured before adding its own.
 */
export function faceCornersOf(descriptor: GeometryDescriptor): readonly number[] | null {
  const generated = polygonCornersOf(descriptor);
  if (generated !== null) return generated;

  // #814 — the layout's own answer, for the reason {@link faceArityOf}'s bevel arm gives: a
  // minted face's corner count is the operator's, and the gather below would be told there is
  // no source face to read it from. This one needs no conversion — the layout speaks corners.
  if (descriptor.kind === 'bevel') {
    const verdict = bevelLayoutOf(descriptor);
    return verdict.kind === 'laid-out' ? verdict.layout.corners : null;
  }

  // Narrowed explicitly for the reason {@link faceArityOf} states one function up.
  if (descriptor.kind !== 'array' && descriptor.kind !== 'mirror' && descriptor.kind !== 'subset')
    return null;
  const sourceCorners = faceCornersOf(descriptor.source.descriptor);
  if (sourceCorners === null) return null;
  const tiled = tiledFaceOrder(descriptor);
  if (tiled === null) return null;
  // #812 — same refusal as `faceArityOf` one function up, for the same reason: how many
  // corners a MINTED face has is the operator's answer, not a source face's.
  const mapped = mappedFacesOf(tiled.order);
  if (mapped === null) return null;
  return mapped.map((face) => sourceCorners[face]);
}

/**
 * How many corners a descriptor has in total — the `corner` answer `componentCountOf` used to
 * refuse, and the fourth and last domain to get one (#776, after #716's points and #718's edges).
 *
 * `number | null` rather than a `CountVerdict`, matching {@link faceCountOf} and not
 * `pointCountOf`: the `null` here has only ever meant one thing, a `gltf` or `baked` somewhere
 * up the source chain, and `componentSelection` lifts it into a named absence at the one site
 * that needs the reason. A corner hangs off a face, so it answers exactly where a face does.
 */
export function cornerCountOf(descriptor: GeometryDescriptor): number | null {
  const corners = faceCornersOf(descriptor);
  if (corners === null) return null;
  let total = 0;
  for (const c of corners) total += c;
  return total;
}

/** The triangles a face arity materialises to — one statement, since three callers need it. */
export function materialisedTriangles(arity: readonly number[]): number {
  let total = 0;
  for (const a of arity) total += a;
  return total;
}

/**
 * Where each face's run STARTS, given how long each face's run is — a prefix sum.
 *
 * Separate from the counts because the two answer different questions and every consumer needs
 * exactly one of them: a count says how big a face is, a start says where it sits. Returning
 * both from one walk is what keeps `materialGroups`, `faceSubset` and the corner order from
 * each writing their own running total.
 *
 * 🔴 NAMED FOR THE FACE AND NOT FOR THE UNIT SINCE #776, WHICH IS THE POINT. Fed an ARITY it
 * gives triangle starts; fed {@link faceCornersOf} it gives corner starts. They are one walk
 * over "how many of these does each face own", and a second copy of it under a second name is
 * how the two readings of the word `corner` got to disagree in the first place.
 */
export function faceElementStarts(perFace: readonly number[]): readonly number[] {
  const starts: number[] = [];
  let running = 0;
  for (const n of perFace) {
    starts.push(running);
    running += n;
  }
  return starts;
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
 * ── A CORNER IS A POLYGON CORNER SINCE #776, AND IT WAS A TRIANGLE CORNER UNTIL THEN ──
 *
 * #694 was filed saying a corner order "cannot [be produced] without the builders' per-face
 * corner counts". Measured then, that was not the obstacle: every descriptor was
 * TRIANGLE-INDEXED, so the per-face corner count was the constant 3. #770 made a face a
 * POLYGON and re-based this on the arity's triangle total — a box's 36 — which was the smaller
 * of the two readings and deliberately not Blender's. #776 takes the other one: a corner is a
 * LOOP, one slot per (face, point) incidence, and a box has 24.
 *
 * 🔴 THE MODEL'S OWN DECLARED NUMBERS ALREADY SAID 24, which is what decided it rather than a
 * preference for Blender's vocabulary. `MeshElementCounts` has read `{points: 8, edges: 12,
 * faces: 6, corners: 24}` for a box since ns-1, and `elementCountFor` has dispatched on it
 * that whole time — so this file was the one place disagreeing with the table every other
 * domain resolves against. The same shape #770 found one domain over, where the plan's own
 * face numbers turned out to have been n-gon numbers all along.
 *
 * ⚠️ AND A BOX CANNOT TELL THE THREE READINGS APART, so nothing here is checked on one. A box
 * is 24 loops / 36 triangle corners / 24 split render vertices; an 8x6 sphere is 176 / 240 /
 * 63. The middle column is what this function used to answer and the last is what
 * `uvAttributes.ts` still lifts — three different numbers that all get called "corner", which
 * is why the gate runs a sphere and a one-face subset beside every box row.
 *
 * 🔴 WINDING IS THE OBSTACLE, AND IT IS A FACT ABOUT THE BUILDERS. `buildMirror` runs
 * `reverseWinding` over its reflected half (`geometryRegistry.ts`), so a reflected face
 * traverses its corners the other way round. A corner order of `k` per face would be correct
 * for an Array and would put every mirrored face's corners in the wrong places — silently,
 * because a UV lands somewhere plausible rather than nowhere. `buildArray` applies
 * translations only and never reverses, which is why the array arm is the identity.
 *
 * The reversal itself is {@link reversedCornerAt}, shared with `weldedPolygonsOf` rather than
 * spelled twice: #785 is what happens when one of the two spellings is missing.
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
const cornerOrderCache = new WeakMap<
  readonly SourceFace[],
  WeakMap<readonly number[], Map<boolean, TiledCornerOrder>>
>();

export function tiledCornerOrder(descriptor: GeometryDescriptor): TiledCornerOrder | null {
  const faces = tiledFaceOrder(descriptor);
  if (faces === null) return null;
  // The SOURCE's corner counts, not the merged one: this order gathers FROM the source's
  // corners, so the denominator and every base offset below are the source's. Narrowed the
  // same way {@link faceArityOf} narrows, and for the same reason.
  if (descriptor.kind !== 'array' && descriptor.kind !== 'mirror' && descriptor.kind !== 'subset')
    return null;
  const sourceCorners = faceCornersOf(descriptor.source.descriptor);
  if (sourceCorners === null) return null;

  // Whether the copies AFTER the preserved source are wound backwards. The single fact that
  // separates two corner layouts sharing one face layout, so it is what the cache splits on.
  const reversesCopies = descriptor.kind === 'mirror';

  // 🔴 AND THE SOURCE'S CORNER COUNTS ARE THE SECOND KEY SINCE #770, FOR THE REASON
  // `faceArityOf`'s memo states: a box and a sphere at w=3 h=2 both have six faces, share one
  // `order` object, and have completely different corner layouts — six quads against six pole
  // triangles. Keying on the order alone was correct while every face carried three corners and
  // became a silently wrong answer the moment that stopped being true.
  const perOrder = cornerOrderCache.get(faces.order);
  const perArity = perOrder?.get(sourceCorners);
  const hit = perArity?.get(reversesCopies);
  if (hit !== undefined) return hit;

  const { sourceFaces } = faces;
  // #812 — refused before the layout is walked rather than inside it, so the cache never holds
  // a partial answer keyed on a holed order.
  const order = mappedFacesOf(faces.order);
  if (order === null) return null;
  // Faces at or after this index are copies that `reverseWinding` flipped. `Infinity` rather
  // than a boolean beside the loop so the comparison below is the same shape in both arms.
  const reversedFrom = reversesCopies ? sourceFaces : Infinity;
  // Where each SOURCE face's corners begin, so a face's corners can be addressed without a
  // running total written a second time here.
  const sourceStart = faceElementStarts(sourceCorners);

  const corners: number[] = [];
  for (let face = 0; face < order.length; face++) {
    const sourceFace = order[face];
    const rim = sourceCorners[sourceFace];
    const base = sourceStart[sourceFace];
    // One slot per corner of the source polygon, in rim order — or in the reversed rim order
    // for a reflected copy. The reversal holds corner 0 fixed, which is what makes a mirror of
    // a mirror the identity rather than a rotation; {@link reversedCornerAt} is where that is
    // decided, once, for this and for `weldedPolygonsOf` both.
    for (let k = 0; k < rim; k++) {
      corners.push(base + (face >= reversedFrom ? reversedCornerAt(k, rim) : k));
    }
  }

  const resolved: TiledCornerOrder = {
    // Summed from the SAME array the offsets above index rather than re-derived through
    // `cornerCountOf`: a denominator that could disagree with the numbering it denominates is
    // the one arithmetic here worth not writing twice. A reduce rather than `last start + last
    // count` because a source CAN have no faces at all — `array(subset(box, "99"), 2)` — and
    // that shortcut reads `undefined + undefined` there, which is a `NaN` denominator that
    // every size check downstream would compare against and silently fail.
    sourceCorners: sourceCorners.reduce((total, n) => total + n, 0),
    order: corners,
  };
  if (perOrder === undefined) {
    cornerOrderCache.set(
      faces.order,
      new WeakMap([[sourceCorners, new Map([[reversesCopies, resolved]])]]),
    );
  } else if (perArity === undefined) {
    perOrder.set(sourceCorners, new Map([[reversesCopies, resolved]]));
  } else {
    perArity.set(reversesCopies, resolved);
  }
  return resolved;
}

/**
 * Why a built geometry disagrees with what its descriptor's faces materialise to, or `null`
 * when they agree — the refusal ns-1b step 4 consults before deriving groups from an index.
 *
 * 🔴 #770 CHANGED WHAT THIS ASSERTS, AND `faces x 3` IS NOW THE WRONG QUESTION. A face is a
 * POLYGON, so three is no longer a constant: a box's quad fans to two triangles and a sphere's
 * pole cell to one. The expected index entry count comes from the ARITY — `sum(arity) x 3` —
 * which is the whole reason {@link faceArityOf} exists. Asking `faces x 3` here after the flip
 * would have refused every correct box build, at the exact spot whose failure mode is a mesh
 * that renders in one material with no error.
 *
 * When the two disagree, the per-face attribute and the geometry are describing different
 * meshes, and a group layout derived from the index would be silently wrong — covering some
 * other mesh's triangles. Refusing BY NAME is the difference between a message that says which
 * numbers disagreed and a mesh that renders one material for reasons nobody can reconstruct.
 *
 * Returns `null` — meaning "no objection" — for a descriptor with no derivable arity
 * (`gltf` / `baked`), because there is nothing to disagree with, and for a geometry with no
 * index, which is a different condition with a different answer and is not this gate's to
 * refuse.
 */
export function faceCountMismatch(
  descriptor: GeometryDescriptor,
  indexCount: number | null,
): string | null {
  const arity = faceArityOf(descriptor);
  if (arity === null || indexCount === null) return null;
  const triangles = materialisedTriangles(arity);
  const expected = triangles * 3;
  if (indexCount === expected) return null;
  return `faceCount: descriptor '${descriptor.kind}' derives ${arity.length} faces materialising to ${triangles} triangles (${expected} index entries) but the built geometry carries ${indexCount}`;
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
 * ── WHERE THE MINT-TIME COUNT RULE LIVES, AND WHY IT IS NOT A FUNCTION HERE (#654) ────
 *
 * A `faceAttributeMismatch(descriptor, attributeCount)` used to sit at this spot, written in
 * ns-1b step 1 as the mint-time half of a pair with {@link faceCountMismatch}. It was retired
 * because the rule it stated is live and the function was not: a census reported ZERO
 * production callers for three phases while `mintTiledModifierAttributes` enforced the same
 * comparison inline, against the SOURCE descriptor. Measured before removing it — over counts
 * 11, 12, 13, 24 and 36, on both an Array and a Mirror, the retired function applied to
 * `descriptor.source.descriptor` and the tiling's own test agreed on every row.
 *
 * 🔴 A CENSUS OVER A NAME CANNOT SEE A RULE THAT WAS COPIED. The zero was true and the
 * conclusion drawn from it — "this guard never runs" — was false. What never ran was the
 * identifier.
 *
 * The surviving statement is the better one on both counts: it compares against the count it
 * already holds, so it does not re-walk `faceCountOf` through a nested generator chain per
 * attribute per evaluate (see {@link TiledFaceOrder} on why that walk happens once), and it
 * is domain-general — a corner attribute is measured against the source's CORNERS (#694),
 * which a face-only function could not express. {@link faceCountMismatch} below is unaffected
 * and is still the build-time half, consulted by the registry against the geometry three.js
 * actually built.
 */
