// #633 (ns-1) — the content identity of an attribute set, and the ONE place a set is built.
//
// ── A THIRD PARALLEL KEY, AND WHY NOT A FOLD INTO THE GEOMETRY KEY ────────────────────
//
// `GeometryRef.key`, `geometryRegistry`'s cache key and `GeometryDescriptor` are NOT
// touched by this phase. The attribute set gets its own independent content key, minted at
// evaluate and carried on the data value ALONGSIDE `materialKey` — exactly the shape
// `BoxData.evaluate` already ships, where a per-object material key sits beside a shared
// geometry handle rather than inside it.
//
// Four independent lines say that is the right seam:
//
//   - This codebase already answered the identical question the other way and shipped it
//     (`BoxData.ts` — `geometry` and `materialKey` as siblings).
//   - `GeometryRef`'s own doc comment considered the fold and rejected it: folding a
//     per-object value into a shared content key either collides or shatters the sharing
//     the cache exists to provide — a box per material instead of a box.
//   - Both reference systems separate material assignment from geometry SPECIFICALLY so
//     that variation over SHARED geometry is possible (Blender's OBJECT/DATA material
//     link; Houdini's per-primitive material attribute on a packed prim).
//   - `GeometryRef.key` is four hand-built literal templates with no generic walk to join
//     (`modifierGeometry.ts`), so folding means editing four functions — which is exactly
//     the render-side work this phase defers.
//
// THE COST, stated rather than discovered: a parallel key does NOT by itself let two
// same-size boxes with different per-face assignments render differently — they still
// resolve to one shared `BufferGeometry`. Making that reach pixels is the next phase's job
// (#638), and `attributeKey.test.ts` pins the four geometry key strings verbatim so the
// deferral cannot leak by someone quietly folding a component in.
//
// ── ABSENT vs EMPTY: ONE REPRESENTATION OF "NO ATTRIBUTES", NOT TWO ───────────────────
//
// "This producer wrote no attributes" and "this producer wrote a set containing nothing"
// are different claims, and a key that silently equates them is the collapse-two-meanings
// defect this epic has already paid for once at the geometry-availability boundary. Rather
// than key them the same, {@link mintAttributes} makes the second one UNCONSTRUCTIBLE: an
// entry-less set mints `null`, so `{}` never reaches the store and never occupies an entry
// distinct from absence. The type stays honest; the ambiguity stays unreachable.
//
// ── THE CANONICALIZER'S RULE IS THE VERIFIABLE ONE ────────────────────────────────────
//
// Omit absent entries, sort names, fixed key order per entry. Deliberately NOT
// "special-case the default/uniform shape" — that is a second condition with no
// independent way to check it. A field explicitly set to `undefined` is never materialised
// into the projection, because a generic key-walk that counts `{field: undefined}` as
// present is how a version bump silently re-mints a whole cache with no failing test.
//
// DECLARED LIMIT — key cost is O(elements). The projection copies every value into a plain
// array and hashes it, so minting a corner-domain UV set is linear in the mesh's corners.
// That is affordable while producers are primitives; when the imported-asset road starts
// minting (Phase 5), this is the number to measure first, and the answer is a cheaper hash
// over the same canonical projection — never a subset of the set, which would key correctly
// only until the omitted domain starts varying.
//
// REF: src/nodes/attributes.ts (the vocabulary); src/nodes/materialKey.ts (the sibling
//      mint, and the generic-walk cost measurements); src/app/asset/bakedGeometryStore.ts
//      (`extractCanonical`/`hashCanonical` — the canonical-projection precedent);
//      src/core/dag/hash.ts (`hashValue`); src/app/attributeStore.ts (the holder);
//      .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §3.1, §8 step 6;
//      issues #395, #633, #638.

import { hashValue } from '../core/dag/hash';
import { attributeLengthMismatch, type AttributeData, type AttributeSet } from './attributes';

/** A set and its content key, minted together so neither can exist without the other. */
export interface MintedAttributes {
  readonly set: AttributeSet;
  readonly key: string;
}

/**
 * The content key of a NON-EMPTY attribute set, or `null` when the set has no entries.
 *
 * Canonical projection: names sorted, absent entries omitted, fixed key order per entry,
 * values copied into plain arrays so the encoding is independent of the backing buffer's
 * type, byte offset and length.
 *
 * ⚠️ `JSON.stringify(new Float32Array([1, 2]))` is `{"0":1,"1":2}` — an OBJECT, not an
 * array. Hashing the typed array directly would still be deterministic, but the copy keeps
 * the projection readable and keeps two equal sets backed by different array types equal.
 */
export function attributeKeyOf(set: AttributeSet): string | null {
  const projection: unknown[] = [];

  for (const name of Object.keys(set).sort()) {
    const attribute = set[name] as AttributeData | undefined;
    // Defence: an entry explicitly set to `undefined` is ABSENT, never a present entry
    // with an empty value. This is the rule the whole key rests on.
    if (attribute === undefined || attribute === null) continue;
    projection.push({
      name,
      domain: attribute.domain,
      type: attribute.type,
      count: attribute.count,
      data: Array.from(attribute.data),
    });
  }

  if (projection.length === 0) return null;
  return hashValue(projection);
}

/**
 * The ONE place production code builds an attribute set.
 *
 * Returns `null` for a set with no entries — so an empty set is unconstructible, and
 * "no attributes" has exactly one representation. Throws when an attribute's declared
 * element count disagrees with the components it carries: that is the one way a well-typed
 * attribute is still wrong, and the mint is the single seam where it can be caught before
 * the value is shared.
 */
export function mintAttributes(
  entries: Readonly<Record<string, AttributeData | undefined>>,
): MintedAttributes | null {
  const set: Record<string, AttributeData> = {};

  for (const name of Object.keys(entries).sort()) {
    const attribute = entries[name];
    if (attribute === undefined) continue;
    const mismatch = attributeLengthMismatch(attribute);
    if (mismatch !== null) {
      throw new Error(`mintAttributes: '${name}' is malformed — ${mismatch}`);
    }
    set[name] = attribute;
  }

  const key = attributeKeyOf(set);
  if (key === null) return null;
  return { set, key };
}
