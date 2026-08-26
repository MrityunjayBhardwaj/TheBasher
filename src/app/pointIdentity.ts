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
//   `pointCountOf`       the descriptor-side arithmetic. Fast, synchronous, and partial:
//                        it answers for the two primitive kinds and refuses the rest.
//   `pointCountMismatch` the parity between them, run on every build.
//
// The split mirrors `faceCount.ts` exactly, for the same reason: a count has to be
// available in a node's `evaluate()`, which is pure and synchronous and has no business
// building a `BufferGeometry`. The difference from faces is that the arithmetic here is
// MUCH more partial, and §`pointCountOf` says why, with the measurement.
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
//      mirrors); src/app/pointIdentity.gate.test.ts; issues #716, #717, #628.

import type { BufferGeometry } from 'three';
import type { GeometryDescriptor } from '../nodes/types';

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
 * How many TOPOLOGICAL points a descriptor tessellates to, or `null` when that is not
 * derivable from params alone.
 *
 * ⚠️ THIS IS A SECOND SPELLING OF THREE.JS'S TESSELLATION, exactly as `faceCountOf` is,
 * and it is made safe the same way: one function, plus {@link pointCountMismatch} run on
 * every build, so the arithmetic cannot drift from the geometry without saying so.
 *
 * ── WHY SO MANY ARMS REFUSE, WHICH IS THE OPPOSITE OF `faceCountOf` ───────────────────
 *
 * A face count is COMBINATORIAL: three copies of a box have three times its faces however
 * the copies are arranged. A welded point count is not — it depends on whether positions
 * COINCIDE, and coincidence is a function of the operator's params, not of its structure.
 *
 * 🔴 MEASURED, because the plan asserted otherwise. It held that the weld composes for
 * Array (source map plus a per-copy offset) and re-walks only for Mirror. An Array x3 of a
 * unit box welds to:
 *
 *     offset [2,0,0]    24     <- the figure the plan generalised from
 *     offset [1,0,0]    16        (copies share a face)
 *     offset [0.5,0,0]  20
 *     offset [0,0,0]     8        (every copy lands on the original)
 *
 * So `source x count` is right at one end of the offset range and wrong by 3x at the
 * other, with a smooth and entirely plausible gradient between. The array/mirror asymmetry
 * was a property of the offset the measurement happened to use, not of the two operators.
 * A static arm here would be wrong in exactly the way an index-derived edge count is
 * wrong: never absurdly, so never caught by eye.
 *
 * Hence: the three derived kinds refuse, and the caller that genuinely needs the number
 * asks {@link weldByPosition} for it — which is total, and cheap.
 */
export function pointCountOf(descriptor: GeometryDescriptor): number | null {
  switch (descriptor.kind) {
    case 'box':
      // Eight corners, independent of size and of the segment counts the descriptor does
      // not carry. The 24 in the buffer are three per corner, one per adjoining face.
      return 8;
    case 'sphere': {
      // Same clamps as `faceCountOf`, for the same reason: three.js raises the segments to
      // its own minimum before tessellating, so a second spelling that skipped the clamp
      // would disagree exactly at the edges nobody tests by hand.
      const w = Math.max(3, Math.floor(descriptor.widthSegments));
      const h = Math.max(2, Math.floor(descriptor.heightSegments));
      // One ring of `w` points per interior row, plus the two poles. The seam column and
      // the pole fans are what the split buffer duplicates; welding removes both.
      return w * (h - 1) + 2;
    }
    case 'gltf':
    case 'baked':
      // The buffers live outside the descriptor — the same escape hatch `faceCountOf`
      // declares, for the same reason, and `null` rather than 0 because a zero would read
      // as "this mesh has no points" on a mesh the author can see.
      return null;
    case 'array':
    case 'mirror':
    case 'subset':
      // Not derivable: see the block above. The count depends on positional coincidence,
      // which the descriptor's params do not determine without evaluating positions.
      return null;
    default: {
      const unreachable: never = descriptor;
      throw new Error(`pointCountOf: undeclared descriptor ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Why a built geometry's welded point count disagrees with its descriptor, or `null` when
 * they agree — or when the descriptor declines to say.
 *
 * The parity half of the two-spellings hazard, and the reason `pointCountOf` is allowed to
 * exist at all. Mirrors {@link faceCountMismatch} in shape deliberately: same `string |
 * null` verdict, same "a refusal is not a disagreement" rule, so a reader who knows one
 * knows the other.
 */
export function pointCountMismatch(
  descriptor: GeometryDescriptor,
  geometry: BufferGeometry,
): string | null {
  const expected = pointCountOf(descriptor);
  if (expected === null) return null;
  const { points } = weldByPosition(geometry);
  if (points === expected) return null;
  const split = geometry.getAttribute('position')?.count ?? 0;
  return `pointCount: descriptor '${descriptor.kind}' derives ${expected} topological points but the built geometry welds to ${points} (from ${split} split positions)`;
}
