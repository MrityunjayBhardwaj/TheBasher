// componentSelection — the resolved component scope of an operator, and the ONE place a
// scope query is read. ns-2 (#607, #660), plan step 9.
//
// ── WHAT THIS MODULE IS FOR ───────────────────────────────────────────────────────────
//
// A geometry operator is not always whole-mesh → whole-mesh. Houdini's rule, which this
// substrate follows: "apply the node's effects to certain groups in the input stream,
// instead of to every point/primitive" (`ref/houdini/SOP.md:49`). The thing that says
// WHICH components is a query the author writes; the thing an operator consumes is a
// resolved {@link ComponentSelection}.
//
// THE RULE THIS MODULE EXISTS TO MAKE TRUE:
//
//     EXACTLY ONE PARSER EXISTS, AND NO OPERATOR EVER INTERPRETS A QUERY.
//
// The parser is not exported. An operator receives a resolved selection and cannot reach
// the query at all, so "a new operator forgot to parse it correctly" has no constructor —
// which matters because the defect this phase exists to delete is precisely a property
// that every member had to remember separately.
//
// 🔴 THE LANGUAGE MOVED DOWN AT STEP 12.5, AND THE RULE ABOVE DID NOT CHANGE. Parsing,
// canonicalising and evaluating a query at a length now live in `scopeQuery.ts`, a LEAF
// with zero value imports, because step 12.5 gave a generator's descriptor a `scope` field
// and that created two consumers which are not the resolver: `faceCount.ts` (a scoped array
// derives `source + subset x (count - 1)`) and `geometryRegistry.ts` (which triangles
// survive). This module imports `faceCount.ts`, so `faceCount.ts` cannot import it back —
// a measured cycle, not a shape preference. What this module still owns is the CONTRACT an
// operator sees: {@link ComponentSelection}, the memoized total, and the ONE resolver that
// turns a spine value plus params into one. `scopeQuery` exports no terms either, so the
// number of readers of a QUERY did not grow; the language simply sits below all three of
// its consumers instead of inside one of them.
//
// ── WHAT AN OPERATOR CAN AND CANNOT DO WITH A SELECTION ───────────────────────────────
//
// {@link ComponentSelection} is ACCESSOR-ONLY, and that is load-bearing rather than
// stylistic. The total selection is MEMOIZED — every unscoped operator at a given
// (domain, length) receives the SAME object — so a reader that mutated it would corrupt
// every other operator's scope in a way no behavioural test could localise. No buffer
// escapes this module, so that reader has no constructor. (A shared frozen buffer was the
// obvious alternative and does not work: `Object.freeze` on a typed array with elements
// throws, and succeeds only on a zero-length view.)
//
// 🔴 STEP 13a AMENDS ONE SENTENCE THIS HEADER USED TO CARRY, AND THE AMENDMENT IS THE
// POINT RATHER THAN AN EXCEPTION TO IT. It used to say a selection is "NEVER a query". A
// selection now carries {@link ComponentSelection.canonicalQuery} — the canonical spelling
// of the query that produced it, or `null` when nothing was authored — because a
// `'source'` operator's whole job is to put its scope into a geometry KEY, and a key needs
// an identity, not a mask.
//
//   WHAT DID NOT CHANGE: no operator INTERPRETS a query. That was always the rule, and it
//   is a rule about who may turn a string into a SET. The parser is unexported, and the two
//   functions that evaluate a query at a length (`scopeSelection`, `scopeSelectedCount`)
//   live in `scopeQuery.ts` with an importer census over `src/nodes/**` that pins their
//   node-module callers at zero.
//   WHAT DID CHANGE: the guarantee used to be free — an operator could not misuse a query
//   it did not have. Now it has one, so the census above is load-bearing where it was
//   merely tidy, and it is asserted rather than assumed.
//
// The alternative was for a generator to re-read `params[SCOPE_PARAM]` itself. That is the
// road this phase exists to close: it puts a second producer of the descriptor's scope
// beside the resolver, and — measured, not argued — it makes the step's own detector
// impossible, because discarding the resolved selection would then change nothing.
//
// ── WHAT v1 PARSES, AND WHAT IT REFUSES BY NAME ───────────────────────────────────────
//
// The reference's Group field is a query language: numeric ranges `0-10`, step `0-100:2`,
// wildcards `arm*`, negation `!1-10`, set removal `^pattern`, and attribute expressions
// `@v>0` (`ref/houdini/SOP.md:51`). v1 ships the subset that needs NO new storage —
// ranges, step, negation, removal — because a wildcard or a name is a reader over STORED
// groups, and nothing in this project stores one yet. Naming a group is a decision already
// taken for the phase that builds them; it is not incurred here.
//
// The deferred constructs are REFUSED BY NAME rather than ignored. An unrecognised query
// that silently means "everything" applies the operation to the whole mesh, which is the
// loudest possible wrong answer wearing the quietest possible failure.
//
// ⚠️ HOW THE OPERATORS COMPOSE IS DECIDED HERE, NOT LOOKED UP. The reference documents
// that `!` and `^` exist and does not state how a query mixing them evaluates; I checked
// and found nothing. So it is decided and pinned by test rather than inferred: terms
// accumulate LEFT TO RIGHT from the empty set — a bare term adds, `^` removes, `!` adds
// the complement. Do not "correct" this against a mental model of Houdini without a
// source; the reason it is written down is that the source does not say.
//
// ── WHAT IS DECIDED ABOUT THE DEGENERATE CASES ────────────────────────────────────────
//
//   no scope param, or a blank one   scope EVERYTHING — the memoized total selection.
//   a query resolving to ZERO        scope NOTHING. `count === 0`, distinct by value from
//                                    a total, so the two cannot be confused by a caller.
//   an unparseable query             a NAMED THROW. Never a silent fall back to
//                                    "everything": a lost scope applies the operation to
//                                    the whole mesh.
//   NO scope, on a value with no     `null` — a DECLARED "nothing to resolve here", not an
//   component domain                 error. Curves, lights, cameras, unwired spines and
//                                    `gltf`/`baked` handles all sit on shipped modifier
//                                    roads today (step 9b measured it), so refusing them
//                                    would throw on the renderer's walk.
//   an AUTHORED scope on one of      a NAMED THROW. The author asked for something that
//   those                           cannot be honoured, and that is the lost-scope hazard.
//
// Indices outside `[0, length)` are DROPPED rather than refused — a range half in bounds
// contributes its in-bounds half, and one wholly out of bounds resolves to nothing. An
// INVERTED range (`5-2`) is refused instead, because it cannot be an authoring intent and
// silently meaning nothing is the same lost-scope hazard.
//
// REF: src/nodes/scopeQuery.ts (the language: parse, canonicalise, evaluate at a length);
//      src/app/faceCount.ts (the only derivable element count); src/nodes/attributes.ts
//      (`KnownDomain`); src/app/modifierDataSource.ts (which values carry components);
//      ref/houdini/SOP.md §4; issues #607, #660.

import { z } from 'zod';
import type { KnownDomain, ScopeDomain } from './attributes';

/**
 * Re-exported, NOT redefined (#714). {@link ScopeDomain} is declared in `attributes.ts`
 * beside the domain vocabulary it is an `Extract` over — that module imports nothing, so it
 * can be reached from anywhere without a cycle.
 *
 * 🔴 IT IS RE-EXPORTED HERE SO `core/dag` DOES NOT GROW A SECOND EDGE INTO `nodes/`. The
 * layering row in `componentScopeChannel.gate.test.ts` pins that surface as an EXACT list —
 * `core/dag/types.ts` reaches this module and nothing else — and it red on the direct import,
 * which is the gate working rather than an obstacle. The concept belongs to this module's
 * surface anyway: "which atom class may a scope be resolved at" is a fact about scopes, and
 * the resolver below is the thing that consumes it.
 */
export type { ScopeDomain };
import type { CountVerdict, GeometryDescriptor, ObjectData } from './types';
import { cornerCountOf, faceCountOf } from '../app/faceCount';
import { edgeCountOf } from '../app/edgeIdentity';
import { pointCountOf } from '../app/pointIdentity';
import { modifierDataSource } from '../app/modifierDataSource';
import { canonicalScopeQuery, isParsableScopeQuery, scopeSelection } from './scopeQuery';
import { edgeIndicesByAngle } from '../app/edgeAngleSelection';

/**
 * A resolved component selection at one domain. NEVER a name, NEVER a buffer, and never a
 * query a reader can turn into a set — see {@link ComponentSelection.canonicalQuery} for
 * the one string it does carry and what may be done with it.
 *
 * `count` is computed at mint — O(1) for a total selection, O(elements) for a scoped one —
 * so a caller can branch on "selects nothing" without walking the mask.
 */
export interface ComponentSelection {
  readonly domain: KnownDomain;
  /** The domain's element count. */
  readonly length: number;
  /** How many elements are selected. */
  readonly count: number;
  /**
   * THE SELECTION'S IDENTITY — the canonical spelling of the query that produced it, or
   * `null` when no scope was authored (ns-2 step 13a).
   *
   * ── WHY A RESOLVED SELECTION CARRIES A STRING AT ALL ──────────────────────────────
   *
   * A `'target'` operator writes through the accessor and never needs this. A `'source'`
   * operator does something the accessor cannot express: it hands its scope to a
   * `GeometryRef`, whose key is a string and whose descriptor is a REBUILD RECIPE the
   * registry re-reads later, off the render road, with no selection in scope. So what a
   * generator must pass downstream is an IDENTITY, and the canonical query is the identity
   * D9 chose — O(query) to fold, against O(elements) for a mask digest on the drag road.
   *
   * ⚠️ `null` AND A QUERY SELECTING EVERYTHING ARE DIFFERENT VALUES, DELIBERATELY. `null`
   * is the unscoped road, and it is what keeps an unscoped geometry key byte-identical to
   * what it was before this phase existed. A query that happens to name every face is a
   * scope the author wrote, and it mints its own build — a benign duplicate, and the same
   * sound-but-not-total property the canonicaliser already declares.
   *
   * 🔴 WHAT A READER MAY DO WITH IT: pass it on. NOT interpret it. The parser is unexported
   * and the two functions that evaluate a query at a length live in `scopeQuery.ts`, whose
   * node-module importers are censused at zero — the row that used to be free (an operator
   * could not misuse a query it never received) and is load-bearing now that one does.
   */
  readonly canonicalQuery: string | null;
  has(element: number): boolean;
}

/**
 * The param an author's scope query lives in.
 *
 * ONE name, exported so nothing spells it a second time. It is a param and not a socket id
 * deliberately: a socket's TYPE is code and its ID is data, so a scope arriving as a new
 * socket would be a project-format migration for something that is authored text.
 */
export const SCOPE_PARAM = 'scope';

/**
 * The limit-method params (#847) — NAMES ONLY, for the reason `SCOPE_PARAM` is a constant.
 *
 * The resolver below reads these out of an operator's params, so the spelling is a contract
 * between it and any operator that declares one, and a contract spelled twice drifts. The
 * SCHEMAS deliberately stay in the declaring node: there is exactly one declarer today, and
 * #680 centralised the scope schema only once five files had copied it.
 */
export const LIMIT_METHOD_PARAM = 'limitMethod';
export const ANGLE_LIMIT_PARAM = 'angleLimit';

/**
 * The scope param's schema — the whole zod chain, so a declarer writes
 * `[SCOPE_PARAM]: scopeParam()` and cannot spell any part of it a sixth time (#680).
 *
 * ── WHAT WAS DUPLICATED, AND WHAT DELIBERATELY IS NOT ─────────────────────────────────
 *
 * This block was byte-identical in five node files — message string and `.default('')`
 * included, verified by pairwise diff. Nothing in it is a per-operator decision: the parser,
 * the refusal message and the empty default are one fact about what a scope query IS.
 *
 * ⚠️ THE ATOM CLASS BESIDE IT IS THE OPPOSITE CASE AND STAYS COPIED. Five operators each
 * declaring `SCOPE_DOMAIN = 'face'` is five decisions that happen to agree, which is exactly
 * why #714 replaced the shared module constant with a per-operator declaration. Collapsing
 * those back into one value would undo that. What was single there was the RATIONALE, and it
 * moved to the type's own definition site instead. Two adjacent duplications, two different
 * fixes — see #680.
 *
 * ── WHY THE REFINEMENT HAS TO BE HERE AT ALL ──────────────────────────────────────────
 *
 * An unparseable query reaching the resolver is a THROW, `evaluate` runs on the render walk
 * with no `try` above it, and this project has no node-error surfacing. Refining at the
 * schema means an unparseable query never enters params. Blank is the same authoring state
 * as absent.
 */
export function scopeParam(): z.ZodDefault<z.ZodEffects<z.ZodString, string, string>> {
  return z
    .string()
    .refine(isParsableScopeQuery, {
      message: 'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
    })
    .default('');
}

/** Every refusal from this module is named and carries the query that produced it. */
function refuse(why: string): never {
  throw new Error(`componentSelection: ${why}`);
}

/**
 * How many elements a domain has for a given descriptor, as a {@link CountVerdict}.
 *
 * 🔑 EVERY DOMAIN ANSWERS SINCE #776, AND THE REFUSAL ARM IS GONE. ns-2 shipped `face` alone;
 * #716 added `point`, #718 `edge`, #776 `corner`. The `never` below now closes a question that
 * has no exceptions left — a fifth domain is a compile error at the site that must answer for
 * it, rather than one more candidate for the refusal the other three used to share.
 *
 * Closed by a `never` over {@link KnownDomain}, so a fifth domain is a compile error at the
 * site that must answer for it.
 *
 * ⚠️ AN ABSENCE AND A REFUSAL ARE DIFFERENT ANSWERS TO DIFFERENT QUESTIONS, and collapsing
 * them is what step 9b measured as a production crash. A refusal says *this domain has no
 * derivation at all in ns-2* — a fact about the code, true for every descriptor, and an
 * author cannot reach it, which is why it THROWS and is not an arm of the verdict. An
 * `outside-the-descriptor` verdict says *this domain is derivable in principle and THIS
 * descriptor cannot say how many* — the `gltf` and `baked` arms, whose buffers live outside
 * the descriptor, and which are ordinary shipped values sitting on a modifier's spine right
 * now. See {@link resolveComponentSelection} for what the difference buys.
 *
 * 🔴 #744 — THE RETURN USED TO BE `number | null`, AND THE `null` WAS CARRYING TWO FACTS.
 * At `point` it meant both "the buffers are elsewhere" (`gltf`, `baked`) and "a welded count
 * depends on positional coincidence" (`array`, `mirror`, `subset`), which have different
 * futures: the first is permanent, the second was a road. #754 built that road — the derived
 * arms compose — so the second meaning is gone rather than named, and what remains is one
 * absence with its reason attached. The type is kept even at two arms because the reason now
 * travels WITH the absence instead of being restated by each caller.
 *
 * ⚠️ THIS IS NOT `elementCountFor`, AND THE DIFFERENCE IS WHY BOTH EXIST. That one maps
 * (domain, a full `MeshElementCounts`) → count. A descriptor yields exactly ONE of those
 * four numbers, so calling it here would mean fabricating three counts in order to read the
 * fourth — inventing a topology to satisfy a signature. This asks a different question of a
 * different input: "can ns-2 resolve a selection against this descriptor, at this domain?"
 * The three unshipped domains answer honestly instead of plausibly.
 *
 * Exported so `attributes.gate.test.ts` can PROBE it. That gate refuses to let any module
 * name the closed domain type without registering an answer for every member, and it caught
 * this module the moment it existed — which is the census working, not an obstacle. The
 * three refusals are registered there as declared exemptions carrying their reason, so
 * "ns-2 resolves at `face` only" is visible where a reader goes looking for it rather than
 * buried in this file's prose.
 */
export function componentCountOf(
  domain: KnownDomain,
  descriptor: GeometryDescriptor,
): CountVerdict {
  switch (domain) {
    case 'face': {
      // The gltf / baked arms have no answer: their buffers live outside the descriptor, so
      // nothing here can say how many faces they hold. A ZERO would read as "scope nothing"
      // on a mesh the author can see, with faces they can count — which is why the absence
      // is carried as its own value rather than as a number.
      //
      // #744 — `faceCountOf` STILL SPEAKS `number | null`, AND THE LIFT HAPPENS HERE. Its
      // `null` has only ever meant one thing: its derived arms recurse, and come back null
      // only when a `gltf` or `baked` sits somewhere up the chain. The collapse #744
      // describes was `pointCountOf`'s alone, so lifting `faceCountOf` too would rewrite
      // five in-module callers to buy a distinction that function does not draw.
      const faces = faceCountOf(descriptor);
      return faces === null
        ? {
            kind: 'outside-the-descriptor',
            why: `descriptor '${descriptor.kind}' resolves to a 'gltf' or 'baked' source, whose triangles live outside the descriptor`,
          }
        : { kind: 'counted', count: faces };
    }
    case 'point':
      // #716 gave this arm the TOPOLOGICAL count; #754 made it total for everything but the
      // two kinds whose buffers are elsewhere, by composing a derived geometry's point
      // identity from its source's instead of position-welding the merged result.
      //
      // ⚠️ ANSWERING HERE DOES NOT WIDEN THE AUTHORING SURFACE, which is worth saying because
      // it looks like it should. A scope's domain is chosen by an OPERATOR'S DECLARATION, and
      // `ScopeDomain` is still `['face']` — so no operator can name `'point'` until that const
      // is widened, which is #667's work. The type refuses it today rather than allowing it
      // quietly, so this arm is reachable from a test and from #667, and from nothing else.
      return pointCountOf(descriptor);
    case 'edge':
      // #718 gave this arm an answer, and it is the LAST of the four to get one. An edge is a
      // pair of topological points, so it waited on #716's weld for something to be a pair OF —
      // an edge set read off the index buffer counts a box's 12 edges as 24, because two faces
      // sharing an edge do not share point indices on a split buffer.
      //
      // ⚠️ ANSWERING HERE DOES NOT WIDEN THE AUTHORING SURFACE, for exactly the reason the
      // `point` arm above records: `ScopeDomain` is still `['face']`, so no operator can name an
      // edge scope until #667 widens it. This arm is reachable from a test and from #667, and
      // from nothing else.
      return edgeCountOf(descriptor);
    case 'corner': {
      // #776 gave this arm an answer, and it is the fourth and last. A corner is a POLYGON
      // corner — Blender's loop — so a box has 24 and not the 36 `tiledCornerOrder` laid out
      // until this phase. That is the number `MeshElementCounts` has declared for a box since
      // ns-1, so this arm now agrees with the table every other domain resolves against.
      //
      // ⚠️ ANSWERING HERE DOES NOT WIDEN THE AUTHORING SURFACE, for exactly the reason the
      // `point` and `edge` arms above record: `ScopeDomain` is still `['face']`, so no operator
      // can name a corner scope until #667 widens it.
      //
      // Lifted from `number | null` the same way the `face` arm above is, and for the same
      // reason — a corner hangs off a face, so `cornerCountOf` answers exactly where
      // `faceCountOf` does and its `null` carries exactly one meaning.
      const corners = cornerCountOf(descriptor);
      return corners === null
        ? {
            kind: 'outside-the-descriptor',
            why: `descriptor '${descriptor.kind}' resolves to a 'gltf' or 'baked' source, whose polygons live outside the descriptor`,
          }
        : { kind: 'counted', count: corners };
    }
    default: {
      const unreachable: never = domain;
      return refuse(`undeclared domain ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The total selection, memoized
// ---------------------------------------------------------------------------

const TOTAL_MEMO = new Map<string, ComponentSelection>();

/**
 * The selection that selects everything at `(domain, length)` — the SAME object every time.
 *
 * An unscoped operator therefore allocates nothing after the first call, and needs no
 * buffer at all: membership at a total selection is a bounds check.
 */
export function totalSelection(domain: KnownDomain, length: number): ComponentSelection {
  if (!Number.isInteger(length) || length < 0) {
    return refuse(`a selection length must be a non-negative integer, got ${String(length)}`);
  }
  const key = `${domain}|${length}`;
  const memo = TOTAL_MEMO.get(key);
  if (memo) return memo;
  const made: ComponentSelection = {
    domain,
    length,
    count: length,
    // The unscoped identity. A generator handed this puts NO scope on its descriptor.
    //
    // ⚠️ IT IS NOT WHAT KEEPS PRE-PHASE KEYS BYTE-IDENTICAL, AND THE FIRST DRAFT OF THIS
    // COMMENT SAID IT WAS. Measured: replacing this `null` with `''` leaves every geometry
    // key unchanged, because `scopeField` in `modifierGeometry.ts` already collapses a blank
    // query to "unscoped" at the ONE place a scope becomes a key. So the choice here is
    // belt-and-braces, and it earns its place for a different and smaller reason — `null`
    // and `''` are different CLAIMS ("nothing was authored" against "the author wrote an
    // empty string"), the same separation [[V205]] draws one level up. Written down because
    // a comment that overstates a guarantee is how a later reader deletes the real one.
    canonicalQuery: null,
    has: (element: number) => Number.isInteger(element) && element >= 0 && element < length,
  };
  TOTAL_MEMO.set(key, made);
  return made;
}

/**
 * Empty the total-selection memo.
 *
 * TEST-ONLY, and it exists because the memo never evicts. It makes the table ORDER-VISIBLE
 * inside one test file: a case asserting anything about growth or identity would otherwise
 * read the previous case's state, and pass or fail depending on the order the cases happen
 * to be written in.
 *
 * ⚠️ THE SIZE CLAIM IS NOW MEASURED, BECAUSE STEP 9b MADE THIS TABLE PRODUCTION-LIVE. Until
 * the evaluator's hand-off landed, {@link totalSelection} had no production caller and
 * "harmless in size" was inference. It is now hit on every unscoped operator cook. Measured:
 * a 121-frame drag that changes the face count every frame leaves **121 entries, one per
 * distinct count, ≈12 KB**; the whole reachable population — a sphere's segments across
 * their full authorable range — is under two thousand entries, so a session's worst case is
 * a few hundred KB. Bounded by DISTINCT COUNTS, never by frames, which is why a drag that
 * returns to a size it already visited adds nothing.
 */
export function __resetSelectionMemoForTests(): void {
  TOTAL_MEMO.clear();
}

// ---------------------------------------------------------------------------
// The ONE resolver
// ---------------------------------------------------------------------------

/**
 * Wrap the language's answer as a resolved selection.
 *
 * {@link scopeSelection} owns the arithmetic — which elements a query names at a length —
 * and this owns the CONTRACT an operator sees: a domain, a length, a count, an identity,
 * and an accessor with no buffer behind it a reader can reach. The mask is captured by the
 * closure and is not a property of the returned object, which is what makes the memoized
 * total safe to share, and is kept here for consistency rather than for necessity.
 *
 * 🔴 THE SELECTION IS RESOLVED FROM THE CANONICAL FORM, NOT FROM THE AUTHORED ONE, so the
 * mask and the identity describe literally the same string (ns-2 step 13a). Canonicalising
 * is meaning-preserving — that is {@link canonicalScopeQuery}'s SOUND direction — and this
 * turns that from a property two call sites rely on separately into one they share.
 *
 * COST, MEASURED rather than waved at, because this runs on the drag road. One extra parse
 * of an authored query per resolve — O(query) beside an O(length) mask fill. Over a
 * 960-face sphere: a SCOPED resolve went **1.48 µs → 1.83 µs** per call (+0.35), and an
 * UNSCOPED one is unchanged at **0.07 µs**, since it never reaches here — it is a memo hit
 * on the total selection. Against the evaluator's recorded 12 µs per operator per frame
 * that is about 3%, and the population that pays it is operators with an authored scope.
 */
function selectionFromQuery(
  query: string,
  domain: KnownDomain,
  length: number,
): ComponentSelection {
  const canonicalQuery = canonicalScopeQuery(query);
  const { mask, count } = scopeSelection(canonicalQuery, length);
  return {
    domain,
    length,
    count,
    canonicalQuery,
    has: (element: number) =>
      Number.isInteger(element) && element >= 0 && element < length && mask[element] === 1,
  };
}

/**
 * The scope an author actually wrote, or `null` when they wrote none.
 *
 * A blank string is the same authoring state as an absent param — the author cleared the
 * field — so both collapse here rather than at three call sites. A non-string is refused:
 * it can only arrive from a schema declaring the param as something else, and guessing at
 * its meaning is how a scope gets lost.
 */
function authoredScope(params: Readonly<Record<string, unknown>>): string | null {
  const raw = params[SCOPE_PARAM];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    return refuse(`the '${SCOPE_PARAM}' param must be a string, got ${typeof raw}`);
  }
  return raw.trim() === '' ? null : raw;
}

/**
 * Resolve an operator's scope from its spine value and its params — THE one resolver.
 *
 * Called from the evaluator, once, for a node whose chain declares a `'source'` or
 * `'target'` scope. It is a pure function of exactly the spine value and the params, which
 * are the two things the evaluator's value key already folds; a selection derived from
 * anything else would not be covered by that cache.
 *
 * ── WHY `null` IS AN ANSWER AND NOT AN ERROR (ns-2 step 9b) ────────────────────────────
 *
 * `null` means: **this spine value has no component domain to resolve against, and the
 * author asked for no scope.** It is a DECLARED answer in the same sense as
 * `BypassKind.none` — the operator is told "there is nothing here", not left to infer it
 * from an omission. The three populations that reach it are shipped and ordinary:
 *
 *   an UNWIRED spine        the operator is mid-authoring; it already stays transparent.
 *   a curve / light / camera `modifierDataSource` says these carry no mesh face at all,
 *                            and the modifiers already pass them through unchanged.
 *   a `gltf` / `baked` handle  the buffers live outside the descriptor, so no count exists.
 *
 * 🔴 THE PLAN SAID TO REFUSE ALL THREE, AND THAT WAS MEASURED AS A PRODUCTION CRASH. This
 * resolver runs at the single `evaluate` call site, ahead of every ArrayModifier and
 * MirrorModifier cook. Both of those roads ship today and are asserted green in this
 * suite — an Array over a curve passes it through, an Array over baked data yields real
 * `ModifiedData` — so refusing here would have thrown on the renderer's own walk. It is
 * the identical failure the plan named when it moved the required parameter OFF
 * `modifierDataSource`: the guard meant to protect the evaluate path firing on the read
 * path. Closing that door at the classifier and leaving it open one level up would have
 * shipped the same crash under a different name.
 *
 * ⚠️ AND THE LOST-SCOPE HAZARD STAYS CLOSED, because the two conditions are separated. An
 * AUTHORED scope over a value that cannot carry one is still a NAMED THROW: the author
 * asked for something the system cannot honour, and quietly applying the operator to the
 * whole mesh is the loudest possible wrong answer wearing the quietest failure. `null`
 * happens only when nothing was asked for.
 */
export function resolveComponentSelection(
  spine: ObjectData | undefined,
  params: Readonly<Record<string, unknown>>,
  domain: ScopeDomain,
): ComponentSelection | null {
  // Read the query FIRST. Every "cannot resolve" branch below needs to know whether an
  // author is being ignored, and a resolver that discovers that halfway down answers
  // differently depending on the order its own checks happen to be written in.
  const authored = authoredScope(params);

  const source = spine === undefined ? null : modifierDataSource(spine);
  if (source === null) {
    const what = spine === undefined ? 'an unwired spine' : `a '${spine.kind}' value`;
    if (authored === null) return null;
    return refuse(
      `${what} has no mesh components, so the authored scope '${authored}' cannot be honoured`,
    );
  }

  const count = componentCountOf(domain, source.geometry.descriptor);
  if (count.kind !== 'counted') {
    if (authored === null) return null;
    // #744 — the verdict's OWN words, quoted rather than restated. The sentence that used to
    // sit here ("its geometry lives outside the descriptor") was this module asserting the
    // reason on the count function's behalf, and it would have gone quietly false the moment
    // a second kind of absence existed. Quoting keeps the reason where it is decided.
    return refuse(
      `descriptor '${source.geometry.descriptor.kind}' has no derivable ${domain} count — ${count.why} — so the authored scope '${authored}' cannot be honoured`,
    );
  }
  const length = count.count;

  // ── #847 — THE ANGLE ARM. A SECOND PRODUCER OF ONE SELECTION, SO IT IS EXCLUSIVE ──────
  //
  // An angle limit and an authored query both produce the selection this function returns,
  // and there must be exactly one producer. The reference makes its limit method an
  // exclusive enum for the same reason, so the conflict is REFUSED rather than resolved by
  // a precedence rule nobody can see: silently ignoring an author is the failure this
  // module already goes out of its way to avoid everywhere else.
  const angleLimit = authoredAngleLimit(params);
  if (angleLimit !== null) {
    if (domain !== 'edge')
      return refuse(
        `an angle limit selects EDGES by the deviation between their two faces, so it cannot produce a '${domain}' selection`,
      );
    if (authored !== null)
      return refuse(
        `both an angle limit and the scope '${authored}' were authored, and a selection has one producer — clear the scope, or set '${LIMIT_METHOD_PARAM}' back to '${SCOPE_PARAM}'`,
      );
    const verdict = edgeIndicesByAngle(source.geometry, angleLimit);
    if (verdict.kind === 'refused') return refuse(verdict.why);
    // 🔴 AN EMPTY RESULT MUST NOT BECOME AN EMPTY QUERY. A blank scope is the authoring
    // state "none written", which `scopeField` turns into an ABSENT field and every
    // generator reads as EVERYTHING — so routing "no edge qualified" through the query
    // path would bevel the whole mesh, which is the exact inverse of what was asked. The
    // state has a name instead.
    if (verdict.edges.length === 0)
      return refuse(
        `no edge deviates by more than ${angleLimit}°, so an angle limit selects nothing here — lower the limit, or the mesh has no edge sharp enough`,
      );
    // Through the same canonicaliser as a typed query, so one spelling of a set exists:
    // the canonical form collapses runs into ranges, which is what keeps a rim loop's key
    // short rather than one index per edge.
    return selectionFromQuery(verdict.edges.join(' '), domain, length);
  }

  // No scope authored at all — the operator applies to everything. This is the ONLY road
  // to "everything" that does not go through a query, which is what keeps a LOST scope
  // distinguishable from an absent one.
  if (authored === null) return totalSelection(domain, length);

  return selectionFromQuery(authored, domain, length);
}

/**
 * The angle limit an author asked for, or `null` when this operator is not angle-limited.
 *
 * Reads the METHOD first and the value second: a stale `angleLimit` left in params by a
 * method switch must not select anything, and asking the method makes that impossible
 * rather than merely unlikely.
 */
function authoredAngleLimit(params: Readonly<Record<string, unknown>>): number | null {
  if (params[LIMIT_METHOD_PARAM] !== 'angle') return null;
  const raw = params[ANGLE_LIMIT_PARAM];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return refuse(
      `'${LIMIT_METHOD_PARAM}' is 'angle' but '${ANGLE_LIMIT_PARAM}' is ${typeof raw}, so no threshold can be applied`,
    );
  }
  return raw;
}

/**
 * The operator's own refusal of an OMITTED selection — rung 3's runtime half, once.
 *
 * The fourth argument to `evaluate` is required on every scoped operator — the three that
 * declare a `source` or `target` scope, censused in `operatorChainDeclaration.gate.test.ts`
 * rather than counted here, because that number has already moved once (step 17 re-declared
 * `MaterialOverrideOp` as `unscoped`). A required parameter closes the omission only in
 * production: `npm run typecheck` excludes
 * test files and vitest strips types without checking them, so both standing gates are
 * blind to the same call site ([[H327]], which has now fired twice in this epic). The
 * refusal has to run.
 *
 * ⚠️ `undefined` AND `null` ARE DIFFERENT FAILURES AND ONLY ONE IS ONE. `undefined` means
 * nobody supplied a selection — the evaluator's hand-off was skipped, or a caller invoked
 * `evaluate` directly — and the operator cannot tell "scope everything" from "scope
 * nothing", so it refuses. `null` is {@link resolveComponentSelection}'s declared answer
 * that this value has no component domain, and it is returned unchanged.
 *
 * ONE implementation for four call sites, deliberately: this phase exists because being an
 * operator was spelled per member, and a refusal copy-pasted four times is the same defect
 * in the commit that closes it.
 */
export function requireResolvedScope(
  scope: ComponentSelection | null | undefined,
  operator: string,
): ComponentSelection | null {
  if (scope === undefined) {
    return refuse(
      `${operator}.evaluate was called with no resolved selection. The evaluator supplies one ` +
        `for every node whose chain declares a 'source' or 'target' scope; reaching this means ` +
        // ⚠️ Do not write the phrase «X from Y» in quotes here: `importsOf` reads a
        // quoted word after `from` as an import specifier, and this string would show up
        // in the repo-wide import census as a module nobody can resolve (#676).
        `the hand-off was skipped, and an operator cannot tell a total selection apart ` +
        `from an empty one.`,
    );
  }
  return scope;
}
