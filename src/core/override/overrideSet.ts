// The shared override-set primitive (#124, V28). ONE place that answers
// "which fields did the director EXPLICITLY author?" for every node that
// overlays an override on a source value — `GltfChild` TRS over an imported
// pose (resolveGltfChildTransform.ts manual band) and `MaterialOverride` PBR
// over a cloned imported material (materialOverrideMerge.ts). Two consumers
// justify the module (D-06); GltfChild hand-rolled this band first, #124 lifts
// it here and adds MaterialOverride as the second consumer.
//
// CRITICAL — the authored bit is EXPLICIT, never derived from value≠default
// (the GltfChild R-4 trap, V28): Basher seeds override params with the SOURCE's
// own value at author time (imported TRS; cloned material channels), so
// `value === default` does NOT mean "untouched". USD (`HasAuthoredValue`) and
// Blender (`IDOverrideLibraryProperty`) can DERIVE "is overridden" because they
// have a two-tier authored-vs-fallback model; Basher params are single-tier
// (no fallback layer beneath the seeded value), so the bit MUST be carried.
// This is also why #99's map-presence heuristic was a workaround for the
// missing bit on MaterialOverride.
//
// SPARSE: an absent (or false) field means "inherit the source value". The set
// only records the fields a director touched. GltfChild's on-disk shape is a
// FULL `{position,rotation,scale}` boolean record; MaterialOverride's is a
// sparse partial — `isOverridden` reads both (absent ⇒ false).
//
// REF: PLAN.md Wave A (A1/A2), CONTEXT D-01/D-02/D-06; vyapti V28; the GltfChild
//      R-4 value-equality trap (resolveGltfChildTransform.ts header).

/**
 * A per-field "authored" set: which fields a director explicitly set. Sparse —
 * an absent or `false` field inherits the source. NEVER derived from
 * value-equality (V28 / R-4).
 */
export type OverriddenSet<K extends string> = Partial<Record<K, boolean>>;

/** True iff `field` is explicitly authored. Absent / false ⇒ inherit source. */
export function isOverridden<K extends string>(
  set: OverriddenSet<K> | undefined,
  field: K,
): boolean {
  return set?.[field] === true;
}

/**
 * Immutably set or clear the authored bit for one field. Setting `on=false`
 * keeps the key (as `false`) rather than deleting it — both read identically
 * via `isOverridden`, and keeping it is friendlier to zod-validated param
 * records that declare a fixed key shape. Use `clearOverride` to drop the key.
 */
export function withOverride<K extends string>(
  set: OverriddenSet<K>,
  field: K,
  on: boolean,
): OverriddenSet<K> {
  return { ...set, [field]: on };
}

/** Immutably drop a field's authored bit entirely (back to fully sparse). */
export function clearOverride<K extends string>(set: OverriddenSet<K>, field: K): OverriddenSet<K> {
  const next = { ...set };
  delete next[field];
  return next;
}

/**
 * Per-field precedence merge: for each `field`, the authored `override` value
 * wins iff its bit is set; otherwise the `source` value is kept. This is
 * GltfChild's "manual override (if overridden[field]) else source" band,
 * generalized (resolveGltfChildTransform.ts `pick`). The caller passes the SAME
 * shape for `source` and `override` (e.g. both `ChildTrs`); only the fields in
 * `fields` are considered, so `source` may carry extra keys that pass through
 * untouched.
 *
 * Pure: returns a fresh object, mutates neither input.
 */
export function mergeOverridden<T extends Record<K, unknown>, K extends string>(
  source: T,
  override: T,
  set: OverriddenSet<K> | undefined,
  fields: readonly K[],
): T {
  const out = { ...source };
  for (const field of fields) {
    if (isOverridden(set, field)) out[field] = override[field];
  }
  return out;
}
