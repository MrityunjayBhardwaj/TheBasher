// #716 (P2 of the polygonal atoms plan) — a position's identity, in a LEAF.
//
// ── WHAT THIS MODULE IS FOR ───────────────────────────────────────────────────────────
//
// The renderer needs a SPLIT point buffer: a box carries 24 positions because its three
// faces at a corner need three different normals. The MODEL wants the topological set —
// a box has 8 corners, and a point attribute has to attach to one of those, not to a
// GPU artifact. This module holds both halves of that and the check that binds them:
//
//   `weldByPosition`     the real answer, from real positions. Total — every descriptor
//                        kind, including the ones whose buffers live outside the descriptor.
//   `pointCountOf`       the descriptor-side arithmetic. Fast, synchronous, and total
//                        except where the buffers live outside the descriptor.
//   `composePointWeld`   a derived geometry's weld, from its source's (#754).
//   `pointCountMismatch` the parity between them, run on every build.
//
// The split mirrors `faceCount.ts` exactly, for the same reason: a count has to be
// available in a node's `evaluate()`, which is pure and synchronous and has no business
// building a `BufferGeometry`.
//
// 🔴 #754 REPLACED THE SENTENCE THAT USED TO SIT HERE, AND IT IS QUOTED BECAUSE IT WENT
// FALSE RATHER THAN STALE. It read: *"the arithmetic here is MUCH more partial than faces,
// and §`pointCountOf` says why"*. The three derived kinds refused, on a measurement that is
// still true and was still the wrong instrument — see `composePointWeld`. They now compose,
// so the arithmetic is exactly as total as `faceCountOf`'s: everything but `gltf` and
// `baked`. What #754 added instead is the composed MAP, and a parity that checks the layout
// that map rests on rather than re-welding a merged buffer.
//
// ── WHY ITS OWN MODULE ────────────────────────────────────────────────────────────────
//
// The same leaf discipline `faceCount.ts` holds and `faceCountLeaf.gate.test.ts` pins.
// Two consumers that must not be able to reach each other: `geometryRegistry.ts` (the
// build-time parity gate, below) and — at #717 — `meshAttributes.ts`, which will need the
// count to mint a point-domain attribute. This module imports TWO TYPES and nothing else,
// so widening the registry's pinned import set stays safe.
//
// REF: src/app/geometryRegistry.ts (the parity gate); src/app/faceCount.ts (the shape this
//      mirrors); src/app/pointIdentity.gate.test.ts; issues #716, #754, #744, #717,
//      #712, #755, #628.

import type { BufferGeometry } from 'three';
import type { CountVerdict, GeometryDescriptor, GeometryRef } from '../nodes/types';

/**
 * A weld: which topological point each split-buffer position belongs to.
 *
 * `map[i]` is the topological index of split position `i`, and `points` is how many
 * topological points there are. Ids are assigned in FIRST-ENCOUNTER order of the split
 * buffer, which is what makes the weld deterministic without needing a sort: the same
 * geometry always yields the same map, and the topological order is a stable function of
 * the buffer order rather than of a hash's iteration order.
 */
export interface PointWeld {
  /** `map[i]` is the topological point that split position `i` belongs to. */
  readonly map: Uint32Array;
  /** How many topological points the geometry has. */
  readonly points: number;
}

/**
 * The quantisation two positions must agree to before they are called the same point.
 *
 * ⚠️ A TOLERANCE IS A DECISION, NOT A DETAIL, so it is named and its consequence is
 * stated: two genuinely distinct points closer together than 1e-4 weld into one, and
 * nothing downstream can tell that happened. 1e-4 is chosen because it is what three's
 * own `mergeVertices` uses by default (`precision = 4`), so a mesh that survives one
 * survives the other, and because it is the value the phase's cost and reduction figures
 * were measured at — changing it here would silently invalidate them.
 *
 * The alternative — exact float equality — is not obviously safer. A sphere's seam column
 * is generated at angle 0 and at 2π, and the two `Math.sin`/`Math.cos` results are not
 * required to agree in their last bits. Exactness would split that seam on some segment
 * counts and not others, which is a worse failure than a stated tolerance: it varies with
 * the parameter instead of with the mesh.
 */
const WELD_QUANTISATION = 1e4;

/**
 * Memoised on the geometry's own identity, so an entry becomes collectable the moment the
 * geometry does and this cache needs no ceiling of its own — the same discipline
 * `cornerOrderCache` holds in `faceCount.ts`. Keying on the object rather than on a
 * restatement of it is also what keeps the weld honest: a descriptor-shaped key would
 * claim two builds of one descriptor must weld alike, which is the very thing
 * `pointCountMismatch` exists to check rather than assume.
 */
const weldCache = new WeakMap<BufferGeometry, PointWeld>();

/**
 * Weld a split point buffer to its topological set, by POSITION ONLY.
 *
 * 🔴 DO NOT REPLACE THIS WITH `mergeVertices`, AND THE REASON IS MEASURED. That function
 * compares the WHOLE vertex — position, normal, uv — so it welds a box **24 → 24** and
 * reads as falsifying this phase's headline. It is not wrong; it answers a different
 * question. A box's 24 split points exist precisely BECAUSE the normals differ, so a
 * comparison that includes the normal can never merge them. What #716 needs is the
 * position alone.
 *
 * Cost is linear and small — measured 4.2 ms for a 33 k-point sphere, 1.1 ms for 8 k.
 */
export function weldByPosition(geometry: BufferGeometry): PointWeld {
  const hit = weldCache.get(geometry);
  if (hit !== undefined) return hit;

  const position = geometry.getAttribute('position');
  const n = position === undefined ? 0 : position.count;
  const map = new Uint32Array(n);
  const seen = new Map<string, number>();
  let next = 0;

  for (let i = 0; i < n; i++) {
    // A string key rather than a spatial structure: the weld pays this hash ONCE PER
    // POINT, which is what makes the stored map 3.81x cheaper than deriving the same
    // answer from position PAIRS on demand (measured — the pair form pays three hashes
    // per triangle with a key twice as long).
    const key = `${Math.round(position.getX(i) * WELD_QUANTISATION)},${Math.round(
      position.getY(i) * WELD_QUANTISATION,
    )},${Math.round(position.getZ(i) * WELD_QUANTISATION)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = next++;
      seen.set(key, id);
    }
    map[i] = id;
  }

  const weld: PointWeld = { map, points: next };
  weldCache.set(geometry, weld);
  return weld;
}

/**
 * A derived geometry's weld, composed from its SOURCE's — the artifact #717 gathers through.
 *
 * `copies` concatenated copies of `source`, so composed point `p` of copy `c` is
 * `source.map[i] + c * source.points`. Two properties come free from that arithmetic and
 * neither needs checking at runtime: the map is TOTAL over the merged buffer, and it is
 * INJECTIVE source-wise — every composed point traces back to exactly one source point,
 * `id % source.points`.
 *
 * 🔴 THIS IS NOT `weldByPosition` OF THE MERGED GEOMETRY, AND THE DIFFERENCE IS THE WHOLE
 * OF #754. A position weld cannot tell *"two copies happen to coincide"* from *"one mesh has
 * duplicate positions"*, and those are different facts. Measured on an Array x3 of a unit
 * box, the position weld answers 24 / 16 / 20 / 8 at offsets 2 / 1 / 0.5 / 0 — not even
 * monotonic, so no cheap "is this degenerate?" predicate covers it — while the composed
 * answer is 24 at every one of them, because the STRUCTURE did not change.
 *
 * The grounding is that nobody welds unconditionally. Merging coincident copies is opt-in
 * on the generator and carries a distance in both references: Blender's Array modifier has
 * *Merge* + *Distance*, its Mirror has *Merge* + *Merge Distance*, and Houdini's Copy does
 * not fuse at all — Fuse is a separate node whose per-attribute policy the author picks from
 * ~10 rules with no stated default. So a generator's output has `source x copies` points
 * UNLESS the generator declares a merge, and we declare none. Adding that option is its own
 * phase, because it brings a distance param, a per-attribute policy, and the interpolation
 * question the plan parks in its promotion phase.
 *
 * NOT memoised, deliberately. Its only caller today is a test, and #717 — the first real one
 * — will know whether it wants the map per build or per gather. A memo installed before its
 * access pattern is known is a cache sized for a guess.
 */
export function composePointWeld(source: PointWeld, copies: number): PointWeld {
  // 🔴 A FRACTIONAL `copies` WOULD FAIL SILENTLY, WHICH IS WHY THIS THROWS RATHER THAN
  // FLOORS. `new Uint32Array(24 * 2.5)` allocates 60 slots, the loop below writes 3 copies'
  // worth, and a typed array DISCARDS the out-of-range writes without raising — so the map
  // would come back the right type, the right-ish length, and a third of it wrong. Flooring
  // instead would pick a reading of the field on the caller's behalf, which is precisely the
  // divergence #755 is filed about. The one caller passes `pointTilingOf`'s value, which is
  // already a clamped integer; anything else is a caller error and says so.
  if (!Number.isInteger(copies) || copies < 1)
    throw new Error(
      `composePointWeld: a copy count must be a positive integer, got ${String(copies)} — see #755`,
    );
  const s = source.map.length;
  const map = new Uint32Array(s * copies);
  for (let c = 0; c < copies; c++) {
    const base = c * source.points;
    for (let i = 0; i < s; i++) map[c * s + i] = source.map[i] + base;
  }
  return { map, points: source.points * copies };
}

/**
 * A derived descriptor's source, and how many copies of its POINT SET the build emits.
 *
 * `faceTilingOf`'s shape in `faceCount.ts`, for the same reason it has one: both consumers
 * of the rule — the arithmetic in {@link pointCountOf} and the map in
 * {@link composePointWeld} — read it here rather than each deriving "the whole source, then
 * N copies of it" for themselves. One claim, one spelling; the one arithmetic an attribute
 * gather will ride on is not the place to keep two.
 *
 * 🔴 IT IGNORES `scope`, AND THAT IS MEASURED RATHER THAN ASSUMED — IT IS ALSO THE SEAM.
 * A scoped generator preserves its whole input and generates from the subset, so the
 * structural rule is `source + subset x repeats`, and this returns `1 + repeats` copies of
 * the SOURCE'S point set only because TODAY the subset's point set IS the source's: a face
 * subset is an index subset over UNCHANGED attribute buffers, so a scoped copy carries every
 * source position and references a fraction of them. Measured — an Array x3 of a box holds
 * 72 split positions at scope `(none)`, `0-5`, `0-1`, `0` and `6-11` alike, while its INDEX
 * moves 108 / 72 / 48 / 42 / 72.
 *
 * ⚠️ SO THIS IS A RULE CONFIRMED BY A DEFECT, and the defect has a number: **#712**, which
 * compacts a subset's attributes down to the elements its index names. The day that lands, a
 * scoped copy stops carrying the whole source point set, this function needs the subset's own
 * point count — a topological fact about which points the kept faces reference, not a
 * combinatorial one — and {@link pointCountMismatch} reds saying exactly that, with #712 in
 * the message. That red is the design: the seam is a failing check, not a comment someone has
 * to find.
 *
 * The `count` clamp mirrors `faceCountOf`'s exactly, including its disagreement with the
 * builder for a fractional count — filed as **#755** rather than fixed differently here,
 * because two arithmetics reading one field two ways is what #755 is about, and a third
 * reading would make it three.
 */
interface PointTiling {
  /** The geometry the copies are made of. */
  readonly source: GeometryRef;
  /** How many copies of that source's POINT SET the merged buffer holds. */
  readonly copies: number;
}

function pointTilingOf(descriptor: GeometryDescriptor): PointTiling | null {
  switch (descriptor.kind) {
    case 'array':
      return { source: descriptor.source, copies: Math.max(1, Math.floor(descriptor.count)) };
    case 'mirror':
      // The whole input, plus its reflection. Blender's Mirror, and Houdini's *Keep Original*.
      return { source: descriptor.source, copies: 2 };
    case 'subset':
      // A subset merges nothing back and copies nothing — it emits its source's positions
      // under a narrowed index. One copy, and #712 is what makes that stop being true.
      return { source: descriptor.source, copies: 1 };
    default:
      return null;
  }
}

/**
 * The geometry a descriptor derives from, or `null` when it derives from none.
 *
 * Exported so the registry can fetch that source and hand its weld to
 * {@link pointCountMismatch} WITHOUT spelling "which kinds have a source" a second time.
 * That list is {@link pointTilingOf}'s, and it is asked here rather than restated — a
 * registry that enumerated the derived kinds itself would keep compiling on the day a fourth
 * one arrives.
 */
export function derivedSourceOf(descriptor: GeometryDescriptor): GeometryRef | null {
  return pointTilingOf(descriptor)?.source ?? null;
}

/** A counted verdict, so the three producers below spell the shape once. */
function counted(count: number): CountVerdict {
  return { kind: 'counted', count };
}

/**
 * How many TOPOLOGICAL points a descriptor tessellates to.
 *
 * ⚠️ THIS IS A SECOND SPELLING OF THREE.JS'S TESSELLATION, exactly as `faceCountOf` is, and
 * it is made safe the same way: one function, plus {@link pointCountMismatch} run on every
 * build, so the arithmetic cannot drift from the geometry without saying so.
 *
 * ── #754 — THE DERIVED ARMS COMPOSE, AND THE ARM THEY REPLACED IS QUOTED ──────────────
 *
 * They used to refuse, and the refusal was argued from a real measurement: an Array x3 of a
 * unit box POSITION-welds to 24 / 16 / 20 / 8 across offsets 2 / 1 / 0.5 / 0, so
 * `source x count` is right at one end of the offset range and wrong by 3x at the other.
 * That measurement is still true. What was wrong was the instrument, not the number — the
 * position weld was being asked *"how many points does this geometry have?"* when it can only
 * answer *"how many distinct positions does this buffer hold?"*, and under both reference
 * systems those are different questions. See {@link composePointWeld} for the grounding.
 *
 * So the composition is STRUCTURAL and the arms are total wherever their source is:
 * an Array x`n` has `n` x its source's points at every offset including `[0,0,0]`, a Mirror
 * has 2x, and a Subset has its source's, because it merges nothing.
 *
 * ── WHAT STILL REFUSES, AND WHY THAT IS PERMANENT ────────────────────────────────────
 *
 * `gltf` and `baked` alone — their buffers live outside the descriptor, the same escape
 * hatch `faceCountOf` declares. A derived kind over one of those PROPAGATES that verdict
 * verbatim rather than minting its own, so the reason a caller reads still names the link
 * that actually could not answer.
 */
export function pointCountOf(descriptor: GeometryDescriptor): CountVerdict {
  switch (descriptor.kind) {
    case 'box':
      // Eight corners, independent of size and of the segment counts the descriptor does
      // not carry. The 24 in the buffer are three per corner, one per adjoining face.
      return counted(8);
    case 'sphere': {
      // Same clamps as `faceCountOf`, for the same reason: three.js raises the segments to
      // its own minimum before tessellating, so a second spelling that skipped the clamp
      // would disagree exactly at the edges nobody tests by hand.
      const w = Math.max(3, Math.floor(descriptor.widthSegments));
      const h = Math.max(2, Math.floor(descriptor.heightSegments));
      // One ring of `w` points per interior row, plus the two poles. The seam column and
      // the pole fans are what the split buffer duplicates; welding removes both.
      return counted(w * (h - 1) + 2);
    }
    case 'gltf':
      return {
        kind: 'outside-the-descriptor',
        why: "a 'gltf' descriptor's buffers live in a loaded asset clone, so nothing on it says how many points they hold",
      };
    case 'baked':
      return {
        kind: 'outside-the-descriptor',
        why: "a 'baked' descriptor carries a vertex count and its authoritative bytes are in OPFS, so its topological points are not derivable here",
      };
    case 'array':
    case 'mirror':
    case 'subset': {
      const source = pointCountOf(descriptor.source.descriptor);
      // Propagated VERBATIM. A generator over a gltf is not a new kind of absence — it is the
      // same one, seen from further down the chain, and the reason a caller reads still names
      // the link that actually could not answer.
      if (source.kind !== 'counted') return source;
      const tiling = pointTilingOf(descriptor);
      // Unreachable: `pointTilingOf` answers for exactly these three kinds. Written as a
      // value rather than a `!` so a fourth derived kind added to one switch and not the
      // other is a wrong ANSWER at a named site instead of a crash at a `!`.
      if (tiling === null)
        return {
          kind: 'outside-the-descriptor',
          why: `'${descriptor.kind}' has no point tiling, so its source's ${source.count} points cannot be composed`,
        };
      return counted(source.count * tiling.copies);
    }
    default: {
      const unreachable: never = descriptor;
      throw new Error(`pointCountOf: undeclared descriptor ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Why a built geometry disagrees with its descriptor's point arithmetic, or `null` when they
 * agree — or when the descriptor declines to say.
 *
 * The parity half of the two-spellings hazard, and the reason {@link pointCountOf} is allowed
 * to exist at all. Same `string | null` verdict as {@link faceCountMismatch} and the same "a
 * refusal is not a disagreement" rule, so a reader who knows one knows the other.
 *
 * ── #754 — TWO KINDS OF DESCRIPTOR GET TWO DIFFERENT CHECKS, AND THEY MUST ────────────
 *
 * A PRIMITIVE is checked against a real weld: on a box or a sphere, coincident split
 * positions genuinely ARE one point, so `weldByPosition` answers the same question the
 * arithmetic does.
 *
 * A DERIVED geometry is not, and running the old check on one would fire on correct builds —
 * a Mirror at offset 0 composes to 16 points and position-welds to 8; an Array x3 at offset 1
 * composes to 24 and welds to 16. Both are right; they are answers to different questions.
 * What is checkable, and what the composition actually rests on, is the LAYOUT: the merged
 * buffer is the concatenation of `copies` copies of the source's, so
 *
 *     built split positions === source split positions x copies
 *
 * Measured across the whole offset range that made the position weld many-to-one, and across
 * every scope. It reds the day a copy stops carrying the full source buffer — which is #712,
 * by name, in the message.
 *
 * `source` is REQUIRED rather than optional, and `null` is a legitimate value meaning "this
 * descriptor derives from nothing". A derived descriptor arriving with `null` is itself
 * reported, because a parity check that silently skips is the covered-but-unhonoured grade.
 */
export function pointCountMismatch(
  descriptor: GeometryDescriptor,
  geometry: BufferGeometry,
  source: PointWeld | null,
): string | null {
  const expected = pointCountOf(descriptor);
  if (expected.kind !== 'counted') return null;

  const tiling = pointTilingOf(descriptor);
  if (tiling === null) {
    const { points } = weldByPosition(geometry);
    if (points === expected.count) return null;
    const split = geometry.getAttribute('position')?.count ?? 0;
    return `pointCount: descriptor '${descriptor.kind}' derives ${expected.count} topological points but the built geometry welds to ${points} (from ${split} split positions)`;
  }

  const { source: from, copies } = tiling;
  if (source === null)
    return `pointCount: descriptor '${descriptor.kind}' derives from a '${from.descriptor.kind}', so its parity needs that source's weld — none was supplied, and the composed count ${expected.count} is unchecked`;

  const split = geometry.getAttribute('position')?.count ?? 0;
  const layout = source.map.length * copies;
  if (split !== layout)
    return `pointCount: descriptor '${descriptor.kind}' composes ${expected.count} points as ${copies} copies of its source's ${source.points}, which assumes ${layout} split positions (${source.map.length} x ${copies}) — the built geometry has ${split}. A copy has stopped carrying its source's whole position buffer: see #712`;

  if (source.points * copies !== expected.count)
    return `pointCount: descriptor '${descriptor.kind}' derives ${expected.count} points from its source's arithmetic, but its source's BUILT geometry welds to ${source.points}, which composes to ${source.points * copies}`;

  return null;
}
