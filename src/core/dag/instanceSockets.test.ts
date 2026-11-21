// #1715 — a node whose sockets come from its params (a ComfyUI workflow node's file).
//
// What must hold:
//   - connect takes a wire into a socket the params give, and refuses one they don't;
//   - the evaluator delivers that wire, typed by the instance's own descriptor;
//   - change the params so the socket goes, and the wire is KEPT and read as unconnected;
//     change them back and it is read again (the #1801 rule for a socket that is not there);
//   - a restore (addNode with the wire, as undo and paste do) keeps a broken wire;
//   - a broken wire can still be disconnected;
//   - the output type a wire carries is the producer instance's;
//   - the same params give the same descriptors.

import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyOp } from './ops';
import { evaluate } from './evaluator';
import { registerNodeType, requireNodeType } from './registry';
import { emptyDagState, type DagState } from './state';
import type { InputDescriptor, NodeDefinition, OutputDescriptor, Op } from './types';
import { inputsOfNode, outputsOfNode } from './instanceSockets';
import { producedTypeOf } from './socketConversion';

const Source: NodeDefinition = {
  type: 'Test1715Source',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: z.object({ v: z.number().default(3) }),
  inputs: {},
  outputs: { out: { type: 'Number', cardinality: 'single' } },
  evaluate: (p) => (p as { v: number }).v,
};

/** Sockets named by its params: `ins` are Number inputs, `outs` Number outputs. Its value is
 *  the sum of whatever arrives, under each output name. */
const Sockets: NodeDefinition = {
  type: 'Test1715Sockets',
  version: 1,
  pure: true,
  cost: 'cheap',
  mainInput: null,
  paramSchema: z.object({
    ins: z.array(z.string()).default([]),
    outs: z.array(z.string()).default([]),
  }),
  inputs: {},
  outputs: {},
  instanceSockets: (params) => {
    const p = params as { ins?: string[]; outs?: string[] };
    const inputs: Record<string, InputDescriptor> = {};
    for (const s of p.ins ?? []) inputs[s] = { type: 'Number', cardinality: 'single' };
    const outputs: Record<string, OutputDescriptor> = {};
    for (const s of p.outs ?? []) outputs[s] = { type: 'Number', cardinality: 'single' };
    return { inputs, outputs };
  },
  evaluate: (params, inputs) => {
    const total = Object.values(inputs).reduce<number>(
      (a, v) => a + (typeof v === 'number' ? v : 0),
      0,
    );
    const out: Record<string, number> = {};
    for (const s of (params as { outs: string[] }).outs) out[s] = total;
    return out;
  },
};

beforeAll(() => {
  registerNodeType(Source as never);
  registerNodeType(Sockets as never);
});

const add = (id: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType,
  params,
});
const wire = (from: string, fs: string, to: string, ts: string): Op => ({
  type: 'connect',
  from: { node: from, socket: fs },
  to: { node: to, socket: ts },
});
const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
const apply = (s: DagState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).next, s);

const base = () =>
  apply(emptyDagState(), [
    add('src', 'Test1715Source', { v: 3 }),
    add('n', 'Test1715Sockets', { ins: ['a'], outs: ['sum'] }),
  ]);

describe('#1715 sockets from params', () => {
  it('connect takes a socket the params give and refuses one they do not', () => {
    const s = apply(base(), [wire('src', 'out', 'n', 'a')]);
    expect(s.nodes.n.inputs.a).toEqual({ node: 'src', socket: 'out' });
    expect(() => apply(base(), [wire('src', 'out', 'n', 'b')])).toThrow(
      "connect: Test1715Sockets has no input socket 'b'",
    );
  });

  it('the evaluator delivers the wire under the output the params name', () => {
    const s = apply(base(), [wire('src', 'out', 'n', 'a')]);
    expect(evaluate(s, 'n', { socket: 'sum' }).value).toBe(3);
  });

  it('a socket the params drop keeps its wire, read as unconnected, until it comes back', () => {
    const wired = apply(base(), [wire('src', 'out', 'n', 'a')]);
    const dropped = apply(wired, [set('n', 'ins', ['c'])]);
    expect(dropped.nodes.n.inputs.a).toEqual({ node: 'src', socket: 'out' });
    expect(evaluate(dropped, 'n', { socket: 'sum' }).value).toBe(0);
    const back = apply(dropped, [set('n', 'ins', ['a', 'c'])]);
    expect(evaluate(back, 'n', { socket: 'sum' }).value).toBe(3);
  });

  it('a restore keeps a broken wire, and it can be disconnected', () => {
    const s = apply(emptyDagState(), [
      add('src', 'Test1715Source'),
      {
        type: 'addNode',
        nodeId: 'n',
        nodeType: 'Test1715Sockets',
        params: { ins: [], outs: ['sum'] },
        inputs: { gone: { node: 'src', socket: 'out' } },
      },
    ]);
    expect(s.nodes.n.inputs.gone).toEqual({ node: 'src', socket: 'out' });
    const cut = apply(s, [
      {
        type: 'disconnect',
        from: { node: 'src', socket: 'out' },
        to: { node: 'n', socket: 'gone' },
      },
    ]);
    expect(cut.nodes.n.inputs.gone).toBeUndefined();
  });

  it('the type a wire carries is read off the producer instance', () => {
    const s = base();
    expect(producedTypeOf(s, { node: 'n', socket: 'sum' })).toBe('Number');
    expect(producedTypeOf(s, { node: 'n', socket: 'nope' })).toBeUndefined();
  });

  it('the same params give the same descriptors; new params a new answer', () => {
    const def = requireNodeType('Test1715Sockets');
    const params = { ins: ['a'], outs: ['sum'] };
    expect(inputsOfNode(def, params)).toBe(inputsOfNode(def, params));
    expect(Object.keys(outputsOfNode(def, { ins: [], outs: ['x', 'y'] }))).toEqual(['x', 'y']);
    // A type without the hook answers with its declared sockets.
    expect(inputsOfNode(requireNodeType('Test1715Source'), {})).toBe(
      requireNodeType('Test1715Source').inputs,
    );
  });
});
