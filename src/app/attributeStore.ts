// #633 (ns-1) — the process-wide, content-keyed holder for attribute sets.
//
// ── WHY A STORE AND NOT A FIELD ON THE VALUE ──────────────────────────────────────────
//
// A set is content-keyed, so two nodes that derive the same attributes share one entry
// rather than each carrying their own copy of the same buffers. Under a content-derived key
// redundant derivation is a HIT, not waste — which is why producers may re-derive their
// attributes on every evaluate and why "stop computing it twice" is never an argument for
// changing this. What growth is a function of is how many DISTINCT sets exist.
//
// ── THE LIMITS, DECLARED HERE RATHER THAN DISCOVERED TWO PHASES LATER ─────────────────
//
// `geometryRegistry` shipped without lifetime discipline and needed a follow-up sweep plus
// a residue instrument to find out what it was holding. The instrument ships with the store
// this time; the sweep does not, and that is a decision rather than an omission:
//
//   1. NOTHING IS EVER FREED. An inserted set lives for the process lifetime. Eviction is a
//      follow-up, and it needs a holder question this store cannot answer on its own (see
//      limit 2). What ships instead is the number: growth attribution by origin, counted on
//      insertion only, plus a resident count — so unbounded growth shows up as a measurement
//      rather than as a memory report.
//   2. THE "ASK THE SCENE" ANSWER DOES NOT TRANSFER. The way to know whether a shared render
//      resource is still held is to walk the live scene and ask which objects hold it. An
//      attribute set's holders are DAG VALUES, not mounted objects, so a scene walk cannot
//      reach them. Any eviction design has to answer that first; guessing from door counts
//      is how the geometry sweep got its second bug.
//   3. READERS MUST NOT WRITE. Entries are handed out by reference and the typed arrays
//      inside them are mutable — `readonly` does not reach into a `Float32Array`. A reader
//      that writes corrupts every other holder of that content key. Nothing enforces this
//      today; it is stated so the first violation is a known rule broken rather than a
//      surprise.
//   4. IN MEMORY ONLY. No OPFS, deliberately. Procedural attributes are re-derivable from
//      params and re-deriving under a content key is free; the persistence road belongs to
//      the imported-asset phase and reuses `bakedGeometryStore`'s binary format when it
//      arrives, rather than inventing a second one here.
//
// ── NOT A SHARED-GPU-RESOURCE DOOR ────────────────────────────────────────────────────
//
// The two render registries make every consumer name which door it opens, because they hand
// out live GPU instances whose ownership decides who may dispose them. This store hands out
// plain data with no GPU lifetime and no disposal, so it has no door discipline — limit 3 is
// the whole of its consumer contract.
//
// REF: src/nodes/attributeKey.ts (the mint — the only source of a key);
//      src/nodes/attributes.ts (the vocabulary);
//      src/app/geometryRegistry.ts (the growth-counter precedent this copies);
//      .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §5.3, §7;
//      issues #395, #633, #586, #587, #588.

import type { AttributeSet } from '../nodes/attributes';

/**
 * Which road grew the store.
 *
 * `evaluate` — a node minted a set from its params, synchronously, inside `evaluate()`.
 * `read`     — a read-side consumer lifted a set off geometry the registry had ALREADY
 *              built. Synchronous, and not the async road: the UV attribute arrives this
 *              way, because UV values come from the tessellation and a pure `evaluate()`
 *              has no business tessellating.
 * `prime`    — the async road filled a set after an OPFS / asset read completed, from a
 *              loader hook OUTSIDE the pure resolver. No producer yet; it exists so the
 *              first one has to declare itself rather than be counted as one of the above.
 * `overlay`  — the animation overlay re-minted a set while rebuilding a geometry handle
 *              whose descriptor a channel had written (#638). This is the SECOND producer
 *              of a mesh attribute set, and it exists as its own origin for the reason the
 *              limits above give: growth attribution by origin is what ships INSTEAD of
 *              eviction, so two producers landing under one label would leave the
 *              instrument reporting a real total with the attribution missing — and a
 *              missing attribution looks exactly like an attribution of zero. It runs on
 *              the animated path, per frame during a drag, which is precisely the road
 *              worth being able to count on its own.
 * `modifier`  — a generator TILED its source's assignment across the copies it merges
 *              (#644). The THIRD producer, and it gets its own origin for the same reason
 *              `overlay` did, plus one that is specific to it: this growth is a function of
 *              the SOURCE's assignment and the generator's params, so it is the only origin
 *              whose size scales with how much a director scopes and copies. Counted under
 *              `evaluate` it would be indistinguishable from an ordinary primitive mint, and
 *              the one road whose cost is worth watching would have no number.
 *
 *              ⚠️ It is deliberately NOT split by which road called the builder. The same
 *              tiling runs from `evaluate()` and from the animation overlay's handle rebuild,
 *              and threading a `via` through `arrayGeometryRef` / `mirrorGeometryRef` would
 *              add a required parameter to a signature with call sites in the test tier —
 *              which BOTH standing gates are blind to, so a forgotten one arrives as
 *              `undefined` and lands back in the bug class `refuseUnattributedGrowth` exists
 *              to refuse. The origin of this growth is the modifier, whichever road drove it.
 */
export type AttributeGrowthSource = 'evaluate' | 'read' | 'prime' | 'overlay' | 'modifier';

const growth: Record<AttributeGrowthSource, number> = {
  evaluate: 0,
  read: 0,
  prime: 0,
  overlay: 0,
  modifier: 0,
};

const entries = new Map<string, AttributeSet>();

/**
 * Put a set in under its content key, and return the RESIDENT set for that key.
 *
 * A second insert of an equal set is a HIT: the resident entry is returned unchanged and
 * growth is not counted, so two nodes deriving the same attributes converge on one object.
 * Callers should use the returned value rather than the one they passed, so equal content
 * is also equal by reference downstream.
 *
 * Synchronous by construction — this seam is reached from `evaluate()`, which never awaits.
 */
export function insert(key: string, set: AttributeSet, via: AttributeGrowthSource): AttributeSet {
  const resident = entries.get(key);
  if (resident !== undefined) return resident;
  entries.set(key, set);
  growth[via]++;
  return set;
}

/** The resident set for a key, or `null` when nothing was ever inserted under it. */
export function read(key: string): AttributeSet | null {
  return entries.get(key) ?? null;
}

/** How many distinct sets the store is holding. Nothing removes entries (limit 1). */
export function residentCount(): number {
  return entries.size;
}

/**
 * Insertions since the last {@link resetGrowth}, by origin.
 *
 * Unconditional, never DEV-gated: a counter the unit tier cannot read is a counter the unit
 * tier cannot gate on.
 */
export function growthBySource(): Readonly<Record<AttributeGrowthSource, number>> {
  return { ...growth };
}

/**
 * Zero the growth counters. Does NOT evict — resident entries are unaffected (limit 1).
 *
 * Derived from the record's own keys rather than assigning each origin by name (#644). The
 * by-name form was a second enumeration of the union, and a fifth origin added to the type
 * without a matching line here would have left that origin's count carrying over between
 * tests — a counter that never resets reads as growth attributable to whatever ran last,
 * which is worse than no attribution because it looks like a measurement.
 */
export function resetGrowth(): void {
  for (const via of Object.keys(growth) as AttributeGrowthSource[]) growth[via] = 0;
}
