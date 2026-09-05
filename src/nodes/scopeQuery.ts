// scopeQuery — the component-scope QUERY LANGUAGE, and nothing else. ns-2 (#607, #660).
//
// ── WHY THIS IS ITS OWN MODULE, AND WHY IT IS A LEAF ──────────────────────────────────
//
// Step 9 put the parser inside `componentSelection.ts`, which was right while the only
// consumer was the resolver. Step 12.5 gives a generator's descriptor a `scope` field, and
// that creates two MORE consumers that are not the resolver and must not reach it:
//
//   `src/app/faceCount.ts`        a scoped array derives `source + subset x (count - 1)`,
//                                 so the COUNT needs to know how many elements a query
//                                 selects out of N.
//   `src/app/geometryRegistry.ts` the BUILD needs to know WHICH ones.
//
// `componentSelection.ts` imports `faceCount.ts` (a face count is the only derivable
// element count), so `faceCount.ts` cannot import it back — measured, that is a genuine
// cycle and not a shape preference. The language therefore moves DOWN, below all three, to
// a module with ZERO value imports. Same rule as `faceCount.ts`'s own move at ns-1b step 1:
// when two modules that must not depend on each other need one fact, the fact goes in a
// leaf.
//
// 🔴 THE ONE-PARSER RULE IS UNCHANGED, AND THIS IS WHERE TO CHECK THAT CLAIM.
// {@link parseScopeQuery} is NOT exported. Everything this module hands out is an ANSWER —
// a canonical string, a boolean, or a resolved mask with its count — never terms. An
// operator still cannot interpret a query, because there is nothing to import that would
// let it: `componentSelection` re-exports none of this, and an operator receives a
// `ComponentSelection` that was resolved for it. What moved is where the language lives,
// not how many readers of a QUERY exist.
//
// ── WHAT v1 PARSES, AND WHAT IT REFUSES BY NAME ───────────────────────────────────────
//
// The reference's Group field is a query language: numeric ranges `0-10`, step `0-100:2`,
// wildcards `arm*`, negation `!1-10`, set removal `^pattern`, and attribute expressions
// `@v>0` (`ref/houdini/SOP.md:51`). v1 ships the subset that needs NO new storage —
// ranges, step, negation, removal — because a wildcard or a name is a reader over STORED
// groups, and nothing in this project stores one yet.
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
// Indices outside `[0, length)` are DROPPED rather than refused — a range half in bounds
// contributes its in-bounds half, and one wholly out of bounds resolves to nothing. An
// INVERTED range (`5-2`) is refused instead, because it cannot be an authoring intent and
// silently meaning nothing is the same lost-scope hazard.
//
// REF: src/nodes/componentSelection.ts (the resolved selection, and the ONE resolver);
//      src/app/faceCount.ts (the scoped count); src/app/geometryRegistry.ts (the scoped
//      build); ref/houdini/SOP.md §4; issues #607, #660.

/** Every refusal from this module is named and carries the query that produced it. */
function refuse(why: string): never {
  throw new Error(`scopeQuery: ${why}`);
}

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
 * cannot see, and they remain named throws from `resolveComponentSelection`.
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
 * IDEMPOTENT, and that is load-bearing rather than tidy: `rebuildGeometryRef` feeds a
 * descriptor's already-canonical scope back through the key builder on every animated
 * write, so a second pass that moved the string would repoint a handle at a different
 * cached geometry each time it ran.
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
// The ONE evaluation of a query at a length
// ---------------------------------------------------------------------------

/** Which elements of `[0, length)` a query selects, and how many. */
export interface ScopeMask {
  /** `1` at every selected index. Length is exactly `length`. */
  readonly mask: Uint8Array;
  /** How many entries are `1` — counted once, at mint, so callers need not walk it. */
  readonly count: number;
}

/**
 * Evaluate a query against an element count — the ONE place a query becomes a set.
 *
 * Both consumers go through this: {@link scopeSelectedCount} for a derived face count, and
 * the registry's scoped build for which triangles survive. Deliberately ONE implementation
 * and not a fast count beside a mask builder, because a second spelling of a set operation
 * that agrees today is [[V155]]'s hazard applied to the one arithmetic this step exists to
 * get right.
 *
 * ⚠️ THE BUFFER LEAVES THIS FUNCTION, and that is a different guarantee from the one
 * `ComponentSelection` makes. A resolved selection is accessor-only because it is MEMOIZED
 * and shared between operators, so a mutating reader would corrupt someone else's scope.
 * This allocates a FRESH mask per call and hands it over; the caller owns it. Nothing here
 * is shared, so there is nothing for a mutation to corrupt.
 *
 * Cost, stated: `O(length x terms)` and one `Uint8Array(length)` per call, on populations of
 * 12-960 faces. Transient, so it enters neither the geometry registry's resident bytes nor
 * the attribute store's growth ([[V163]]).
 */
export function scopeSelection(query: string, length: number): ScopeMask {
  if (!Number.isInteger(length) || length < 0) {
    return refuse(`a selection length must be a non-negative integer, got ${String(length)}`);
  }
  const terms = parseScopeQuery(query);
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
  return { mask, count };
}

/**
 * The largest length this module will probe when deciding {@link selectsNothingAtEveryLength}.
 *
 * Populations here are 12-960 elements. The cap exists so a pathological literal like
 * `^0-999999999` cannot turn a cheap authoring check into a long loop; past it the answer is
 * "cannot prove", never "empty". Proving-or-abstaining is the safe direction: the caller
 * uses this to ADVISE, and a missed advisory is a smaller cost than a wrong one.
 */
const EMPTINESS_PROBE_CAP = 65536;

/**
 * Does this query select NOTHING, at every possible element count? (#917)
 *
 * ⚠️ THIS IS NOT A REFUSAL, AND MUST NOT BECOME ONE. `'^0'` is the project's canonical
 * spelling for the empty set ({@link EMPTY_SELECTION_QUERY}, #862) — a derived selection can
 * legitimately name nothing, and an angle limit above every angle a mesh has produces exactly
 * that by scrubbing. So the empty selection is a value the system MINTS, not a mistake to
 * refuse at the door. This predicate exists so an authoring surface can SAY SO, which is the
 * gap: the state is representable on purpose and was reachable in silence.
 *
 * ── WHY EACH ARM ANSWERS THE WAY IT DOES ─────────────────────────────────────────────
 *
 * A blank query is `false`, and that is the arm most worth reading twice. Blank parses to
 * ZERO terms, so `scopeSelection('', n)` counts 0 at every length and a naive reading would
 * call it universally empty — but blank is the authoring state "none written", which every
 * generator reads as EVERYTHING. Reporting it as "selects nothing" would advise the exact
 * inversion this module exists to prevent, on by far the most common value.
 *
 * A query carrying a COMPLEMENT term is `false` without evaluation. For any index past every
 * term's end, `inTerm` is false and the complement arm sets it — so such a query is non-empty
 * at a large enough length, whatever it does at a small one. `'!0-11'` selects nothing at 12
 * and all 12 of the next 12 at 24; that is the LENGTH-DEPENDENT case, which needs the element
 * count and is not this question.
 *
 * Otherwise the mask is evaluated once at a length that exceeds every term's reach. That is
 * sufficient because a mask entry is a function of its INDEX and the terms alone — `length`
 * only truncates the walk — so an index that is unset at the probe length is unset at every
 * length that contains it.
 *
 * 🔑 It delegates to {@link scopeSelection} rather than re-walking the terms. A second
 * spelling of this set arithmetic that agrees today is exactly the hazard the one-implementation
 * rule above exists to prevent, and an advisory that disagrees with the build it describes
 * would be worse than no advisory.
 */
export function selectsNothingAtEveryLength(query: string): boolean {
  let terms: ScopeTerm[];
  try {
    terms = parseScopeQuery(query);
  } catch {
    // Unparsable — a different failure, already refused at the authoring door. Not empty.
    return false;
  }
  if (terms.length === 0) return false;
  if (terms.some((t) => t.op === 'complement')) return false;
  const maxEnd = terms.reduce((m, t) => Math.max(m, t.end), 0);
  if (maxEnd + 1 > EMPTINESS_PROBE_CAP) return false;
  return scopeSelection(query, maxEnd + 1).count === 0;
}

/**
 * How many of `length` elements a query selects.
 *
 * The count half of {@link scopeSelection}, named separately because that is the whole of
 * what a derived face count needs and reading `.count` off a mask at each call site would
 * put the same expression in two files.
 */
export function scopeSelectedCount(query: string, length: number): number {
  return scopeSelection(query, length).count;
}
