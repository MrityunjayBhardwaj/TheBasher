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
//   • a wire into or out of a socket the node's mode has switched off is not drawn (#1825):
//     Blender keeps such a link but hides it (`node_link_is_hidden` needs both sockets visible,
//     and a socket is visible only while available, BKE_node_runtime.hh `is_visible`); the
//     evaluator ignores it, so drawing it would show a value flowing where none does;
//   • a node that follows another's name says whose (in its tooltip: today every one is also
//     wired to the node it follows, so a line would only repeat the wire);
//   • #1716 — a row where a run of frames enters a still input says which frame it picks (the
//     first, today), so the wire shows a still being taken from frames rather than hiding it.
//
// REF: src/core/dag/layout.ts (viewEdgesOf, viewRowsOf, levelOf); src/app/collections.ts
//      (hiddenNodes); src/app/timeDependence.ts (timeDependentNodes).

import { brokenInputsOf, inputsOfNode, outputsOfNode } from '../core/dag/instanceSockets';
import { levelOf, viewEdgesOf, viewRowsOf, type ViewEdge, type ViewRow } from '../core/dag/layout';
import type { DagState } from '../core/dag/state';
import type { InputDescriptor, NodeId, NodeRef, OutputDescriptor } from '../core/dag/types';
import { evaluate, evaluateInputRef, type EvaluatorCache } from '../core/dag/evaluator';
import { imageTakeOf, isImageValueLike } from '../core/dag/imageExtent';
import { relationsOf } from '../core/dag/idRefSweep';
import { getNodeType } from '../core/dag/registry';
import { inputAvailable, outputAvailable } from '../core/dag/socketAvailability';
import { hiddenNodes } from './collections';
import { childIdsOf } from './sceneHierarchy';
import { nodeDisplayName } from './sceneTreeWalk';
import { timeDependentNodes } from './timeDependence';

export interface GraphInputRow extends ViewRow {
  /** Set when what drives this row is hidden: the type of the first node driving it, so the
   *  row takes its colour. */
  readonly tint?: string;
  /** #1716 — set on a still input fed a run of frames: the frame each such wire picks, in wire
   *  order. Absent when nothing is picked. */
  readonly picks?: readonly number[];
  /** #1715 — on a node whose sockets come from its settings (a workflow node's file): what the
   *  socket takes, in words ("still image", "frames", "number", "text"). Such a node draws every
   *  socket it has, wired or not, so the file's sockets can be read off the node. */
  readonly socketType?: string;
  /** #1715 — a wire kept on a socket the node's file no longer has: read as unconnected. */
  readonly broken?: true;
}

/**
 * #1716 — the frames picked on `id`'s wired input `socket`, or undefined when the input does not
 * take a still or every wire into it already carries one. Asks the evaluator's own arrival
 * (`evaluateInputRef`) at frame 0, so the row says what the node is really handed. Only still
 * inputs are evaluated, and a producer that cannot be evaluated yet shows no marker.
 */
function picksOn(
  state: DagState,
  id: NodeId,
  socket: string,
  cache: EvaluatorCache | undefined,
): number[] | undefined {
  const node = state.nodes[id];
  const def = node ? getNodeType(node.type) : undefined;
  const desc = def ? inputsOfNode(def, node.params)[socket] : undefined;
  if (imageTakeOf(desc, node?.params) !== 'still') return undefined;
  const picks: number[] = [];
  for (const ref of bindingRefs(node.inputs?.[socket])) {
    try {
      const v = evaluateInputRef(state, id, socket, ref, { cache }).value;
      if (isImageValueLike(v) && v.extent.kind === 'still' && v.extent.pickedFrame !== undefined)
        picks.push(v.extent.pickedFrame);
    } catch {
      // Not evaluable yet (an authoring state): nothing to say about the wire.
    }
  }
  return picks.length > 0 ? picks : undefined;
}

function withPicks(
  state: DagState,
  id: NodeId,
  rows: GraphInputRow[],
  cache: EvaluatorCache | undefined,
): GraphInputRow[] {
  return rows.map((r) => {
    if (r.ref) return r;
    const picks = picksOn(state, id, r.socket, cache);
    return picks ? { ...r, picks } : r;
  });
}
/** #1715 — a socket's type in words: an Image by what it takes, else its type name. */
function typeInWords(desc: InputDescriptor | OutputDescriptor, params: unknown): string {
  const take =
    'takes' in desc
      ? typeof desc.takes === 'function'
        ? desc.takes(params)
        : desc.takes
      : undefined;
  if (take === 'still') return 'still image';
  if (take === 'frames') return 'frames';
  const t = Array.isArray(desc.type) ? desc.type[0] : desc.type;
  if (t === 'Number') return 'number';
  if (t === 'String') return 'text';
  return String(t).toLowerCase();
}

/**
 * #1715 — a node whose sockets come from its settings draws all of them, each with its type, and
 * a row for every wire it keeps on a socket its file no longer has. Every other node draws the
 * rows its wires land on, as before.
 */
function withOwnSockets(
  state: DagState,
  id: NodeId,
  rows: GraphInputRow[],
  outputs: readonly string[],
  cache: EvaluatorCache | undefined,
): { inputs: GraphInputRow[]; outputs: readonly string[]; outputTypes?: Record<string, string> } {
  const node = state.nodes[id];
  const def = node ? getNodeType(node.type) : undefined;
  if (!node || !def?.instanceSockets) return { inputs: rows, outputs };
  const ins = inputsOfNode(def, node.params);
  const out: GraphInputRow[] = Object.entries(ins).map(([socket, desc]) => {
    const drawn = rows.find((r) => r.socket === socket && !r.ref);
    return {
      ...(drawn ?? { socket, count: 0, ref: false }),
      socketType: typeInWords(desc, node.params),
    };
  });
  for (const socket of brokenInputsOf(def, node)) {
    out.push({ socket, count: bindingRefs(node.inputs[socket]).length, ref: false, broken: true });
  }
  out.push(...rows.filter((r) => r.ref));
  const outs = outputsOfNode(def, node.params);
  const outputTypes: Record<string, string> = {};
  const extentOf = (socket: string) => {
    try {
      // The output's own value says whether it is a still or frames (#1716's extent).
      const v = evaluate(state, id, { socket, cache }).value;
      return isImageValueLike(v) ? (v.extent.kind === 'still' ? 'still image' : 'frames') : null;
    } catch {
      return null;
    }
  };
  for (const [socket, desc] of Object.entries(outs))
    outputTypes[socket] = extentOf(socket) ?? typeInWords(desc, node.params);
  return { inputs: out, outputs: Object.keys(outs), outputTypes };
}

export type GraphWire = ViewEdge;
export type GraphFlag = 'scene' | 'render';

export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  readonly name: string;
  readonly inputs: readonly GraphInputRow[];
  /** Output sockets something reads, in first-use order. #1715 — a node whose sockets come from
   *  its settings lists every output it has. */
  readonly outputs: readonly string[];
  /** #1715 — each listed output's type in words, for a node whose sockets come from its settings. */
  readonly outputTypes?: Readonly<Record<string, string>>;
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
  /** What `id` holds, however deep. Today every child is also wired into its holder, so this
   *  adds nothing to `upstream`; once a child takes its parent as an input (#1824), it is how a
   *  group still finds what it holds. */
  const descendants = (id: NodeId): Set<NodeId> => {
    const seen = new Set<NodeId>();
    const stack = [...childIdsOf(state, id)];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...childIdsOf(state, x));
    }
    return seen;
  };
  const drawable = (id: NodeId) =>
    !hidden.has(id) && bindingRefs(nodes[id]?.inputs?.data).length > 0;

  const keep = new Set<NodeId>(Object.keys(nodes).filter((id) => !hidden.has(id)));
  for (const id of keep) {
    if (childIdsOf(state, id).length === 0) continue;
    const sub = [...upstream(id), ...descendants(id)];
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

/** Whether a wire is live: both its sockets exist in their nodes' current modes. A reference
 *  is not a socket wire and always is. */
function live(state: DagState, w: ViewEdge): boolean {
  if (w.ref) return true;
  const a = state.nodes[w.from];
  const b = state.nodes[w.to];
  const da = a && getNodeType(a.type);
  const db = b && getNodeType(b.type);
  return (
    (!da || outputAvailable(da, a.params, w.fromSocket)) &&
    (!db || inputAvailable(db, b.params, w.toSocket))
  );
}

/**
 * What the view draws at one level: the top level (`level` null or absent), or the sub-network
 * of the owner named. A level that does not exist (its owner was deleted, or the node named
 * holds no sub-network) reads as the top.
 */
export function sceneGraphOf(
  state: DagState,
  opts: { showHidden: boolean; showAnimation?: boolean; level?: NodeId | null },
  /** #1716 — for the frame-pick markers, which evaluate a still input's producers. */
  cache?: EvaluatorCache,
): SceneGraph {
  const levels = levelOf(state);
  const owners = new Set(levels.values());
  const level = opts.level && owners.has(opts.level) ? opts.level : null;
  const all = viewEdgesOf(state).filter((w) => live(state, w));
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
    .map((id) => {
      const own = withOwnSockets(
        state,
        id,
        withPicks(state, id, withTints(rows.inputs.get(id) ?? [], tinted.get(id) ?? []), cache),
        rows.outputs.get(id) ?? [],
        cache,
      );
      return { id, own };
    })
    .map(({ id, own }) => ({
      id,
      type: state.nodes[id].type,
      name: nodeDisplayName(state.nodes, id),
      inputs: own.inputs,
      outputs: own.outputs,
      ...(own.outputTypes ? { outputTypes: own.outputTypes } : {}),
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
