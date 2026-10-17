// sceneGraph — the scene as nodes and wires, for the read-only Graph editor space (#1675, the
// first slice of the §16 node view #1563).
//
// Two pure halves, so the React shell only draws:
//
//   • `sceneGraphOf` reads the DAG into what the view draws. Wires come from `node.inputs`.
//     References — the half of the graph that travels in params, not on wires (keyframe
//     channels, constraints, aim targets) — come from each node type's declared `idRefs`, the
//     same index delete and duplicate consult, so a new node kind shows up here the day it
//     declares its references and no list in this file goes stale.
//   • `layoutGraph` places them: data flows left to right into the render. It is a small
//     layered layout of our own — the usual layout libraries are not permissively licensed.
//
// REF: src/core/dag/types.ts (NodeDefinition.idRefs: role/shape); src/core/dag/idRefSweep.ts
//      (refIdsAt); src/app/collections.ts (hiddenNodes).

import { refIdsAt } from '../core/dag/idRefSweep';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { NodeId, NodeRef } from '../core/dag/types';
import { hiddenNodes } from './collections';
import { nodeDisplayName } from './sceneTreeWalk';

export interface GraphInputRow {
  /** The socket name, or for a reference the param it arrives through. */
  readonly socket: string;
  /** How many wires land on it (a `children` list lands many). */
  readonly count: number;
  readonly ref: boolean;
}

export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  readonly name: string;
  readonly inputs: readonly GraphInputRow[];
  /** Output sockets something reads, in first-use order. */
  readonly outputs: readonly string[];
  /** Hidden in the viewport (its own flag or a collection's). */
  readonly hidden: boolean;
}

export interface GraphWire {
  readonly from: NodeId;
  readonly fromSocket: string;
  readonly to: NodeId;
  readonly toSocket: string;
  /** A reference by id rather than a wire. */
  readonly ref: boolean;
}

export interface SceneGraph {
  readonly nodes: readonly GraphNode[];
  readonly wires: readonly GraphWire[];
  /** Nodes left out because everything they draw is hidden (0 when `showHidden`). */
  readonly omitted: number;
}

const bindingRefs = (v: NodeRef | readonly NodeRef[] | undefined): readonly NodeRef[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v as NodeRef];

/**
 * A reference's direction follows what it means (`idRefs.role`):
 *   • 'subject'  — this node acts ON the referent (a channel animates its target, a constraint
 *                  turns its owner), so the line runs from this node into the referent.
 *   • 'argument' — this node READS the referent (the aim target, the curve to follow), so the
 *                  line runs from the referent into this node.
 * The row on the receiving end is named for what arrives: the animated param when the channel
 * says which (`paramPath`), else the referrer's type; the param path on the reading side.
 */
function referenceWires(state: DagState): GraphWire[] {
  const out: GraphWire[] = [];
  for (const node of Object.values(state.nodes)) {
    for (const r of getNodeType(node.type)?.idRefs ?? []) {
      for (const id of refIdsAt(node.params, r.path, r.shape)) {
        if (!state.nodes[id] || id === node.id) continue;
        if (r.role === 'subject') {
          const p = node.params as { paramPath?: unknown };
          const row = typeof p?.paramPath === 'string' && p.paramPath ? p.paramPath : node.type;
          out.push({ from: node.id, fromSocket: r.path, to: id, toSocket: row, ref: true });
        } else {
          out.push({ from: id, fromSocket: 'out', to: node.id, toSocket: r.path, ref: true });
        }
      }
    }
  }
  return out;
}

/**
 * The nodes worth drawing when hidden pieces are left out. Blender hides an object alone and its
 * children keep drawing (collections.ts `hiddenNodes`), so a group is not hidden by flag — but a
 * group whose every drawable (a shown node carrying `data`) is hidden draws nothing, and showing
 * its empty shell is noise. Then whatever only fed what was left out goes too, and a reference
 * acting only on what was left out goes with it.
 */
function drawnNodes(
  state: DagState,
  wires: readonly GraphWire[],
  hidden: ReadonlySet<NodeId>,
): Set<NodeId> {
  const nodes = state.nodes;
  const upstream = (id: NodeId): Set<NodeId> => {
    const seen = new Set<NodeId>();
    const stack = [id];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x) || !nodes[x]) continue;
      seen.add(x);
      for (const v of Object.values(nodes[x].inputs ?? {}))
        for (const r of bindingRefs(v)) stack.push(r.node);
    }
    return seen;
  };
  const drawable = (id: NodeId) =>
    !hidden.has(id) && bindingRefs(nodes[id]?.inputs?.data).length > 0;

  const keep = new Set<NodeId>(Object.keys(nodes).filter((id) => !hidden.has(id)));
  for (const id of keep) {
    if (bindingRefs(nodes[id].inputs?.children).length === 0) continue;
    const sub = [...upstream(id)];
    if (sub.some((x) => hidden.has(x)) && !sub.some(drawable)) keep.delete(id);
  }

  const readers = new Map<NodeId, NodeId[]>();
  const subjects = new Map<NodeId, NodeId[]>();
  for (const w of wires) {
    if (!w.ref) readers.set(w.from, [...(readers.get(w.from) ?? []), w.to]);
    else if (w.fromSocket !== 'out') subjects.set(w.from, [...(subjects.get(w.from) ?? []), w.to]);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...keep]) {
      const r = readers.get(id) ?? [];
      const s = subjects.get(id) ?? [];
      if (
        (r.length && r.every((x) => !keep.has(x))) ||
        (s.length && s.every((x) => !keep.has(x)))
      ) {
        keep.delete(id);
        grew = true;
      }
    }
  }
  return keep;
}

export function sceneGraphOf(state: DagState, opts: { showHidden: boolean }): SceneGraph {
  const all: GraphWire[] = [];
  for (const node of Object.values(state.nodes)) {
    for (const [socket, v] of Object.entries(node.inputs ?? {})) {
      for (const r of bindingRefs(v)) {
        if (state.nodes[r.node])
          all.push({
            from: r.node,
            fromSocket: r.socket,
            to: node.id,
            toSocket: socket,
            ref: false,
          });
      }
    }
  }
  all.push(...referenceWires(state));

  const hidden = hiddenNodes(state, 'viewport');
  const shown = opts.showHidden
    ? new Set(Object.keys(state.nodes))
    : drawnNodes(state, all, hidden);
  const wires = all.filter((w) => shown.has(w.from) && shown.has(w.to));

  const rows = new Map<NodeId, GraphInputRow[]>();
  const outs = new Map<NodeId, string[]>();
  for (const w of wires) {
    const r = rows.get(w.to) ?? [];
    const at = r.findIndex((x) => x.socket === w.toSocket && x.ref === w.ref);
    if (at >= 0) r[at] = { ...r[at], count: r[at].count + 1 };
    else r.push({ socket: w.toSocket, count: 1, ref: w.ref });
    rows.set(w.to, r);
    const o = outs.get(w.from) ?? [];
    if (!o.includes(w.fromSocket)) o.push(w.fromSocket);
    outs.set(w.from, o);
  }
  const nodes = Object.values(state.nodes)
    .filter((n) => shown.has(n.id))
    .map((n) => ({
      id: n.id,
      type: n.type,
      name: nodeDisplayName(state.nodes, n.id),
      inputs: rows.get(n.id) ?? [],
      outputs: outs.get(n.id) ?? [],
      hidden: hidden.has(n.id),
    }));
  return { nodes, wires, omitted: Object.keys(state.nodes).length - nodes.length };
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────

export interface LayoutBox {
  readonly id: NodeId;
  readonly height: number;
}
export interface Layout {
  readonly pos: ReadonlyMap<NodeId, { x: number; y: number }>;
  readonly width: number;
  readonly height: number;
}

/**
 * A layered layout, left to right:
 *   1. Columns by longest path from the sources, then every node pulled right to sit one column
 *      before its nearest reader, so a mesh sits beside the object that uses it rather than at
 *      the far left. A wire that would close a cycle is left out of the ranking.
 *   2. Order within a column starts from a walk back from the right edge, so what hangs under
 *      one parent starts together, then a few barycentre sweeps untangle crossings.
 *   3. Heights: each node is drawn toward the middle of its neighbours, then pushed apart so a
 *      column never overlaps.
 */
export function layoutGraph(
  boxes: readonly LayoutBox[],
  edges: readonly { from: NodeId; to: NodeId }[],
  o: { width: number; colGap: number; rowGap: number },
): Layout {
  const ids = boxes.map((b) => b.id);
  const height = new Map(boxes.map((b) => [b.id, b.height]));
  const succ = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  const pred = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));

  // Drop the wires that close a cycle (DFS back edges), so the ranking below terminates.
  const raw = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  for (const e of edges)
    if (raw.has(e.from) && raw.has(e.to) && e.from !== e.to) raw.get(e.from)!.push(e.to);
  const state = new Map<NodeId, 1 | 2>();
  const topo: NodeId[] = [];
  const visit = (root: NodeId) => {
    const stack: [NodeId, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = raw.get(top[0])![top[1]++];
      if (next === undefined) {
        state.set(top[0], 2);
        topo.push(top[0]);
        stack.pop();
      } else if (state.get(next) === undefined) {
        succ.get(top[0])!.push(next);
        pred.get(next)!.push(top[0]);
        state.set(next, 1);
        stack.push([next, 0]);
      } else if (state.get(next) === 2) {
        succ.get(top[0])!.push(next);
        pred.get(next)!.push(top[0]);
      }
    }
  };
  for (const id of ids) if (state.get(id) === undefined) visit(id);
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
  const reindex = () => columns.forEach((c) => c.forEach((id, i) => index.set(id, i)));
  reindex();
  for (let pass = 0; pass < 8; pass++) {
    const forward = pass % 2 === 0;
    const order = forward ? columns : [...columns].reverse();
    for (const c of order) {
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
      at += height.get(id)! + o.rowGap;
    }
  }
  const center = (id: NodeId) => y.get(id)! + height.get(id)! / 2;
  for (let pass = 0; pass < 6; pass++) {
    for (const c of pass % 2 === 0 ? columns : [...columns].reverse()) {
      const want = c.map((id) => {
        const nb = [...pred.get(id)!, ...succ.get(id)!];
        return nb.length
          ? nb.reduce((a, x) => a + center(x), 0) / nb.length - height.get(id)! / 2
          : y.get(id)!;
      });
      // Settle top-down (each at its wish unless it runs into the one above) and bottom-up (each
      // at its wish unless it runs into the one below), then take the average: both keep every
      // gap, so their average does too, and neither direction is favoured.
      const down: number[] = [];
      const up: number[] = [];
      for (let i = 0; i < c.length; i++) {
        const floor = i ? down[i - 1] + height.get(c[i - 1])! + o.rowGap : -Infinity;
        down[i] = Math.max(want[i], floor);
      }
      for (let i = c.length - 1; i >= 0; i--) {
        const ceil = i < c.length - 1 ? up[i + 1] - o.rowGap - height.get(c[i])! : Infinity;
        up[i] = Math.min(want[i], ceil);
      }
      c.forEach((id, i) => y.set(id, (down[i] + up[i]) / 2));
    }
  }

  const minY = Math.min(0, ...y.values());
  const pos = new Map<NodeId, { x: number; y: number }>();
  let bottom = 0;
  for (const id of ids) {
    const p = { x: col.get(id)! * (o.width + o.colGap), y: y.get(id)! - minY };
    pos.set(id, p);
    bottom = Math.max(bottom, p.y + height.get(id)!);
  }
  return { pos, width: ncol * o.width + (ncol - 1) * o.colGap, height: bottom };
}
