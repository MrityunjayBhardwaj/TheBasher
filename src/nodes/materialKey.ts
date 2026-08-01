// materialKey — identity for a material, MINTED BY EVALUATION (#536 S1).
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────
//
// Whether two objects draw the same material is decided by the graph: the fold
// (param → socket → operator stack) is what resolves it. Until now the renderer
// rediscovered that downstream by content-hashing the compiled spec in
// `materialRegistry`, which is identity being derived in the wrong place — the evaluator
// already knew. This mints it once, where the fold happens, and hands it down.
//
// ── WHY A SIBLING FIELD AND NOT A HANDLE ────────────────────────────────────────────
//
// The obvious design — and the one #536's plan originally called for — was a
// `MaterialRef { key, spec }` handle mirroring `GeometryRef`, with the IR as its payload.
// MEASURED, and it does not work here: the animation overlay road addresses an evaluated
// value by a path that MIRRORS the param path (`channelPathForBand`), so putting the IR
// behind a handle inserts a `.spec` hop the param path does not have. A channel authored
// on `material.base.color` would land at `data.material.base.color` while the renderer
// read `data.material.spec.base.color` — the colour animates in the inspector and FREEZES
// on screen, with typecheck and the whole unit suite green. The conformance matrix's
// overlay road caught exactly that.
//
// It is also why the fix could not be "add the hop to the rebase rule": that rule keys on
// the BAND, and only `MeshData` would carry a handle — `BakedData` and `ModifiedData` hold
// bare specs — so one band would no longer have one shape.
//
// 🔑 `GeometryRef` gets away with being a handle because NOTHING reads a `size` off the
// evaluated value; geometry is a recipe the registry rebuilds, not fields the renderer
// reads leaf by leaf. Material is read AND animated leaf by leaf. Same-looking problem,
// genuinely different constraint — which is why "mirror GeometryRef" was the wrong
// instinct here. (That geometry ALSO has no working overlay path for `size` is a separate,
// pre-existing gap; see #537.)
//
// So identity rides ALONGSIDE the IR instead of wrapping it. The invariant's first clause
// — identity is minted by graph evaluation, never rediscovered downstream — is satisfied
// either way; only the carrier changes, and this carrier costs no consumer a single edit.
//
// ── IDENTITY IS NOT OWNERSHIP ───────────────────────────────────────────────────────
//
// This answers only "are these the same thing". It does not make the spec immutable and
// does not stop a consumer writing to what it resolves to. `GeometryRef` has been a
// handle all along and a shared geometry was still traded between two meshes (#533).
// Ownership is a separate seam (#536 S3).
//
// ── THE KEY FUNCTION, AND WHY THIS SPELLING ─────────────────────────────────────────
//
// Measured on a fully-populated OpenPBR IR (20k iterations, one run):
//
//   generic sorted walk, per-leaf JSON.stringify   3.285 µs   ← materialRegistry.keyOf
//   generic walk, no stringify, no sort            0.696 µs   ← this
//   explicit field template                        0.144 µs   ← boxGeometryRef's strategy
//
// A whole `BoxData.evaluate` is 0.102 µs, so the registry's spelling would have added
// ~32× the cost of the evaluation it sits inside. The explicit template is fastest and is
// the one that DRIFTS: a field added to the IR silently stops being part of identity,
// which is #532's class of bug (a field specced but never applied) one level down. The
// generic walk keeps "a new field joins the key for free"; dropping the per-leaf
// `JSON.stringify` and the per-level sort is what makes it cheap enough to run on every
// evaluation. No memo: at 0.7 µs on an O(changed) path there is nothing worth caching, and
// the evaluator's params-hash `WeakMap` could not help anyway — `resolveNodeMaterial`
// hydrates a fresh IR each time, so an identity-keyed memo would never hit.
//
// ⚠️ THE COST OF DROPPING THE SORT, stated rather than glossed: two content-equal specs
// built with different key INSERTION order would key differently. Every IR here comes out
// of the one `hydrateInlineMaterial` seam so order is deterministic in practice, and
// `materialKey.test.ts` pins that rather than trusting it. The failure direction is the
// safe one: they would miss each other and each get their own instance (a lost dedup,
// invisible except as a perf loss), never two DIFFERENT materials colliding onto one,
// which is the direction that would repaint someone else's object.
//
// REF: docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4-§5; src/app/modifierGeometry.ts
//      (`boxGeometryRef`); src/app/materialRegistry.ts (`keyOf` — the downstream key this
//      replaces in S2); src/app/objectDataBand.ts (the overlay rule that ruled out a
//      handle); issues #530, #532, #533, #535, #536, #537.

/**
 * Fields that are NOT part of render identity.
 *
 * `name` is a display label carried over from the P0 `{name,color}` shape — it is the one
 * field in the IR the material builder never applies, and `PrimitiveMaterialSpec` (what
 * the registry compiles and keys today) deliberately has no `name` at all. Keying on it
 * would separate two materials that render identically just because a director typed
 * different labels, which is a LOST dedup rather than a wrong picture — the quiet kind of
 * regression, since nothing on screen would look wrong.
 *
 * ⚠️ An exclusion list is a small drift risk in its own right (a future display-only field
 * would have to be added here). It is deliberately kept to the single field that has a
 * measured downstream justification, rather than being opened up to "things that feel
 * cosmetic" — and `materialKey.test.ts` pins both directions: a name change must NOT move
 * the key, and every rendering lobe MUST.
 */
const NON_RENDERING_FIELDS = new Set(['name']);

/**
 * The content key for a resolved material IR.
 *
 * Walks GENERICALLY — every own enumerable leaf except {@link NON_RENDERING_FIELDS} — so a
 * field added to `InlineMaterialSpec` joins the key without anyone remembering to add it.
 */
export function materialKeyOf(spec: unknown): string {
  if (spec === null || spec === undefined) return 'n';
  if (typeof spec !== 'object' || Array.isArray(spec)) return walk(spec);
  let s = '{';
  for (const k of Object.keys(spec as Record<string, unknown>)) {
    if (NON_RENDERING_FIELDS.has(k)) continue;
    s += k + ':' + walk((spec as Record<string, unknown>)[k]) + ',';
  }
  return s + '}';
}

function walk(value: unknown): string {
  if (value === null || value === undefined) return 'n';
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) {
    let s = '[';
    for (let i = 0; i < value.length; i++) s += materialKeyOf(value[i]) + ',';
    return s + ']';
  }
  let s = '{';
  for (const k of Object.keys(value as Record<string, unknown>)) {
    s += k + ':' + materialKeyOf((value as Record<string, unknown>)[k]) + ',';
  }
  return s + '}';
}
