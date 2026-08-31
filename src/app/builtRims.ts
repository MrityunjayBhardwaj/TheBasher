// builtRims — a face's polygon rim in SPLIT vertex numbering, read off a BUILT geometry (#786).
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT `polygonLayoutOf` ──────────────────────────────────
//
// `polygonLayoutOf` (polygonLayout.ts) answers the same question from a DESCRIPTOR, and refuses
// `array` / `mirror` / `subset` because a copy's rim needs the source's split vertex count and
// nothing descriptor-side has it. That refusal is correct and permanent; its own wording names
// the way out — *"the only thing that knows it reads a BUILT geometry"*.
//
// This is that thing. Where a caller has the built geometry in hand, the rims are recoverable
// for every kind whose arity composes, with no split vertex count anywhere. #777 asked whether
// the descriptor side could be taught to state one; the answer that emerged is that no consumer
// needs it to, because every consumer wanting SPLIT rims runs where a geometry is already built.
//
// ── THE TECHNIQUE, AND THE ASSUMPTION THAT LOOKS RIGHT AND IS NOT ────────────────────────
//
// 🔴 THE TRIANGLES ARE NOT EMITTED AS A FAN FROM `rim[0]`, AND ASSUMING THEY ARE IS WRONG ON A
// BOX. The first draft of this read triangle `t` as `(rim[0], rim[t+1], rim[t+2])` — the rule
// `fanToTriangles` uses to go the other way — and recovered a wrong rim for 6 of a box's 6
// faces. `cornerCount.gate.test.ts` ground 3 does not catch that, deliberately: it compares the
// triangles of a face as a SET of rotation-normalised triples, so it pins WHICH triangles a
// face has and never the order or rotation they are emitted in.
//
// So the rim is recovered as the BOUNDARY CYCLE of the face's triangles. An interior fan edge is
// shared by two of them and appears twice; a boundary edge appears once. Walking the boundary
// edges in their DIRECTED form yields the rim with its winding intact — which is what makes this
// comparable to `weldedPolygonsOf` rather than merely equal up to reversal.
//
// REF: src/app/polygonLayout.ts (`PolygonRim`, `fanToTriangles` — the inverse);
//      src/app/faceCount.ts (`faceElementStarts` — the prefix sum, passed in, not re-derived);
//      src/app/edgeIdentity.ts (`weldedPolygonsOf` — the topological rims this is gated against);
//      issues #786, #777, #776.

import type { BufferGeometry } from 'three';
import type { PolygonRim } from './polygonLayout';
import type { GeometryRef } from '../nodes/types';
import { faceArityOf, faceElementStarts } from './faceCount';
import { weldedPolygonsOf } from './edgeIdentity';
import { composePointWeld, pointCountOf, weldByPosition } from './pointIdentity';
import type { PointWeld } from './pointIdentity';
import { getForRead } from './geometryRegistry';
import { bevelLayoutOf } from './bevelLayout';

/**
 * Cached per geometry. A built geometry is produced from exactly one descriptor, so its arity —
 * and therefore its rims — are fixed for its lifetime. That is the same assumption
 * `weldByPosition` already makes about a geometry's positions.
 */
const rimCache = new WeakMap<BufferGeometry, readonly PolygonRim[]>();

/**
 * Every face's rim, in the geometry's own SPLIT vertex numbering, or `null` when the geometry
 * carries no index buffer (nothing to walk).
 *
 * `arity[f]` is how many triangles face `f` fans to and `starts[f]` where they begin — both
 * passed in rather than re-derived, so the one prefix sum #776 unified stays one.
 */
export function builtPolygonRims(
  geometry: BufferGeometry,
  arity: readonly number[],
  starts: readonly number[],
): readonly PolygonRim[] | null {
  const hit = rimCache.get(geometry);
  if (hit !== undefined) return hit;

  const index = geometry.getIndex();
  if (index === null) return null;
  // The edge key packs two vertex indices into one number. If a geometry ever carried enough
  // vertices for `b` to reach the stride, two different edges would key the same and the walk
  // would silently follow the wrong one — a content-keyed collision, which is a failure mode
  // this codebase has shipped before. Refuse rather than answer wrongly.
  const positions = geometry.getAttribute('position');
  if (positions !== undefined && positions.count >= KEY_STRIDE) return null;

  const rims: PolygonRim[] = [];
  for (let f = 0; f < arity.length; f++) {
    const rim = rimOfFace(index, arity[f], starts[f]);
    if (rim === null) return null;
    rims.push(rim);
  }
  rimCache.set(geometry, rims);
  return rims;
}

/** The boundary cycle of one face's triangles, wound as they are wound. */
function rimOfFace(
  index: NonNullable<ReturnType<BufferGeometry['getIndex']>>,
  triangles: number,
  start: number,
): PolygonRim | null {
  // Count each undirected edge, and remember every directed one. An edge interior to the fan is
  // walked once in each direction by the two triangles sharing it, so it lands on 2.
  const seen = new Map<number, number>();
  const directed: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const i = (start + t) * 3;
    const v = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      const key = a < b ? a * KEY_STRIDE + b : b * KEY_STRIDE + a;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      directed.push(a, b);
    }
  }

  const next = new Map<number, number>();
  for (let i = 0; i < directed.length; i += 2) {
    const a = directed[i];
    const b = directed[i + 1];
    const key = a < b ? a * KEY_STRIDE + b : b * KEY_STRIDE + a;
    // A vertex the boundary visits twice would overwrite here rather than fork, so the cycle
    // length check below is what refuses a pinched face instead of silently shortening it.
    if (seen.get(key) === 1) next.set(a, b);
  }
  if (next.size === 0) return null;

  const first = next.keys().next().value as number;
  const rim: number[] = [first];
  let cur = next.get(first)!;
  while (cur !== first) {
    if (rim.length > next.size) return null;
    rim.push(cur);
    const step = next.get(cur);
    if (step === undefined) return null;
    cur = step;
  }
  return rim.length === next.size ? rim : null;
}

/** Bigger than any vertex index a built geometry here carries, so `a*STRIDE+b` is injective. */
const KEY_STRIDE = 0x1000000;

/**
 * A derived geometry's weld, COMPOSED from its source's rather than re-welded (#754).
 *
 * Position-welding a merged buffer is the wrong instrument — a mirror at offset 0 lays two
 * copies on top of each other and a positional weld would fuse them into one point. So the
 * primitive at the bottom of the chain is welded by position and every derived kind above it
 * composes, which is the same thing `pointCountOf` does and the reason its counts agree.
 *
 * `null` rather than a throw wherever the chain cannot answer: a `gltf` or `baked` source has no
 * derivable point count, and a subset whose ratio is not a whole number of copies is not a
 * repetition at all. Both are refusals a caller must handle, not crashes.
 */
export function composedWeldOf(ref: GeometryRef): PointWeld | null {
  const d = ref.descriptor;
  // #814 — READ OFF THE LAYOUT, NOT WELDED BY POSITION, and the reason is the one this function's
  // own header gives for the derived kinds: a position weld answers "how many distinct positions
  // does this buffer hold", which is a different question. A bevel builds one split vertex per
  // output corner, so `rims[face][k]` IS the topological point of split vertex `k` of face
  // `face` — the map is the layout's rims, flattened in the order the builder writes them.
  //
  // Positionally it happens to agree at any amount small enough that no two chamfered corners
  // coincide, which is exactly why it has to be stated rather than left to luck: at a larger
  // amount the positional answer silently drops points that structurally exist.
  if (d.kind === 'bevel') {
    const verdict = bevelLayoutOf(d);
    if (verdict.kind !== 'laid-out') return null;
    const { rims, points } = verdict.layout;
    const map = new Uint32Array(rims.reduce((sum, rim) => sum + rim.length, 0));
    let cursor = 0;
    for (const rim of rims) for (const point of rim) map[cursor++] = point;
    return { map, points };
  }
  if (d.kind !== 'array' && d.kind !== 'mirror' && d.kind !== 'subset') {
    const geometry = getForRead(ref);
    return geometry === undefined || geometry === null ? null : weldByPosition(geometry);
  }
  const merged = pointCountOf(d);
  const source = pointCountOf(d.source.descriptor);
  if (merged.kind !== 'counted' || source.kind !== 'counted' || source.count === 0) return null;
  const copies = merged.count / source.count;
  if (!Number.isInteger(copies) || copies < 1) return null;
  const below = composedWeldOf(d.source);
  return below === null ? null : composePointWeld(below, copies);
}

/**
 * Every face's rim in SPLIT numbering, ROTATED so it starts at the same corner the substrate's
 * welded rim does — the split-space counterpart of {@link weldedPolygonsOf}, corner for corner.
 *
 * ── WHY THE ROTATION IS NOT COSMETIC ─────────────────────────────────────────────────────
 *
 * A boundary walk starts wherever it happens to start, and a rim rotated by one corner bounds
 * the same face and fans to the same triangles. It is a DIFFERENT loop order, and the corner
 * domain is indexed by loop. For `box` and `sphere` the substrate already fixes that order —
 * `weldedPolygonsOf` maps `polygonLayoutOf`'s rims elementwise, so loop 0 is the same corner in
 * both spaces. A derived kind taking whatever the walk produced would index its corners by a
 * different convention than a primitive, and because nothing reads this key in production yet,
 * that difference would be invisible rather than wrong-looking. So it is aligned here.
 *
 * Returning `null` when no rotation matches is the self-check: the two derivations are supposed
 * to describe the same loop, so a failure to align is a genuine disagreement and not a shrug.
 */
export function alignedSplitRims(
  ref: GeometryRef,
  geometry: BufferGeometry,
): readonly PolygonRim[] | null {
  const arity = faceArityOf(ref.descriptor);
  const welded = weldedPolygonsOf(ref.descriptor);
  const weld = composedWeldOf(ref);
  if (arity === null || welded === null || weld === null) return null;

  const raw = builtPolygonRims(geometry, arity, faceElementStarts(arity));
  if (raw === null || raw.length !== welded.length) return null;

  const out: PolygonRim[] = [];
  for (let f = 0; f < raw.length; f++) {
    const aligned = rotateOnto(raw[f], welded[f], weld);
    if (aligned === null) return null;
    out.push(aligned);
  }
  return out;
}

/** `split` rotated so that mapping it through `weld` reproduces `target` exactly, or `null`. */
function rotateOnto(split: PolygonRim, target: PolygonRim, weld: PointWeld): PolygonRim | null {
  const n = split.length;
  if (n !== target.length) return null;
  for (let s = 0; s < n; s++) {
    let matches = true;
    for (let i = 0; i < n && matches; i++) {
      if (weld.map[split[(s + i) % n]] !== target[i]) matches = false;
    }
    if (matches) {
      const rim: number[] = [];
      for (let i = 0; i < n; i++) rim.push(split[(s + i) % n]);
      return rim;
    }
  }
  return null;
}
