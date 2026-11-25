// stackPanelModel — what the stack panel shows for each row of the translator's tree (#1817).
//
// Pure, so it is tested without a browser: the React panel (`StackPanel.tsx`) only lays it out and
// keeps which groups are open. Nothing here decides what an edit does; that is `stackEdit.ts`, and
// what the panel offers to add is what `planStackEdit` would accept, found by asking it.
//
// REF: issue #1817 and the mockup on #1815; src/app/stackTree.ts; src/app/stackEdit.ts.

import { getNodeType, listNodeTypes, mainInputOfType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { TEMPLATE_DEFINITION_TYPE } from '../core/dag/templates';
import type { NodeRef } from '../core/dag/types';
// The row's read model lives in `layerView.ts` (#1894 S1): it derives a row from the declared
// contract + the render-identical resolver, so read == render and the view names no node kind.
// Re-exported here so `StackPanel.tsx` and the tests keep their one import of the panel model.
import { typeLabel } from './layerView';
import { planStackEdit, type StackPlace } from './stackEdit';
import { laneObjectOf, type StackGroup, type StackNodeRow, type StackRow } from './stackTree';

export { layerView as rowView, nameOf, typeLabel, formatValue } from './layerView';
export type { Overridden, RowView } from './layerView';

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
