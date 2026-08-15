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
// REF: src/app/faceCount.ts (the only derivable element count); src/nodes/attributes.ts
//      (`KnownDomain`); src/app/modifierDataSource.ts (which values carry components);
//      ref/houdini/SOP.md §4; issues #607, #660.

import type { KnownDomain } from './attributes';
import type { GeometryDescriptor, ObjectData } from './types';
import { faceCountOf } from '../app/faceCount';
import { modifierDataSource } from '../app/modifierDataSource';

/**
 * A resolved component selection at one domain. NEVER a query, NEVER a name, NEVER a
 * buffer.
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
 * The domain ns-2 resolves selections at.
 *
 * `face` ONLY, and the reason is arithmetic rather than taste: a face count is derivable
 * from a descriptor and the other three are not. `point` needs a new count derivation and
 * has 24 seam-split points on a box; `edge` has no buffer at all. Widening is one edit
 * here plus an arm in {@link componentCountOf}.
 */
const SCOPE_DOMAIN: KnownDomain = 'face';

/** Every refusal from this module is named and carries the query that produced it. */
function refuse(why: string): never {
  throw new Error(`componentSelection: ${why}`);
}

/**
 * How many elements a domain has for a given descriptor, `null` when that descriptor cannot
 * say, or a named refusal when the DOMAIN is not one ns-2 resolves at.
 *
 * Closed by a `never` over {@link KnownDomain}, so a fifth domain is a compile error at the
 * site that must answer for it.
 *
 * ⚠️ `null` AND A REFUSAL ARE DIFFERENT ANSWERS TO DIFFERENT QUESTIONS, and collapsing them
 * is what step 9b measured as a production crash. A refusal says *this domain has no
 * derivation at all in ns-2* — a fact about the code, true for every descriptor, and an
 * author cannot reach it. `null` says *this domain is derivable in principle and THIS
 * descriptor cannot say how many* — the `gltf` and `baked` arms, whose buffers live outside
 * the descriptor, and which are ordinary shipped values sitting on a modifier's spine right
 * now. See {@link resolveComponentSelection} for what the difference buys.
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
): number | null {
  switch (domain) {
    case 'face':
      // The gltf / baked arms answer `null`: their buffers live outside the descriptor, so
      // nothing here can say how many faces they hold. A ZERO would read as "scope nothing"
      // on a mesh the author can see, with faces they can count — which is why the absence
      // is carried as its own value rather than as a number.
      return faceCountOf(descriptor);
    case 'point':
    case 'edge':
    case 'corner':
      return refuse(
        `domain '${domain}' is not resolvable from a descriptor — ns-2 ships 'face' only`,
      );
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
// The ONE parser
// ---------------------------------------------------------------------------

type ScopeOp = 'add' | 'remove' | 'complement';

interface ScopeTerm {
  readonly op: ScopeOp;
  readonly start: number;
  readonly end: number;
  readonly step: number;
}

const ATOM = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/;

/**
 * A scope query as terms, or a named refusal. NOT EXPORTED — see the module header.
 *
 * Separators are whitespace or commas. The reference writes them space-separated; a comma
 * is admitted because it is the shape a human types for a list, and it costs nothing to
 * accept because canonicalisation erases the difference — a separator carries no meaning.
 */
function parseScopeQuery(query: string): ScopeTerm[] {
  const tokens = query
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  return tokens.map((token) => {
    let op: ScopeOp = 'add';
    let body = token;
    if (body.startsWith('!')) {
      op = 'complement';
      body = body.slice(1);
    } else if (body.startsWith('^')) {
      op = 'remove';
      body = body.slice(1);
    }

    // The deferred constructs, each refused by its own name rather than by a generic
    // "cannot parse". A reader who mistyped a range and a reader who reached for attribute
    // expressions need different sentences.
    if (body.startsWith('@')) {
      return refuse(
        `attribute expressions are not implemented ('${token}'). They are the one construct that survives a topology change without an id, and they are deferred deliberately, not overlooked`,
      );
    }
    if (body.includes('*')) {
      return refuse(
        `wildcards are not implemented ('${token}') — they match STORED group names, and no group can be named yet`,
      );
    }
    if (/^[A-Za-z_]/.test(body)) {
      return refuse(
        `named groups are not implemented ('${token}') — v1's query is a range expression over component indices`,
      );
    }

    const m = ATOM.exec(body);
    if (!m) return refuse(`'${token}' is not a component index or range`);

    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    const step = m[3] === undefined ? 1 : Number(m[3]);

    if (end < start) {
      // Refused rather than normalised or clamped. Clamping an inverted range to nothing is
      // exactly the silent lost scope this module refuses everywhere else, and swapping the
      // ends guesses at an intent the author did not express.
      return refuse(
        `'${token}' is an inverted range — its end (${end}) is below its start (${start})`,
      );
    }
    if (step < 1) return refuse(`'${token}' has a step of ${step}; a step must be at least 1`);

    return { op, start, end, step };
  });
}

/** Is `i` inside this term's range, honouring its step? */
function inTerm(term: ScopeTerm, i: number): boolean {
  return i >= term.start && i <= term.end && (i - term.start) % term.step === 0;
}

/**
 * Can this string be parsed as a scope query? A BOOLEAN, and nothing else (ns-2 step 12).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A HOLE IN THE ONE-PARSER RULE ──────────────────
 *
 * Step 12 declares the first `scope` param, which makes an authored query reachable for the
 * first time. Every refusal in this module is a THROW, and the throw would land on the
 * renderer's own walk: `resolveEvaluatedMesh` calls `evaluate` with no `try` above it and
 * `SceneFromDAG` calls that during render — measured, not assumed. A director who mistypes
 * a range would take the viewport down, and this project has NO node-error surfacing at all
 * (censused at zero), so the crash would be the entire feedback.
 *
 * So the query is validated where it is AUTHORED instead of where it is read. A node's
 * `paramSchema` refines the field with this predicate, `setParam` silently rejects a value
 * its schema does not accept, and an unparseable query therefore never reaches params, never
 * reaches the resolver, and cannot throw. That is the ladder's third rung: the bad state is
 * not guarded against, it has no constructor.
 *
 * ⚠️ THIS RETURNS A BOOLEAN AND CAN NEVER RETURN TERMS, which is the whole reason it is safe
 * to export while {@link parseScopeQuery} stays private. The rule this module exists to make
 * true is that no operator INTERPRETS a query — an operator that could ask "which faces does
 * this name?" would be a second reading of the query language, and that is the defect the
 * phase is deleting. "Is this well-formed?" is a different question with a one-bit answer:
 * it cannot be used to act on a scope, only to refuse one at the door.
 *
 * It is deliberately NOT total in the other direction either: a query that parses can still
 * be unhonourable against a particular value (an authored scope on a curve, or on a `gltf`
 * handle whose face count is not derivable). Those depend on the SPINE, which a param schema
 * cannot see, and they remain named throws from {@link resolveComponentSelection}.
 */
export function isParsableScopeQuery(query: string): boolean {
  try {
    parseScopeQuery(query);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The ONE canonicaliser
// ---------------------------------------------------------------------------

/**
 * The canonical spelling of a scope query — the string a scoped build folds into its
 * geometry key, so two authors who wrote the same scope differently share one cached
 * geometry.
 *
 * It is a pure function of the QUERY and knows nothing about element counts, deliberately:
 * folding a resolved mask would be canonical by construction and O(elements) on the
 * per-frame drag road, while this is O(query).
 *
 * ⚠️ THE DIRECTION THIS GUARANTEES, AND THE ONE IT DOES NOT.
 *
 *   SOUND      — two queries with the same canonical form resolve identically at EVERY
 *                length. This is the load-bearing half: over-coalescing would merge two
 *                different scopes onto one cached geometry, which is a wrong mesh on
 *                screen, not a wasted byte.
 *   NOT TOTAL  — two queries that resolve identically may canonicalise apart, and that is
 *                accepted. `0-5` and `!6-11` select the same six faces of a twelve-face
 *                box and cannot be recognised as equal without knowing the box has twelve
 *                faces. They mint two cached geometries: a benign duplicate, bounded by
 *                the number of distinct canonical queries.
 *
 * Terms are reordered only WITHIN a run of the same operator, because the operators
 * accumulate left to right and are not commutative across each other: `0-5 ^2` and
 * `^2 0-5` mean different things. Within one run they are — union and difference are each
 * commutative with themselves — which is what makes `5,4,3,2,1,0` and `0-5` one entry.
 */
export function canonicalScopeQuery(query: string): string {
  return formatTerms(canonicaliseTerms(parseScopeQuery(query)));
}

function canonicaliseTerms(terms: readonly ScopeTerm[]): ScopeTerm[] {
  const out: ScopeTerm[] = [];
  let i = 0;
  while (i < terms.length) {
    const op = terms[i].op;
    let j = i;
    while (j < terms.length && terms[j].op === op) j += 1;
    out.push(...canonicaliseRun(terms.slice(i, j)));
    i = j;
  }
  return out;
}

/**
 * Sort, de-duplicate and (where it is meaning-preserving) coalesce one maximal run of
 * same-operator terms.
 *
 * 🔴 COALESCING IS NOT VALID FOR EVERY OPERATOR, AND ASSUMING IT WAS SHIPPED A BUG (#677).
 * Each term in an `add` run contributes its range and each term in a `remove` run takes
 * one away, so both runs are a UNION of ranges and merging two that touch is exactly the
 * same set. A `complement` term contributes the complement of its range, and the union of
 * two complements is NOT the complement of the union:
 *
 *     `!0-2 !3-5`  over 12 faces  =  {3..11} ∪ {0,1,2,6..11}  =  all twelve
 *     `!0-5`       over 12 faces  =  {6..11}                  =  six
 *
 * Merging them made two queries selecting twelve and six faces share one canonical form,
 * which is one cached geometry for two different scopes — the wrong mesh on screen, and
 * the precise failure this canonicaliser exists to prevent. Sorting and de-duplication
 * stay valid for all three, because union is commutative whatever is being unioned.
 */
function canonicaliseRun(run: readonly ScopeTerm[]): ScopeTerm[] {
  const coalescible = run[0].op !== 'complement';

  // Even within a coalescible run, only CONTIGUOUS ranges merge: a stepped range cannot
  // absorb or be absorbed without changing which elements it names, so stepped terms are
  // sorted and de-duplicated and otherwise left exactly as written.
  const contiguous = run
    .filter((t) => t.step === 1)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const stepped = run
    .filter((t) => t.step !== 1)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.step - b.step);

  const merged: ScopeTerm[] = [];
  for (const term of contiguous) {
    const last = merged[merged.length - 1];
    // `start <= last.end + 1` merges ADJACENT ranges too: `0-2 3-5` is `0-5`.
    const mergeable = coalescible && last !== undefined && term.start <= last.end + 1;
    if (mergeable) {
      if (term.end > last.end) merged[merged.length - 1] = { ...last, end: term.end };
    } else if (last && last.start === term.start && last.end === term.end) {
      // A duplicate is removable for every operator — `!0-5 !0-5` is `!0-5`.
      continue;
    } else {
      merged.push(term);
    }
  }

  const dedupedSteps: ScopeTerm[] = [];
  for (const term of stepped) {
    const last = dedupedSteps[dedupedSteps.length - 1];
    if (last && last.start === term.start && last.end === term.end && last.step === term.step) {
      continue;
    }
    dedupedSteps.push(term);
  }

  return [...merged, ...dedupedSteps];
}

function formatTerms(terms: readonly ScopeTerm[]): string {
  return terms
    .map((t) => {
      const prefix = t.op === 'remove' ? '^' : t.op === 'complement' ? '!' : '';
      if (t.step !== 1) return `${prefix}${t.start}-${t.end}:${t.step}`;
      if (t.start === t.end) return `${prefix}${t.start}`;
      return `${prefix}${t.start}-${t.end}`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// The ONE resolver
// ---------------------------------------------------------------------------

/** Build a scoped selection from already-parsed terms. */
function selectionFromTerms(
  terms: readonly ScopeTerm[],
  domain: KnownDomain,
  length: number,
): ComponentSelection {
  const mask = new Uint8Array(length);
  for (const term of terms) {
    if (term.op === 'complement') {
      for (let i = 0; i < length; i += 1) if (!inTerm(term, i)) mask[i] = 1;
      continue;
    }
    const value = term.op === 'add' ? 1 : 0;
    const from = Math.max(0, term.start);
    const to = Math.min(length - 1, term.end);
    for (let i = from; i <= to; i += 1) if (inTerm(term, i)) mask[i] = value;
  }

  let count = 0;
  for (let i = 0; i < length; i += 1) if (mask[i] === 1) count += 1;

  // The mask is captured by the closure and is not a property of the returned object, so
  // no reader can reach it. That is what makes the memoized total safe to share, and it is
  // the same guarantee here for consistency rather than for necessity.
  return {
    domain,
    length,
    count,
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

  const length = componentCountOf(SCOPE_DOMAIN, source.geometry.descriptor);
  if (length === null) {
    if (authored === null) return null;
    return refuse(
      `descriptor '${source.geometry.descriptor.kind}' has no derivable face count (its geometry lives outside the descriptor), so the authored scope '${authored}' cannot be honoured`,
    );
  }

  // No scope authored at all — the operator applies to everything. This is the ONLY road
  // to "everything" that does not go through a query, which is what keeps a LOST scope
  // distinguishable from an absent one.
  if (authored === null) return totalSelection(SCOPE_DOMAIN, length);

  return selectionFromTerms(parseScopeQuery(authored), SCOPE_DOMAIN, length);
}

/**
 * The operator's own refusal of an OMITTED selection — rung 3's runtime half, once.
 *
 * The fourth argument to `evaluate` is required on the four scoped operators, and a
 * required parameter closes the omission only in production: `npm run typecheck` excludes
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
