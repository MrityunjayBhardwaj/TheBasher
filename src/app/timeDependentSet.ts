// timeDependentSet — which nodes can change with time, read off the node table ONCE per graph
// (#1730).
//
// WHY THIS EXISTS. The viewport decided "is this node animated?" in its render body, by building
// the channel, strip and driver target sets, widening them along each object's data lane, and
// separately building the constraint and follow-path sets. The frame loop needs the same answer,
// and two copies of a membership rule drift: a node one copy forgets is drawn frozen with no
// error anywhere ("not animated" and "animated but not followed" look the same, #398 #522).
// This is that rule, in one place, kept per node table.
//
// Blender tags only the operations reachable from the time source (`deg_node_time.cc`) and
// Houdini recooks only time-dependent nodes. The set here is the same idea at the granularity
// this codebase evaluates: a node is time-dependent when something animates it, or when it sits
// under something that does (its world moves even though nothing keys it).
//
// What it holds:
//   - `channelDriven`: a keyed channel, a Strip or a bound driver targets the node, or one of the
//     nodes on its data lane (a split object's colour and size are keyed on its data node). This
//     is the set the viewport mounts its channel overlay for.
//   - `constrained`: an active Track-To or Follow-Path targets it. `followed`: Follow-Path only.
//   - `posed`: an armature Object with a pose wired in.
//   - `roots`: the union of the four. `order`: the roots and every scene-graph descendant of them,
//     each holder before what it holds, so a reader walking `order` meets a parent's world
//     before its children's.
//   - `has(id)`: membership in `order`. A node outside it has the same world at every time, for
//     as long as this node table stands.
//
// REF: issue #1730; src/app/sceneHierarchy.ts (the holder relation); src/app/sceneIndex.ts (the
//      same per-table cache).

import type { DagState } from '../core/dag/state';
import { dataLaneNodeIds } from './dataLaneOverlay';
import { stripTargetSet } from './layeredChannels';
import { directChannelTargetSet } from './nodeChannels';
import { constraintTargetSet, followPathTargetSet } from './nodeConstraints';
import { driverTargetSet } from './paramDrivers';
import { hierarchyChildIds } from './sceneHierarchy';

type Nodes = DagState['nodes'];

export interface TimeDependentSet {
  readonly channelDriven: ReadonlySet<string>;
  readonly constrained: ReadonlySet<string>;
  readonly followed: ReadonlySet<string>;
  readonly posed: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
  /** The roots and their descendants, every holder before what it holds. */
  readonly order: readonly string[];
  has(id: string): boolean;
}

const cache = new WeakMap<Nodes, TimeDependentSet>();

/** The time-dependent set of `state`'s node table, built on first use and kept while the table
 *  is unchanged (a playhead move edits nothing, so it reuses it). */
export function timeDependentSetOf(state: DagState): TimeDependentSet {
  const hit = cache.get(state.nodes);
  if (hit) return hit;
  const set = build(state);
  cache.set(state.nodes, set);
  return set;
}

function build(state: DagState): TimeDependentSet {
  const nodes = state.nodes;
  const channelDriven = new Set<string>([
    ...directChannelTargetSet(nodes),
    ...stripTargetSet(nodes),
    ...driverTargetSet(nodes),
  ]);
  // The whole data lane, not one hop: `data` names the top of an operator stack, and the keyed
  // node can be any level of it (#522).
  for (const node of Object.values(nodes)) {
    if (channelDriven.has(node.id)) continue;
    for (const laneId of dataLaneNodeIds(state, node.id)) {
      if (channelDriven.has(laneId)) {
        channelDriven.add(node.id);
        break;
      }
    }
  }
  const constrained = constraintTargetSet(nodes);
  const followed = followPathTargetSet(nodes);
  const posed = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type !== 'Object') continue;
    const pose = node.inputs?.pose as { node?: unknown } | undefined;
    if (pose && typeof pose.node === 'string' && pose.node) posed.add(node.id);
  }
  const roots = new Set<string>([...channelDriven, ...constrained, ...posed]);

  // Down from the roots through the scene graph; then each holder before what it holds (Kahn's
  // order over the holder edges inside the set). A cycle in a malformed graph leaves its members
  // out of the ordered prefix; they are appended, so membership never depends on the order.
  const members = new Set<string>();
  const stack = [...roots].filter((id) => nodes[id]);
  while (stack.length) {
    const id = stack.pop()!;
    if (members.has(id)) continue;
    members.add(id);
    for (const child of hierarchyChildIds(nodes[id])) if (nodes[child]) stack.push(child);
  }
  const holders = new Map<string, number>();
  for (const id of members) holders.set(id, 0);
  for (const id of members) {
    for (const child of hierarchyChildIds(nodes[id])) {
      if (members.has(child)) holders.set(child, holders.get(child)! + 1);
    }
  }
  const order: string[] = [];
  const ready = [...members].filter((id) => holders.get(id) === 0).sort();
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of hierarchyChildIds(nodes[id])) {
      if (!holders.has(child)) continue;
      const left = holders.get(child)! - 1;
      holders.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  if (order.length < members.size) {
    const placed = new Set(order);
    for (const id of [...members].sort()) if (!placed.has(id)) order.push(id);
  }

  return {
    channelDriven,
    constrained,
    followed,
    posed,
    roots,
    order,
    has: (id) => members.has(id),
  };
}
