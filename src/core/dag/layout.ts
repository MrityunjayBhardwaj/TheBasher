// #1562 — where each node sits in the node view.
//
// A position is stored on the node (`meta.position`, written by `setMeta`). A node without one
// (every node of a project saved before #1562, and every node a door adds without placing it)
// is given one here, derived and never written: an old project opens laid out without a
// migration and without being marked unsaved.
//
// The layout is per LEVEL, the way the node view shows the graph (GRAPH.md §4 rule 2): the top
// level, and each sub-network at its nearest owner. Inside a level, producers stand left of
// what they feed (column = the longest chain of wires reaching the node within the level) and a
// column is ordered by where its producers stand, so wires run left to right and cross little.
// In a level where some nodes are placed and some are not, the unplaced ones are laid out in a
// band below the placed ones, so nothing lands on a node someone placed.

import type { DagState } from './state';
import { registryEpoch } from './registry';
import { subnetworkOf, subnetworkOwnersOf } from './subnetworks';
import type { NodeId } from './types';

export type Position = readonly [number, number];

/** Spacing between columns and rows of a derived layout, in node-view units. */
export const LAYOUT_COLUMN = 240;
export const LAYOUT_ROW = 100;

/** The owner of the level each node is shown at: its nearest sub-network owner, or `null` at
 *  the top level. */
export function levelOf(state: DagState): ReadonlyMap<NodeId, NodeId | null> {
  const closures = subnetworkOwnersOf(state).map((owner) => ({
    owner,
    closure: subnetworkOf(state, owner),
  }));
  const level = new Map<NodeId, NodeId | null>();
  for (const id of Object.keys(state.nodes)) {
    // Sub-networks nest, so the nearest holder is the one holding the fewest nodes.
    let nearest: { owner: NodeId; size: number } | null = null;
    for (const { owner, closure } of closures) {
      if (closure.has(id) && (!nearest || closure.size < nearest.size))
        nearest = { owner, size: closure.size };
    }
    level.set(id, nearest?.owner ?? null);
  }
  return level;
}

const layouts = new WeakMap<
  DagState['nodes'],
  { readonly epoch: number; readonly positions: ReadonlyMap<NodeId, Position> }
>();

/** Every node's position: its own when it has one, else the derived one. Kept beside the graph
 *  and keyed on the registry epoch, since levels are read off node types (V649). */
export function layoutOf(state: DagState): ReadonlyMap<NodeId, Position> {
  const known = layouts.get(state.nodes);
  if (known && known.epoch === registryEpoch()) return known.positions;
  const byLevel = new Map<NodeId | null, NodeId[]>();
  for (const [id, owner] of levelOf(state)) {
    const members = byLevel.get(owner) ?? [];
    members.push(id);
    byLevel.set(owner, members);
  }
  const positions = new Map<NodeId, Position>();
  for (const members of byLevel.values()) layoutLevel(state, members, positions);
  layouts.set(state.nodes, { epoch: registryEpoch(), positions });
  return positions;
}

/** Where `id` sits in the node view, or undefined when the graph has no such node. */
export function positionOf(state: DagState, id: NodeId): Position | undefined {
  return layoutOf(state).get(id);
}

function producersIn(state: DagState, id: NodeId, level: ReadonlySet<NodeId>): NodeId[] {
  const out: NodeId[] = [];
  for (const binding of Object.values(state.nodes[id].inputs)) {
    for (const ref of Array.isArray(binding) ? binding : [binding])
      if (level.has(ref.node) && !out.includes(ref.node)) out.push(ref.node);
  }
  return out;
}

function layoutLevel(state: DagState, members: NodeId[], into: Map<NodeId, Position>): void {
  let placedBottom = -Infinity;
  const unplaced: NodeId[] = [];
  for (const id of members) {
    const stored = state.nodes[id].meta?.position;
    if (stored) {
      into.set(id, stored);
      placedBottom = Math.max(placedBottom, stored[1]);
    } else unplaced.push(id);
  }
  if (unplaced.length === 0) return;
  const top = placedBottom === -Infinity ? 0 : placedBottom + 2 * LAYOUT_ROW;

  const level = new Set(unplaced);
  const column = new Map<NodeId, number>();
  // The graph is acyclic (`connect` refuses a loop), so the longest chain is finite.
  const columnOf = (id: NodeId): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    const producers = producersIn(state, id, level);
    const c = producers.length === 0 ? 0 : 1 + Math.max(...producers.map(columnOf));
    column.set(id, c);
    return c;
  };
  const columns: NodeId[][] = [];
  for (const id of unplaced) (columns[columnOf(id)] ??= []).push(id);

  const row = new Map<NodeId, number>();
  columns.forEach((ids, c) => {
    // Order a column by the mean row of its producers; a node fed by nothing keeps the order
    // the graph holds it in. Ties keep that order too (the sort is stable).
    const weight = (id: NodeId): number => {
      const rows = producersIn(state, id, level).map((p) => row.get(p)!);
      return rows.length === 0 ? Infinity : rows.reduce((a, b) => a + b, 0) / rows.length;
    };
    const ordered = c === 0 ? ids : [...ids].sort((a, b) => weight(a) - weight(b));
    ordered.forEach((id, r) => {
      row.set(id, r);
      into.set(id, [c * LAYOUT_COLUMN, top + r * LAYOUT_ROW]);
    });
  });
}
