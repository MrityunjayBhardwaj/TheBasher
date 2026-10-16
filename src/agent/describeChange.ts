// describeChange — what an agent's ops did, in a director's words (#1612).
//
// The chat, the review bar and the undo step used to name an agent change by its tool calls:
// `mesh.add, mesh.add, mesh.add`, and in the chat the call's JSON with its generated ids. This
// reads the change itself instead — the ops and the scene they apply to — so every tool, and the
// next one, is described without a sentence written per tool, and the three surfaces say the
// same thing because they ask the same function.
//
// What counts as a THING: the agent adds a cube as four ops (a `BoxData`, an `Object`, and two
// edges); the person added one cube. An added node is folded into whatever it feeds when that
// is added too (the data half into its Object), and into the node it feeds when that node was
// already there (a constraint added onto a cube is a change to the cube), except for the Scene,
// which everything feeds. Edits name the object a person sees: a write to a cube's data half
// is a change to the cube.
//
// Names come from `nodeDisplayName`, the outliner's own answer, so a description never names a
// thing differently from the outliner.
//
// REF: src/app/addPrimitives.ts (`buildAddPrimitiveOps`, the shapes an add takes);
//      src/app/sceneTreeWalk.ts (`nodeDisplayName`); src/agent/orchestrator.ts (the callers).

import type { DagState } from '../core/dag/state';
import type { Node, NodeId, Op } from '../core/dag/types';
import { nodeDisplayName } from '../app/sceneTreeWalk';

const DATA_NOUN: Record<string, string> = {
  BoxData: 'cube',
  SphereData: 'sphere',
  CameraData: 'camera',
  CurveData: 'path',
  Skeleton: 'armature',
};

const TYPE_NOUN: Record<string, string> = {
  Null: 'empty',
  AmbientLight: 'ambient light',
  Group: 'group',
  Transform: 'transform',
};

/** `TrackTo` → `track to`: a readable fallback for a type with no word of its own. */
function typeWords(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function plural(noun: string): string {
  const words = noun.split(' ');
  const last = words.pop()!;
  const p = /[^aeiou]y$/.test(last)
    ? `${last.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(last)
      ? `${last}es`
      : `${last}s`;
  return [...words, p].join(' ');
}

function counted(noun: string, n: number): string {
  if (n === 1) return `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
  return `${n} ${plural(noun)}`;
}

/** `a`, `a and b`, `a, b and c`. */
function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** At most three names, then how many more. */
function names(items: string[]): string {
  if (items.length <= 3) return list(items);
  return `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`;
}

function refsOf(node: Node | undefined): NodeId[] {
  if (!node) return [];
  const out: NodeId[] = [];
  for (const b of Object.values(node.inputs ?? {})) {
    for (const r of Array.isArray(b) ? b : [b])
      if (r && typeof r.node === 'string') out.push(r.node);
  }
  return out;
}

/**
 * One sentence for what `ops` do to `before`, e.g. "Added 3 cubes and an area light, changed
 * Cube". Empty when the ops change nothing a person would name.
 */
export function describeChange(before: DagState, ops: readonly Op[]): string {
  const nodes = before.nodes;
  const added = new Map<NodeId, { type: string; params: Record<string, unknown> }>();
  const removed = new Set<NodeId>();
  for (const op of ops) {
    if (op.type === 'addNode')
      added.set(op.nodeId, {
        type: op.nodeType,
        params: (op.params ?? {}) as Record<string, unknown>,
      });
    else if (op.type === 'removeNode') removed.add(op.nodeId);
  }

  // The edges this batch makes, by the node they leave.
  const feeds = new Map<NodeId, NodeId[]>();
  for (const op of ops) {
    if (op.type !== 'connect') continue;
    const to = feeds.get(op.from.node) ?? [];
    to.push(op.to.node);
    feeds.set(op.from.node, to);
  }
  const isScene = (id: NodeId) => (added.get(id)?.type ?? nodes[id]?.type) === 'Scene';

  // An existing node's change is shown on the object a person sees: the Object whose data it is.
  const ownerOf = (id: NodeId): NodeId => {
    for (const [oid, n] of Object.entries(nodes)) {
      if (n.type !== 'Object') continue;
      const data = n.inputs?.data;
      if (data && !Array.isArray(data) && data.node === id) return oid;
    }
    return id;
  };

  const changed: NodeId[] = [];
  const change = (id: NodeId) => {
    if (added.has(id) || removed.has(id) || !nodes[id] || isScene(id)) return;
    const owner = ownerOf(id);
    if (!changed.includes(owner)) changed.push(owner);
  };

  // Added things, by noun, in the order they were added.
  const addedNouns = new Map<string, number>();
  for (const [id, a] of added) {
    const into = feeds.get(id) ?? [];
    if (into.some((t) => added.has(t))) continue; // a part of something else added here
    const existing = into.filter((t) => !isScene(t));
    if (a.type !== 'Object' && existing.length > 0) {
      existing.forEach(change); // added onto something already there
      continue;
    }
    let noun = TYPE_NOUN[a.type] ?? typeWords(a.type);
    if (a.type === 'Object') {
      const dataId = ops.find(
        (o) => o.type === 'connect' && o.to.node === id && o.to.socket === 'data',
      );
      const dId = dataId && dataId.type === 'connect' ? dataId.from.node : undefined;
      const d = dId ? (added.get(dId) ?? nodes[dId]) : undefined;
      const lightKind = d && (d.params as { lightKind?: unknown }).lightKind;
      noun =
        d?.type === 'LightData'
          ? typeof lightKind === 'string'
            ? `${lightKind.toLowerCase()} light`
            : 'light'
          : d
            ? (DATA_NOUN[d.type] ?? 'object')
            : 'object';
    }
    addedNouns.set(noun, (addedNouns.get(noun) ?? 0) + 1);
  }

  // Removed things: a node is folded into another removed node it fed.
  const removedNames: string[] = [];
  for (const id of removed) {
    if (!nodes[id]) continue;
    const fedRemoved = Object.entries(nodes).some(
      ([oid, n]) => oid !== id && removed.has(oid) && refsOf(n).includes(id),
    );
    if (!fedRemoved) removedNames.push(nodeDisplayName(nodes, id));
  }

  for (const op of ops) {
    switch (op.type) {
      case 'setParam':
      case 'setMeta':
      case 'setSpareParam':
      case 'removeSpareParam':
        change(op.nodeId);
        break;
      case 'connect':
      case 'disconnect':
        if (!added.has(op.from.node) && !removed.has(op.from.node)) change(op.to.node);
        break;
    }
  }

  const clauses: string[] = [];
  if (addedNouns.size > 0)
    clauses.push(`added ${list([...addedNouns].map(([noun, n]) => counted(noun, n)))}`);
  if (removedNames.length > 0) clauses.push(`removed ${names(removedNames)}`);
  if (changed.length > 0)
    clauses.push(`changed ${names(changed.map((id) => nodeDisplayName(nodes, id)))}`);
  const s = clauses.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
