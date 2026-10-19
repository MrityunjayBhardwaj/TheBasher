// sceneGraph — the scene as nodes and wires, for the read-only Graph editor space (#1675, the
// first slice of the §16 node view #1563).
//
// `sceneGraphOf` reads the DAG into what the view draws, one level at a time. It owns no
// relationship and no position of its own: the wires and references are `viewEdgesOf` and the
// levels `levelOf`, both in src/core/dag/layout.ts beside `layoutOf`, which says where each
// node sits. This file only decides what is worth drawing: hidden pieces are left out, and the
// space they would take stays empty, so showing them never moves anything else.
//
// What Houdini's network editor shows beside the nodes, read from the graph (#1563):
//   • animation, constraints and drivers are hidden until asked for, and show as a tint on the
//     row they drive (Houdini colours an animated parameter rather than drawing its channel);
//   • the scene and render outputs are flags on the node they are bound to (`network/flags`);
//   • a node whose value changes with time is marked (its cook state, as the evaluator sees
//     it: `timeDependentNodes`);
//   • a node says how many of its lines lead to another level (`network/dependencies`);
//   • a node that follows another's name says whose (in its tooltip: today every one is also
//     wired to the node it follows, so a line would only repeat the wire).
//
// REF: src/core/dag/layout.ts (viewEdgesOf, viewRowsOf, levelOf); src/app/collections.ts
//      (hiddenNodes); src/app/timeDependence.ts (timeDependentNodes).

import { levelOf, viewEdgesOf, viewRowsOf, type ViewEdge, type ViewRow } from '../core/dag/layout';
import type { DagState } from '../core/dag/state';
import type { NodeId, NodeRef } from '../core/dag/types';
import { relationsOf } from '../core/dag/idRefSweep';
import { hiddenNodes } from './collections';
import { nodeDisplayName } from './sceneTreeWalk';
import { timeDependentNodes } from './timeDependence';

export interface GraphInputRow extends ViewRow {
  /** Set when what drives this row is hidden: the type of the first node driving it, so the
   *  row takes its colour. */
  readonly tint?: string;
}
export type GraphWire = ViewEdge;
export type GraphFlag = 'scene' | 'render';

export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  readonly name: string;
  readonly inputs: readonly GraphInputRow[];
  /** Output sockets something reads, in first-use order. */
  readonly outputs: readonly string[];
  /** Hidden in the viewport (its own flag or a collection's). */
  readonly hidden: boolean;
  /** How many nodes its sub-network shows one level down; 0 when it owns none. */
  readonly inside: number;
  /** The outputs bound to it. */
  readonly flags: readonly GraphFlag[];
  /** Its value changes with time, so it is cooked again as the playhead moves. */
  readonly timeDependent: boolean;
  /** Lines from or to a node at another level, which this level cannot draw. A line between an
   *  owner and its own sub-network is the sub-network itself and is not counted. */
  readonly away: number;
  /** The name of the node whose name this one follows (`meta.nameFrom`), or null. */
  readonly namedAfter: string | null;
}

export interface SceneGraph {
  readonly nodes: readonly GraphNode[];
  readonly wires: readonly GraphWire[];
  /** Nodes of this level left out because everything they draw is hidden (0 when
   *  `showHidden`). */
  readonly omitted: number;
  /** Animation, constraints and drivers of this level left out (0 when `showAnimation`). */
  readonly animation: number;
  /** The owners from the top level down to the one shown; empty at the top level. */
  readonly path: readonly NodeId[];
}

const bindingRefs = (v: NodeRef | readonly NodeRef[] | undefined): readonly NodeRef[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v as NodeRef];

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

/** The drawn rows plus the tinted ones. A tint landing on a reference row that is drawn joins it
 *  rather than adding a second row of the same name, so the node is no taller than the layout
 *  spaced it for. */
function withTints(
  rows: readonly GraphInputRow[],
  tints: readonly GraphInputRow[],
): GraphInputRow[] {
  const out = [...rows];
  for (const t of tints) {
    const at = out.findIndex((r) => r.ref && r.socket === t.socket);
    if (at >= 0) out[at] = { ...out[at], count: out[at].count + t.count, tint: t.tint };
    else out.push(t);
  }
  return out;
}

/** A node that acts on others only by a 'subject' reference (a keyframe channel, a constraint)
 *  and has no wire at all: its whole effect is on the node it names. A driver fed by a wire
 *  stays drawn, since it is where that wire's value leaves the wires for a parameter. */
function isSidecar(state: DagState, id: NodeId): boolean {
  const r = relationsOf(state, id);
  return (
    r.wiresIn.length === 0 && r.wiresOut.length === 0 && r.refsOut.some((x) => x.role === 'subject')
  );
}

/**
 * What the view draws at one level: the top level (`level` null or absent), or the sub-network
 * of the owner named. A level that no longer exists (its owner was deleted) reads as the top.
 */
export function sceneGraphOf(
  state: DagState,
  opts: { showHidden: boolean; showAnimation?: boolean; level?: NodeId | null },
): SceneGraph {
  const levels = levelOf(state);
  const level = opts.level && state.nodes[opts.level] ? opts.level : null;
  const all = viewEdgesOf(state);
  const hidden = hiddenNodes(state, 'viewport');
  const drawn = opts.showHidden ? null : drawnNodes(state, all, hidden);
  const here = Object.keys(state.nodes).filter((id) => levels.get(id) === level);
  const visible = here.filter((id) => !drawn || drawn.has(id));
  const sidecars = new Set(opts.showAnimation ? [] : visible.filter((id) => isSidecar(state, id)));
  const shown = new Set(visible.filter((id) => !sidecars.has(id)));
  const wires = all.filter((w) => shown.has(w.from) && shown.has(w.to));
  const rows = viewRowsOf(wires);

  // A hidden sidecar's line becomes a tint on the row it would have arrived on.
  const tinted = new Map<NodeId, GraphInputRow[]>();
  for (const w of all) {
    if (!sidecars.has(w.from) || !shown.has(w.to)) continue;
    const list = tinted.get(w.to) ?? [];
    const at = list.findIndex((r) => r.socket === w.toSocket);
    if (at >= 0) list[at] = { ...list[at], count: list[at].count + 1 };
    else list.push({ socket: w.toSocket, count: 1, ref: true, tint: state.nodes[w.from].type });
    tinted.set(w.to, list);
  }

  const away = new Map<NodeId, number>();
  for (const w of all) {
    const a = levels.get(w.from) ?? null;
    const b = levels.get(w.to) ?? null;
    if (a === b || a === w.to || b === w.from) continue;
    if (shown.has(w.from)) away.set(w.from, (away.get(w.from) ?? 0) + 1);
    if (shown.has(w.to)) away.set(w.to, (away.get(w.to) ?? 0) + 1);
  }

  const inside = new Map<NodeId, number>();
  for (const owner of levels.values()) if (owner) inside.set(owner, (inside.get(owner) ?? 0) + 1);
  const flagged = (id: NodeId): GraphFlag[] =>
    (['scene', 'render'] as const).filter((o) => state.outputs[o]?.node === id);
  const timed = timeDependentNodes(state);
  const followed = (id: NodeId): string | null => {
    const source = relationsOf(state, id).follows;
    return source && state.nodes[source] ? nodeDisplayName(state.nodes, source) : null;
  };
  const nodes = here
    .filter((id) => shown.has(id))
    .map((id) => ({
      id,
      type: state.nodes[id].type,
      name: nodeDisplayName(state.nodes, id),
      inputs: withTints(rows.inputs.get(id) ?? [], tinted.get(id) ?? []),
      outputs: rows.outputs.get(id) ?? [],
      hidden: hidden.has(id),
      inside: inside.get(id) ?? 0,
      flags: flagged(id),
      timeDependent: timed.has(id),
      away: away.get(id) ?? 0,
      namedAfter: followed(id),
    }));

  const path: NodeId[] = [];
  for (let at: NodeId | null = level; at; at = levels.get(at) ?? null) path.unshift(at);
  return {
    nodes,
    wires,
    omitted: here.length - visible.length,
    animation: sidecars.size,
    path,
  };
}
