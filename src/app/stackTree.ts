// stackTree — any graph upstream of an output, as the layered stack a panel draws (#1815).
//
// The stack is computed from the wires and stores nothing, so it can't drift from the node view:
//   1. the top row is the output, and each row sits on top of the one below it;
//   2. a node's main input (`mainInputOfType`, #1814) continues flat underneath it;
//   3. every other wired input is a group headed by its wire type and socket, with its own stack,
//      and so is a setting that names what an input would read (`worldRefs`), marked a reference;
//   4. a node with no main input is only groups, in socket order, one per wire; a switch marks the
//      route it has picked;
//   5. a node reached twice is drawn in full once, and is a "same as" row everywhere else;
//   6. a node with consumers outside the view lists them;
//   7. a template lists its exposed params, its inputs are routes, and its body is `inside`, by
//      these same rules, with the inputs it reads from outside marked as boundaries.
//
// A flat run is walked before the groups hanging off it, so a node both a run and a group reach is
// drawn in the run, where it is part of the stack, and the group points at it.
//
// A step with an influence is six small nodes around one constraint (`chainEdit.ts`), and what a
// person reads there is one row with a number on it, so `readBlend`'s shape folds into its step. A
// blend that isn't exactly that shape draws node by node, as a hand-wired graph should.
//
// REF: issue #1815 and its mockup; src/core/dag/registry.ts (`mainInputOfType`);
//      src/core/dag/chainEdit.ts (`readBlend`); ref GROUND_TRUTH_STACK_VIEWS.

import type { z } from 'zod';
import { readBlend, type StepBlend } from '../core/dag/chainEdit';
import { getNodeType, mainInputOfType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { bodyInputOwnerOf } from '../core/dag/subnetworks';
import {
  isLocked,
  TEMPLATE_BODY_SOCKET,
  TEMPLATE_LOCKED_PARAM,
  templatesOf,
} from '../core/dag/templates';
import type { Node, NodeRef } from '../core/dag/types';
import { pickCameraSelect } from '../nodes/CameraSelect';

export interface StackGroup {
  /** Stable while the wires are: what a panel keeps a group's open state by. */
  readonly key: string;
  readonly socket: string;
  /** Which wire of a list socket this route is, or null for a single one. */
  readonly index: number | null;
  /** What the wire carries, read off the output feeding it. */
  readonly wireType: string;
  /** The param naming this route's node, when a name stands in for the wire; else null. */
  readonly reference: string | null;
  /** A switch's picked route. False on everything else. */
  readonly active: boolean;
  readonly rows: readonly StackRow[];
}

export interface StackTemplate {
  /** The params an instance exposes on its row. */
  readonly exposed: readonly string[];
  /** How many instances of this template the graph holds, this one included. */
  readonly instances: number;
  readonly locked: boolean;
  readonly inside: readonly StackRow[];
}

export interface StackNodeRow {
  readonly kind: 'node';
  /** The node id: a node has one full row. */
  readonly key: string;
  readonly nodeId: string;
  readonly nodeType: string;
  /** The output the wire above reads, or the view's output on the top row. */
  readonly outputSocket: string;
  /** What reads this node from outside the view. */
  readonly usedBy: readonly string[];
  /** The blend folded into this row, whose `factor` is the influence; null on an unblended row. */
  readonly blend: StepBlend | null;
  /** A body input: what it reads and whose. `owner` is null when it reads its default. */
  readonly boundary: { readonly input: string; readonly owner: string | null } | null;
  readonly template: StackTemplate | null;
  readonly groups: readonly StackGroup[];
}

export interface StackSameRow {
  readonly kind: 'same';
  readonly key: string;
  /** The node drawn in full elsewhere; its full row's key is this id. */
  readonly nodeId: string;
  readonly outputSocket: string;
}

export type StackRow = StackNodeRow | StackSameRow;

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const refsOf = (binding: unknown): NodeRef[] =>
  Array.isArray(binding) ? (binding as NodeRef[]) : binding ? [binding as NodeRef] : [];

const single = (binding: unknown): NodeRef | null =>
  binding && !Array.isArray(binding) ? (binding as NodeRef) : null;

const sameRef = (a: NodeRef | null, b: NodeRef | null) =>
  a !== null && b !== null && a.node === b.node && a.socket === b.socket;

/** The setting `socket` reads through instead of a wire, when one names a node (a wire wins). */
function referenceOf(state: DagState, node: Node, socket: string): NodeRef | null {
  const param = getNodeType(node.type)?.worldRefs?.[socket];
  const named = param ? (node.params as Record<string, unknown>)[param] : undefined;
  if (refsOf(node.inputs[socket]).length > 0 || typeof named !== 'string') return null;
  const outputs = getNodeType(state.nodes[named]?.type ?? '')?.outputs;
  return outputs?.world ? { node: named, socket: 'world' } : null;
}

/** Every input of `node` with something to draw: declared sockets in order, then anything else. */
function drawnSockets(state: DagState, node: Node): string[] {
  const declared = Object.keys(getNodeType(node.type)?.inputs ?? {});
  const bound = Object.keys(node.inputs).filter((s) => refsOf(node.inputs[s]).length > 0);
  return [
    ...declared.filter((s) => bound.includes(s) || referenceOf(state, node, s)),
    ...bound.filter((s) => !declared.includes(s)),
  ];
}

/**
 * The route a switch has picked, or null when `node` is no switch or its pick matches nothing. This
 * reads the param as stored, so a keyed switch shows its stored pick, not the one at the playhead.
 */
function activeRoute(state: DagState, node: Node, refs: readonly NodeRef[]): number | null {
  const params = node.params as Record<string, unknown>;
  const byName = (name: unknown) => {
    const i = refs.findIndex(
      (r) => (state.nodes[r.node]?.params as { name?: unknown } | undefined)?.name === name,
    );
    return i < 0 ? null : i;
  };
  if (node.type === 'CameraSelect')
    return pickCameraSelect(
      String(params.active ?? ''),
      refs.map((r) => r.node),
    );
  if (node.type === 'ClipSelect') return byName(params.selectedClipName);
  if (node.type === 'LightProfileSelect') return byName(params.selectedProfile);
  return null;
}

function wireTypeOf(state: DagState, ref: NodeRef): string {
  const type = getNodeType(state.nodes[ref.node]?.type ?? '')?.outputs?.[ref.socket]?.type;
  return Array.isArray(type) ? type.join(' | ') : String(type ?? 'unknown');
}

/** The stack upstream of `output`, top row first. Empty when `output` names no node. */
export function stackOf(state: DagState, output: NodeRef): StackRow[] {
  const full = new Set<string>();
  // Everything the view draws, folded nodes included: what reads a node from here is not "outside".
  const view = new Set<string>();
  const drawn: { row: Writable<StackNodeRow>; ids: string[] }[] = [];
  const templates = templatesOf(state);

  /** The step a blend folds into, when its factor is shared and the step reads what it blends. */
  const foldAt = (id: string): { step: string; blend: StepBlend; below: NodeRef } | null => {
    const fold = readBlend(state, id);
    if (!fold?.blend.factor) return null;
    return sameRef(single(state.nodes[fold.step]?.inputs.in), fold.below) ? fold : null;
  };

  const templateOf = (node: Node, rowKey: string): StackTemplate | null => {
    if (!templates.has(node.type)) return null;
    const schema = getNodeType(node.type)?.paramSchema as z.AnyZodObject | undefined;
    const body = single(node.inputs[TEMPLATE_BODY_SOCKET]);
    return {
      exposed: Object.keys(schema?.shape ?? {}).filter((p) => p !== TEMPLATE_LOCKED_PARAM),
      instances: Object.values(state.nodes).filter((n) => n.type === node.type).length,
      locked: isLocked(node),
      inside: body ? walk(body, `${rowKey}:inside`) : [],
    };
  };

  const groupsOf = (node: Node, rowKey: string, main: string | null): StackGroup[] => {
    const groups: StackGroup[] = [];
    const isTemplate = templates.has(node.type);
    for (const socket of drawnSockets(state, node)) {
      if (socket === main || (isTemplate && socket === TEMPLATE_BODY_SOCKET)) continue;
      const binding = node.inputs[socket];
      const named = referenceOf(state, node, socket);
      const refs = named ? [named] : refsOf(binding);
      const active = activeRoute(state, node, refs);
      refs.forEach((ref, i) => {
        const index = Array.isArray(binding) ? i : null;
        const key = `${rowKey}:${socket}${index === null ? '' : `[${i}]`}`;
        groups.push({
          key,
          socket,
          index,
          wireType: wireTypeOf(state, ref),
          reference: named ? (getNodeType(node.type)?.worldRefs?.[socket] ?? null) : null,
          active: active === i,
          rows: walk(ref, key),
        });
      });
    }
    return groups;
  };

  const walk = (start: NodeRef, parentKey: string): StackRow[] => {
    const rows: StackRow[] = [];
    const run: {
      row: Writable<StackNodeRow>;
      node: Node;
      fold: ReturnType<typeof foldAt>;
      main: string | null;
    }[] = [];
    for (let at: NodeRef | null = start; at && state.nodes[at.node]; ) {
      const fold = foldAt(at.node);
      const id: string = fold?.step ?? at.node;
      const node: Node | undefined = state.nodes[id];
      if (!node) break;
      if (full.has(id)) {
        rows.push({
          kind: 'same',
          key: `${parentKey}/${id}`,
          nodeId: id,
          outputSocket: at.socket,
        });
        break;
      }
      full.add(id);
      view.add(id);
      if (fold) {
        const { under, over, location, rotation, stretch, place, out } = fold.blend;
        for (const part of [under, over, location, rotation, stretch, place, out]) view.add(part);
      }
      const main: string | null = mainInputOfType(node.type) ?? null;
      const leafInput = getNodeType(node.type)?.bodyInputLeaf
        ? (node.params as { input?: unknown }).input
        : undefined;
      const row: Writable<StackNodeRow> = {
        kind: 'node',
        key: id,
        nodeId: id,
        nodeType: node.type,
        outputSocket: at.socket,
        usedBy: [],
        blend: fold?.blend ?? null,
        boundary:
          typeof leafInput === 'string'
            ? { input: leafInput, owner: bodyInputOwnerOf(state, id) ?? null }
            : null,
        template: null,
        groups: [],
      };
      drawn.push({ row, ids: fold ? [id, fold.blend.out] : [id] });
      run.push({ row, node, fold, main });
      rows.push(row);
      at = fold ? fold.below : main ? single(node.inputs[main]) : null;
    }
    for (const { row, node, fold, main } of run) {
      const groups = groupsOf(node, row.key, main);
      const factor = fold?.blend.factor;
      if (factor) {
        const key = `${row.key}:factor`;
        groups.push({
          key,
          socket: 'factor',
          index: null,
          wireType: wireTypeOf(state, factor),
          reference: null,
          active: false,
          rows: walk(factor, key),
        });
      }
      row.groups = groups;
      row.template = templateOf(node, row.key);
    }
    return rows;
  };

  const rows = walk(output, '');

  const readers = new Map<string, Set<string>>();
  for (const node of Object.values(state.nodes)) {
    const read = [
      ...Object.values(node.inputs).flatMap(refsOf),
      ...Object.keys(getNodeType(node.type)?.worldRefs ?? {}).flatMap(
        (socket) => referenceOf(state, node, socket) ?? [],
      ),
    ];
    for (const ref of read) {
      let set = readers.get(ref.node);
      if (!set) readers.set(ref.node, (set = new Set()));
      set.add(node.id);
    }
  }
  for (const { row, ids } of drawn) {
    row.usedBy = ids
      .flatMap((id) => [...(readers.get(id) ?? [])])
      .filter((reader, i, all) => !view.has(reader) && all.indexOf(reader) === i)
      .sort();
  }
  return rows;
}
