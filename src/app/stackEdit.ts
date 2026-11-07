// stackEdit — what an edit in the stack does to the graph (#1816).
//
// Every place in a stack is a wire. A row is read through one (the row above's main input, or the
// socket its group stands for), so an edit is that wire moved, and rebuilding the stack from the
// graph gives back what the edit promised. Each edit plans one list of ops for one `dispatchAtomic`,
// so one undo takes it back, and plans nothing else: the panel only says what the person asked for.
//
// AN EDIT WITH MORE THAN ONE READING IS REFUSED, WITH THE REASON, instead of guessed:
//  - a node something else also reads: moving or deleting it here would change what they read, and
//    only the person knows whether that is meant. A row can still be added above it, because that
//    moves one wire.
//  - the top row of the view: it is the view's output, and what reads it is outside the view.
//  - a row a param names instead of a wire (`worldRefs`): that is the param's to change.
//  - the source of a blended step's influence: without one the step stops being one row.
//  - a node with more than one output added where the wire could take either.
//  - a constraint leaving its chain: it says in its own `target` whose chain it is on.
//  - an object moving between parents: that is Parent To, which also keeps it where it is.
//  - a new object: a wire doesn't put it in the scene, a collection does (#1823), and Add links it.
//
// The dry run (`assertCommits`) asks what the commit doors will ask, so a loop, a wrong wire type or
// a shape change inside a template is refused here with the doors' own words, not at dispatch.
//
// Constraint steps go through `chainEdit.ts`, which owns their blend and their bottom. Moving one
// inside its stack needs nothing of it: a blended row just has two input wires.
//
// REF: issue #1816; src/app/stackTree.ts (`stackOf`); src/core/dag/chainEdit.ts;
//      src/app/sceneNodeActions.ts (`planDeleteNodes`); src/core/dag/templates.ts (`templateEdits`).

import type { z } from 'zod';
import { addStepOps, readChain, removeStepOps } from '../core/dag/chainEdit';
import { bypassParamOf } from '../core/dag/chainBypass';
import { findNewDanglingIdRef } from '../core/dag/idRefSweep';
import { applyOps, GraphRefusal } from '../core/dag/ops';
import { getNodeType, mainInputOfType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import {
  TEMPLATE_BODY_SOCKET,
  TEMPLATE_DEFINITION_TYPE,
  TEMPLATE_LOCKED_PARAM,
  TEMPLATE_TYPE_PREFIX,
  templateEdits,
  templatesOf,
} from '../core/dag/templates';
import type { Node, NodeDefinition, NodeRef, Op } from '../core/dag/types';
import { canModifyGeometry, canWearMaterial } from './modifierGeometry';
import { isMaterialLaneOperator, isModifierNode } from './operatorChain';
import { planDeleteNodes } from './sceneNodeActions';
import { stackOf, type StackGroup, type StackNodeRow, type StackRow } from './stackTree';

/** Where a row lands: on top of a row, reading it, or on a socket of a row, as a route of its own. */
export type StackPlace =
  | { readonly above: string }
  | { readonly route: { readonly owner: string; readonly socket: string } };

/** Rows are named by their `key` from `stackOf`. */
export type StackEdit =
  | {
      readonly kind: 'add';
      readonly nodeId: string;
      readonly nodeType: string;
      readonly params?: Record<string, unknown>;
      readonly place: StackPlace;
    }
  | { readonly kind: 'delete'; readonly row: string }
  /** Within the row's flat run; `to` is its new index there, 0 on top. */
  | { readonly kind: 'move'; readonly row: string; readonly to: number }
  /** Into a group or out of one: the row alone, closing the gap it leaves. */
  | { readonly kind: 'regroup'; readonly row: string; readonly place: StackPlace }
  /** Within one list socket; `from` and `to` are positions in that list. */
  | {
      readonly kind: 'reorderRoutes';
      readonly row: string;
      readonly socket: string;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: 'mute'; readonly row: string }
  | { readonly kind: 'makeUnique'; readonly row: string };

export type StackEditPlan =
  | { readonly ok: true; readonly ops: Op[] }
  | { readonly ok: false; readonly reason: string };

/** One input a row is read through. `index` is its position in a list socket. */
interface Wire {
  readonly node: string;
  readonly socket: string;
  readonly index: number | null;
}

/** What reads the top row of a run. */
interface RunTop {
  /** Null on the view's own top row, which nothing in the view reads. */
  readonly wires: readonly Wire[] | null;
  /** The param naming the row, when a name stands in for the wire. */
  readonly reference: string | null;
  /** The route is a blended step's influence. */
  readonly factor: boolean;
}

interface Place {
  readonly row: StackRow;
  readonly run: readonly StackRow[];
  readonly index: number;
  readonly top: RunTop;
  /** What reads this row. Null on the view's own top row. */
  readonly slot: readonly Wire[] | null;
}

const refuse = (reason: string): never => {
  throw new GraphRefusal(reason);
};

const single = (socket: string, node: string): Wire => ({ node, socket, index: null });

/** The wires a row reads what is below it through: none at the bottom of a run. */
function entriesOf(row: StackNodeRow): Wire[] {
  if (row.blend) return [single('in', row.nodeId), single('transform', row.blend.under)];
  const main = mainInputOfType(row.nodeType);
  return main ? [single(main, row.nodeId)] : [];
}

function groupTop(row: StackNodeRow, group: StackGroup): RunTop {
  if (group.reference) return { wires: [], reference: group.reference, factor: false };
  if (row.blend && group.socket === 'factor') {
    const { location, rotation, stretch } = row.blend;
    return {
      wires: [location, rotation, stretch].map((mix) => single('factor', mix)),
      reference: null,
      factor: true,
    };
  }
  return {
    wires: [{ node: row.nodeId, socket: group.socket, index: group.index }],
    reference: null,
    factor: false,
  };
}

/** Every row of the view by key, with what reads it. */
function locate(state: DagState, output: NodeRef): Map<string, Place> {
  const places = new Map<string, Place>();
  const visit = (rows: readonly StackRow[], top: RunTop) => {
    rows.forEach((row, index) => {
      const above = rows[index - 1];
      const slot = above?.kind === 'node' ? entriesOf(above) : top.wires;
      places.set(row.key, { row, run: rows, index, top, slot });
      if (row.kind !== 'node') return;
      for (const group of row.groups) visit(group.rows, groupTop(row, group));
      if (row.template) {
        const body = single(TEMPLATE_BODY_SOCKET, row.nodeId);
        visit(row.template.inside, { wires: [body], reference: null, factor: false });
      }
    });
  };
  visit(stackOf(state, output), { wires: null, reference: null, factor: false });
  return places;
}

const placeOf = (places: ReadonlyMap<string, Place>, key: string): Place =>
  places.get(key) ?? refuse(`"${key}" is not a row of this stack`);

const nodeRowOf = (place: Place): StackNodeRow =>
  place.row.kind === 'node'
    ? place.row
    : refuse(`this row is a second use of "${place.row.nodeId}"; edit the full row`);

/** The output a row is read from. A blended step is read from its blend. */
function exitOf(places: ReadonlyMap<string, Place>, row: StackRow): NodeRef {
  const full = row.kind === 'node' ? row : places.get(row.nodeId)?.row;
  const blend = full?.kind === 'node' ? full.blend : null;
  return blend
    ? { node: blend.out, socket: 'out' }
    : { node: row.nodeId, socket: row.outputSocket };
}

const bindingAt = (state: DagState, wire: Wire): NodeRef | null => {
  const binding = state.nodes[wire.node]?.inputs[wire.socket];
  if (Array.isArray(binding)) return binding[wire.index ?? 0] ?? null;
  return binding ?? null;
};

/** The ops pointing `wires` at `from`, or leaving them empty. Only what changes. */
function rewire(state: DagState, wires: readonly Wire[], from: NodeRef | null) {
  const cuts: Op[] = [];
  const joins: Op[] = [];
  for (const wire of wires) {
    const was = bindingAt(state, wire);
    if (was && from && was.node === from.node && was.socket === from.socket) continue;
    const to = { node: wire.node, socket: wire.socket };
    if (was) cuts.push({ type: 'disconnect', from: was, to });
    if (from) {
      joins.push({
        type: 'connect',
        from,
        to,
        ...(wire.index !== null ? { index: wire.index } : {}),
      });
    }
  }
  return { cuts, joins };
}

/** What reads this row besides the wires of its own slot: the shared nodes a move would change. */
function otherReaders(state: DagState, place: Place): string[] {
  const row = nodeRowOf(place);
  const own = row.blend ? [row.nodeId, row.blend.out] : [row.nodeId];
  const slot = new Set((place.slot ?? []).map((w) => `${w.node}.${w.socket}`));
  const readers = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    if (node.id === row.blend?.over) continue; // the blend reading its own step
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      if (!slot.has(`${node.id}.${socket}`) && refs.some((r) => own.includes(r.node))) {
        readers.add(node.id);
      }
    }
    for (const param of Object.values(getNodeType(node.type)?.worldRefs ?? {})) {
      if (own.includes((node.params as Record<string, unknown>)[param] as string)) {
        readers.add(node.id);
      }
    }
  }
  for (const [name, ref] of Object.entries(state.outputs)) {
    if (own.includes(ref.node)) readers.add(`the ${name} output`);
  }
  return [...readers].sort();
}

const refusedIfShared = (state: DagState, place: Place, verb: string) => {
  const others = otherReaders(state, place);
  if (others.length > 0) {
    refuse(
      `"${place.row.nodeId}" is also read by ${others.join(', ')}, so ${verb} it here would change what they read`,
    );
  }
};

/** Refused when nothing in the view holds the wire that reads this row. */
function holdingWires(place: Place): readonly Wire[] {
  if (place.index === 0 && place.top.reference) {
    refuse(
      `"${place.row.nodeId}" is named by the param "${place.top.reference}"; change that instead`,
    );
  }
  return (
    place.slot ?? refuse(`"${place.row.nodeId}" is this view's output, so nothing here holds it`)
  );
}

const refusedIfInfluence = (place: Place, below: StackRow | undefined) => {
  if (place.index === 0 && place.top.factor && !below) {
    refuse(
      `"${place.row.nodeId}" drives an influence, which needs a source; set the influence instead`,
    );
  }
};

/** A modifier or a material operator is only offered on what it can act on (#498, #394). */
function refusedByLane(state: DagState, nodeType: string, base: string) {
  const stub = { type: nodeType } as Node;
  if (isModifierNode(stub) && !canModifyGeometry(state, base)) {
    refuse(`${nodeType} can't reshape what "${base}" holds`);
  }
  if (isMaterialLaneOperator(stub) && !canWearMaterial(state, base)) {
    refuse(`"${base}" can't wear a material, so ${nodeType} would do nothing`);
  }
}

/** The ops that put `moving`, whose wires are all free, at `place`, in `state`. */
function landOps(
  state: DagState,
  output: NodeRef,
  moving: { readonly id: string; readonly exit: NodeRef },
  place: StackPlace,
): Op[] {
  const places = locate(state, output);
  const nodeType = state.nodes[moving.id].type;
  if ('above' in place) {
    const target = placeOf(places, place.above);
    const wires = holdingWires(target);
    const main =
      mainInputOfType(nodeType) ??
      refuse(`${nodeType} has no main input, so it can't sit on top of a row`);
    refusedByLane(state, nodeType, target.run[target.run.length - 1].nodeId);
    const { cuts, joins } = rewire(state, wires, moving.exit);
    const reads: Op = {
      type: 'connect',
      from: exitOf(places, target.row),
      to: { node: moving.id, socket: main },
    };
    return [...cuts, ...joins, reads];
  }
  const { owner, socket } = place.route;
  const row = nodeRowOf(placeOf(places, owner));
  const input =
    getNodeType(row.nodeType)?.inputs[socket] ?? refuse(`${row.nodeType} has no input "${socket}"`);
  if (input.cardinality !== 'list' && state.nodes[row.nodeId].inputs[socket]) {
    refuse(`"${row.nodeId}" already reads something through "${socket}"; add on top of that row`);
  }
  return [{ type: 'connect', from: moving.exit, to: { node: row.nodeId, socket } }];
}

/** The output a new node is read from: its only one, or `out`, which every type means as its own. */
function soleOutput(def: NodeDefinition): string {
  const sockets = Object.keys(def.outputs);
  if (sockets.length === 1) return sockets[0];
  if (def.outputs.out) return 'out';
  return refuse(`${def.type} has ${sockets.length} outputs, so which one to read is not clear`);
}

/** A new constraint joins the chain of the object its place is on, through `chainEdit`. */
function addStep(
  state: DagState,
  output: NodeRef,
  edit: Extract<StackEdit, { kind: 'add' }>,
): Op[] {
  const places = locate(state, output);
  const notOnAChain = () => refuse(`${edit.nodeType} goes on an object's constraints`);
  let object: string | undefined;
  let at: number | undefined;
  if ('route' in edit.place) {
    const { owner, socket } = edit.place.route;
    const row = nodeRowOf(placeOf(places, owner));
    if (getNodeType(row.nodeType)?.inputs[socket]?.chain !== 'end') notOnAChain();
    object = row.nodeId;
  } else {
    const target = placeOf(places, edit.place.above);
    const own = target.run.find((r) => r.kind === 'node' && r.nodeType === 'OwnWorld');
    object = (state.nodes[own?.nodeId ?? '']?.params as { object?: string } | undefined)?.object;
    if (!object) return notOnAChain();
    const steps = readChain(state, object)?.steps ?? [];
    at =
      target.row.nodeId === own?.nodeId
        ? 0
        : steps.findIndex((s) => s.id === target.row.nodeId) + 1;
  }
  return (
    addStepOps(
      state,
      object,
      edit.nodeId,
      edit.nodeType as 'TrackTo' | 'FollowPath',
      edit.params ?? {},
      at,
    ) ??
    refuse(`the constraints of "${object}" were wired by hand, so where this goes is not clear`)
  );
}

function addOps(state: DagState, output: NodeRef, edit: Extract<StackEdit, { kind: 'add' }>): Op[] {
  const def = getNodeType(edit.nodeType) ?? refuse(`there is no node type "${edit.nodeType}"`);
  if (def.worldStep) return addStep(state, output, edit);
  if (def.outputs.world) {
    refuse(`a new ${edit.nodeType} goes in through Add, which also puts it in a collection`);
  }
  const add: Op = {
    type: 'addNode',
    nodeId: edit.nodeId,
    nodeType: edit.nodeType,
    params: edit.params ?? {},
  };
  const exit = { node: edit.nodeId, socket: soleOutput(def) };
  const working = applyOps(state, [add]).next;
  return [add, ...landOps(working, output, { id: edit.nodeId, exit }, edit.place)];
}

function deleteOps(state: DagState, places: ReadonlyMap<string, Place>, key: string): Op[] {
  const place = placeOf(places, key);
  const below = place.run[place.index + 1];
  const wires = holdingWires(place);
  refusedIfInfluence(place, below);
  // A second use is one wire, and taking it away has one reading.
  if (place.row.kind === 'same') {
    const { cuts } = rewire(state, wires, null);
    return cuts;
  }
  const row = nodeRowOf(place);
  if (row.nodeType === 'OwnWorld') {
    refuse(`"${row.nodeId}" is the bottom of a constraint chain; it goes with the last constraint`);
  }
  refusedIfShared(state, place, 'deleting');
  if (getNodeType(row.nodeType)?.worldStep) {
    const object = (state.nodes[row.nodeId].params as { target?: string }).target;
    const onChain = object && readChain(state, object)?.steps.some((s) => s.id === row.nodeId);
    if (object && onChain) return removeStepOps(state, object, row.nodeId) ?? [];
    if (row.blend)
      refuse(`the blend on "${row.nodeId}" was wired by hand; delete its nodes one by one`);
  }
  const ops = takeOps(state, places, place);
  const plan = planDeleteNodes(applyOps(state, ops).next, [row.nodeId]);
  return plan.ok ? [...ops, ...plan.ops] : refuse(plan.reason);
}

/** The ops lifting a row out of its run and closing the gap: its input and what read it are free. */
function takeOps(state: DagState, places: ReadonlyMap<string, Place>, place: Place): Op[] {
  const row = nodeRowOf(place);
  const below = place.run[place.index + 1];
  const close = below ? exitOf(places, below) : null;
  const read = rewire(state, place.slot ?? [], close);
  const free = rewire(state, entriesOf(row), null);
  return [...read.cuts, ...free.cuts, ...read.joins];
}

function moveOps(
  state: DagState,
  places: ReadonlyMap<string, Place>,
  key: string,
  to: number,
): Op[] {
  const place = placeOf(places, key);
  const { run, index: from, top } = place;
  nodeRowOf(place);
  // The bottom of a run has nothing to read, so nothing can go under it and it can't go up.
  const movable = run.filter((r) => r.kind === 'node' && entriesOf(r).length > 0).length;
  const fixed = run[movable];
  if (from >= movable)
    refuse(`"${place.row.nodeId}" is the bottom of its stack, so it stays there`);
  if (to < 0 || to >= movable) refuse(`position ${to} is outside what can move in this stack`);
  const held = top.wires !== null && top.reference === null;
  if ((from === 0 || to === 0) && !held) {
    refuse(`the top row of this stack is held by what reads it, so it stays where it is`);
  }
  if (from === to) return [];
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) {
    refusedIfShared(state, placeOf(places, run[i].key), 'moving');
  }

  const order = run.slice(0, movable).filter((_, i) => i !== from) as StackNodeRow[];
  order.splice(to, 0, run[from] as StackNodeRow);
  const parts = order.map((row, i) => {
    const under = order[i + 1] ?? fixed;
    return rewire(state, entriesOf(row), under ? exitOf(places, under) : null);
  });
  if (held) parts.push(rewire(state, top.wires ?? [], exitOf(places, order[0])));
  // Every old wire goes first: a move would otherwise pass through a loop on the way.
  return [...parts.flatMap((p) => p.cuts), ...parts.flatMap((p) => p.joins)];
}

function regroupOps(
  state: DagState,
  output: NodeRef,
  places: ReadonlyMap<string, Place>,
  key: string,
  place: StackPlace,
): Op[] {
  const from = placeOf(places, key);
  const row = nodeRowOf(from);
  holdingWires(from);
  refusedIfInfluence(from, from.run[from.index + 1]);
  const def = getNodeType(row.nodeType);
  if (def?.worldStep || row.nodeType === 'OwnWorld') {
    refuse(
      `"${row.nodeId}" says in its own settings whose constraint it is, so it stays on that chain`,
    );
  }
  if (def?.outputs.world) {
    refuse(
      `moving "${row.nodeId}" under another parent is Parent To, which also keeps it in place`,
    );
  }
  refusedIfShared(state, from, 'moving');
  const take = takeOps(state, places, from);
  const working = applyOps(state, take).next;
  // Lifted out, what only this row read has left the view, so there is no such place to land on.
  const target = 'above' in place ? place.above : place.route.owner;
  if (places.has(target) && !locate(working, output).has(target)) {
    refuse(`"${target}" would no longer be in this stack once "${row.nodeId}" moves`);
  }
  return [
    ...take,
    ...landOps(working, output, { id: row.nodeId, exit: exitOf(places, row) }, place),
  ];
}

function reorderOps(
  state: DagState,
  places: ReadonlyMap<string, Place>,
  edit: Extract<StackEdit, { kind: 'reorderRoutes' }>,
): Op[] {
  const row = nodeRowOf(placeOf(places, edit.row));
  const binding = state.nodes[row.nodeId].inputs[edit.socket];
  if (getNodeType(row.nodeType)?.inputs[edit.socket]?.cardinality !== 'list') {
    refuse(`"${edit.socket}" holds one wire, so it has no order to change`);
  }
  const list = Array.isArray(binding) ? binding : binding ? [binding] : [];
  if (!list[edit.from] || !list[edit.to]) {
    refuse(
      `"${edit.socket}" has ${list.length} routes, so there is no position ${edit.from} to ${edit.to}`,
    );
  }
  if (edit.from === edit.to) return [];
  const order = list.filter((_, i) => i !== edit.from);
  order.splice(edit.to, 0, list[edit.from]);
  const to = { node: row.nodeId, socket: edit.socket };
  return [
    ...list.map((from): Op => ({ type: 'disconnect', from, to })),
    ...order.map((from): Op => ({ type: 'connect', from, to })),
  ];
}

/** The param that mutes a node: its declared bypass, or a `mute` a constraint or a layer holds. */
function muteParamOf(def: NodeDefinition | undefined): string | null {
  if (!def) return null;
  const declared = bypassParamOf(def);
  if (declared) return declared;
  const shape = (def.paramSchema as z.AnyZodObject | undefined)?.shape;
  return shape && 'mute' in shape ? 'mute' : null;
}

function muteOps(state: DagState, places: ReadonlyMap<string, Place>, key: string): Op[] {
  const id = placeOf(places, key).row.nodeId;
  const node = state.nodes[id];
  const param = muteParamOf(getNodeType(node.type));
  if (!param) return refuse(`${node.type} has no mute, so "${id}" can't be muted`);
  const value = (node.params as Record<string, unknown>)[param] !== true;
  return [{ type: 'setParam', nodeId: id, paramPath: param, value }];
}

/**
 * This instance gets a template of its own, a copy of the definition, and the others keep theirs.
 * Unlocked, because editing it is why a person asks for one: it's the only instance it can reach.
 * A node can't change type, so it is taken out and put back under the same id, with its wires.
 */
function makeUniqueOps(state: DagState, places: ReadonlyMap<string, Place>, key: string): Op[] {
  const row = nodeRowOf(placeOf(places, key));
  if (!row.template) return refuse(`"${row.nodeId}" is no template instance`);
  if (row.template.instances < 2) {
    refuse(`"${row.nodeId}" is the only instance of ${row.nodeType}, so it is unique already`);
  }
  const node = state.nodes[row.nodeId];
  for (const [name, ref] of Object.entries(state.outputs)) {
    if (ref.node === row.nodeId)
      refuse(`"${row.nodeId}" is bound as the ${name} output; rebind it first`);
  }
  const templates = templatesOf(state);
  const { definition } = templates.get(row.nodeType)!;
  const name = row.nodeType.slice(TEMPLATE_TYPE_PREFIX.length);
  let n = 2;
  while (templates.has(`${TEMPLATE_TYPE_PREFIX}${name}_${n}`)) n++;
  const type = `${TEMPLATE_TYPE_PREFIX}${name}_${n}`;
  let holder = `${row.nodeId}_template`;
  while (state.nodes[holder]) holder += '_';

  const cuts: Op[] = [];
  const joins: Op[] = [];
  for (const reader of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(reader.inputs)) {
      (Array.isArray(binding) ? binding : [binding]).forEach((from, i) => {
        if (from.node !== row.nodeId) return;
        const to = { node: reader.id, socket };
        cuts.push({ type: 'disconnect', from, to });
        joins.push({
          type: 'connect',
          from,
          to,
          ...(Array.isArray(binding) ? { index: i } : {}),
        });
      });
    }
  }
  return [
    {
      type: 'addNode',
      nodeId: holder,
      nodeType: TEMPLATE_DEFINITION_TYPE,
      params: { definition: { ...definition, type, label: `${definition.label} ${n}` } },
    },
    ...cuts,
    { type: 'removeNode', nodeId: row.nodeId },
    {
      type: 'addNode',
      nodeId: row.nodeId,
      nodeType: type,
      params: { ...(node.params as object), [TEMPLATE_LOCKED_PARAM]: false },
      inputs: node.inputs,
      ...(node.spare !== undefined ? { spare: node.spare } : {}),
      ...(node.meta !== undefined ? { meta: node.meta } : {}),
    },
    ...joins,
  ];
}

/** What the commit doors would refuse, asked now, so the reason reaches the person. */
function assertCommits(state: DagState, ops: readonly Op[]) {
  if (ops.length === 0) return;
  const { next } = applyOps(state, ops);
  const edits = templateEdits(state, next);
  if ('refusal' in edits) refuse(edits.refusal);
  if (!ops.some((op) => op.type === 'removeNode')) return;
  const dangling = findNewDanglingIdRef(state.nodes, next.nodes);
  if (dangling) refuse(`"${dangling.node}" still names "${dangling.missing}"`);
}

function opsOf(state: DagState, output: NodeRef, edit: StackEdit): Op[] {
  const places = locate(state, output);
  switch (edit.kind) {
    case 'add':
      return addOps(state, output, edit);
    case 'delete':
      return deleteOps(state, places, edit.row);
    case 'move':
      return moveOps(state, places, edit.row, edit.to);
    case 'regroup':
      return regroupOps(state, output, places, edit.row, edit.place);
    case 'reorderRoutes':
      return reorderOps(state, places, edit);
    case 'mute':
      return muteOps(state, places, edit.row);
    case 'makeUnique':
      return makeUniqueOps(state, places, edit.row);
  }
}

/** One edit of the stack upstream of `output`, as ops for one `dispatchAtomic`, or why it can't be. */
export function planStackEdit(state: DagState, output: NodeRef, edit: StackEdit): StackEditPlan {
  try {
    const ops = opsOf(state, output, edit);
    assertCommits(state, ops);
    return { ok: true, ops };
  } catch (error) {
    if (error instanceof GraphRefusal) return { ok: false, reason: error.message };
    throw error;
  }
}
