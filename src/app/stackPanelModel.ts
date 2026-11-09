// stackPanelModel — what the stack panel shows for each row of the translator's tree (#1817).
//
// Pure, so it is tested without a browser: the React panel (`StackPanel.tsx`) only lays it out and
// keeps which groups are open. Nothing here decides what an edit does; that is `stackEdit.ts`, and
// what the panel offers to add is what `planStackEdit` would accept, found by asking it.
//
// REF: issue #1817 and the mockup on #1815; src/app/stackTree.ts; src/app/stackEdit.ts.

import { getNodeType, listNodeTypes, mainInputOfType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { TEMPLATE_DEFINITION_TYPE, templatesOf } from '../core/dag/templates';
import type { NodeRef } from '../core/dag/types';
import { nodeDisplayName } from './sceneTreeWalk';
import { muteParamOf, planStackEdit, type StackPlace } from './stackEdit';
import { laneObjectOf, type StackGroup, type StackNodeRow, type StackRow } from './stackTree';

/** `TrackTo` reads "Track To"; a template type reads its definition's label. */
export function typeLabel(state: DagState, type: string): string {
  const template = templatesOf(state).get(type);
  if (template) return template.definition.label;
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return `(${value.map(formatValue).join(', ')})`;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value)?.slice(0, 24) ?? '—';
};

/** A param a wired input of the same name stands in for: its value is held, and not used. */
export interface Overridden {
  readonly param: string;
  readonly value: string;
}

export interface RowView {
  readonly name: string;
  readonly type: string;
  /** What kind of row this is, in a word or two: "constraint", "blend · 3 inputs". */
  readonly tag: string | null;
  readonly overridden: readonly Overridden[];
  /** A template instance's exposed params with their values, unwired ones only. */
  readonly exposed: readonly Overridden[];
  /** A blended step's influence: its number, or that a wire drives it. */
  readonly influence: string | null;
  /** Null when the type has no mute. */
  readonly muted: boolean | null;
}

/** What a person reads a node as: its name, or its type when nobody named it. */
export function nameOf(state: DagState, nodeId: string): string {
  const named = nodeDisplayName(state.nodes, nodeId);
  const type = state.nodes[nodeId]?.type;
  return named === nodeId && type ? typeLabel(state, type) : named;
}

export function rowView(state: DagState, row: StackNodeRow): RowView {
  const node = state.nodes[row.nodeId];
  const def = getNodeType(row.nodeType);
  const params = (node?.params ?? {}) as Record<string, unknown>;
  const wired = (socket: string) => node?.inputs[socket] !== undefined;
  const overridden = Object.keys(def?.inputs ?? {})
    .filter((socket) => socket in params && wired(socket))
    .map((param) => ({ param, value: formatValue(params[param]) }));
  const groups = row.groups.length;
  let tag: string | null = null;
  if (row.template) {
    tag = `template · ${row.template.instances} instance${row.template.instances === 1 ? '' : 's'}`;
  } else if (def?.worldStep) tag = 'constraint';
  // An object's groups are its lanes, not operands of one operation, so it isn't counted.
  else if (mainInputOfType(row.nodeType) === null && groups > 1 && !def?.outputs.world) {
    tag = `${groups} inputs`;
  }
  const factor = row.blend?.factor;
  const holder = factor ? state.nodes[factor.node] : undefined;
  const influence = !row.blend
    ? null
    : holder?.type === 'Value'
      ? formatValue((holder.params as { value?: unknown }).value)
      : 'wired';
  const mute = muteParamOf(def);
  return {
    // A node nobody named reads as its type: an id like `data_mw7iys99` says nothing to a person.
    name: nameOf(state, row.nodeId),
    type: typeLabel(state, row.nodeType),
    tag,
    overridden,
    exposed: (row.template?.exposed ?? [])
      .filter((param) => !wired(param))
      .map((param) => ({ param, value: formatValue(params[param]) })),
    influence,
    muted: mute ? params[mute] === true : null,
  };
}

/** How many rows a collapsed group holds, at any depth, so a closed group still says its size. */
export function rowCount(rows: readonly StackRow[]): number {
  return rows.reduce(
    (n, row) =>
      n +
      1 +
      (row.kind === 'node'
        ? row.groups.reduce((m, g) => m + rowCount(g.rows), 0) +
          (row.template ? rowCount(row.template.inside) : 0)
        : 0),
    0,
  );
}

export const groupLabel = (group: StackGroup): string =>
  `${group.socket}${group.index === null ? '' : ` ${group.index + 1}`}`;

/**
 * For every full row, the keys of the groups and template insides it sits in, outermost first: what
 * has to be open to show it. A "same as" row opens these to jump to the node it stands for.
 */
export function openPaths(rows: readonly StackRow[]): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>();
  const walk = (list: readonly StackRow[], path: readonly string[]) => {
    for (const row of list) {
      if (row.kind !== 'node') continue;
      paths.set(row.nodeId, path);
      for (const g of row.groups) walk(g.rows, [...path, g.key]);
      if (row.template) walk(row.template.inside, [...path, `${row.key}:inside`]);
    }
  };
  walk(rows, []);
  return paths;
}

/** The empty sockets of a row, where a new route can go: what "+ socket" offers. */
export function emptySockets(state: DagState, row: StackNodeRow): string[] {
  const node = state.nodes[row.nodeId];
  const def = getNodeType(row.nodeType);
  if (!node || !def) return [];
  return Object.entries(def.inputs ?? {})
    .filter(([socket, input]) => !input.available && !input.body && !node.inputs[socket])
    .map(([socket]) => socket);
}

/** A type the place would take, and what it reads as. */
export interface Offer {
  readonly type: string;
  readonly label: string;
}

/**
 * Every type `planStackEdit` would accept at `place`, by asking it. Asked when a person opens the
 * menu, not on every draw: a list worked out from socket types alone would drift from what the
 * edit accepts, and a menu offering what then gets refused is a menu that lies.
 */
export function offersAt(state: DagState, output: NodeRef, place: StackPlace): Offer[] {
  const above = 'above' in place;
  const offers: Offer[] = [];
  for (const type of listNodeTypes()) {
    if (type === TEMPLATE_DEFINITION_TYPE) continue;
    const def = getNodeType(type);
    if (!def || def.bodyInputLeaf) continue;
    if (above && !mainInputOfType(type)) continue;
    let id = `${type.replace(/\W/g, '_')}_new`;
    while (state.nodes[id]) id += '_';
    const plan = planStackEdit(state, output, { kind: 'add', nodeId: id, nodeType: type, place });
    if (plan.ok) offers.push({ type, label: typeLabel(state, type) });
  }
  return offers.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The object whose Constraint Stack a selected node shows: a constraint step's own object (its
 * `target`), or the object whose lane a hand-wired node (a Mix, a Lag) feeds, so selecting any row
 * keeps the stack on screen, as the old Constraints card did.
 */
export function stackObjectOf(state: DagState, nodeId: string): string {
  const node = state.nodes[nodeId];
  if (node && getNodeType(node.type)?.worldStep) {
    const target = (node.params as { target?: unknown }).target;
    if (typeof target === 'string' && state.nodes[target]) return target;
  }
  return laneObjectOf(state, nodeId) ?? nodeId;
}

/** A fresh id for a node of `type`, which no node holds. */
export function freshId(state: DagState, type: string): string {
  const base = type.replace(/^template\./, '').replace(/\W/g, '_');
  for (let i = 1; ; i++) {
    const id = `${base}_${i}`;
    if (!state.nodes[id]) return id;
  }
}
