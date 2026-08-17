// #633 (ns-1) — the content identity of an attribute set, and the ONE place a set is built.
//
// ── A CONTENT KEY OF ITS OWN — AND, SINCE #638, ALSO A COMPONENT OF THE GEOMETRY KEY ──
//
// 🔴 THE PARAGRAPH THAT USED TO STAND HERE IS NOW FALSE, AND IT IS RESTATED RATHER THAN
// DELETED, because the argument it made is still half true and the half that changed is
// the whole subject of #638.
//
// What it said: "`GeometryRef.key`, `geometryRegistry`'s cache key and
// `GeometryDescriptor` are NOT touched by this phase" — true of ns-1, which deferred the
// render half. ns-1b ends that deferral. `GeometryRef.key` and the registry's cache key
// now carry an `|a:<key>` component; `GeometryDescriptor` is still untouched.
//
// What survives unchanged, and what the four lines below were really about: the MATERIAL
// and the object's SLOT TABLE still may not be folded in. Those are object-level substance
// — two objects filling the same slots differently are the same geometry — and folding
// either would shatter sharing into a box per material. The per-face INDEX is not that: it
// is part of what the geometry IS.
//
//   - This codebase already answered the material question the other way and shipped it
//     (`BoxData.ts` — `geometry` and `materialKey` as siblings). Still true; `materialKey`
//     is still a sibling and always will be.
//   - `GeometryRef`'s own doc comment rejected folding a PER-OBJECT value into a shared
//     content key. Still true, and now stated with the index carved out explicitly.
//   - Both reference systems separate material assignment from geometry so that variation
//     over SHARED geometry is possible (Blender's OBJECT/DATA material link; Houdini's
//     per-primitive material attribute on a packed prim). Still true — and note that both
//     put the per-element INDEX on the geometry and the TABLE on the object. That split is
//     what #638 implements, not a departure from it.
//   - `GeometryRef.key` is four hand-built literal templates with no generic walk to join
//     (`modifierGeometry.ts`), so folding means editing those functions — which is exactly
//     the render-side work ns-1 deferred, and #638 does. The two primitive builders now
//     take a REQUIRED attribute key.
//     ⚠️ THE MODIFIER BUILDERS TAKE NO SUCH PARAMETER AND THEIR KEYS STILL CARRY A
//     COMPONENT (#644) — the two are not the same statement, and reading the first as the
//     second is a live trap. They MINT one instead of receiving one: the source's component
//     is stripped and a freshly tiled set is minted from it, so an array over an assigned
//     box keys as `array|box|1,1,1|3|2,0,0|a:…`. Widened again by #688 to gather every
//     FACE-domain attribute rather than `material_index` alone; corner-domain attributes
//     are still dropped, because the tiling order is a face permutation (#694).
//
// THE COST ns-1 STATED, AND WHAT PAID IT: a parallel key alone did not let two same-size
// boxes with different per-face assignments render differently — they resolved to one
// shared `BufferGeometry`. The fold is what makes them different geometry. It has to be the
// fold rather than a per-object override because the group layout lives on the
// `BufferGeometry` INSTANCE: three.js has no per-object group layout, so two objects
// needing different face→slot layouts would have to disagree about one shared array.
// `attributeKey.test.ts` still pins the four key strings verbatim — now as BASE templates
// plus an explicit component — so the fold cannot widen past what was decided.
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
