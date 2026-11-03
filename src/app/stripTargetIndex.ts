// stripTargetIndex — `stripTargetSet` built once per node table (#1757).
//
// A per-param read asks the strip enumerator for every node it resolves, and the enumerator walks
// every track to answer — almost always "nothing", since few nodes have a strip placed on them.
// The set of strip targets answers that first. It is a superset of what the enumerator returns
// anything for (it keeps muted strips and strips on muted tracks), so a node outside it gets
// nothing from the enumerator, and skipping the call there changes no read.
//
// Ops never mutate a node table in place, so the table's identity is the set's version.

import { stripTargetSet } from './layeredChannels';

type Nodes = Parameters<typeof stripTargetSet>[0];

const memo = new WeakMap<object, ReadonlySet<string>>();

/** The ids some Strip (with an action) targets, for `nodes`. Read-only and shared. */
export function stripTargetsOf(nodes: Nodes): ReadonlySet<string> {
  const hit = memo.get(nodes);
  if (hit) return hit;
  const set = stripTargetSet(nodes);
  memo.set(nodes, set);
  return set;
}
