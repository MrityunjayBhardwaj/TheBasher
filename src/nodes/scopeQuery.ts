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
// `@v>0` (`ref/houdini/SOP.md:51`). v1 shipped the subset that needs NO new storage — ranges,
// step, negation, removal — because a wildcard or a name is a reader over STORED groups.
//
// 🔑 #1027 GAVE GROUPS A WRITER, AND NAMES JOINED THE GRAMMAR WITH IT. `ComponentGroupOp`
// authors a face-domain membership attribute, so a name is now a reader over something that
// exists. What that costs this module is stated rather than hidden: a range is a function of
// the INDEX and a name is a function of the GEOMETRY, so evaluating one needs a {@link
// GroupLookup} the CALLER supplies — see that type on why it is handed in rather than imported,
// and why that is what keeps the one-parser rule true.
//
// Wildcards and attribute expressions stay deferred. A wildcard is now genuinely buildable
// (there are names to match) and is simply not built; an attribute expression still needs a
// general attribute reader.
//
// The deferred constructs are REFUSED BY NAME rather than ignored, and so is a name no group
// answers to. An unrecognised query that silently means "everything" applies the operation to
// the whole mesh, which is the loudest possible wrong answer wearing the quietest possible
// failure — and silently meaning NOTHING is the same hazard with the sign flipped, because a
// mask would delete the mesh.
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

/**
 * What a term names: a span of indices, or a GROUP by name (#1027).
 *
 * 🔴 THE TWO ARE DIFFERENT IN ONE WAY THAT MATTERS EVERYWHERE BELOW. A range is a function of
 * the INDEX alone, so it can be evaluated, canonicalised and reasoned about at any length with
 * nothing else in hand. A group is a function of the GEOMETRY, so it cannot be evaluated at all
 * without the membership — which is why {@link scopeSelection} takes a lookup and why
 * {@link selectsNothingAtEveryLength} abstains the moment it sees one.
 */
type ScopeAtom =
  | { readonly kind: 'range'; readonly start: number; readonly end: number; readonly step: number }
  | { readonly kind: 'group'; readonly name: string };

interface ScopeTerm {
  readonly op: ScopeOp;
  readonly atom: ScopeAtom;
}

const ATOM = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/;

/**
 * The names this grammar reads as a GROUP rather than as a range.
 *
 * ⚠️ IT IS DELIBERATELY THE SAME PATTERN `componentGroups.isValidGroupName` ENFORCES, AND
 * THE DUPLICATION IS THE POINT. This module is a LEAF with zero value imports — that is what
 * keeps the one-parser rule true, since a module an operator could import a resolver from
 * would defeat it — so it cannot import the writer's charset, and the writer cannot import
 * this one. Two spellings of one rule is exactly the drift this repo catalogues, so it is not
 * left to agree by good intentions: `componentGroups.gate.test.ts` row 7 asserts the two
 * agree, per name, by asking THIS grammar what it does with each one.
 */
const GROUP_TERM = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    // A NAME (#1027). Parsing it is a statement about SHAPE only: whether a group of this
    // name exists is a question about a geometry, which this module never holds and a param
    // schema cannot see. It is answered at resolution, by name, in {@link scopeSelection}.
    if (GROUP_TERM.test(body)) {
      return { op, atom: { kind: 'group', name: body } };
    }
    // Starts like a name and is not one — `arm-left`, `arm.2`. Refused with the NAME's
    // charset rather than the range's, because that is what the author was reaching for; the
    // generic "not an index or range" below would send them to fix the wrong thing.
    if (/^[A-Za-z_]/.test(body)) {
      return refuse(
        `'${token}' is not a group name — a name starts with a letter or underscore and uses only letters, digits and underscores`,
      );
    }

    const m = ATOM.exec(body);
    if (!m) return refuse(`'${token}' is not a component index, range or group name`);

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

    return { op, atom: { kind: 'range', start, end, step } };
  });
}

/**
 * Is `i` named by this term's atom?
 *
 * A group's membership is handed in already resolved, because this module cannot reach a
 * geometry and must not learn how: the whole reason it is a leaf is that a module able to
 * turn a name into a set is a module an operator could import to interpret a query.
 */
function inAtom(atom: ScopeAtom, i: number, membership: ArrayLike<number> | null): boolean {
  if (atom.kind === 'group')
    return membership !== null && i < membership.length && membership[i] === 1;
  return i >= atom.start && i <= atom.end && (i - atom.start) % atom.step === 0;
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

  const ranges = run.filter(
    (t): t is ScopeTerm & { atom: Extract<ScopeAtom, { kind: 'range' }> } =>
      t.atom.kind === 'range',
  );
  // 🔴 A GROUP NEVER MERGES WITH ANYTHING, AND NOT ONLY BECAUSE IT IS A DIFFERENT SHAPE
  // (#1027). Coalescing is valid above precisely because a range's membership is derivable
  // from the query — two touching ranges ARE their union at every length. A group's is not
  // derivable here at all, so `arm leg` cannot be shown to equal any third term, and even
  // `arm arm` is only removable because a name resolves to one answer per geometry. Sorted
  // and de-duplicated by name; nothing else.
  const groups = run
    .filter(
      (t): t is ScopeTerm & { atom: Extract<ScopeAtom, { kind: 'group' }> } =>
        t.atom.kind === 'group',
    )
    .sort((a, b) => (a.atom.name < b.atom.name ? -1 : a.atom.name > b.atom.name ? 1 : 0));

  // Even within a coalescible run, only CONTIGUOUS ranges merge: a stepped range cannot
  // absorb or be absorbed without changing which elements it names, so stepped terms are
  // sorted and de-duplicated and otherwise left exactly as written.
  const contiguous = ranges
    .filter((t) => t.atom.step === 1)
    .sort((a, b) => a.atom.start - b.atom.start || a.atom.end - b.atom.end);
  const stepped = ranges
    .filter((t) => t.atom.step !== 1)
    .sort(
      (a, b) => a.atom.start - b.atom.start || a.atom.end - b.atom.end || a.atom.step - b.atom.step,
    );

  const merged: (ScopeTerm & { atom: Extract<ScopeAtom, { kind: 'range' }> })[] = [];
  for (const term of contiguous) {
    const last = merged[merged.length - 1];
    // `start <= last.end + 1` merges ADJACENT ranges too: `0-2 3-5` is `0-5`.
    const mergeable = coalescible && last !== undefined && term.atom.start <= last.atom.end + 1;
    if (mergeable) {
      if (term.atom.end > last.atom.end) {
        merged[merged.length - 1] = { ...last, atom: { ...last.atom, end: term.atom.end } };
      }
    } else if (last && last.atom.start === term.atom.start && last.atom.end === term.atom.end) {
      // A duplicate is removable for every operator — `!0-5 !0-5` is `!0-5`.
      continue;
    } else {
      merged.push(term);
    }
  }

  const dedupedSteps: ScopeTerm[] = [];
  for (const term of stepped) {
    const last = dedupedSteps[dedupedSteps.length - 1];
    if (
      last &&
      last.atom.kind === 'range' &&
      last.atom.start === term.atom.start &&
      last.atom.end === term.atom.end &&
      last.atom.step === term.atom.step
    ) {
      continue;
    }
    dedupedSteps.push(term);
  }

  const dedupedGroups: ScopeTerm[] = [];
  for (const term of groups) {
    const last = dedupedGroups[dedupedGroups.length - 1];
    if (last && last.atom.kind === 'group' && last.atom.name === term.atom.name) continue;
    dedupedGroups.push(term);
  }

  // Groups come LAST within a run, which is a spelling choice and safe for the reason the run
  // exists: everything in one run shares an operator, and union and difference are each
  // commutative with themselves. Across runs the order is preserved, because they are not.
  return [...merged, ...dedupedSteps, ...dedupedGroups];
}

function formatTerms(terms: readonly ScopeTerm[]): string {
  return terms
    .map((t) => {
      const prefix = t.op === 'remove' ? '^' : t.op === 'complement' ? '!' : '';
      if (t.atom.kind === 'group') return `${prefix}${t.atom.name}`;
      const { start, end, step } = t.atom;
      if (step !== 1) return `${prefix}${start}-${end}:${step}`;
      if (start === end) return `${prefix}${start}`;
      return `${prefix}${start}-${end}`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// The ONE evaluation of a query at a length
// ---------------------------------------------------------------------------

/**
 * How a caller answers "which elements does the group `name` hold?" — `null` for a name this
 * geometry does not carry (#1027).
 *
 * 🔴 IT IS A FUNCTION HANDED IN, NOT A MODULE THIS ONE IMPORTS, and that is the whole shape of
 * the feature. Turning a name into a set requires the geometry's attribute set; importing the
 * store here would make this module able to resolve a query from nothing but a string, and an
 * operator could then import it and interpret its own scope — which is the exact defect the
 * one-parser rule exists to prevent. Handed in as DATA, the leaf stays a leaf: the knowledge
 * of where a group lives stays with the callers that already hold a geometry.
 */
export type GroupLookup = (name: string) => ArrayLike<number> | null;

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
export function scopeSelection(query: string, length: number, groups?: GroupLookup): ScopeMask {
  if (!Number.isInteger(length) || length < 0) {
    return refuse(`a selection length must be a non-negative integer, got ${String(length)}`);
  }
  const terms = parseScopeQuery(query);
  const mask = new Uint8Array(length);
  for (const term of terms) {
    const atom = term.atom;
    // 🔴 RESOLVED ONCE PER TERM, NEVER PER INDEX. A lookup reads the attribute store, and
    // calling it inside the walk would turn an O(length) pass into O(length) store reads for
    // a value that cannot change during the pass.
    const membership = atom.kind === 'group' ? resolveGroup(atom.name, groups) : null;

    if (term.op === 'complement') {
      for (let i = 0; i < length; i += 1) if (!inAtom(atom, i, membership)) mask[i] = 1;
      continue;
    }
    const value = term.op === 'add' ? 1 : 0;
    // A group's membership gives no bounds to narrow the walk with, so it walks the whole
    // length. A range still narrows, which is the common case and the hot one.
    const from = atom.kind === 'range' ? Math.max(0, atom.start) : 0;
    const to = atom.kind === 'range' ? Math.min(length - 1, atom.end) : length - 1;
    for (let i = from; i <= to; i += 1) if (inAtom(atom, i, membership)) mask[i] = value;
  }

  let count = 0;
  for (let i = 0; i < length; i += 1) if (mask[i] === 1) count += 1;
  return { mask, count };
}

/**
 * A group's membership, or a NAMED refusal — never a silent empty set (#1027).
 *
 * ⚠️ THE TWO FAILURES ARE DIFFERENT FACTS AND GET DIFFERENT SENTENCES, because they are fixed
 * in different places. No lookup at all means the CALLER has not been given the geometry — a
 * bug in the wiring, and the author of the query can do nothing about it. A lookup that misses
 * means the query names a group this mesh does not carry, which is the author's to fix.
 *
 * 🔴 NEITHER MAY RESOLVE TO "EVERYTHING" OR TO "NOTHING". An unrecognised group silently
 * meaning the whole mesh is this module's founding failure — the loudest possible wrong answer
 * wearing the quietest possible failure — and silently meaning nothing is the same hazard with
 * the sign flipped, because a mask modifier would delete the mesh.
 */
function resolveGroup(name: string, groups: GroupLookup | undefined): ArrayLike<number> {
  if (groups === undefined) {
    return refuse(
      `'${name}' names a group, and this reader was given no way to resolve one. A group is a property of a geometry, so whoever evaluates a query naming one has to supply the lookup`,
    );
  }
  const membership = groups(name);
  if (membership === null) {
    return refuse(`no group named '${name}' on this geometry`);
  }
  return membership;
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
 * Does this query name a GROUP? A BOOLEAN, and nothing else (#1027).
 *
 * ── WHY A CALLER NEEDS THIS, AND WHY IT IS NOT A HOLE IN THE ONE-PARSER RULE ──────────
 *
 * A range query's answer is a function of the query and the length, so a cache keyed on those
 * two is complete. A query naming a group is a function of the GEOMETRY as well: two meshes
 * with the same face count and the same query string `arm` can hold different memberships, and
 * a cache that did not know the difference would hand the second mesh the first one's layout.
 * That is the over-coalescing hazard {@link canonicalScopeQuery} is written against, arriving
 * one level down in a cache key instead of in a geometry key.
 *
 * So a caller that caches needs ONE BIT — "does this answer depend on more than the string?" —
 * and the alternative was to widen every such key with the source's attribute key
 * unconditionally, which would split cache entries for every numeric query in the product to
 * fix a case none of them has. This keeps those keys byte-identical and widens only the ones
 * that genuinely vary.
 *
 * ⚠️ IT RETURNS A BOOLEAN AND CAN NEVER RETURN TERMS, exactly as {@link isParsableScopeQuery}
 * does and for the same reason: "is a name involved?" cannot be used to act on a scope, only to
 * decide what a key must contain. An unparseable query answers `false` — it is refused at the
 * authoring door and has no terms to inspect.
 */
export function scopeNamesAGroup(query: string): boolean {
  try {
    return parseScopeQuery(query).some((t) => t.atom.kind === 'group');
  } catch {
    return false;
  }
}

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
  // #1027 — A GROUP MAKES THIS UNANSWERABLE HERE, AND ABSTAINING IS THE CORRECT ANSWER. This
  // predicate exists for an authoring surface with no geometry in hand, so it cannot know what
  // a name holds; a group could be empty on one mesh and not on the next. `false` is "cannot
  // prove", which is the direction the doc above already commits to — the caller ADVISES, and
  // a missed advisory costs less than a wrong one.
  if (terms.some((t) => t.atom.kind === 'group')) return false;
  const maxEnd = terms.reduce((m, t) => Math.max(m, t.atom.kind === 'range' ? t.atom.end : 0), 0);
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
export function scopeSelectedCount(query: string, length: number, groups?: GroupLookup): number {
  return scopeSelection(query, length, groups).count;
}
