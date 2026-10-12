// #1580 — a wire has more than one way in, and every way in answers to the same rule.
//
// `connect` checked a wire: the socket exists, the producer exists, the type is taken or
// converts, a role is held once, no loop. `addNode` also creates wires, through its `inputs`,
// and checked none of it: a pose into a Number socket was applied.
//
// Two things are pinned here. Which operations can create a wire is DERIVED, by applying a
// sample of every operation and watching the edge set, so an operation added later that can
// create one has to be named. And each of those is run against the same refusals, which must
// read the same from every door apart from the operation's name.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, registerNodeType } from '../core/dag';
import { requireNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import { OpSchema, type InputBinding, type NodeRef, type Op } from '../core/dag/types';
import { registerAllNodes } from './registerAll';

const IMAGE = { type: 'Image', cardinality: 'single' } as const;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  // Two producers that declare the same pass role, one that declares none, and a consumer
  // with a list of images: the smallest graph the one-role-once rule can be broken on. And a
  // Vector3 producer, for the refusal that names a way forward.
  for (const [type, role] of [
    ['DepthA', 'depth'],
    ['DepthB', 'depth'],
    ['Plain', undefined],
  ] as const) {
    registerNodeType({
      type,
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: {},
      outputs: { out: role ? { ...IMAGE, role } : IMAGE },
      evaluate: () => null,
    } as never);
  }
  registerNodeType({
    type: 'Vec',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: {},
    outputs: { out: { type: 'Vector3', cardinality: 'single' } },
    evaluate: () => [1, 2, 3],
  } as never);
  registerNodeType({
    type: 'Stack',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: { items: { type: 'Image', cardinality: 'list' } },
    outputs: { out: IMAGE },
    evaluate: () => null,
  } as never);
});

const defaults = (nodeType: string): unknown => requireNodeType(nodeType).paramSchema.parse({});
type AddNode = Extract<Op, { type: 'addNode' }>;
const bare = (nodeId: string, nodeType: string): AddNode => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params: defaults(nodeType),
});
const apply = (state: DagState, ops: readonly Op[]): DagState =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** A skeleton, two numbers, a vector and three image producers, with one wire (m0 → m1). */
function seeded(): DagState {
  return apply(emptyDagState(), [
    bare('skel', 'Skeleton'),
    bare('m0', 'Math'),
    bare('m1', 'Math'),
    bare('da', 'DepthA'),
    bare('db', 'DepthB'),
    bare('plain', 'Plain'),
    bare('vec', 'Vec'),
    { type: 'connect', from: { node: 'm0', socket: 'out' }, to: { node: 'm1', socket: 'a' } },
  ]);
}

const edgesOf = (state: DagState): Set<string> => {
  const edges = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      refs.forEach((r, i) => edges.add(`${r.node}.${r.socket}>${node.id}.${socket}#${i}`));
    }
  }
  return edges;
};

/** One applicable sample of every operation. A wire-creating sample where the operation's
 *  shape can carry a wire at all. Keyed by `Op['type']`, so a new operation does not compile
 *  until it has one. */
const samples = (): Record<Op['type'], Op> => ({
  addNode: {
    ...bare('fresh', 'Math'),
    inputs: { a: { node: 'm0', socket: 'out' } },
  },
  removeNode: { type: 'removeNode', nodeId: 'skel' },
  connect: {
    type: 'connect',
    from: { node: 'm0', socket: 'out' },
    to: { node: 'm1', socket: 'b' },
  },
  disconnect: {
    type: 'disconnect',
    from: { node: 'm0', socket: 'out' },
    to: { node: 'm1', socket: 'a' },
  },
  setParam: { type: 'setParam', nodeId: 'm0', paramPath: 'op', value: 'mul' },
  setMeta: { type: 'setMeta', nodeId: 'm0', name: 'renamed' },
  setSpareParam: {
    type: 'setSpareParam',
    nodeId: 'm0',
    key: 'extra',
    param: { type: 'float', value: 1 },
  },
  removeSpareParam: { type: 'removeSpareParam', nodeId: 'm0', key: 'extra' },
});

type Door = (consumerId: string, consumerType: string, socket: string, refs: NodeRef[]) => Op[];

/** Every operation that can create a wire, as the ops that put `refs` on one socket of a new
 *  node. Checked below to be exactly the derived set. */
const DOORS: Record<string, Door> = {
  addNode: (consumerId, consumerType, socket, refs) => [
    {
      ...bare(consumerId, consumerType),
      inputs: { [socket]: (refs.length === 1 ? refs[0] : refs) as InputBinding },
    },
  ],
  connect: (consumerId, consumerType, socket, refs) => [
    bare(consumerId, consumerType),
    ...refs.map((from): Op => ({ type: 'connect', from, to: { node: consumerId, socket } })),
  ],
};

const outcome = (state: DagState, ops: readonly Op[]): { refused: string } | { next: DagState } => {
  try {
    return { next: apply(state, ops) };
  } catch (e) {
    return { refused: (e as Error).message };
  }
};

/** A refusal without the name of the operation that raised it. */
const body = (message: string): string => message.replace(/^(addNode|connect): /, '');

describe('#1580 — the operations that can create a wire', () => {
  it('has a sample for every operation in the schema', () => {
    const inSchema = OpSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(samples()).sort()).toEqual(inSchema);
  });

  it('are addNode and connect, found by applying each and watching the edges', () => {
    const creators: string[] = [];
    const all = samples();
    for (const [type, op] of Object.entries(all)) {
      // removeSpareParam needs the spare it removes.
      const before = type === 'removeSpareParam' ? apply(seeded(), [all.setSpareParam]) : seeded();
      const had = edgesOf(before);
      const after = edgesOf(applyOp(before, op).next);
      if ([...after].some((edge) => !had.has(edge))) creators.push(type);
    }
    expect(creators.sort()).toEqual(['addNode', 'connect']);
    expect(Object.keys(DOORS).sort()).toEqual(creators.sort());
  });
});

interface Refusal {
  name: string;
  consumerType: string;
  socket: string;
  refs: NodeRef[];
  says: RegExp;
}

const REFUSALS: Refusal[] = [
  {
    name: 'a type the socket does not take',
    consumerType: 'Math',
    socket: 'a',
    refs: [{ node: 'skel', socket: 'pose' }],
    says: /^type mismatch Skeleton\.pose:PosedSkeleton → Math\.a:Number — there is no conversion/,
  },
  {
    name: 'a type with a way forward',
    consumerType: 'Math',
    socket: 'a',
    refs: [{ node: 'vec', socket: 'out' }],
    says: /^type mismatch Vec\.out:Vector3 → Math\.a:Number — .*VecBreak3/,
  },
  {
    name: 'an input socket the node type does not have',
    consumerType: 'Math',
    socket: 'nope',
    refs: [{ node: 'm0', socket: 'out' }],
    says: /^Math has no input socket 'nope'$/,
  },
  {
    name: 'a producer that is not in the graph',
    consumerType: 'Math',
    socket: 'a',
    refs: [{ node: 'ghost', socket: 'out' }],
    says: /^Node not found: ghost$/,
  },
  {
    name: 'an output socket the producer does not have',
    consumerType: 'Math',
    socket: 'a',
    refs: [{ node: 'm0', socket: 'nope' }],
    says: /^Math has no output socket 'nope'$/,
  },
  {
    name: 'the node itself',
    consumerType: 'Math',
    socket: 'a',
    refs: [{ node: 'fresh', socket: 'out' }],
    says: /^would create a cycle \(fresh → fresh\)$/,
  },
  {
    name: 'a second pass of a role the list already holds',
    consumerType: 'Stack',
    socket: 'items',
    refs: [
      { node: 'da', socket: 'out' },
      { node: 'db', socket: 'out' },
    ],
    says: /^Stack\.items already holds a depth pass \("da"\); a role may be bound once/,
  },
];

describe('#1580 — every door refuses the same wires, in the same words', () => {
  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name}`, () => {
      const state = seeded();
      const said: Record<string, string> = {};
      for (const [door, opsFor] of Object.entries(DOORS)) {
        const result = outcome(
          state,
          opsFor('fresh', refusal.consumerType, refusal.socket, refusal.refs),
        );
        expect('refused' in result, `${door} applied it`).toBe(true);
        if ('refused' in result) said[door] = result.refused;
      }
      for (const [door, message] of Object.entries(said)) {
        expect(body(message), door).toMatch(refusal.says);
        expect(body(message), door).toBe(body(said.connect));
      }
    });
  }

  it('takes the same wires through either door, and stores the same graph', () => {
    const accepted: Array<[string, string, NodeRef[]]> = [
      ['Math', 'a', [{ node: 'm0', socket: 'out' }]],
      // #1549: a Number converts into a Vector3 input, from this door too.
      ['VecBreak3', 'v', [{ node: 'm0', socket: 'out' }]],
      // One depth pass beside an image that declares no role.
      [
        'Stack',
        'items',
        [
          { node: 'da', socket: 'out' },
          { node: 'plain', socket: 'out' },
        ],
      ],
    ];
    for (const [consumerType, socket, refs] of accepted) {
      const stored = Object.entries(DOORS).map(([door, opsFor]) => {
        const result = outcome(seeded(), opsFor('fresh', consumerType, socket, refs));
        expect('next' in result, `${door} refused ${consumerType}.${socket}`).toBe(true);
        return 'next' in result ? result.next.nodes.fresh : undefined;
      });
      expect(stored[0]).toEqual(stored[1]);
    }
  });
});

describe('#1580 — what only addNode can be handed', () => {
  it('refuses a list on a socket that carries one wire', () => {
    const op = {
      ...bare('fresh', 'Math'),
      inputs: { a: [{ node: 'm0', socket: 'out' }] },
    };
    expect(() => applyOp(seeded(), op)).toThrow(
      'addNode: Math.a carries one wire and was given a list of 1',
    );
  });

  it('checks the socket even when the list on it is empty', () => {
    const op = { ...bare('fresh', 'Math'), inputs: { nope: [] } };
    expect(() => applyOp(seeded(), op)).toThrow("addNode: Math has no input socket 'nope'");
  });

  it('checks every wire of a list, not only the first', () => {
    const op = {
      ...bare('fresh', 'Stack'),
      inputs: {
        items: [
          { node: 'plain', socket: 'out' },
          { node: 'm0', socket: 'out' },
        ],
      },
    };
    expect(() => applyOp(seeded(), op)).toThrow(
      /^addNode: type mismatch Math\.out:Number → Stack\.items:Image/,
    );
  });

  it('checks every socket, not only the first', () => {
    const op = {
      ...bare('fresh', 'Math'),
      inputs: { a: { node: 'm0', socket: 'out' }, b: { node: 'skel', socket: 'pose' } },
    };
    expect(() => applyOp(seeded(), op)).toThrow(/^addNode: type mismatch Skeleton\.pose/);
  });

  it('leaves the graph as it was when it refuses', () => {
    const state = seeded();
    const op = {
      ...bare('fresh', 'Math'),
      inputs: { a: { node: 'skel', socket: 'pose' } },
    };
    expect(() => applyOp(state, op)).toThrow();
    expect(state.nodes.fresh).toBeUndefined();
  });

  it('takes a lone wire on a list socket, as connect reads one', () => {
    const op = {
      ...bare('fresh', 'Stack'),
      inputs: { items: { node: 'plain', socket: 'out' } },
    };
    expect(applyOp(seeded(), op).next.nodes.fresh.inputs.items).toEqual({
      node: 'plain',
      socket: 'out',
    });
  });

  it('brings a removed node back with its wires on undo', () => {
    // m1 holds the seed's one wire and feeds nothing, so it can be removed.
    const state = seeded();
    const removed = applyOp(state, { type: 'removeNode', nodeId: 'm1' });
    expect(removed.next.nodes.m1).toBeUndefined();
    const undone = applyOp(removed.next, removed.inverse).next;
    expect(undone.nodes.m1).toEqual(state.nodes.m1);
    expect(undone.nodes.m1.inputs.a).toEqual({ node: 'm0', socket: 'out' });
  });
});
