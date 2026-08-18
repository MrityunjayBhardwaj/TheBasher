// #634 (ns-1) — the ONE place a primitive's attribute set is derived from its params.
//
// ── A PROJECTION, NOT A SECOND AUTHORING SURFACE ──────────────────────────────────────
//
// `BoxData.params.material` stays the single source of truth for what a primitive is made
// of. The face-domain `material_index` this mints is DERIVED from it at evaluate time: every
// face gets slot 0, because a primitive has exactly one material slot and nothing in the UI
// can yet say otherwise. Nothing is authored here, nothing round-trips, and consequently
// nothing in a save file changes shape — which is why this slice needs no migration.
//
// Deriving it anyway, in the degenerate uniform case, is the point of the slice: it moves
// the READ path onto the attribute system while the answers are still identical, so the
// rewrite and the behaviour change do not land in the same commit. The suite cannot tell the
// two implementations apart on this population — every producer writes a uniform assignment
// — and that is expected. The discriminating case has to be MINTED (#634's two-valued
// member); it cannot be found in the real population, because the real population cannot
// express it yet.
//
// ── WHY IT MAY RETURN NOTHING ─────────────────────────────────────────────────────────
//
// A geometry whose face count is not derivable from params (glTF, baked — their buffers live
// in an asset clone or in OPFS) gets NO attribute set rather than a guessed one. Absence
// here means "this road has not been given a data half yet", which is the honest state and
// the subject of a later phase; a fabricated count would be a length that agrees with
// nothing.
//
// REF: src/app/faceCount.ts (`faceCountOf` — the count, why it is gated, and why it is a leaf);
//      src/nodes/attributeKey.ts (`mintAttributes`); src/app/attributeStore.ts (the holder);
//      issues #633, #634, #395.

// #644 — `tiledFaceOrder` hands over the merge order ALREADY RESOLVED. This module never
// names `scopeSelection`/`scopeSelectedCount`, and that is a pinned invariant rather than an
// accident: turning a query string into a set is the resolver's job and the descriptor
// road's, never a node module's (`componentScopeChannel.gate.test.ts`).
import {
  faceCountOf,
  tiledCornerOrder,
  tiledFaceOrder,
  type TiledCornerOrder,
  type TiledFaceOrder,
} from '../app/faceCount';
import { insert, read, type AttributeGrowthSource } from '../app/attributeStore';
import {
  MATERIAL_INDEX,
  componentsOf,
  emptyLike,
  isKnownDomain,
  type AttributeData,
  type DomainId,
} from './attributes';
import { mintAttributes, type MintedAttributes } from './attributeKey';
import type { GeometryDescriptor } from './types';
// TYPE ONLY, and that is the whole relationship: this module reads a selection through its
// accessor and can never construct one, so the memoized total stays un-forgeable here.
import type { ComponentSelection } from './componentSelection';

/**
 * Refuse a mint that did not say where its growth belongs (#638, ns-1b step 6).
 *
 * ⚠️ THIS EXISTS BECAUSE THE REQUIRED PARAMETER WAS NOT ENOUGH, MEASURED RATHER THAN
 * FEARED. `via` was made required at step 3b — and the tree still had SEVENTEEN call sites
 * passing nothing, because `npm run typecheck` excludes `*.test.*` and vitest transpiles
 * through esbuild without checking types at all. Both standing gates are blind to the same
 * omission. What it does is silent and specific: `growth[undefined]++` writes `NaN` under a
 * junk key, every assertion on `growthBySource().evaluate` still passes, and the attribution
 * that the store ships INSTEAD of eviction quietly under-reports.
 *
 * A required parameter closes the omission where something typechecks. The tier that mints
 * most often is not that tier, so the refusal has to be a runtime one.
 */
function refuseUnattributedGrowth(via: AttributeGrowthSource): void {
  if (via === undefined) {
    throw new Error(
      'meshAttributes: an attribute set was minted without saying where its growth belongs — pass an AttributeGrowthSource',
    );
  }
}

/**
 * The attribute set a primitive with ONE material slot carries: a face-domain
 * `material_index` of all zeros, sized to the geometry's face count.
 *
 * Returns `null` when the face count is not derivable from the descriptor — see the module
 * note. Pure: mints, stores nothing.
 *
 * ⚠️ Takes the DESCRIPTOR, not the handle, and #638 is what forced the narrowing: the
 * attribute key is now folded into `GeometryRef.key`, so it has to exist BEFORE the handle
 * does. Nothing was lost — this only ever read `geometry.descriptor`.
 */
export function uniformMaterialAttributes(descriptor: GeometryDescriptor): MintedAttributes | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;

  const materialIndex: AttributeData = {
    domain: 'face',
    type: 'int',
    count: faces,
    // Int32Array is zero-filled on construction — every face on slot 0.
    data: new Int32Array(faces),
  };
  return mintAttributes({ [MATERIAL_INDEX]: materialIndex });
}

/**
 * Derive the set, put it in the store, and hand back the key a data value carries.
 *
 * Called from `evaluate()` and, since #638, from the animation overlay's handle rebuild.
 * The insertion is content-keyed and idempotent — re-deriving the same set is a HIT, so
 * this stays safe to run on every evaluation and on every frame of a drag, and the node
 * stays pure in the sense that matters: the same params produce the same value.
 *
 * `via` is REQUIRED, not defaulted, and the reason is the same rung of the same ladder the
 * builders' attribute key sits on. The store ships growth attribution by origin INSTEAD of
 * eviction, so a third producer silently counted as one of the first two would leave the
 * total right and the attribution missing — and a missing attribution reads exactly like an
 * attribution of zero. A new producer has to say who it is.
 */
export function mintMeshAttributes(
  descriptor: GeometryDescriptor,
  via: AttributeGrowthSource,
): string | null {
  refuseUnattributedGrowth(via);
  const minted = uniformMaterialAttributes(descriptor);
  if (minted === null) return null;
  insert(minted.key, minted.set, via);
  return minted.key;
}

/**
 * The attribute set for a mesh whose faces in `[from, to]` use slot 1 and the rest slot 0
 * (#638, ns-1b step 6) — the FIRST non-uniform assignment anything in this app can author.
 *
 * The bounds are clamped rather than refused: an authored range reaching past the end of a
 * mesh is an ordinary state while a param is being dragged or a source is being resized, and
 * a value that refuses to evaluate mid-drag is worse than one that assigns what exists. An
 * INVERTED range (`from > to`) clamps to nothing and every face stays on slot 0 — which then
 * resolves back to a single material, because the assignment reports one used slot. No arm
 * is needed for it anywhere downstream; it simply is not a two-material mesh.
 *
 * Returns `null` when the face count is not derivable from the descriptor, exactly as
 * {@link uniformMaterialAttributes} does — see the module note.
 */
export function faceRangeMaterialAttributes(
  descriptor: GeometryDescriptor,
  from: number,
  to: number,
): MintedAttributes | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;

  const data = new Int32Array(faces);
  const lo = Math.max(0, Math.trunc(from));
  const hi = Math.min(faces - 1, Math.trunc(to));
  for (let face = lo; face <= hi; face++) data[face] = 1;

  const materialIndex: AttributeData = { domain: 'face', type: 'int', count: faces, data };
  return mintAttributes({ [MATERIAL_INDEX]: materialIndex });
}

/**
 * The attribute set for a mesh whose TARGETED faces use slot 1 and the rest slot 0, where
 * "targeted" is a resolved {@link ComponentSelection} (ns-2 steps 12 and 14, #607).
 *
 * ── WHY THE OPERATOR DOES NOT BUILD THE SELECTION ITSELF ─────────────────────────────
 *
 * `SetMaterialOp` is the first `'target'` consumer: the selection names which components
 * RECEIVE the write. It hands over what the evaluator gave it and this function does the
 * arithmetic — because an operator that built its own selection out of a face count is the
 * decorative-road failure this phase names by name, and `totalSelection` is censused at zero
 * external callers to make that unconstructible.
 *
 * 🔴 IT TOOK A SECOND INPUT UNTIL ns-2 STEP 14: `faceFrom`/`faceTo`, the crude precursor the
 * selection supersedes, intersected with the selection here. They are gone, and a saved range
 * is rewritten into the equivalent query by `SetMaterialOp`'s v1 → v2 migration rather than
 * dropped — so this function's contract narrowed without any authored state changing meaning.
 * What is left is the shape the phase was aiming at: ONE input naming which components are
 * addressed, resolved in ONE place.
 *
 * The key is content-derived, so two different targeted sets key apart automatically.
 *
 * Returns `null` when the face count is not derivable from the descriptor.
 */
export function targetedMaterialAttributes(
  descriptor: GeometryDescriptor,
  selection: ComponentSelection | null,
): MintedAttributes | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;

  const data = new Int32Array(faces);
  for (let face = 0; face < faces; face++) {
    // A `null` selection is the resolver's declared "this value has no component domain",
    // not "select nothing" — every face is addressed, exactly as it was before scope existed.
    // `count === 0` is the different thing and it is carried by the selection.
    if (selection === null || selection.has(face)) data[face] = 1;
  }

  const materialIndex: AttributeData = { domain: 'face', type: 'int', count: faces, data };
  return mintAttributes({ [MATERIAL_INDEX]: materialIndex });
}

/**
 * Derive a targeted assignment, store it, and hand back BOTH the key and how many faces it
 * actually covers — the selection sibling of {@link mintMeshAttributes}.
 *
 * Its RANGE sibling, `mintFaceRangeAttributes`, was deleted at the ns-2 merge gate: step 14
 * retired `SetMaterialOp`'s `faceFrom`/`faceTo` pair and took its only caller with it, and
 * an exported store-wrapper with no callers reads as live API. `faceRangeMaterialAttributes`
 * below is deliberately KEPT — `SetMaterialOp.test.ts` anchors on it as the untouched #638
 * producer, an oracle that does not route through the code it checks.
 *
 * ⚠️ THE COVERED COUNT IS RETURNED RATHER THAN RE-DERIVED BY THE CALLER. `SetMaterialOp`
 * needs it to choose between REPLACE and APPEND, and a caller that recomputed it from the
 * selection and the range would be a second implementation of this function's arithmetic —
 * two spellings that agree today and diverge the first time either is touched. One walk,
 * one answer.
 */
export function mintTargetedAttributes(
  descriptor: GeometryDescriptor,
  selection: ComponentSelection | null,
  via: AttributeGrowthSource,
): { readonly key: string; readonly covered: number; readonly faces: number } | null {
  refuseUnattributedGrowth(via);
  const faces = faceCountOf(descriptor);
  const minted = targetedMaterialAttributes(descriptor, selection);
  if (minted === null || faces === null) return null;
  insert(minted.key, minted.set, via);
  const assigned = minted.set[MATERIAL_INDEX].data;
  let covered = 0;
  for (let face = 0; face < faces; face++) if (assigned[face] === 1) covered += 1;
  return { key: minted.key, covered, faces };
}

/**
 * The tiled key already minted for a (layout, source assignment) pair (#689).
 *
 * Keyed on the LAYOUT OBJECT first and the source's attribute key second, which is what makes
 * the nesting the right way round: the outer key is the thing with a bounded lifetime, so this
 * whole structure is reclaimed by `faceCount.ts`'s cache rather than by a policy of its own.
 * Two modifiers over one source with different scopes hold different layouts and therefore
 * different outer entries — a flat map keyed on the source alone would have them evict each
 * other and hit 0%.
 *
 * The inner key stays the SOURCE's attribute key even though the gather now reads every
 * face-domain attribute (#688): that key is a content hash of the source's whole set, so it
 * already varies with anything the gather could read. Widening the gather does not widen what
 * identifies its input.
 */
const tiledKeyCache = new WeakMap<readonly number[], Map<string, string>>();

/**
 * How one domain's attributes are laid out across a generator's copies: the gather order, the
 * number of elements a source must carry to fit it, and the noun a refusal names them with.
 */
interface TiledLayout {
  /** `order[i]` is the source element that element `i` of the merged geometry came from. */
  readonly order: readonly number[];
  /** What an attribute at this domain must declare as its `count` to fit the source. */
  readonly sourceElements: number;
  /** What to call these elements in a message a human reads. */
  readonly noun: string;
}

/**
 * Which layout lays out a domain, or `null` when this road cannot lay it out (#694).
 *
 * ── ONE DISPATCH, THREE CALLERS, BECAUSE THE ALTERNATIVE IS THREE ANSWERS ─────────────
 *
 * The filter that decides which attributes tile, the refusal that checks each one fits, and
 * the gather that copies the values all ask THIS function. They previously agreed by all
 * three spelling `'face'` separately, which was true while one domain tiled and would not
 * have survived the second: the filter could admit a corner attribute the refusal then
 * measured against a face count. The order, the denominator and the noun travel together
 * because they are one decision.
 *
 * 🔴 `point` AND `edge` RETURN `null` RATHER THAN THROWING, WHICH IS THE PRE-#694 BEHAVIOUR
 * DELIBERATELY KEPT. A source carrying them takes the historical road — no tiling, no layout
 * — exactly as it did when only `face` tiled. Refusing loudly instead would be a behaviour
 * change for sources that exist today, smuggled in under a widening.
 *
 * ⚠️ THE `never` CLOSES "IS THERE AN ARM FOR EVERY DOMAIN?", NOT "IS EACH ARM RIGHT?". It
 * fires when `KNOWN_DOMAINS` grows and nobody decided what the new domain does here — which
 * is worth having and is not evidence that the arms above it return the right orders. That
 * claim is a runtime one, and it is held by the gate's mirrored-corner row: an arm returning
 * a wrong-but-valid order compiles perfectly and reds there.
 *
 * An UNKNOWN domain is `null` too, and before the switch rather than in it: domains are data
 * and round-trip, so a set carrying one this build has never heard of must survive being read
 * and re-written, not stop a generator from building.
 */
function layoutForDomain(
  domain: DomainId,
  faces: TiledFaceOrder,
  corners: TiledCornerOrder,
): TiledLayout | null {
  if (!isKnownDomain(domain)) return null;
  switch (domain) {
    case 'face':
      return { order: faces.order, sourceElements: faces.sourceFaces, noun: 'faces' };
    case 'corner':
      return { order: corners.order, sourceElements: corners.sourceCorners, noun: 'corners' };
    case 'point':
    case 'edge':
      return null;
    default: {
      const unreachable: never = domain;
      throw new Error(`layoutForDomain: undeclared domain ${String(unreachable)}`);
    }
  }
}

/**
 * Tile a source's per-face attributes across the copies a generator merges, store them, and
 * hand back the key the generator's handle carries — or `null` when there is nothing to tile
 * (#644, widened by #688). The FIFTH member of this file's minter family.
 *
 * ── EVERY FACE-DOMAIN ATTRIBUTE, NOT A NAME THIS MODULE KNOWS (#688) ──────────────────
 *
 * The first version gathered `material_index` alone. That made the generator's key name only
 * the tiled material index, which was a TRUE statement about the merged geometry exactly as
 * long as `material_index` was the only face-domain attribute anything minted — and
 * `AttributeSet`'s own comment exists to say that will not last. The moment a source carried
 * a second one, two genuinely different merged geometries collapsed onto one cached build and
 * the second attribute was dropped: #649's defect with the sign flipped, and constructed
 * rather than argued (`face_group` differing, `sourceKeysDiffer: true`, `arrayKeysDiffer:
 * false`, both `array|box|1,1,1|3|2,0,0|a:ea2140ba`).
 *
 * So the set is selected by DOMAIN, which is the property that makes a face order applicable,
 * rather than by name. Nothing here knows what a caller's attribute means, and that is the
 * point: the gather is `tiled[i] = source[order[i]]`, which is correct for any per-face datum.
 *
 * ── FACE AND CORNER, EACH ON ITS OWN ORDER (#694) ─────────────────────────────────────
 *
 * This block used to say ONLY THE FACE DOMAIN, and gave the reason in the negative: `order`
 * is a permutation of FACE indices, so a corner attribute — `UVMap` above all — was dropped
 * and two sources differing only in their UVs collapsed onto one cached build. That is
 * closed. `tiledCornerOrder` expands the face order into corners, and {@link layoutForDomain}
 * is the single place that says which order lays out which domain.
 *
 * 🔴 THE OBSTACLE WAS NEVER THE PER-FACE CORNER COUNT, WHICH IS WHAT #694 WAS FILED SAYING.
 * Every descriptor this module answers for is triangle-indexed, so that count is 3. The
 * obstacle was WINDING: `buildMirror` reverses its reflected half, so a corner order of
 * `3·face + k` is right for an Array and silently wrong for a Mirror. Recorded because a
 * reader who trusts the issue will go looking for per-face corner counts that do not exist.
 *
 * ⚠️ POINT AND EDGE ARE STILL DROPPED, and for the original reason — there is no point or
 * edge order. Their sharing loss stays open, and it is a real one the day anything mints
 * them; `layoutForDomain`'s `null` arm is where that decision would be taken.
 *
 * ── THE ORDER IS TAKEN FROM THE BUILDER, NOT FROM THE ARITHMETIC ──────────────────────
 *
 * `buildArray` merges `[source.clone(), ...faceSubset(source, scope) x (count - 1)]` and
 * `buildMirror` merges `[source.clone(), faceSubset(source, scope)]`, where `faceSubset`
 * walks `f = 0..faces-1` ASCENDING and keeps the faces the mask names. `mergeGeometries`
 * concatenates in that order. So the assignment is laid out the same way: the whole source
 * first, then `repeats` passes over the selected faces in ascending order.
 *
 * Both the count and this layout come from {@link tiledFaceOrder}, and the subset comes from
 * `scopeSelection` — the same one evaluation of a query the builder's `faceSubset` uses. That
 * is what makes "the tiled index has exactly as many entries as the built geometry has faces"
 * true by construction rather than by a test: `build()` consults `faceCountMismatch` BEFORE
 * deriving a layout, so a disagreement of one face silently drops every group.
 *
 * ── WHY A SINGLE MISFIT REFUSES THE WHOLE SET ─────────────────────────────────────────
 *
 * One attribute whose count does not match the source's face total refuses ALL of them, and
 * that is the same both-or-neither rule the slot table forwards under. Tiling the ones that
 * fit and dropping the one that does not would be *this function* silently losing an
 * attribute, which is the defect it was widened to remove. A partial answer here is
 * indistinguishable from the bug.
 *
 * ── WHY IT RETURNS `null` RATHER THAN A UNIFORM SET WHEN THE SOURCE HAS NONE ──────────
 *
 * A source that answered `null` to the attribute question has no assignment to propagate,
 * and minting a uniform one here would be this module inventing data on the generator's
 * behalf — plus it would change every unscoped generator key that has ever been written.
 * Absence stays absence, and the generator's key keeps its historical spelling. A source
 * carrying attributes at no face domain at all takes the same road, for the same reason.
 *
 * `via` is fixed at `'modifier'` rather than threaded from the caller; the reason is in
 * `attributeStore.ts`'s origin table.
 */

export function mintTiledModifierAttributes(descriptor: GeometryDescriptor): string | null {
  // Narrowing for `source`: `tiledFaceOrder` answers only for these two kinds, but that is
  // its invariant and not something the type system carries back out here.
  if (descriptor.kind !== 'array' && descriptor.kind !== 'mirror') return null;

  const sourceKey = descriptor.source.attributeKey;
  if (sourceKey === undefined) return null;
  // `null`, not `undefined` — the store's own "no set under this key". The one-attribute
  // version reached the set through `?.[MATERIAL_INDEX]`, which collapsed that distinction
  // into the same `undefined` a missing NAME produces; reading the set itself separates them.
  const carried = read(sourceKey);
  if (carried === null) return null;

  // Selected by DOMAIN, never by name (#688) — see the block above. Sorted so the walk below
  // is deterministic; `mintAttributes` sorts again on its own, so the key does not depend on
  // this, but the WARNING's wording does and a message whose word order varies per run is a
  // message nobody can grep for.
  const tiled = tiledFaceOrder(descriptor);
  if (tiled === null) return null;
  const { sourceFaces } = tiled;
  // Asked for unconditionally rather than only when a corner attribute is present: it is a
  // memoised expansion of the face order just taken, so the branch would buy nothing and
  // would put the two orders on different roads through this function.
  const corners = tiledCornerOrder(descriptor);
  if (corners === null) return null;

  // The memo is consulted BEFORE the layouts are resolved, not after. Everything below this
  // line is a pure function of the two things the key already names — the corner order and the
  // source key — so a hit that had to walk the attribute set first would be paying the cost it
  // exists to avoid. #689 measured that road at 75 µs to 1.69 ms per operator per evaluate.
  const perSource = tiledKeyCache.get(corners.order);
  const remembered = perSource?.get(sourceKey);
  if (remembered !== undefined) return remembered;

  // ONE layout per attribute, resolved once and carried to all three users below (the empty
  // check, the refusal, the gather). Calling `layoutForDomain` at each of them instead would
  // allocate a record per attribute per user on a per-evaluate road, and — worse than the cost
  // — would let the three disagree about which attributes tile if the dispatch ever stopped
  // being a pure function of the domain. Insertion order is the sorted name order, so the
  // walk below is deterministic and the refusal's wording does not vary per run.
  const layouts = new Map<string, TiledLayout>();
  for (const name of Object.keys(carried).sort()) {
    const layout = layoutForDomain(carried[name].domain, tiled, corners);
    if (layout !== null) layouts.set(name, layout);
  }
  // Not "no attributes" but "none this road can lay out": a source carrying only point- or
  // edge-domain data reaches here and takes the historical road, which is why this is a
  // separate exit from the `sourceKey === undefined` one above rather than folded into it.
  //
  // ⚠️ THE ORDERS ARE TAKEN BEFORE THIS FILTER, NOT AFTER. The filter asks which layout lays
  // a domain out, so it needs the layouts; asking a cheaper domain-only predicate first would
  // be a SECOND statement of which domains this road can tile, free to drift from the one
  // below. Both orders are memoised, so the cost of taking them for a source that turns out
  // to carry nothing layable is a map lookup.
  if (layouts.size === 0) return null;

  // Refused BY NAME — every name, not the first — and it degrades to the pre-#644 behaviour
  // (no tiling, no layout) rather than laying out a wrong one: tiling a set that does not fit
  // its own source would put the right slots on the WRONG triangles, which is quieter than
  // drawing slot 0 and therefore worse than the bug this change removes. ALL of them are
  // named because a reader who fixes the alphabetically-first one and re-runs would otherwise
  // meet the next one with no warning that it was already known.
  //
  // ⚠️ NO PRODUCTION ROAD REACHES IT TODAY, SAID HERE RATHER THAN LEFT TO BE DISCOVERED.
  // A ref's key and its `attributeKey` are minted in one expression, so a source's set
  // always fits its own descriptor; the one road that could break the pair — the overlay
  // rebuilding a handle whose face count moved — is exactly what `rebuiltMeshAttributes`
  // above resolves, and it drops the set rather than carrying a stale one. So this is the
  // arm for a producer that has not been written yet. It is still exercised directly by
  // the gate, because a named guard nobody has ever run reads as "no objection" forever
  // and a reader who finds it stops looking.
  //
  // The denominator is PER DOMAIN (#694): a face attribute must carry one element per source
  // face and a corner attribute one per source corner, so a single `sourceFaces` comparison
  // would have refused every correctly-sized corner attribute the moment corners started
  // tiling. Both the number and the noun come from the same record the gather uses.
  const misfits = [...layouts].filter(
    ([name, layout]) => carried[name].count !== layout.sourceElements,
  );
  if (misfits.length > 0) {
    console.warn(
      `meshAttributes: '${descriptor.kind}' cannot tile ${misfits
        .map(([name, layout]) => `'${name}' over ${carried[name].count} ${layout.noun}`)
        .join(
          ', ',
        )} onto a source of ${sourceFaces} faces / ${corners.sourceCorners} corners — leaving the copies unassigned`,
    );
    return null;
  }

  // #689 — the gather, the Int32Array and the content hash below are all a function of exactly
  // two things: the source's assignment, and the layout to gather it through. Neither moves
  // during an offset drag, and re-deriving them per frame produced a key that was already
  // resident (measured: 121 frames, ZERO new store entries). So the answer is remembered.
  //
  // The layout half of the key is the order object's IDENTITY, not a restatement of what the
  // layout depends on. `faceCount.ts` returns the same object for an unchanged tiling, so this
  // cache cannot disagree with that module about what "the same layout" means — and it cannot
  // outlive it either: a WeakMap keyed on the order means an entry becomes collectable the
  // moment `faceCount.ts` drops that order from its own bounded cache. One reclaimer, one
  // stated ceiling, and it lives beside the thing being bounded rather than here.
  //
  // 🔴 THE CORNER ORDER, NOT THE FACE ORDER, AND #694 IS WHY. A Mirror and an Array with
  // `count: 2` share ONE face order object — their face layouts are genuinely identical and
  // `faceCount.ts` says so in as many words. Their tiled SETS are not identical once corners
  // tile, because only the mirror's copy is wound backwards. Keyed on the face order this
  // cache handed the mirror's set to the array; the corner order is the finer identity that
  // separates them, and it is reachable for exactly as long, being held by the same WeakMap
  // one hop further down. Measured: keyed on `order`, the gate's array control reads back the
  // mirror's swapped corners.
  // A GATHER, and deliberately nothing more. Every decision about which source face lands
  // where — the preserved input, the subset, how many times it repeats — was taken by
  // `tiledFaceOrder`, beside the count this has to agree with. There is no arithmetic here
  // to drift from it.
  //
  // `count` is in ELEMENTS and `data` is flattened component-major, so the copy steps by
  // `componentsOf(type)` — that is the whole difference between this and the one-attribute
  // version, and it is why a `float3` face attribute lands correctly rather than being
  // sheared by a factor of three. The output array class is taken from the SOURCE's rather
  // than derived from its declared `type`, so a source whose type and storage already
  // disagree comes out exactly as inconsistent as it went in: a gather does not quietly
  // half-correct its input, and truncating floats into an `Int32Array` on the strength of a
  // `type: 'int'` label would be doing precisely that.
  const tiledSet: Record<string, AttributeData> = {};
  for (const [name, layout] of layouts) {
    const attribute = carried[name];
    const components = componentsOf(attribute.type);
    // WHICH order gathers this attribute is decided by its own DOMAIN, through the same
    // dispatch the filter and the refusal above consulted (#694). A face attribute rides the
    // face order and a corner attribute the corner order; nothing here re-decides that, and
    // the `null` arm is unreachable because `layable` is exactly the names it answered for.

    // The array CLASS is forwarded off the source too (#696), through a helper closed by a
    // `never`. It was the one thing here still derived rather than forwarded, and as a
    // two-arm ternary it would have kept compiling — silently allocating the wrong class —
    // the day `AttributeArray` grows a third member.
    const data = emptyLike(attribute.data, layout.order.length * components);
    for (let element = 0; element < layout.order.length; element++) {
      const from = layout.order[element] * components;
      const to = element * components;
      for (let component = 0; component < components; component++) {
        data[to + component] = attribute.data[from + component];
      }
    }
    // The domain is FORWARDED, not re-declared as `'face'`. They are equal by the filter
    // above, and writing the literal would make this the second place that decides what
    // domain the tiled attribute is at — one of them free to drift.
    tiledSet[name] = {
      domain: attribute.domain,
      type: attribute.type,
      count: layout.order.length,
      data,
    };
  }
  const minted = mintAttributes(tiledSet);
  if (minted === null) return null;
  insert(minted.key, minted.set, 'modifier');

  // Remembered only on the success path — a refusal above returns before this, so a source
  // whose assignment does not fit gets the warning EVERY time rather than once. A guard that
  // goes quiet after its first firing is a guard that stops reporting a condition which is
  // still true.
  if (perSource === undefined) tiledKeyCache.set(corners.order, new Map([[sourceKey, minted.key]]));
  else perSource.set(sourceKey, minted.key);
  return minted.key;
}

/** What {@link rebuiltMeshAttributes} decided, and why — the reason is never dropped. */
export interface RebuiltAttributes {
  /** The key the rebuilt handle should carry, or `null` for "no attributes on this one". */
  readonly key: string | null;
  /** `null` when nothing was given up; otherwise what was dropped and why. */
  readonly reason: string | null;
}

/**
 * What attribute key a REBUILT geometry handle carries — the overlay road's answer (#638).
 *
 * ── WHY THE OVERLAY MAY NOT SIMPLY CARRY THE OLD KEY FORWARD ──────────────────────────
 *
 * The animation overlay rebuilds a handle whenever a channel writes one of its descriptor's
 * param fields, and for a sphere those fields include `widthSegments` / `heightSegments`.
 * A sphere's face count is `2w(h−1)`, so an animated segment count changes how many faces
 * exist — while the carried key still names a set sized for the OLD count. That set then
 * describes a different mesh: the count gate refuses it, no group layout is written, and
 * under a multi-slot assignment the mesh is handed a material array over an empty layout,
 * which in three.js draws nothing at all. The object disappears mid-animation, casts no
 * shadow, and stops being clickable, with nothing logged.
 *
 * ⚠️ The previous shape of this defence — asserting the rebuilt key *still carries a
 * component* — is satisfied by a STALE component, which is precisely the failure. Only the
 * count discriminates.
 *
 * Three arms, and the middle one is the only one that carries:
 *
 *   uniform carried set        → RE-MINT at the rebuilt descriptor's face count. For a box
 *                                this is a no-op by value (12 faces at every size), so the
 *                                current population sees no change at all; for a sphere it
 *                                is the correct new set.
 *   non-uniform, count intact  → carry it. The assignment is authored data the overlay has
 *                                no business re-deriving, and it still fits.
 *   non-uniform, count changed → DROP it and say so. There is no correct answer without a
 *                                resampling policy, and a visible degradation to one
 *                                material is the honest failure; the invisible mesh is not.
 */
export function rebuiltMeshAttributes(
  carriedKey: string | undefined,
  rebuilt: GeometryDescriptor,
): RebuiltAttributes {
  if (carriedKey === undefined) return { key: null, reason: null };

  const carried = read(carriedKey);
  const index = carried?.[MATERIAL_INDEX];
  // Nothing resident under the carried key, or nothing face-domain in it: re-derive rather
  // than propagate a name the store cannot resolve.
  if (index === undefined) return { key: mintMeshAttributes(rebuilt, 'overlay'), reason: null };

  let uniform = true;
  for (let i = 0; i < index.data.length; i++) {
    if (index.data[i] !== index.data[0]) {
      uniform = false;
      break;
    }
  }
  if (uniform) return { key: mintMeshAttributes(rebuilt, 'overlay'), reason: null };

  const faces = faceCountOf(rebuilt);
  if (faces === null || faces === index.count) return { key: carriedKey, reason: null };
  return {
    key: null,
    reason: `meshAttributes: a per-face assignment over ${index.count} faces cannot follow '${rebuilt.kind}' to ${faces} faces — dropping it, so the mesh draws with one material rather than not at all`,
  };
}
