// #1562 — where each node sits in the node view. #1563 — one layout, the one the view draws.
//
// A position is stored on the node (`meta.position`, written by `setMeta`). A node without one
// (every node of a project saved before #1562, and every node a door adds without placing it)
// is given one here, derived and never written: an old project opens laid out without a
// migration and without being marked unsaved.
//
// The layout is per LEVEL, the way the node view shows the graph (GRAPH.md §4 rule 2): the top
// level, and each sub-network at its nearest owner. In a level where some nodes are placed and
// some are not, the unplaced ones are laid out in a band below the placed ones, so nothing
// lands on a node someone placed.
//
// What the view draws between two nodes is read here too (`viewEdgesOf`, from `relationsOf`),
// and so is how big it draws a node: the layout spaces nodes by the rows they show and ranks
// them by the same wires and references the view draws. Positions are in node-view units.

import type { DagState } from './state';
import { relationsOf } from './idRefSweep';
import { registryEpoch } from './registry';
import { subnetworkOf, subnetworkOwnersOf } from './subnetworks';
import type { NodeId } from './types';

export type Position = readonly [number, number];

/** A node's box in the node view, and the gaps between boxes, in node-view units. */
export const NODE_WIDTH = 230;
export const NODE_HEAD = 40;
export const NODE_ROW = 18;
export const NODE_PAD = 8;
export const COLUMN_GAP = 90;
export const ROW_GAP = 16;

/** The height of a node showing `inputs` input rows and `outputs` output sockets. The first
 *  output sits in the head, so only the rest take a row. */
export function nodeHeight(inputs: number, outputs: number): number {
  return NODE_HEAD + Math.max(inputs, outputs - 1, 0) * NODE_ROW + NODE_PAD;
}

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

// ── What the view draws between nodes ───────────────────────────────────────────────────

/** One line in the node view: a wire, or a reference drawn the way it acts. */
export interface ViewEdge {
  readonly from: NodeId;
  /** The output socket, or for a 'subject' reference the param on the referrer holding it. */
  readonly fromSocket: string;
  readonly to: NodeId;
  /** The input socket, or for a reference the row it arrives on. */
  readonly toSocket: string;
  /** A reference by id rather than a wire. */
  readonly ref: boolean;
}

const edgesByNodes = new WeakMap<
  DagState['nodes'],
  { readonly epoch: number; readonly edges: readonly ViewEdge[] }
>();

/**
 * Every wire and declared reference in the graph, as the node view draws them, read off
 * `relationsOf` (#1553). A reference's direction follows what it means (`idRefs.role`):
 *   • 'subject'  — the referrer acts ON the referent (a channel animates its target, a
 *                  constraint turns its owner), so the line runs from the referrer into the
 *                  referent, arriving on the animated param when the referrer names one
 *                  (`paramPath`), else on a row named for the referrer's type.
 *   • 'argument' — the referrer READS the referent (an aim target, a curve to follow), so the
 *                  line runs from the referent into the referrer, arriving on the param path.
 */
export function viewEdgesOf(state: DagState): readonly ViewEdge[] {
  const known = edgesByNodes.get(state.nodes);
  if (known && known.epoch === registryEpoch()) return known.edges;
  const edges: ViewEdge[] = [];
  for (const node of Object.values(state.nodes)) {
    const relations = relationsOf(state, node.id);
    for (const w of relations.wiresIn) {
      if (!state.nodes[w.node]) continue;
      edges.push({
        from: w.node,
        fromSocket: w.output,
        to: node.id,
        toSocket: w.socket,
        ref: false,
      });
    }
    for (const r of relations.refsOut) {
      if (!state.nodes[r.node] || r.node === node.id) continue;
      if (r.role === 'subject') {
        const p = node.params as { paramPath?: unknown };
        const row = typeof p?.paramPath === 'string' && p.paramPath ? p.paramPath : node.type;
        edges.push({ from: node.id, fromSocket: r.path, to: r.node, toSocket: row, ref: true });
      } else {
        edges.push({ from: r.node, fromSocket: 'out', to: node.id, toSocket: r.path, ref: true });
      }
    }
  }
  edgesByNodes.set(state.nodes, { epoch: registryEpoch(), edges });
  return edges;
}

/** A row on a node's left edge: one per socket or reference row, however many lines land. */
export interface ViewRow {
  readonly socket: string;
  readonly count: number;
  readonly ref: boolean;
}

/** The input rows and used output sockets each node shows, for the edges given. */
export function viewRowsOf(edges: readonly ViewEdge[]): {
  readonly inputs: ReadonlyMap<NodeId, readonly ViewRow[]>;
  readonly outputs: ReadonlyMap<NodeId, readonly string[]>;
} {
  const inputs = new Map<NodeId, ViewRow[]>();
  const outputs = new Map<NodeId, string[]>();
  for (const e of edges) {
    const rows = inputs.get(e.to) ?? [];
    const at = rows.findIndex((r) => r.socket === e.toSocket && r.ref === e.ref);
    if (at >= 0) rows[at] = { ...rows[at], count: rows[at].count + 1 };
    else rows.push({ socket: e.toSocket, count: 1, ref: e.ref });
    inputs.set(e.to, rows);
    const outs = outputs.get(e.from) ?? [];
    if (!outs.includes(e.fromSocket)) outs.push(e.fromSocket);
    outputs.set(e.from, outs);
  }
  return { inputs, outputs };
}

// ── Positions ───────────────────────────────────────────────────────────────────────────

const layouts = new WeakMap<
  DagState['nodes'],
  { readonly epoch: number; readonly positions: ReadonlyMap<NodeId, Position> }
>();

/** Every node's position (its box's top-left corner): its own when it has one, else the
 *  derived one. Kept beside the graph and keyed on the registry epoch, since levels and
 *  references are read off node types (V649). */
export function layoutOf(state: DagState): ReadonlyMap<NodeId, Position> {
  const known = layouts.get(state.nodes);
  if (known && known.epoch === registryEpoch()) return known.positions;
  const level = levelOf(state);
  const byLevel = new Map<NodeId | null, NodeId[]>();
  for (const [id, owner] of level) {
    const members = byLevel.get(owner) ?? [];
    members.push(id);
    byLevel.set(owner, members);
  }
  const edges = viewEdgesOf(state);
  const rows = viewRowsOf(edges);
  const height = (id: NodeId) =>
    nodeHeight(rows.inputs.get(id)?.length ?? 0, rows.outputs.get(id)?.length ?? 0);
  const positions = new Map<NodeId, Position>();
  for (const members of byLevel.values()) layoutLevel(state, members, edges, height, positions);
  layouts.set(state.nodes, { epoch: registryEpoch(), positions });
  return positions;
}

/** Where `id` sits in the node view, or undefined when the graph has no such node. */
export function positionOf(state: DagState, id: NodeId): Position | undefined {
  return layoutOf(state).get(id);
}

function layoutLevel(
  state: DagState,
  members: readonly NodeId[],
  edges: readonly ViewEdge[],
  height: (id: NodeId) => number,
  into: Map<NodeId, Position>,
): void {
  let placedBottom = -Infinity;
  const unplaced: NodeId[] = [];
  for (const id of members) {
    const stored = state.nodes[id].meta?.position;
    if (stored) {
      into.set(id, stored);
      placedBottom = Math.max(placedBottom, stored[1] + height(id));
    } else unplaced.push(id);
  }
  if (unplaced.length === 0) return;
  const top = placedBottom === -Infinity ? 0 : placedBottom + 2 * ROW_GAP;

  const inLevel = new Set(unplaced);
  const local = edges.filter((e) => e.from !== e.to && inLevel.has(e.from) && inLevel.has(e.to));
  for (const [id, [x, y]] of layered(unplaced, height, acyclic(local))) into.set(id, [x, top + y]);
}

/**
 * The edges to rank by, with none closing a loop. Wires never do (`connect` refuses a loop), so
 * all of them stay; a reference is kept unless what it points at already reaches what it starts
 * from (a driver reading the node it drives). Dropping a reference rather than a wire keeps
 * every wire running left to right.
 */
function acyclic(edges: readonly ViewEdge[]): { from: NodeId; to: NodeId }[] {
  const next = new Map<NodeId, NodeId[]>();
  const add = (from: NodeId, to: NodeId) => next.set(from, [...(next.get(from) ?? []), to]);
  const reaches = (start: NodeId, goal: NodeId): boolean => {
    const seen = new Set<NodeId>();
    const stack = [start];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === goal) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...(next.get(x) ?? []));
    }
    return false;
  };
  const kept: { from: NodeId; to: NodeId }[] = [];
  for (const e of edges) {
    if (e.ref) continue;
    add(e.from, e.to);
    kept.push(e);
  }
  for (const e of edges) {
    if (!e.ref || reaches(e.to, e.from)) continue;
    add(e.from, e.to);
    kept.push(e);
  }
  return kept;
}

/**
 * A layered layout of one level, left to right (#1675's, moved here so there is one):
 *   1. Columns by longest path from the sources, then every node pulled right to sit one column
 *      before its nearest reader, so a mesh sits beside the object that uses it rather than at
 *      the far left.
 *   2. Order within a column starts from a walk back from the right edge, so what hangs under
 *      one parent starts together, then a few barycentre sweeps untangle crossings.
 *   3. Heights: each node is drawn toward the middle of its neighbours, then pushed apart so a
 *      column never overlaps.
 * The edges must not close a loop.
 */
function layered(
  ids: readonly NodeId[],
  height: (id: NodeId) => number,
  edges: readonly { from: NodeId; to: NodeId }[],
): Map<NodeId, Position> {
  const succ = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  const pred = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    succ.get(e.from)!.push(e.to);
    pred.get(e.to)!.push(e.from);
  }

  // Producers before what they feed.
  const topo: NodeId[] = [];
  const done = new Set<NodeId>();
  const visit = (root: NodeId) => {
    const stack: [NodeId, number][] = [[root, 0]];
    done.add(root);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = succ.get(top[0])![top[1]++];
      if (next === undefined) {
        topo.push(top[0]);
        stack.pop();
      } else if (!done.has(next)) {
        done.add(next);
        stack.push([next, 0]);
      }
    }
  };
  for (const id of ids) if (!done.has(id)) visit(id);
  topo.reverse();

  const col = new Map<NodeId, number>();
  for (const id of topo) col.set(id, Math.max(-1, ...pred.get(id)!.map((p) => col.get(p)!)) + 1);
  for (const id of [...topo].reverse()) {
    const s = succ.get(id)!;
    if (s.length) col.set(id, Math.min(...s.map((x) => col.get(x)!)) - 1);
  }

  const ncol = Math.max(0, ...col.values()) + 1;
  const columns: NodeId[][] = Array.from({ length: ncol }, () => []);
  const placed = new Set<NodeId>();
  const walkBack = (id: NodeId) => {
    if (placed.has(id)) return;
    placed.add(id);
    columns[col.get(id)!].push(id);
    for (const p of pred.get(id)!) walkBack(p);
  };
  for (const id of ids) if (succ.get(id)!.length === 0 && pred.get(id)!.length > 0) walkBack(id);
  for (const id of ids) walkBack(id);

  const index = new Map<NodeId, number>();
  columns.forEach((c) => c.forEach((id, i) => index.set(id, i)));
  for (let pass = 0; pass < 8; pass++) {
    const forward = pass % 2 === 0;
    for (const c of forward ? columns : [...columns].reverse()) {
      const key = new Map<NodeId, number>();
      for (const id of c) {
        const nb = forward ? pred.get(id)! : succ.get(id)!;
        key.set(
          id,
          nb.length ? nb.reduce((a, x) => a + index.get(x)!, 0) / nb.length : index.get(id)!,
        );
      }
      c.sort((a, b) => key.get(a)! - key.get(b)!);
      c.forEach((id, i) => index.set(id, i));
    }
  }

  const y = new Map<NodeId, number>();
  for (const c of columns) {
    let at = 0;
    for (const id of c) {
      y.set(id, at);
      at += height(id) + ROW_GAP;
    }
  }
  const center = (id: NodeId) => y.get(id)! + height(id) / 2;
  for (let pass = 0; pass < 6; pass++) {
    for (const c of pass % 2 === 0 ? columns : [...columns].reverse()) {
      const want = c.map((id) => {
        const nb = [...pred.get(id)!, ...succ.get(id)!];
        return nb.length
          ? nb.reduce((a, x) => a + center(x), 0) / nb.length - height(id) / 2
          : y.get(id)!;
      });
      // Settle top-down (each at its wish unless it runs into the one above) and bottom-up (each
      // at its wish unless it runs into the one below), then take the average: both keep every
      // gap, so their average does too, and neither direction is favoured.
      const down: number[] = [];
      const up: number[] = [];
      for (let i = 0; i < c.length; i++) {
        const floor = i ? down[i - 1] + height(c[i - 1]) + ROW_GAP : -Infinity;
        down[i] = Math.max(want[i], floor);
      }
      for (let i = c.length - 1; i >= 0; i--) {
        const ceil = i < c.length - 1 ? up[i + 1] - ROW_GAP - height(c[i]) : Infinity;
        up[i] = Math.min(want[i], ceil);
      }
      c.forEach((id, i) => y.set(id, (down[i] + up[i]) / 2));
    }
  }

  const minY = Math.min(0, ...y.values());
  const out = new Map<NodeId, Position>();
  for (const id of ids) out.set(id, [col.get(id)! * (NODE_WIDTH + COLUMN_GAP), y.get(id)! - minY]);
  return out;
}
