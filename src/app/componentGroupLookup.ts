// componentGroupLookup — how a road that holds a GEOMETRY answers "what does this group hold?"
// #1027 (#607).
//
// ── WHY IT IS ITS OWN MODULE ──────────────────────────────────────────────────────────
//
// `scopeQuery.ts` takes a {@link GroupLookup} as DATA rather than importing a store, because a
// module able to turn a name into a set from nothing but a string is a module an operator could
// import to interpret its own scope — the one defect the one-parser rule exists to prevent.
// Something still has to build that function, and FOUR roads need it: the resolver, the derived
// face count, the scoped build, and the bevel layout. Putting it in any one of them would make
// the other three import that one; `faceCount.ts` in particular is a deliberate leaf and
// `componentSelection.ts` already imports it, so the dependency could only go one way.
//
// It therefore sits below all four, on three modules that are themselves leaves: the store
// (`attributeStore` imports one TYPE), the name rule (`componentGroups` imports nothing), and
// types. Measured, not assumed: none of those imports `faceCount` or `componentSelection`, so
// there is no cycle to create.
//
// REF: src/nodes/scopeQuery.ts (`GroupLookup`, and why it is handed in);
//      src/nodes/componentGroups.ts (the prefix — applied HERE and nowhere else);
//      src/app/attributeStore.ts; issues #1027, #607.

import { read } from './attributeStore';
import { groupAttributeName } from '../nodes/componentGroups';
import type { GroupLookup } from '../nodes/scopeQuery';
import type { GeometryRef } from '../nodes/types';
import type { ScopeDomain } from '../nodes/attributes';

/**
 * The lookup for one geometry at one component class.
 *
 * 🔴 v1 GROUPS ARE FACE-DOMAIN, AND A NON-FACE SCOPE REFUSES BY NAME RATHER THAN MISSING.
 * A bevel's scope names EDGES, so `arm` on a bevel is not "this mesh has no group called arm" —
 * the mesh may very well have one — it is "a face group cannot scope an edge selection". Those
 * are different facts with different fixes, and returning `null` would tell the author the
 * false one. The lookup throws instead, which is inside its contract: a lookup is asked at most
 * once per term, by the one resolver, on a road that already refuses queries by name.
 *
 * ⚠️ ABSENT AND UNRESOLVABLE COLLAPSE TO `null` ON PURPOSE, and that is the same reasoning
 * `mintTargetedAttributes` states: a geometry carrying no attribute key and a key the store
 * cannot resolve both mean "there is nothing here to read", and inventing a distinction would
 * put a second failure mode in front of an author who can act on neither.
 */
export function groupLookupFor(
  geometry: GeometryRef | null | undefined,
  domain: ScopeDomain,
): GroupLookup {
  if (domain !== 'face') {
    return (name) => {
      throw new Error(
        `componentGroupLookup: '${name}' names a group, and groups are face-domain — a group cannot scope a selection over ${domain}s`,
      );
    };
  }
  const key = geometry?.attributeKey;
  const set = key === undefined ? null : read(key);
  return (name) => {
    const attribute = set?.[groupAttributeName(name)];
    // The DOMAIN is re-checked rather than trusted from the name. An attribute set is data and
    // can arrive from a save file or a future producer, so `group:arm` at the corner domain is
    // representable; reading its values against face indices would silently name the wrong
    // elements, which is the failure this whole module is arranged to make impossible.
    if (attribute === undefined || attribute.domain !== 'face') return null;
    return attribute.data;
  };
}
