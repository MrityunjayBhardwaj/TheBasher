// sceneGraph — the scene as nodes and wires, for the read-only Graph editor space (#1675, the
// first slice of the §16 node view #1563).
//
// `sceneGraphOf` reads the DAG into what the view draws, one level at a time. It owns no
// relationship and no position of its own: the wires and references are `viewEdgesOf` and the
// levels `levelOf`, both in src/core/dag/layout.ts beside `layoutOf`, which says where each
// node sits. This file only decides what is worth drawing: hidden pieces are left out, and the
// space they would take stays empty, so showing them never moves anything else.
//
// REF: src/core/dag/layout.ts (viewEdgesOf, viewRowsOf, levelOf); src/app/collections.ts
//      (hiddenNodes).

import { levelOf, viewEdgesOf, viewRowsOf, type ViewEdge, type ViewRow } from '../core/dag/layout';
import type { DagState } from '../core/dag/state';
import type { NodeId, NodeRef } from '../core/dag/types';
import { hiddenNodes } from './collections';
import { nodeDisplayName } from './sceneTreeWalk';

export type GraphInputRow = ViewRow;
export type GraphWire = ViewEdge;

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
}

export interface SceneGraph {
  readonly nodes: readonly GraphNode[];
  readonly wires: readonly GraphWire[];
  /** Nodes of this level left out because everything they draw is hidden (0 when
   *  `showHidden`). */
  readonly omitted: number;
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

/**
 * What the view draws at one level: the top level (`level` null or absent), or the sub-network
 * of the owner named. A level that no longer exists (its owner was deleted) reads as the top.
 */
export function sceneGraphOf(
  state: DagState,
  opts: { showHidden: boolean; level?: NodeId | null },
): SceneGraph {
  const levels = levelOf(state);
  const level = opts.level && state.nodes[opts.level] ? opts.level : null;
  const all = viewEdgesOf(state);
  const hidden = hiddenNodes(state, 'viewport');
  const drawn = opts.showHidden ? null : drawnNodes(state, all, hidden);
  const here = Object.keys(state.nodes).filter((id) => levels.get(id) === level);
  const shown = new Set(here.filter((id) => !drawn || drawn.has(id)));
  const wires = all.filter((w) => shown.has(w.from) && shown.has(w.to));
  const rows = viewRowsOf(wires);

  const inside = new Map<NodeId, number>();
  for (const owner of levels.values()) if (owner) inside.set(owner, (inside.get(owner) ?? 0) + 1);
  const nodes = here
    .filter((id) => shown.has(id))
    .map((id) => ({
      id,
      type: state.nodes[id].type,
      name: nodeDisplayName(state.nodes, id),
      inputs: rows.inputs.get(id) ?? [],
      outputs: rows.outputs.get(id) ?? [],
      hidden: hidden.has(id),
      inside: inside.get(id) ?? 0,
    }));

  const path: NodeId[] = [];
  for (let at: NodeId | null = level; at; at = levels.get(at) ?? null) path.unshift(at);
  return { nodes, wires, omitted: here.length - nodes.length, path };
}
