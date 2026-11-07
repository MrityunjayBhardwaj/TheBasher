// chainEdit — add, remove and move the steps of a constraint chain, and set a step's influence
// (#1811, #1812). What the panel's rows do once they write the chain: pure Op lists, for
// `dispatchAtomic`, in terms of the wires.
//
//   OwnWorld → step → step → the object's `constraints` input
//
// INFLUENCE IS THE SMALL NODES, as decided on #1811: a step blended onto what it received by a
// Polar Split of each side, three Mix nodes (location, rotation, stretch), a Combine Transform and a
// Multiply Transforms. One Value node feeds all three factors, so the row is one number, a key on it
// moves the whole blend, and it can be replaced by anything that outputs a number. A step that has
// never had its influence changed has none of these. Blender's numbers for the blend are in
// `constraintChain.blender.test.ts`.
//
// A chain somebody wired by hand into another shape is theirs: `readChain` answers null for it and
// nothing here edits it, rather than guess which wire is which.

import { subjectReferrersInto } from './idRefSweep';
import { applyOps } from './ops';
import { getNodeType } from './registry';
import type { DagState } from './state';
import type { NodeRef, Op } from './types';

/** The blend over one step: the ids of its small nodes, and what feeds its factor. */
export interface StepBlend {
  readonly under: string;
  readonly over: string;
  readonly location: string;
  readonly rotation: string;
  readonly stretch: string;
  readonly place: string;
  readonly out: string;
  /** Who feeds all three factors, or null when they don't share one source. */
  readonly factor: NodeRef | null;
}

export interface ChainStep {
  readonly id: string;
  readonly blend: StepBlend | null;
}

export interface Chain {
  /** The OwnWorld at the bottom, or null when the object has no chain yet. */
  readonly own: string | null;
  /** Bottom first: the order the stack runs in. */
  readonly steps: readonly ChainStep[];
}

const single = (binding: unknown): NodeRef | null =>
  binding && !Array.isArray(binding) ? (binding as NodeRef) : null;

/** The blend whose output is `outId`, or null when that node isn't one this module wrote. */
export function readBlend(
  state: DagState,
  outId: string,
): { step: string; blend: StepBlend; below: NodeRef } | null {
  const input = (id: string | undefined, socket: string): NodeRef | null =>
    id ? single(state.nodes[id]?.inputs[socket]) : null;
  const isType = (id: string | undefined, type: string): id is string =>
    id !== undefined && state.nodes[id]?.type === type;

  const place = input(outId, 'a')?.node;
  const stretch = input(outId, 'b')?.node;
  const location = input(place, 'translation')?.node;
  const rotation = input(place, 'rotation')?.node;
  const under = input(location, 'aVector')?.node;
  const over = input(location, 'bVector')?.node;
  if (
    !isType(place, 'CombineTransform') ||
    !isType(stretch, 'Mix') ||
    !isType(location, 'Mix') ||
    !isType(rotation, 'Mix') ||
    !isType(under, 'PolarSplit') ||
    !isType(over, 'PolarSplit')
  ) {
    return null;
  }
  const sameSplits = (mix: string, a: string, b: string) =>
    input(mix, a)?.node === under && input(mix, b)?.node === over;
  if (!sameSplits(rotation, 'aRotation', 'bRotation')) return null;
  if (!sameSplits(stretch, 'aMatrix', 'bMatrix')) return null;
  const step = input(over, 'transform');
  const below = input(under, 'transform');
  if (!step || !below || !getNodeType(state.nodes[step.node]?.type ?? '')?.worldStep) return null;
  const factors = [location, rotation, stretch].map((mix) => input(mix, 'factor'));
  const shared = factors.every(
    (f) => f && f.node === factors[0]?.node && f.socket === factors[0]?.socket,
  );
  return {
    step: step.node,
    below,
    blend: {
      under,
      over,
      location,
      rotation,
      stretch,
      place,
      out: outId,
      factor: shared ? factors[0] : null,
    },
  };
}

/** `objectId`'s chain, or null when its wires aren't the shape this module writes. */
export function readChain(state: DagState, objectId: string): Chain | null {
  const object = state.nodes[objectId];
  if (!object) return null;
  let ref = single(object.inputs.constraints);
  if (!ref) return { own: null, steps: [] };
  const steps: ChainStep[] = [];
  // A chain written by hand into a loop has no bottom, and this is not the place to hang on it.
  const met = new Set<string>();
  for (;;) {
    const node: DagState['nodes'][string] | undefined = state.nodes[ref.node];
    if (!node || met.has(node.id)) return null;
    met.add(node.id);
    if (node.type === 'OwnWorld') {
      if ((node.params as { object?: unknown }).object !== objectId) return null;
      return { own: node.id, steps: steps.reverse() };
    }
    if (getNodeType(node.type)?.worldStep) {
      steps.push({ id: node.id, blend: null });
      const below: NodeRef | null = single(node.inputs.in);
      if (!below) return null;
      ref = below;
      continue;
    }
    if (node.type !== 'MultiplyTransforms') return null;
    const read = readBlend(state, node.id);
    if (!read) return null;
    // The step and the blend have to agree on what they received.
    const received = single(state.nodes[read.step].inputs.in);
    if (received?.node !== read.below.node || received?.socket !== read.below.socket) return null;
    steps.push({ id: read.step, blend: read.blend });
    ref = read.below;
  }
}

const world = (node: string): NodeRef => ({ node, socket: 'world' });
const connect = (from: NodeRef, node: string, socket: string): Op => ({
  type: 'connect',
  from,
  to: { node, socket },
});
const disconnect = (from: NodeRef, node: string, socket: string): Op => ({
  type: 'disconnect',
  from,
  to: { node, socket },
});
const outputOf = (step: ChainStep): NodeRef =>
  step.blend ? { node: step.blend.out, socket: 'out' } : world(step.id);
const inputsOf = (step: ChainStep): readonly [string, string][] => [
  [step.id, 'in'],
  ...(step.blend ? ([[step.blend.under, 'transform']] as [string, string][]) : []),
];

/** The wires that stack `steps`, in order, where `chain` had `chain.steps`. Only what changed. */
function restackOps(
  chain: Chain,
  objectId: string,
  own: string,
  steps: readonly ChainStep[],
): Op[] {
  const before = new Map<string, NodeRef>();
  let below = world(own);
  for (const step of chain.steps) {
    before.set(step.id, below);
    below = outputOf(step);
  }
  const topBefore = chain.steps.length > 0 ? below : null;

  const cuts: Op[] = [];
  const joins: Op[] = [];
  const same = (a: NodeRef | undefined | null, b: NodeRef) =>
    a?.node === b.node && a?.socket === b.socket;
  below = world(own);
  for (const step of steps) {
    const was = before.get(step.id);
    if (!same(was, below)) {
      for (const [node, socket] of inputsOf(step)) {
        if (was) cuts.push(disconnect(was, node, socket));
        joins.push(connect(below, node, socket));
      }
    }
    below = outputOf(step);
  }
  if (!same(topBefore, below)) {
    if (topBefore) cuts.push(disconnect(topBefore, objectId, 'constraints'));
    joins.push(connect(below, objectId, 'constraints'));
  }
  // Every old wire goes first: a move would otherwise pass through a loop on the way.
  return [...cuts, ...joins];
}

/** The OwnWorld a chain starts from, and the op that makes it when the object has none. */
function bottomOf(chain: Chain, objectId: string, state: DagState): { own: string; ops: Op[] } {
  if (chain.own) return { own: chain.own, ops: [] };
  let own = `${objectId}_own_world`;
  while (state.nodes[own]) own += '_';
  return {
    own,
    ops: [{ type: 'addNode', nodeId: own, nodeType: 'OwnWorld', params: { object: objectId } }],
  };
}

/**
 * Wires a step that already exists into `objectId`'s chain, on top unless `at` says where (0 is the
 * bottom), starting the chain if it has none. Null when the chain isn't one this module can edit.
 */
export function attachStepOps(
  state: DagState,
  objectId: string,
  stepId: string,
  at?: number,
): Op[] | null {
  const chain = readChain(state, objectId);
  if (!chain) return null;
  const { own, ops } = bottomOf(chain, objectId, state);
  const steps = [...chain.steps];
  steps.splice(at ?? steps.length, 0, { id: stepId, blend: null });
  return [...ops, ...restackOps(chain, objectId, own, steps)];
}

/** Adds a new step to `objectId`'s chain. See {@link attachStepOps}. */
export function addStepOps(
  state: DagState,
  objectId: string,
  stepId: string,
  stepType: 'TrackTo' | 'FollowPath',
  params: Record<string, unknown>,
  at?: number,
): Op[] | null {
  const chain = readChain(state, objectId);
  if (!chain) return null;
  const { own, ops } = bottomOf(chain, objectId, state);
  ops.push({
    type: 'addNode',
    nodeId: stepId,
    nodeType: stepType,
    params: { target: objectId, ...params },
  });
  const steps = [...chain.steps];
  steps.splice(at ?? steps.length, 0, { id: stepId, blend: null });
  ops.push(...restackOps(chain, objectId, own, steps));
  return ops;
}

/** The wires and nodes that take `step` off `chain`, leaving the step's own node for the caller. */
function offChainOps(state: DagState, chain: Chain, objectId: string, step: ChainStep): Op[] {
  const rest = chain.steps.filter((s) => s !== step);
  const own = chain.own!;
  const ops: Op[] = [];
  if (rest.length === 0) ops.push(disconnect(outputOf(step), objectId, 'constraints'));
  else ops.push(...restackOps(chain, objectId, own, rest));
  const going: string[] = [];
  const blend = step.blend;
  if (blend) {
    // Readers before what they read: `removeNode` refuses a node something still consumes.
    going.push(
      blend.out,
      blend.place,
      blend.stretch,
      blend.rotation,
      blend.location,
      blend.over,
      blend.under,
    );
    const source = blend.factor;
    if (source && state.nodes[source.node]?.type === 'Value') going.push(source.node);
  }
  // A key or a driver on any of them goes too, as it does with any deleted node.
  for (const sidecar of subjectReferrersInto(state.nodes, new Set(going))) {
    ops.push({ type: 'removeNode', nodeId: sidecar.id });
  }
  for (const id of going) ops.push({ type: 'removeNode', nodeId: id });
  return ops;
}

/** Takes a step off, with its blend. The last step takes the chain's bottom with it. */
export function removeStepOps(state: DagState, objectId: string, stepId: string): Op[] | null {
  const chain = readChain(state, objectId);
  const step = chain?.steps.find((s) => s.id === stepId);
  if (!chain?.own || !step) return null;
  const ops = offChainOps(state, chain, objectId, step);
  for (const sidecar of subjectReferrersInto(state.nodes, new Set([stepId]))) {
    ops.push({ type: 'removeNode', nodeId: sidecar.id });
  }
  ops.push({ type: 'removeNode', nodeId: stepId });
  if (chain.steps.length === 1) ops.push({ type: 'removeNode', nodeId: chain.own });
  return ops;
}

/**
 * Takes a step out of a chain and keeps its node, for a step moving to another object. Its blend
 * goes, so its influence is back to 1: the blend belonged to where it was.
 */
export function detachStepOps(state: DagState, objectId: string, stepId: string): Op[] | null {
  const chain = readChain(state, objectId);
  const step = chain?.steps.find((s) => s.id === stepId);
  if (!chain?.own || !step) return null;
  const below = state.nodes[stepId].inputs.in;
  const ops = offChainOps(state, chain, objectId, step);
  if (below && !Array.isArray(below)) ops.push(disconnect(below, stepId, 'in'));
  if (chain.steps.length === 1) ops.push({ type: 'removeNode', nodeId: chain.own });
  return ops;
}

const orderOf = (state: DagState, id: string): number => {
  const order = (state.nodes[id]?.params as { order?: unknown } | undefined)?.order;
  return typeof order === 'number' ? order : 0;
};

/**
 * What a commit owes the chains: a step that names an object and isn't on its chain joins it, at
 * the place its `order` says, and one whose object changed leaves the old chain first. So every
 * road that adds a constraint by naming its object, raw ops included, ends up wired. A step wired by
 * hand, or an object whose chain was wired into another shape, is left as it is.
 */
export function chainFollowUpOps(prev: DagState, next: DagState): Op[] {
  const ops: Op[] = [];
  let working = next;
  const applyAll = (more: readonly Op[]) => {
    ops.push(...more);
    working = applyOps(working, more).next;
  };
  for (const [id, node] of Object.entries(next.nodes)) {
    if (prev.nodes[id] === node || !getNodeType(node.type)?.worldStep) continue;
    const target = (node.params as { target?: unknown }).target;
    const was = (prev.nodes[id]?.params as { target?: unknown } | undefined)?.target;
    if (typeof was === 'string' && was !== target && prev.nodes[was]) {
      if (readChain(working, was)?.steps.some((s) => s.id === id)) {
        const off = detachStepOps(working, was, id);
        if (off) applyAll(off);
      }
    }
    if (typeof target !== 'string' || !working.nodes[target]) continue;
    if (getNodeType(working.nodes[target].type)?.inputs.constraints?.chain !== 'end') continue;
    if (working.nodes[id].inputs.in) continue;
    const chain = readChain(working, target);
    if (!chain) continue;
    const order = orderOf(working, id);
    const at = chain.steps.filter((s) => orderOf(working, s.id) <= order).length;
    const on = attachStepOps(working, target, id, at);
    if (on) applyAll(on);
  }
  return ops;
}

/**
 * Every node `objectId`'s chain is made of, readers first: for a delete of the object, which takes
 * the blends with it. Empty when it has no chain, or one wired into another shape.
 */
export function chainNodeIds(state: DagState, objectId: string): string[] {
  const chain = readChain(state, objectId);
  if (!chain?.own) return [];
  const out: string[] = [];
  for (const step of [...chain.steps].reverse()) {
    const blend = step.blend;
    if (blend) {
      out.push(
        blend.out,
        blend.place,
        blend.stretch,
        blend.rotation,
        blend.location,
        blend.over,
        blend.under,
      );
      if (blend.factor && state.nodes[blend.factor.node]?.type === 'Value') {
        out.push(blend.factor.node);
      }
    }
    out.push(step.id);
  }
  out.push(chain.own);
  return out;
}

/** Moves a step to position `to` (0 is the bottom), its blend with it. */
export function moveStepOps(
  state: DagState,
  objectId: string,
  stepId: string,
  to: number,
): Op[] | null {
  const chain = readChain(state, objectId);
  const step = chain?.steps.find((s) => s.id === stepId);
  if (!chain?.own || !step) return null;
  const steps = chain.steps.filter((s) => s !== step);
  steps.splice(Math.max(0, Math.min(to, steps.length)), 0, step);
  return restackOps(chain, objectId, chain.own, steps);
}

/** A step's influence: its number, and the node that holds it, for the row to read and key. */
export type Influence =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly nodeId: string }
  | { readonly kind: 'wired'; readonly from: NodeRef | null };

export function influenceOf(state: DagState, objectId: string, stepId: string): Influence | null {
  const step = readChain(state, objectId)?.steps.find((s) => s.id === stepId);
  if (!step) return null;
  if (!step.blend) return { kind: 'none' };
  const factor = step.blend.factor;
  return factor && state.nodes[factor.node]?.type === 'Value'
    ? { kind: 'value', nodeId: factor.node }
    : { kind: 'wired', from: factor };
}

/**
 * Sets a step's influence, wiring the blend the first time it's asked for. Null when a wire drives
 * it, since that wire's node owns the number, or when the chain can't be edited here.
 */
export function setInfluenceOps(
  state: DagState,
  objectId: string,
  stepId: string,
  value: number,
  /** Wire the blend even at 1, so there is a number to key. */
  force = false,
): Op[] | null {
  const chain = readChain(state, objectId);
  const index = chain?.steps.findIndex((s) => s.id === stepId) ?? -1;
  if (!chain?.own || index < 0) return null;
  const step = chain.steps[index];
  if (step.blend) {
    const now = influenceOf(state, objectId, stepId);
    return now?.kind === 'value'
      ? [{ type: 'setParam', nodeId: now.nodeId, paramPath: 'value', value }]
      : null;
  }
  if (value === 1 && !force) return [];

  const n = (suffix: string) => `${stepId}_influence_${suffix}`;
  const below = index === 0 ? world(chain.own) : outputOf(chain.steps[index - 1]);
  const add = (id: string, nodeType: string, params: object = {}): Op => ({
    type: 'addNode',
    nodeId: id,
    nodeType,
    params: params as Record<string, unknown>,
  });
  const part = (node: string, socket: string): NodeRef => ({ node, socket });
  const blended: ChainStep = {
    id: stepId,
    blend: {
      under: n('under'),
      over: n('over'),
      location: n('location'),
      rotation: n('rotation'),
      stretch: n('stretch'),
      place: n('place'),
      out: n('out'),
      factor: part(n('value'), 'out'),
    },
  };
  const ops: Op[] = [
    add(n('value'), 'Value', { value }),
    add(n('under'), 'PolarSplit'),
    add(n('over'), 'PolarSplit'),
    add(n('location'), 'Mix', { dataType: 'Vector' }),
    add(n('rotation'), 'Mix', { dataType: 'Rotation' }),
    add(n('stretch'), 'Mix', { dataType: 'Matrix' }),
    add(n('place'), 'CombineTransform'),
    add(n('out'), 'MultiplyTransforms'),
    connect(below, n('under'), 'transform'),
    connect(world(stepId), n('over'), 'transform'),
  ];
  for (const [mix, output, a, b] of [
    [n('location'), 'translation', 'aVector', 'bVector'],
    [n('rotation'), 'rotation', 'aRotation', 'bRotation'],
    [n('stretch'), 'stretch', 'aMatrix', 'bMatrix'],
  ] as const) {
    ops.push(
      connect(part(n('under'), output), mix, a),
      connect(part(n('over'), output), mix, b),
      connect(part(n('value'), 'out'), mix, 'factor'),
    );
  }
  ops.push(
    connect(part(n('location'), 'outVector'), n('place'), 'translation'),
    connect(part(n('rotation'), 'outRotation'), n('place'), 'rotation'),
    connect(part(n('place'), 'out'), n('out'), 'a'),
    connect(part(n('stretch'), 'outMatrix'), n('out'), 'b'),
  );
  // Whatever read this step now reads the blend.
  const above = chain.steps[index + 1];
  const aboveInputs: readonly [string, string][] = above
    ? inputsOf(above)
    : [[objectId, 'constraints']];
  for (const [node, socket] of aboveInputs) {
    ops.push(disconnect(world(stepId), node, socket), connect(outputOf(blended), node, socket));
  }
  return ops;
}
