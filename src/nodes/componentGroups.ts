// componentGroups — the ONE place that knows a group's name is an attribute name. #1027 (#607).
//
// ── WHY A MODULE, AND WHY IT IS A LEAF ────────────────────────────────────────────────
//
// A named group is a face-domain attribute whose membership is 1 or 0 per face. That single
// sentence has two readers who must not import each other: the WRITER (`ComponentGroupOp`,
// which mints the attribute) and, at gate 3, the RESOLVER (which turns a name in a query back
// into a mask). `scopeQuery.ts` is a leaf with zero value imports precisely so that no
// operator can interpret a query; if the prefix lived there it would stop being one, and if
// it lived in the writer the resolver would import a node. So the fact goes DOWN, into a
// module with no value imports at all — the same rule `faceCount.ts` and `scopeQuery.ts`
// were each moved by.
//
// ── WHY GROUP NAMES ARE PREFIXED RATHER THAN STORED AT THE TOP OF THE SET ─────────────
//
// An `AttributeSet` is `Record<string, AttributeData>`, and three names already mean
// something: `material_index`, `UVMap`, `UVProject`. A director who names a group
// `material_index` would, with a bare key, silently overwrite the face-material assignment —
// a wrong mesh on screen produced by a legal-looking rename, with nothing to catch it because
// both the before and after are well-formed sets.
//
// Prefixing makes that state unconstructible rather than guarded: `group:material_index` and
// `material_index` are different keys, and no group can ever land on a well-known name
// however it is spelled. It buys the second thing gate 3 needs for free — "which of these
// attributes are groups?" becomes decidable by inspection instead of by a list somebody has
// to remember to update.
//
// 🔴 THE PREFIX IS INTERNAL AND MUST STAY THAT WAY. A query names a group BARE (`arm`), the
// inspector shows `arm`, and the agent says `arm`. The prefix exists between this module and
// the attribute set and nowhere else. A user who types `group:arm` is naming a group called
// `group:arm`, which {@link isValidGroupName} refuses — see the charset note below.
//
// REF: src/nodes/attributes.ts (`AttributeSet`, and the three well-known names);
//      src/nodes/scopeQuery.ts (the grammar this charset is derived FROM);
//      src/nodes/ComponentGroupOp.ts (the writer); issues #1027, #607, #734.

/** The namespace every group attribute lives under. Internal — see the module header. */
export const GROUP_ATTRIBUTE_PREFIX = 'group:';

/**
 * The names a group may have — DERIVED FROM THE QUERY GRAMMAR, not chosen for tidiness.
 *
 * Every character this refuses is one `scopeQuery` already spends on something else, so a
 * name outside this set could be authored and then never addressed:
 *
 *   leading digit   an index or a range (`0`, `0-5`)
 *   `-` and `:`     range and step separators, so `arm-left` would parse as neither a
 *                   name nor a range and land in the generic refusal
 *   `*`             wildcards, refused by name today and reserved for matching STORED
 *                   group names — which is what this issue creates
 *   `@`             attribute expressions
 *   `!` and `^`     the complement and removal operators, read before the term
 *   space and `,`   term separators
 *
 * ⚠️ THE RELATIONSHIP IS CONTAINMENT, AND IT IS PROPER — measured, after this comment first
 * claimed the charset was the grammar's exact complement and the gate refused it. The grammar
 * decides "is this a name?" with a PREFIX test (`/^[A-Za-z_]/`), so it reads `arm-left` as a
 * name too and refuses it as not-implemented. This charset is therefore a SUBSET of what the
 * grammar routes to name handling, not its mirror image.
 *
 * The direction that is load-bearing is the one that survives: **every name this admits is one
 * the grammar sends to name resolution, never to the range parser.** A name outside the subset
 * costs an author nothing they could have had — at gate 3 it resolves to "no such group", which
 * is the same refusal from one step further along. A name the grammar read as a RANGE would be
 * the real loss, and that is what the containment forbids.
 *
 * `componentGroups.gate.test.ts` row 7 asserts that direction per name, against the grammar
 * itself, because these two modules share no import and a sentence here enforces nothing.
 */
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Can this string be a group name? A BOOLEAN, for the reason `isParsableScopeQuery` is one:
 * it refines the `name` param's schema, so an unusable name never enters params and can never
 * reach the mint. The bad state has no constructor rather than a guard.
 */
export function isValidGroupName(name: string): boolean {
  return GROUP_NAME.test(name);
}

/** The attribute name a group is stored under. The ONE place the prefix is applied. */
export function groupAttributeName(name: string): string {
  return `${GROUP_ATTRIBUTE_PREFIX}${name}`;
}

/**
 * The group name an attribute holds, or `null` if the attribute is not a group.
 *
 * The inverse of {@link groupAttributeName}, and the reason the prefix pays for itself: a
 * reader can ask any attribute set which of its entries are groups without being handed a
 * list to keep in step.
 *
 * 🔴 IT RE-VALIDATES RATHER THAN TRUSTING THE PREFIX. An attribute set is data and can arrive
 * from a save file or a future producer, so `group:0-5` is representable even though nothing
 * here can mint it. Returning `0-5` as a group name would put a string into the resolver that
 * the grammar reads as a RANGE — a name that silently means six faces. Refusing it keeps the
 * round-trip claim true of everything this function hands out, not only of what it minted.
 */
export function groupNameOf(attributeName: string): string | null {
  if (!attributeName.startsWith(GROUP_ATTRIBUTE_PREFIX)) return null;
  const name = attributeName.slice(GROUP_ATTRIBUTE_PREFIX.length);
  return isValidGroupName(name) ? name : null;
}
