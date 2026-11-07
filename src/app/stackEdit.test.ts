// #1816 — every stack edit is a rewire: edit, rebuild from the graph, get the stack promised, and
// one undo gives back the graph. The round trip runs through the real store, over generated graphs,
// and works out what each edit promised on a plain tree, apart from the code it checks.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, type DagState } from '../core/dag';
import { addStepOps, setInfluenceOps } from '../core/dag/chainEdit';
import { getNodeType, mainInputOfType, registerNodeType } from '../core/dag/registry';
import { useDagStore } from '../core/dag/store';
import { TEMPLATE_DEFINITION_TYPE, type TemplateDefinition } from '../core/dag/templates';
import type { NodeRef, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildAllExampleProjects } from '../core/project/examples';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { planStackEdit, type StackEdit, type StackPlace } from './stackEdit';
import { stackOf, type StackNodeRow, type StackRow } from './stackTree';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const EMPTY: DagState = { nodes: {}, outputs: {} } as unknown as DagState;
const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);
const node = (id: string, nodeType: string, params: object = {}): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string, out = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: out },
  to: { node: to, socket },
});
const out = (id: string, socket = 'out'): NodeRef => ({ node: id, socket });
const store = () => useDagStore.getState();

/** The plan, which must be accepted, committed through the store. */
function commit(s: DagState, output: NodeRef, edit: StackEdit): DagState {
  const plan = planStackEdit(s, output, edit);
  if (!plan.ok) throw new Error(`refused: ${plan.reason}`);
  store().reset();
  store().hydrate(s);
  store().dispatchAtomic(plan.ops, 'user');
  return store().state;
}
const refusal = (s: DagState, output: NodeRef, edit: StackEdit): string => {
  const plan = planStackEdit(s, output, edit);
  if (plan.ok) throw new Error(`accepted: ${JSON.stringify(plan.ops)}`);
  return plan.reason;
};

/** Top row first, down the flat run from `from`. */
const run = (s: DagState, from: string): string[] => {
  const rows = stackOf(s, out(from));
  return rows.map((r) => r.nodeId);
};

/** clamp → remap → value, with `math` reading it. The run is `clamp remap value`. */
const numberRun = () =>
  apply(EMPTY, [
    node('value', 'Value', { value: 1 }),
    node('remap', 'CurveRemap'),
    node('clamp', 'Clamp'),
    node('math', 'Math'),
    wire('value', 'remap', 'in'),
    wire('remap', 'clamp', 'in'),
    wire('clamp', 'math', 'a'),
  ]);
const MATH = out('math');

/** A list of numbers: no shipped type has one that takes these rows. */
const registerList = () =>
  registerNodeType({
    type: 'tmpList',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    mainInput: null,
    inputs: { items: { type: 'Number', cardinality: 'list' } },
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: () => 0,
  } as never);

describe('moving a row within a flat run', () => {
  it('swaps the wires and nothing else', () => {
    const before = numberRun();
    const after = commit(before, MATH, { kind: 'move', row: 'clamp', to: 1 });
    expect(run(after, 'remap')).toEqual(['remap', 'clamp', 'value']);
    expect(after.nodes.math.inputs.a).toEqual(out('remap'));
    expect(Object.keys(after.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
  });

  it('refuses to pass a node something else reads, and says who', () => {
    const shared = apply(numberRun(), [node('ext', 'Clamp'), wire('remap', 'ext', 'in')]);
    expect(refusal(shared, MATH, { kind: 'move', row: 'clamp', to: 1 })).toMatch(
      /also read by ext/,
    );
  });

  it('keeps the bottom of a run at the bottom: nothing can go under what reads nothing', () => {
    expect(refusal(numberRun(), MATH, { kind: 'move', row: 'clamp', to: 2 })).toMatch(/outside/);
    expect(refusal(numberRun(), MATH, { kind: 'move', row: 'value', to: 0 })).toMatch(/bottom/);
  });

  it("refuses to move the view's own top row: what reads it isn't in the view", () => {
    const view = out('clamp');
    expect(refusal(numberRun(), view, { kind: 'move', row: 'clamp', to: 1 })).toMatch(/top row/);
    expect(refusal(numberRun(), view, { kind: 'move', row: 'remap', to: 0 })).toMatch(/top row/);
  });
});

describe('deleting a row', () => {
  it('closes the run over it', () => {
    const after = commit(numberRun(), MATH, { kind: 'delete', row: 'remap' });
    expect(after.nodes.remap).toBeUndefined();
    expect(after.nodes.clamp.inputs.in).toEqual(out('value'));
    expect(after.nodes.value).toBeDefined();
  });

  it('is refused on a node something else reads, because which of the two is meant is not clear', () => {
    const shared = apply(numberRun(), [node('ext', 'Clamp'), wire('remap', 'ext', 'in')]);
    expect(refusal(shared, MATH, { kind: 'delete', row: 'remap' })).toMatch(/also read by ext/);
  });

  it('a second use is one wire, and taking it away leaves the node', () => {
    const s = apply(numberRun(), [wire('remap', 'math', 'b')]);
    const rows = stackOf(s, MATH)[0] as StackNodeRow;
    const second = rows.groups.find((g) => g.socket === 'b')!.rows[0];
    expect(second.kind).toBe('same');
    const after = commit(s, MATH, { kind: 'delete', row: second.key });
    expect(after.nodes.math.inputs.b).toBeUndefined();
    expect(after.nodes.remap).toBeDefined();
  });

  it('a route in a list keeps the others where they are', () => {
    let s = apply(EMPTY, [node('scene', 'Scene')]);
    for (const id of ['a', 'b', 'c']) {
      s = makeSplitCube(s, {
        objectId: id,
        connectTo: { node: 'scene', socket: 'children' },
      }).state;
    }
    const after = commit(s, out('scene'), { kind: 'delete', row: 'b' });
    expect((after.nodes.scene.inputs.children as NodeRef[]).map((r) => r.node)).toEqual(['a', 'c']);
    expect(after.nodes.b_data).toBeUndefined(); // what it owned went with it
  });

  it("refuses the view's own output", () => {
    expect(refusal(numberRun(), MATH, { kind: 'delete', row: 'math' })).toMatch(/output/);
  });
});

describe('adding a row', () => {
  it('on top of a row, on the one wire that reads it', () => {
    const shared = apply(numberRun(), [node('ext', 'Clamp'), wire('remap', 'ext', 'in')]);
    const after = commit(shared, MATH, {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'Clamp',
      place: { above: 'remap' },
    });
    expect(after.nodes.clamp.inputs.in).toEqual(out('fresh'));
    expect(after.nodes.fresh.inputs.in).toEqual(out('remap'));
    expect(after.nodes.ext.inputs.in).toEqual(out('remap')); // the other reader is left alone
  });

  it('as a new route on an empty socket', () => {
    const after = commit(numberRun(), MATH, {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'Value',
      params: { value: 2 },
      place: { route: { owner: 'math', socket: 'b' } },
    });
    expect(after.nodes.math.inputs.b).toEqual(out('fresh'));
  });

  it('on top of a route in a list, which keeps its place there', () => {
    registerList();
    const s = apply(EMPTY, [
      node('a', 'Value', { value: 1 }),
      node('b', 'Value', { value: 2 }),
      node('c', 'Value', { value: 3 }),
      node('list', 'tmpList'),
      wire('a', 'list', 'items'),
      wire('b', 'list', 'items'),
      wire('c', 'list', 'items'),
    ]);
    const after = commit(s, out('list'), {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'Clamp',
      place: { above: 'b' },
    });
    expect((after.nodes.list.inputs.items as NodeRef[]).map((r) => r.node)).toEqual([
      'a',
      'fresh',
      'c',
    ]);
  });

  it('refuses a new object: a wire does not put it in the scene, a collection does', () => {
    const s = apply(EMPTY, [node('scene', 'Scene')]);
    const reason = refusal(s, out('scene'), {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'Object',
      place: { route: { owner: 'scene', socket: 'children' } },
    });
    expect(reason).toMatch(/goes in through Add/);
  });

  it('refuses what the place has no reading for', () => {
    const add = (nodeType: string, place: StackPlace) =>
      refusal(numberRun(), MATH, { kind: 'add', nodeId: 'fresh', nodeType, place });
    expect(add('Value', { above: 'remap' })).toMatch(/no main input/);
    expect(add('Clamp', { route: { owner: 'math', socket: 'a' } })).toMatch(/already reads/);
    expect(add('Clamp', { route: { owner: 'math', socket: 'nope' } })).toMatch(/no input/);
    expect(add('Clamp', { above: 'gone' })).toMatch(/not a row/);
    expect(add('Nope', { above: 'remap' })).toMatch(/no node type/);
    expect(add('Clamp', { above: 'math' })).toMatch(/output/);
  });

  it('refuses a node with several outputs, because which one to read is not clear', () => {
    const reason = refusal(numberRun(), MATH, {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'PolarSplit',
      place: { route: { owner: 'math', socket: 'b' } },
    });
    expect(reason).toMatch(/3 outputs/);
  });

  it('refuses a wire of the wrong type, in the words of the graph', () => {
    const reason = refusal(numberRun(), MATH, {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'InvertTransform',
      place: { above: 'remap' },
    });
    expect(reason).toMatch(/^connect:/);
  });

  it('refuses a modifier on what it cannot reshape (#498), as the old road does', () => {
    const s = apply(EMPTY, [
      node('cam', 'CameraData', { fov: 50 }),
      node('obj', 'Object'),
      wire('cam', 'obj', 'data'),
    ]);
    const reason = refusal(s, out('obj'), {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'BevelModifier',
      place: { above: 'cam' },
    });
    expect(reason).toMatch(/can't reshape/);
  });

  it('refuses a material operator on what cannot wear one, as the old road does', () => {
    const s = apply(EMPTY, [
      node('cam', 'CameraData', { fov: 50 }),
      node('obj', 'Object'),
      wire('cam', 'obj', 'data'),
    ]);
    const reason = refusal(s, out('obj'), {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'SetMaterialOp',
      place: { above: 'cam' },
    });
    expect(reason).toMatch(/can't wear a material/);
  });
});

describe('moving a row into or out of a group', () => {
  it('takes the row alone and closes the gap', () => {
    const s = apply(numberRun(), [
      node('other', 'Value', { value: 3 }),
      wire('other', 'math', 'b'),
    ]);
    const after = commit(s, MATH, { kind: 'regroup', row: 'remap', place: { above: 'other' } });
    expect(after.nodes.clamp.inputs.in).toEqual(out('value'));
    expect(after.nodes.math.inputs.b).toEqual(out('remap'));
    expect(after.nodes.remap.inputs.in).toEqual(out('other'));
  });

  it('refuses a place under the row itself, which no longer exists once it moves', () => {
    registerNodeType({
      type: 'tmpSide',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      mainInput: 'in',
      inputs: {
        in: { type: 'Number', cardinality: 'single' },
        side: { type: 'Number', cardinality: 'single' },
      },
      outputs: { out: { type: 'Number', cardinality: 'single' } },
      evaluate: () => 0,
    } as never);
    const s = apply(EMPTY, [
      node('source', 'Value', { value: 1 }),
      node('x', 'tmpSide'),
      node('math', 'Math'),
      wire('source', 'x', 'side'),
      wire('x', 'math', 'a'),
    ]);
    // `source` is only here because x reads it, so with x lifted out it has left the stack.
    const reason = refusal(s, MATH, { kind: 'regroup', row: 'x', place: { above: 'source' } });
    expect(reason).toMatch(/no longer be in this stack once "x" moves/);
  });

  it('refuses an object: moving one between parents is Parent To, which keeps it in place', () => {
    let s = apply(EMPTY, [
      node('scene', 'Scene'),
      node('g', 'Group'),
      wire('g', 'scene', 'children'),
    ]);
    s = makeSplitCube(s, { objectId: 'a', connectTo: { node: 'scene', socket: 'children' } }).state;
    const reason = refusal(s, out('scene'), {
      kind: 'regroup',
      row: 'a',
      place: { route: { owner: 'g', socket: 'children' } },
    });
    expect(reason).toMatch(/Parent To/);
  });
});

describe('reordering the routes of a group', () => {
  const scene = () => {
    let s = apply(EMPTY, [node('scene', 'Scene')]);
    for (const id of ['a', 'b', 'c']) {
      s = makeSplitCube(s, {
        objectId: id,
        connectTo: { node: 'scene', socket: 'children' },
      }).state;
    }
    return s;
  };

  it('changes the list and nothing else', () => {
    const after = commit(scene(), out('scene'), {
      kind: 'reorderRoutes',
      row: 'scene',
      socket: 'children',
      from: 2,
      to: 0,
    });
    expect((after.nodes.scene.inputs.children as NodeRef[]).map((r) => r.node)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('refuses sockets that hold one wire: their order is the node type', () => {
    const reason = refusal(numberRun(), MATH, {
      kind: 'reorderRoutes',
      row: 'math',
      socket: 'a',
      from: 0,
      to: 1,
    });
    expect(reason).toMatch(/one wire/);
  });

  it('refuses a position the list does not have', () => {
    const edit = { kind: 'reorderRoutes', row: 'scene', socket: 'children' } as const;
    expect(refusal(scene(), out('scene'), { ...edit, from: 0, to: 3 })).toMatch(/3 routes/);
  });
});

describe('muting a row', () => {
  it("writes the type's own declared bypass, and back", () => {
    const s = apply(EMPTY, [
      node('box', 'BoxData', { size: [1, 1, 1] }),
      node('bevel', 'BevelModifier'),
      wire('box', 'bevel', 'target'),
    ]);
    const edit: StackEdit = { kind: 'mute', row: 'bevel' };
    const off = commit(s, out('bevel'), edit);
    expect((off.nodes.bevel.params as { muted?: boolean }).muted).toBe(true);
    const on = commit(off, out('bevel'), edit);
    expect((on.nodes.bevel.params as { muted?: boolean }).muted).toBe(false);
  });

  it('mutes a constraint', () => {
    const s = chained();
    const after = commit(s, TRANSFORM, { kind: 'mute', row: 'tt' });
    expect((after.nodes.tt.params as { mute?: boolean }).mute).toBe(true);
  });

  it('refuses a type with no mute: a write nothing reads would be a dead button', () => {
    expect(refusal(numberRun(), MATH, { kind: 'mute', row: 'clamp' })).toMatch(/no mute/);
  });
});

function chained(influence?: number) {
  let s = makeSplitCube(EMPTY, { objectId: 'crate' }).state;
  s = apply(s, addStepOps(s, 'crate', 'fp', 'FollowPath', {})!);
  s = apply(s, addStepOps(s, 'crate', 'tt', 'TrackTo', {})!);
  s = apply(s, addStepOps(s, 'crate', 'tt2', 'TrackTo', {})!);
  if (influence !== undefined) s = apply(s, setInfluenceOps(s, 'crate', 'tt', influence)!);
  return s;
}
const TRANSFORM = out('crate');
const chainRun = (s: DagState) => {
  const crate = stackOf(s, TRANSFORM)[0] as StackNodeRow;
  return crate.groups.find((g) => g.socket === 'constraints')?.rows.map((r) => r.nodeId) ?? [];
};

describe('a constraint chain', () => {
  it('moving a blended step takes both of its input wires', () => {
    const after = commit(chained(0.5), TRANSFORM, { kind: 'move', row: 'tt', to: 0 });
    expect(chainRun(after)).toEqual(['tt', 'tt2', 'fp', 'crate_own_world']);
    expect((stackOf(after, TRANSFORM)[0] as StackNodeRow).groups.length).toBeGreaterThan(0);
    const tt = (stackOf(after, TRANSFORM)[0] as StackNodeRow).groups
      .find((g) => g.socket === 'constraints')!
      .rows.find((r) => r.nodeId === 'tt') as StackNodeRow;
    expect(tt.blend).not.toBeNull(); // still one row
    expect(after.nodes.tt.inputs.in).toEqual(after.nodes[tt.blend!.under].inputs.transform);
  });

  it('deleting a step takes its blend, and the last one takes the bottom', () => {
    let s = commit(chained(0.5), TRANSFORM, { kind: 'delete', row: 'tt' });
    expect(s.nodes.tt).toBeUndefined();
    expect(Object.keys(s.nodes).filter((id) => id.includes('influence'))).toEqual([]);
    s = commit(s, TRANSFORM, { kind: 'delete', row: 'tt2' });
    s = commit(s, TRANSFORM, { kind: 'delete', row: 'fp' });
    expect(chainRun(s)).toEqual([]);
    expect(s.nodes.crate_own_world).toBeUndefined();
  });

  it('adding a step names its object and starts a chain that has none', () => {
    const s = makeSplitCube(EMPTY, { objectId: 'crate' }).state;
    const after = commit(s, TRANSFORM, {
      kind: 'add',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      place: { route: { owner: 'crate', socket: 'constraints' } },
    });
    expect(chainRun(after)).toEqual(['tt', 'crate_own_world']);
    expect((after.nodes.tt.params as { target?: string }).target).toBe('crate');
  });

  it('adding a step on top of a row lands at that place in the chain', () => {
    const after = commit(chained(), TRANSFORM, {
      kind: 'add',
      nodeId: 'mid',
      nodeType: 'TrackTo',
      place: { above: 'fp' },
    });
    expect(chainRun(after)).toEqual(['tt2', 'tt', 'mid', 'fp', 'crate_own_world']);
    const bottom = commit(chained(), TRANSFORM, {
      kind: 'add',
      nodeId: 'low',
      nodeType: 'TrackTo',
      place: { above: 'crate_own_world' },
    });
    expect(chainRun(bottom)).toEqual(['tt2', 'tt', 'fp', 'low', 'crate_own_world']);
  });

  it('refuses a step away from any chain, and one leaving its own', () => {
    const add: StackEdit = {
      kind: 'add',
      nodeId: 'x',
      nodeType: 'TrackTo',
      place: { above: 'remap' },
    };
    expect(refusal(numberRun(), MATH, add)).toMatch(/goes on an object's constraints/);
    const route: StackPlace = { route: { owner: 'math', socket: 'b' } };
    expect(refusal(numberRun(), MATH, { ...add, place: route } as StackEdit)).toMatch(
      /goes on an object's constraints/,
    );
    const reason = refusal(chained(), TRANSFORM, {
      kind: 'regroup',
      row: 'fp',
      place: { above: 'crate_data' },
    });
    expect(reason).toMatch(/stays on that chain/);
  });

  it('refuses taking the source of an influence away, and takes a row above it', () => {
    const s = chained(0.5);
    const factorRow = (state: DagState) => {
      const crate = stackOf(state, TRANSFORM)[0] as StackNodeRow;
      const tt = crate.groups
        .find((g) => g.socket === 'constraints')!
        .rows.find((r) => r.nodeId === 'tt') as StackNodeRow;
      return tt.groups.find((g) => g.socket === 'factor')!.rows;
    };
    const value = factorRow(s)[0].key;
    expect(refusal(s, TRANSFORM, { kind: 'delete', row: value })).toMatch(/influence/);
    const elsewhere: StackPlace = { route: { owner: 'crate', socket: 'parent' } };
    expect(refusal(s, TRANSFORM, { kind: 'regroup', row: value, place: elsewhere })).toMatch(
      /influence/,
    );
    const after = commit(s, TRANSFORM, {
      kind: 'add',
      nodeId: 'fresh',
      nodeType: 'Clamp',
      place: { above: value },
    });
    expect(factorRow(after).map((r) => r.nodeId)).toEqual(['fresh', value]); // all three factors
  });

  it('refuses a step something still names, which the delete would leave pointing at nothing', () => {
    const s = apply(chained(), [
      node('lag', 'Lag', { sourceTransform: { node: 'tt', channel: 'tx' } }),
    ]);
    expect(refusal(s, TRANSFORM, { kind: 'delete', row: 'tt' })).toMatch(/"lag" still names "tt"/);
  });

  it('refuses a blended step on no chain: which nodes are its blend was decided by hand', () => {
    const s = apply(chained(0.5), [
      node('hero', 'Null'),
      { type: 'setParam', nodeId: 'tt', paramPath: 'target', value: 'hero' },
    ]);
    expect(refusal(s, TRANSFORM, { kind: 'delete', row: 'tt' })).toMatch(/wired by hand/);
  });

  it('refuses the bottom of a chain', () => {
    const reason = refusal(chained(), TRANSFORM, { kind: 'delete', row: 'crate_own_world' });
    expect(reason).toMatch(/bottom of a constraint chain/);
  });
});

describe('what else reads a row', () => {
  it('a param naming it counts, as a wire does', () => {
    let s = apply(EMPTY, [node('scene', 'Scene')]);
    s = makeSplitCube(s, {
      objectId: 'hero',
      connectTo: { node: 'scene', socket: 'children' },
    }).state;
    s = makeSplitCube(s, { objectId: 'crate' }).state;
    s = apply(s, addStepOps(s, 'crate', 'tt', 'TrackTo', { aimNode: 'hero' })!);
    expect(refusal(s, out('scene'), { kind: 'delete', row: 'hero' })).toMatch(/also read by tt/);
  });

  it('a named output counts', () => {
    const s = apply(EMPTY, [
      node('stage', 'Scene'),
      node('pass', 'BeautyPass'),
      wire('stage', 'pass', 'scene'),
      { type: 'setOutput', name: 'scene', ref: out('stage') },
    ]);
    expect(refusal(s, out('pass'), { kind: 'delete', row: 'stage' })).toMatch(/the scene output/);
  });
});

describe('moving the top row', () => {
  it("is refused: what holds the view's output isn't in the view", () => {
    const place: StackPlace = { route: { owner: 'clamp', socket: 'in' } };
    expect(refusal(numberRun(), MATH, { kind: 'regroup', row: 'math', place })).toMatch(/output/);
  });
});

describe('a row a param names', () => {
  it("refuses to edit it through the name: the row belongs to the param's own value", () => {
    let s = makeSplitCube(EMPTY, { objectId: 'crate' }).state;
    s = apply(s, [node('hero', 'Null')]);
    s = apply(s, addStepOps(s, 'crate', 'tt', 'TrackTo', { aimNode: 'hero' })!);
    const crate = stackOf(s, TRANSFORM)[0] as StackNodeRow;
    const tt = crate.groups.find((g) => g.socket === 'constraints')!.rows[0] as StackNodeRow;
    const named = tt.groups.find((g) => g.reference === 'aimNode')!.rows[0];
    expect(refusal(s, TRANSFORM, { kind: 'delete', row: named.key })).toMatch(/aimNode/);
    expect(
      refusal(s, TRANSFORM, {
        kind: 'regroup',
        row: named.key,
        place: { route: { owner: 'crate', socket: 'parent' } },
      }),
    ).toMatch(/aimNode/);
    expect(
      refusal(s, TRANSFORM, {
        kind: 'add',
        nodeId: 'x',
        nodeType: 'Clamp',
        place: { above: named.key },
      }),
    ).toMatch(/aimNode/);
  });
});

const bodyNode = (id: string, type: string, params: object) =>
  ({ id, type, version: 1, params, inputs: {} }) as TemplateDefinition['body']['nodes'][string];
const SOFT: TemplateDefinition = {
  type: 'template.Soft',
  label: 'Soft',
  inputs: { in: { type: 'Number' } },
  output: { type: 'Number' },
  body: {
    nodes: { leaf: bodyNode('leaf', 'BodyInput', { input: 'in' }) },
    out: { node: 'leaf', socket: 'out' },
  },
} as TemplateDefinition;
const instanceOps = (id: string, locked = true): Op[] => [
  node(`${id}_leaf`, 'BodyInput', { input: 'in' }),
  node(id, 'template.Soft', { locked }),
  wire(`${id}_leaf`, id, 'body'),
];

describe('a template', () => {
  const two = () =>
    apply(EMPTY, [
      node('def', TEMPLATE_DEFINITION_TYPE, { definition: SOFT }),
      node('value', 'Value', { value: 1 }),
      ...instanceOps('one'),
      ...instanceOps('two'),
      node('math', 'Math'),
      wire('value', 'one', 'in'),
      wire('one', 'math', 'a'),
      wire('two', 'math', 'b'),
    ]);

  it('make unique: this instance gets its own copy, unlocked, under the same id and wires', () => {
    const after = commit(two(), MATH, { kind: 'makeUnique', row: 'one' });
    expect(after.nodes.one.type).toBe('template.Soft_2');
    expect(after.nodes.two.type).toBe('template.Soft');
    expect(after.nodes.one.inputs.in).toEqual(out('value'));
    expect(after.nodes.one.inputs.body).toEqual(out('one_leaf'));
    expect(after.nodes.math.inputs.a).toEqual(out('one'));
    expect((after.nodes.one.params as { locked: boolean }).locked).toBe(false);
    expect(getNodeType('template.Soft_2')).toBeDefined();
    const row = stackOf(after, MATH)[0] as StackNodeRow;
    const inst = row.groups[0].rows[0] as StackNodeRow;
    expect(inst.template?.instances).toBe(1);
  });

  it('make unique keeps the name, and the place in a list that reads it', () => {
    registerList();
    const s = apply(two(), [
      node('list', 'tmpList'),
      wire('one', 'list', 'items'),
      wire('two', 'list', 'items'),
      { type: 'setMeta', nodeId: 'one', name: 'Smoother' },
    ]);
    const after = commit(s, out('list'), { kind: 'makeUnique', row: 'one' });
    expect(after.nodes.one.meta?.name).toBe('Smoother');
    expect((after.nodes.list.inputs.items as NodeRef[]).map((r) => r.node)).toEqual(['one', 'two']);
  });

  it('make unique refuses an instance bound as an output', () => {
    const stage = {
      type: 'template.Stage',
      label: 'Stage',
      inputs: {},
      output: { type: 'Scene' },
      body: { nodes: { s: bodyNode('s', 'Scene', {}) }, out: { node: 's', socket: 'out' } },
    } as unknown as TemplateDefinition;
    const s = apply(EMPTY, [
      node('def', TEMPLATE_DEFINITION_TYPE, { definition: stage }),
      node('s1', 'Scene'),
      node('s2', 'Scene'),
      node('a', 'template.Stage'),
      node('b', 'template.Stage'),
      wire('s1', 'a', 'body'),
      wire('s2', 'b', 'body'),
      { type: 'setOutput', name: 'scene', ref: out('a') },
    ]);
    expect(refusal(s, out('a'), { kind: 'makeUnique', row: 'a' })).toMatch(/scene output/);
  });

  it('make unique is one undo, and the type it made goes with it', () => {
    const before = two();
    commit(before, MATH, { kind: 'makeUnique', row: 'one' });
    store().undo();
    expect(store().state.nodes).toEqual(before.nodes);
    expect(getNodeType('template.Soft_2')).toBeUndefined();
    expect(getNodeType('template.Soft')).toBeDefined();
  });

  it('a second make unique takes the next free name', () => {
    const s = apply(two(), instanceOps('three'));
    const once = commit(s, MATH, { kind: 'makeUnique', row: 'one' });
    const twice = commit(once, MATH, { kind: 'makeUnique', row: 'two' });
    expect(twice.nodes.two.type).toBe('template.Soft_3');
  });

  it('refuses on the only instance, and on a row that is no instance', () => {
    const only = apply(EMPTY, [
      node('def', TEMPLATE_DEFINITION_TYPE, { definition: SOFT }),
      ...instanceOps('one'),
    ]);
    expect(refusal(only, out('one'), { kind: 'makeUnique', row: 'one' })).toMatch(/unique already/);
    expect(refusal(numberRun(), MATH, { kind: 'makeUnique', row: 'clamp' })).toMatch(/no template/);
  });

  it('a shape edit inside an instance is refused in the words of the lock', () => {
    const add = (id: string): StackEdit => ({
      kind: 'add',
      nodeId: 'x',
      nodeType: 'Clamp',
      place: { above: `${id}_leaf` },
    });
    expect(refusal(two(), MATH, add('one'))).toMatch(/locked/);
    const open = apply(EMPTY, [
      node('def', TEMPLATE_DEFINITION_TYPE, { definition: SOFT }),
      ...instanceOps('one', false),
    ]);
    expect(refusal(open, out('one'), add('one'))).toMatch(/#1665/);
  });
});

// ── The round trip ─────────────────────────────────────────────────────────────────────────────

/** A stack with every "same as" expanded and nothing but what an edit can promise. */
interface Tree {
  key: string;
  id: string;
  type: string;
  groups: { socket: string; rows: Tree[] }[];
}

const INSIDE = '(inside)';

const leaf = (id: string, type: string, key = id): Tree => ({ key, id, type, groups: [] });

function outline(rows: readonly StackRow[]): Tree[] {
  const runs = new Map<string, { run: readonly StackRow[]; index: number }>();
  const index = (list: readonly StackRow[]) => {
    list.forEach((row, i) => {
      if (row.kind !== 'node') return;
      runs.set(row.nodeId, { run: list, index: i });
      row.groups.forEach((g) => index(g.rows));
      if (row.template) index(row.template.inside);
    });
  };
  index(rows);
  // A param can name an ancestor (a constraint aiming at its own object's parent), which no wire
  // could do, so a "same as" can point back up its own path. It stops there.
  const path = new Set<string>();
  const expand = (list: readonly StackRow[]): Tree[] =>
    list.flatMap((row): Tree[] => {
      if (row.kind === 'node') return [treeOf(row)];
      if (path.has(row.nodeId)) return [leaf(row.nodeId, '(up)', row.key)];
      const at = runs.get(row.nodeId)!;
      const [first, ...tail] = expand(at.run.slice(at.index));
      return [{ ...first, key: row.key }, ...tail];
    });
  const treeOf = (row: StackNodeRow): Tree => {
    path.add(row.nodeId);
    const tree = {
      key: row.key,
      id: row.nodeId,
      type: row.nodeType,
      groups: [
        ...row.groups.map((g) => ({ socket: g.socket, rows: expand(g.rows) })),
        ...(row.template ? [{ socket: INSIDE, rows: expand(row.template.inside) }] : []),
      ],
    };
    path.delete(row.nodeId);
    return tree;
  };
  return expand(rows);
}

const bare = (rows: readonly Tree[]): unknown =>
  rows.map((r) => ({
    id: r.id,
    type: r.type,
    groups: r.groups
      .map((g) => ({ socket: g.socket, rows: bare(g.rows) }))
      .sort((a, b) => (a.socket < b.socket ? -1 : a.socket > b.socket ? 1 : 0)),
  }));

/** `change` over every run, at any depth, inside out. */
function overRuns(rows: readonly Tree[], change: (run: Tree[]) => Tree[]): Tree[] {
  return change(
    rows.map((r) => ({
      ...r,
      groups: r.groups.map((g) => ({ ...g, rows: overRuns(g.rows, change) })),
    })),
  );
}
const withoutEmptyGroups = (rows: readonly Tree[]): Tree[] =>
  overRuns(rows, (run) =>
    run.map((r) => ({ ...r, groups: r.groups.filter((g) => g.rows.length > 0) })),
  );
const withoutEmptyChains = (rows: readonly Tree[]): Tree[] =>
  overRuns(rows, (run) =>
    run.map((r) => ({
      ...r,
      groups: r.groups.filter(
        (g) => !(g.socket === 'constraints' && g.rows.every((c) => c.type === 'OwnWorld')),
      ),
    })),
  );

function findTree(rows: readonly Tree[], key: string): Tree | undefined {
  for (const row of rows) {
    if (row.key === key) return row;
    for (const g of row.groups) {
      const hit = findTree(g.rows, key);
      if (hit) return hit;
    }
  }
  return undefined;
}

function landed(rows: readonly Tree[], row: Tree, place: StackPlace): Tree[] {
  if ('above' in place) {
    return overRuns(rows, (run) => run.flatMap((r) => (r.key === place.above ? [row, r] : [r])));
  }
  const { owner, socket: named } = place.route;
  const socket = named === 'body' ? INSIDE : named;
  return overRuns(rows, (run) =>
    run.flatMap((r) => {
      if (r.id !== owner) return [r];
      if (mainInputOfType(r.type) === socket) return [r, row];
      const has = r.groups.some((g) => g.socket === socket);
      return [
        {
          ...r,
          groups: has
            ? r.groups.map((g) => (g.socket === socket ? { ...g, rows: [...g.rows, row] } : g))
            : [...r.groups, { socket, rows: [row] }],
        },
      ];
    }),
  );
}

/** The stack `edit` promises, from the stack before it. */
function promised(before: readonly Tree[], edit: StackEdit, after: DagState): Tree[] {
  switch (edit.kind) {
    case 'mute':
      return [...before];
    case 'makeUnique': {
      const type = after.nodes[edit.row].type;
      return overRuns(before, (run) => run.map((r) => (r.id === edit.row ? { ...r, type } : r)));
    }
    case 'delete': {
      // A second use takes what its expansion drew under it, since that wire was all it was.
      const gone = overRuns(before, (run) => {
        const at = run.findIndex((r) => r.key === edit.row);
        if (at < 0) return run;
        return edit.row.includes('/') ? run.slice(0, at) : run.filter((_, i) => i !== at);
      });
      return withoutEmptyChains(withoutEmptyGroups(gone));
    }
    case 'move':
      return overRuns(before, (run) => {
        const from = run.findIndex((r) => r.id === edit.row);
        if (from < 0) return run;
        const whole = findRunOf(before, edit.row) ?? run;
        const shift = edit.to - whole.findIndex((r) => r.id === edit.row);
        const rest = run.filter((r) => r.id !== edit.row);
        rest.splice(from + shift, 0, run[from]);
        return rest;
      });
    case 'reorderRoutes':
      return overRuns(before, (run) =>
        run.map((r) => {
          if (r.id !== edit.row) return r;
          const routes = r.groups.filter((g) => g.socket === edit.socket);
          const order = routes.filter((_, i) => i !== edit.from);
          order.splice(edit.to, 0, routes[edit.from]);
          return {
            ...r,
            groups: [...r.groups.filter((g) => g.socket !== edit.socket), ...order],
          };
        }),
      );
    case 'add': {
      const row = leaf(edit.nodeId, edit.nodeType);
      if (!getNodeType(edit.nodeType)?.worldStep || !('route' in edit.place)) {
        return landed(before, row, edit.place);
      }
      // A constraint added to an object goes on top of its chain, which it starts if it has none.
      const object = edit.place.route.owner;
      const bottom = leaf(`${object}_own_world`, 'OwnWorld');
      return overRuns(before, (run) =>
        run.map((r) => {
          if (r.id !== object) return r;
          const chain = r.groups.find((g) => g.socket === 'constraints');
          if (!chain)
            return { ...r, groups: [...r.groups, { socket: 'constraints', rows: [row, bottom] }] };
          return {
            ...r,
            groups: r.groups.map((g) => (g === chain ? { ...g, rows: [row, ...g.rows] } : g)),
          };
        }),
      );
    }
    case 'regroup': {
      const row = findTree(before, edit.row)!;
      const gone = overRuns(before, (run) => run.filter((r) => r.id !== edit.row));
      return withoutEmptyGroups(landed(gone, row, edit.place));
    }
  }
}

function findRunOf(rows: readonly Tree[], id: string): Tree[] | undefined {
  let best: Tree[] | undefined;
  overRuns(rows, (run) => {
    if (run.some((r) => r.id === id) && (!best || run.length > best.length)) best = run;
    return run;
  });
  return best;
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A graph of numbers with shared nodes and templates, and objects with stacks and chains. */
function generate(seed: number): { state: DagState; views: NodeRef[] } {
  const r = mulberry(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
  let s = apply(EMPTY, [
    node('def', TEMPLATE_DEFINITION_TYPE, { definition: SOFT }),
    node('v0', 'Value', { value: 1 }),
    node('v1', 'Value', { value: 2 }),
  ]);
  const pool = ['v0', 'v1'];
  const count = 3 + Math.floor(r() * 7);
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    const kind = pick(['Clamp', 'CurveRemap', 'Math', 'Soft']);
    // Mostly the latest node, so runs grow long; sometimes an old one, so nodes get shared.
    const feed = () => (r() < 0.65 ? pool[pool.length - 1] : pick(pool));
    if (kind === 'Math')
      s = apply(s, [node(id, 'Math'), wire(feed(), id, 'a'), wire(feed(), id, 'b')]);
    else if (kind === 'Soft') s = apply(s, [...instanceOps(id, r() < 0.5), wire(feed(), id, 'in')]);
    else s = apply(s, [node(id, kind), wire(feed(), id, 'in')]);
    pool.push(id);
  }
  if (r() < 0.4) s = apply(s, [node('ext', 'Clamp'), wire(pick(pool), 'ext', 'in')]);
  s = apply(s, [node('top', 'Math'), wire(pool[pool.length - 1], 'top', 'a')]);
  if (r() < 0.6) s = apply(s, [wire(pick(pool), 'top', 'b')]);

  s = apply(s, [node('scene', 'Scene')]);
  const objects = 1 + Math.floor(r() * 3);
  for (let o = 0; o < objects; o++) {
    const id = `obj${o}`;
    s = makeSplitCube(s, { objectId: id, connectTo: { node: 'scene', socket: 'children' } }).state;
    const steps = Math.floor(r() * 4);
    for (let i = 0; i < steps; i++) {
      const step = `${id}_step${i}`;
      s = apply(s, addStepOps(s, id, step, pick(['TrackTo', 'FollowPath'] as const), {})!);
      if (r() < 0.4) s = apply(s, setInfluenceOps(s, id, step, 0.5)!);
    }
    let top = `${id}_data`;
    const modifiers = Math.floor(r() * 4);
    for (let i = 0; i < modifiers; i++) {
      const mod = `${id}_mod${i}`;
      s = apply(s, [
        node(mod, pick(['BevelModifier', 'MirrorModifier', 'ArrayModifier'])),
        { type: 'disconnect', from: out(top), to: { node: id, socket: 'data' } },
        wire(top, mod, 'target'),
        wire(mod, id, 'data'),
      ]);
      top = mod;
    }
  }
  return { state: s, views: [out('top'), out('scene')] };
}

const allKeys = (rows: readonly StackRow[]): StackRow[] =>
  rows.flatMap((row) =>
    row.kind === 'same'
      ? [row]
      : [
          row,
          ...row.groups.flatMap((g) => allKeys(g.rows)),
          ...(row.template ? allKeys(row.template.inside) : []),
        ],
  );

/** A spread of edits for a stack: each kind on each row, with places drawn at random. */
function editsFor(rows: readonly StackRow[], r: () => number, fresh: () => string): StackEdit[] {
  const every = allKeys(rows);
  const any = () => every[Math.floor(r() * every.length)];
  const nodes = every.filter((x): x is StackNodeRow => x.kind === 'node');
  const place = (): StackPlace => {
    if (r() < 0.6) return { above: any().key };
    const owner = nodes[Math.floor(r() * nodes.length)];
    const sockets = Object.keys(getNodeType(owner.nodeType)?.inputs ?? {});
    return { route: { owner: owner.key, socket: sockets[Math.floor(r() * sockets.length)] } };
  };
  const edits: StackEdit[] = [];
  for (const row of every) {
    edits.push(
      { kind: 'delete', row: row.key },
      { kind: 'mute', row: row.key },
      { kind: 'makeUnique', row: row.key },
      { kind: 'move', row: row.key, to: Math.floor(r() * 4) },
      { kind: 'regroup', row: row.key, place: place() },
      {
        kind: 'add',
        nodeId: fresh(),
        nodeType: ['Clamp', 'Value', 'MirrorModifier', 'TrackTo'][Math.floor(r() * 4)],
        place: place(),
      },
    );
    if (row.kind !== 'node') continue;
    const lists = new Set(row.groups.filter((g) => g.index !== null).map((g) => g.socket));
    for (const socket of lists) {
      const n = row.groups.filter((g) => g.socket === socket).length;
      edits.push({
        kind: 'reorderRoutes',
        row: row.key,
        socket,
        from: Math.floor(r() * n),
        to: Math.floor(r() * n),
      });
    }
  }
  return edits;
}

/** The nodes with their params as `addNode` stores them, which is how an undo restores one (#1746). */
const asStored = (s: DagState) =>
  Object.fromEntries(
    Object.values(s.nodes).map((n) => [
      n.id,
      { ...n, params: getNodeType(n.type)?.paramSchema.safeParse(n.params).data ?? n.params },
    ]),
  );
describe('the round trip', () => {
  /** Plan, commit, rebuild, compare, undo. False when refused, which leaves the graph untouched. */
  function roundTrip(state: DagState, view: NodeRef, edit: StackEdit): boolean {
    const plan = planStackEdit(state, view, edit);
    const label = JSON.stringify({ view, edit });
    if (!plan.ok) {
      expect(plan.reason, label).toMatch(/\S/);
      return false;
    }
    const before = outline(stackOf(state, view));
    store().reset();
    store().hydrate(state);
    store().dispatchAtomic(plan.ops, 'user');
    const after = store().state;
    const want = promised(before, edit, after);
    expect(bare(outline(stackOf(after, view))), label).toEqual(bare(want));
    if (edit.kind === 'mute') {
      const id = allKeys(stackOf(state, view)).find((x) => x.key === edit.row)!.nodeId;
      expect(after.nodes[id], label).not.toEqual(state.nodes[id]);
    }
    if (plan.ops.length > 0) {
      expect(store().undoStack.length, label).toBe(1);
      store().undo();
      expect(asStored(store().state), label).toEqual(asStored(state));
    }
    return true;
  }

  it('over generated graphs, every accepted edit gives the stack it promised and one undo', () => {
    const tally = new Map<string, { accepted: number; refused: number }>();
    for (let seed = 1; seed <= 40; seed++) {
      const { state, views } = generate(seed);
      const r = mulberry(seed * 7919);
      let n = 0;
      for (const view of views) {
        for (const edit of editsFor(stackOf(state, view), r, () => `fresh_${n++}`)) {
          const counts = tally.get(edit.kind) ?? { accepted: 0, refused: 0 };
          tally.set(edit.kind, counts);
          if (roundTrip(state, view, edit)) counts.accepted++;
          else counts.refused++;
        }
      }
    }
    // A round trip that never ran an edit of some kind has proved nothing about it.
    for (const kind of [
      'add',
      'delete',
      'move',
      'regroup',
      'reorderRoutes',
      'mute',
      'makeUnique',
    ]) {
      expect(tally.get(kind)?.accepted, kind).toBeGreaterThan(5);
    }
    for (const kind of ['add', 'delete', 'move', 'regroup', 'mute', 'makeUnique']) {
      expect(tally.get(kind)?.refused, kind).toBeGreaterThan(5);
    }
  }, 300000);

  it('over the real default scene and examples, the same holds', async () => {
    const examples = await buildAllExampleProjects();
    const projects = [buildDefaultDagState(), ...examples.map((p) => p.state as DagState)];
    expect(projects.length).toBeGreaterThan(3);
    let accepted = 0;
    for (const state of projects) {
      const scene = state.outputs.scene;
      expect(scene).toBeDefined();
      const r = mulberry(1234);
      let n = 0;
      for (const edit of editsFor(stackOf(state, scene), r, () => `fresh_${n++}`)) {
        if (roundTrip(state, scene, edit)) accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(50);
  }, 300000);
});
