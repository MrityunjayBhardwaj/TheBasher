// #1815 — the stack is computed from the wires: one test per rule, over graphs built with real ops.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, type DagState } from '../core/dag';
import { addStepOps, setInfluenceOps } from '../core/dag/chainEdit';
import { registerNodeType } from '../core/dag/registry';
import { TEMPLATE_DEFINITION_TYPE, type TemplateDefinition } from '../core/dag/templates';
import type { NodeRef, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildAllExampleProjects } from '../core/project/examples';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { stackOf, type StackGroup, type StackNodeRow, type StackRow } from './stackTree';

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

const ids = (rows: readonly StackRow[]) => rows.map((r) => r.nodeId);
const full = (rows: readonly StackRow[], id: string) =>
  rows.find((r) => r.kind === 'node' && r.nodeId === id) as StackNodeRow;
const group = (row: StackNodeRow, socket: string, index: number | null = null) =>
  row.groups.find((g) => g.socket === socket && g.index === index) as StackGroup;

/** Every row at any depth, inside templates too. */
function everyRow(rows: readonly StackRow[]): StackRow[] {
  return rows.flatMap((r) =>
    r.kind === 'same'
      ? [r]
      : [
          r,
          ...r.groups.flatMap((g) => everyRow(g.rows)),
          ...(r.template ? everyRow(r.template.inside) : []),
        ],
  );
}

describe('rules 1 and 2: a main input continues flat', () => {
  it('a modifier stack reads top to bottom, output first', () => {
    const s = apply(EMPTY, [
      node('box', 'BoxData', { size: [1, 1, 1] }),
      node('bevel', 'BevelModifier'),
      node('array', 'ArrayModifier'),
      node('mirror', 'MirrorModifier'),
      wire('box', 'bevel', 'target'),
      wire('bevel', 'array', 'target'),
      wire('array', 'mirror', 'target'),
    ]);
    const rows = stackOf(s, out('mirror'));
    expect(ids(rows)).toEqual(['mirror', 'array', 'bevel', 'box']);
    expect(rows.every((r) => r.kind === 'node' && r.groups.length === 0)).toBe(true);
  });

  it('continues through the main input, not the first socket', () => {
    // An AnimationClip's first socket is its skeleton; what it continues through is `source`.
    const s = apply(EMPTY, [
      node('src', 'Skeleton'),
      node('base', 'AnimationClip'),
      node('top', 'AnimationClip'),
      wire('src', 'top', 'skeleton'),
      wire('base', 'top', 'source'),
    ]);
    const rows = stackOf(s, out('top'));
    expect(ids(rows)).toEqual(['top', 'base']);
    expect(ids(group(full(rows, 'top'), 'skeleton').rows)).toEqual(['src']);
  });

  it('a stack with no such node is empty', () => {
    expect(stackOf(EMPTY, out('nope'))).toEqual([]);
  });
});

describe('rule 3: every other input is a group with its own stack', () => {
  it('heads it with the wire type and socket, and walks it by the same rules', () => {
    const s = apply(EMPTY, [
      node('p', 'TransformPoint'),
      node('v', 'InvertTransform'),
      node('pt', 'MakeVec3'),
      wire('pt', 'p', 'point'),
      wire('v', 'p', 'transform'),
    ]);
    const row = full(stackOf(s, out('p')), 'p');
    expect(row.groups.map((g) => [g.socket, g.wireType])).toEqual([['transform', 'Matrix4']]);
    expect(ids(group(row, 'transform').rows)).toEqual(['v']);
    expect(ids(stackOf(s, out('p')))).toEqual(['p', 'pt']);
  });

  it('leaves an unwired input out', () => {
    const s = apply(EMPTY, [node('p', 'TransformPoint')]);
    expect(full(stackOf(s, out('p')), 'p').groups).toEqual([]);
  });
});

describe('rule 4: no main input is always a group', () => {
  it('one route per input, in socket order, even when the first is the only one wired', () => {
    const s = apply(EMPTY, [
      node('a', 'Clamp'),
      node('b', 'Clamp'),
      node('m', 'Math'),
      wire('b', 'm', 'b'),
      wire('a', 'm', 'a'),
    ]);
    const rows = stackOf(s, out('m'));
    expect(ids(rows)).toEqual(['m']);
    expect(full(rows, 'm').groups.map((g) => g.socket)).toEqual(['a', 'b']);
  });

  it('a list socket is one route per wire', () => {
    const s = apply(EMPTY, [
      node('a', 'LightRig', { name: 'A' }),
      node('b', 'LightRig', { name: 'B' }),
      node('sel', 'LightProfileSelect', { selectedProfile: 'B' }),
      wire('a', 'sel', 'rigs'),
      wire('b', 'sel', 'rigs'),
    ]);
    const row = full(stackOf(s, out('sel')), 'sel');
    expect(row.groups.map((g) => [g.socket, g.index])).toEqual([
      ['rigs', 0],
      ['rigs', 1],
    ]);
  });

  it.each([
    ['LightProfileSelect', 'rigs', 'LightRig', 'selectedProfile'],
    ['ClipSelect', 'clips', 'TransformClip', 'selectedClipName'],
  ])(
    '%s marks the route it picked, and none when the pick is gone',
    (type, socket, each, param) => {
      const build = (picked: string) =>
        apply(EMPTY, [
          node('a', each, { name: 'A' }),
          node('b', each, { name: 'B' }),
          node('sel', type, { [param]: picked }),
          wire('a', 'sel', socket),
          wire('b', 'sel', socket),
        ]);
      const active = (picked: string) =>
        full(stackOf(build(picked), out('sel')), 'sel').groups.map((g) => g.active);
      expect(active('B')).toEqual([false, true]);
      expect(active('A')).toEqual([true, false]);
      expect(active('gone')).toEqual([false, false]);
    },
  );

  it('a camera switch marks its pick, and the first camera when it names none, as it draws', () => {
    let s = EMPTY;
    for (const id of ['c1', 'c2']) s = apply(s, [node(id, 'Null')]);
    const build = (active: string) =>
      apply(s, [
        node('sel', 'CameraSelect', { active }),
        wire('c1', 'sel', 'cameras'),
        wire('c2', 'sel', 'cameras'),
      ]);
    const marks = (active: string) =>
      full(stackOf(build(active), out('sel')), 'sel').groups.map((g) => g.active);
    expect(marks('c2')).toEqual([false, true]);
    expect(marks('')).toEqual([true, false]);
  });
});

describe('rule 5: a node reached twice shows once in full', () => {
  it('the second route gets a same-as row, and nothing below it is repeated', () => {
    const s = apply(EMPTY, [
      node('src', 'Noise'),
      node('shared', 'Clamp'),
      node('m', 'Math'),
      wire('src', 'shared', 'in'),
      wire('shared', 'm', 'a'),
      wire('shared', 'm', 'b'),
    ]);
    const row = full(stackOf(s, out('m')), 'm');
    expect(ids(group(row, 'a').rows)).toEqual(['shared', 'src']);
    const b = group(row, 'b').rows;
    expect(b.map((r) => [r.kind, r.nodeId])).toEqual([['same', 'shared']]);
  });

  it('a flat run claims a shared node over a group hanging off it', () => {
    // The side socket comes first, so only walking the run before its groups gets this right.
    registerNodeType({
      type: 'tmpSideFirst',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      mainInput: 'spine',
      inputs: {
        side: { type: 'Number', cardinality: 'single' },
        spine: { type: 'Number', cardinality: 'single' },
      },
      outputs: { out: { type: 'Number', cardinality: 'single' } },
      evaluate: () => 0,
    } as never);
    const s = apply(EMPTY, [
      node('shared', 'Clamp'),
      node('top', 'tmpSideFirst'),
      wire('shared', 'top', 'side'),
      wire('shared', 'top', 'spine'),
    ]);
    const rows = stackOf(s, out('top'));
    expect(ids(rows)).toEqual(['top', 'shared']);
    expect(rows[1].kind).toBe('node');
    expect(group(full(rows, 'top'), 'side').rows.map((r) => r.kind)).toEqual(['same']);
  });

  it('gives every row a key of its own', () => {
    const s = apply(EMPTY, [
      node('shared', 'Clamp'),
      node('m', 'Math'),
      node('n', 'Math'),
      wire('shared', 'm', 'a'),
      wire('shared', 'm', 'b'),
      wire('shared', 'n', 'a'),
      wire('m', 'n', 'b'),
    ]);
    const keys = everyRow(stackOf(s, out('n'))).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('rule 6: consumers outside the view', () => {
  it('lists what reads a node from outside, and not what reads it from inside', () => {
    const s = apply(EMPTY, [
      node('src', 'Clamp'),
      node('top', 'Clamp'),
      node('other', 'Clamp'),
      node('other2', 'Lag'),
      wire('src', 'top', 'in'),
      wire('src', 'other', 'in'),
      wire('src', 'other2', 'in'),
    ]);
    const rows = stackOf(s, out('top'));
    expect(full(rows, 'src').usedBy).toEqual(['other', 'other2']);
    expect(full(rows, 'top').usedBy).toEqual([]);
  });
});

describe('a constraint chain', () => {
  function chained(influence?: number) {
    let s = makeSplitCube(EMPTY, { objectId: 'crate' }).state;
    s = apply(s, [node('hero', 'Null')]);
    s = apply(s, addStepOps(s, 'crate', 'fp', 'FollowPath', {})!);
    s = apply(s, addStepOps(s, 'crate', 'tt', 'TrackTo', {})!);
    if (influence !== undefined) s = apply(s, setInfluenceOps(s, 'crate', 'tt', influence)!);
    return s;
  }
  const transform = (s: DagState) =>
    group(full(stackOf(s, out('crate')), 'crate'), 'constraints').rows;

  it('an object is groups, and its constraints run flat down to its own transform', () => {
    const s = chained();
    const crate = full(stackOf(s, out('crate')), 'crate');
    expect(crate.groups.map((g) => g.socket)).toEqual(['data', 'constraints']);
    expect(ids(transform(s)).at(0)).toBe('tt');
    expect(s.nodes[ids(transform(s)).at(-1)!].type).toBe('OwnWorld');
    expect(ids(transform(s)).slice(0, 2)).toEqual(['tt', 'fp']);
  });

  it('a target named by a setting is a group marked as a reference', () => {
    let s = chained();
    s = apply(s, [{ type: 'setParam', nodeId: 'tt', paramPath: 'aimNode', value: 'hero' } as Op]);
    const aim = group(full(transform(s), 'tt'), 'aim');
    expect(aim.reference).toBe('aimNode');
    expect(aim.wireType).toBe('Matrix4');
    expect(ids(aim.rows)).toEqual(['hero']);
  });

  it('a wire on that input wins over the name, and is no reference', () => {
    let s = chained();
    s = apply(s, [
      node('other', 'Null'),
      { type: 'setParam', nodeId: 'tt', paramPath: 'aimNode', value: 'hero' } as Op,
      wire('other', 'tt', 'aim', 'world'),
    ]);
    const aim = group(full(transform(s), 'tt'), 'aim');
    expect(aim.reference).toBeNull();
    expect(ids(aim.rows)).toEqual(['other']);
  });

  it('naming a target counts as reading it, from outside the view', () => {
    let s = chained();
    s = apply(s, [{ type: 'setParam', nodeId: 'tt', paramPath: 'aimNode', value: 'hero' } as Op]);
    expect(full(stackOf(s, out('hero')), 'hero').usedBy).toEqual(['tt']);
  });

  it('two objects aiming at each other by name draw without hanging', () => {
    let s = chained();
    s = makeSplitCube(s, { objectId: 'b' }).state;
    s = apply(s, addStepOps(s, 'b', 'tb', 'TrackTo', { aimNode: 'crate' })!);
    s = apply(s, [{ type: 'setParam', nodeId: 'tt', paramPath: 'aimNode', value: 'b' } as Op]);
    const every = everyRow(stackOf(s, out('crate')));
    const same = every.find((r) => r.kind === 'same' && r.nodeId === 'crate');
    expect(same).toBeDefined();
  });

  it('the #1815 mockup: a blend of two Track-Tos sharing one Follow Path, 4 deep', () => {
    let s = makeSplitCube(EMPTY, { objectId: 'crate' }).state;
    s = apply(s, [
      node('own', 'OwnWorld', { object: 'crate' }),
      node('fp', 'FollowPath', { target: 'crate' }),
      node('a', 'TrackTo', { target: 'crate' }),
      node('b', 'TrackTo', { target: 'crate' }),
      node('mix', 'Mix', { dataType: 'Matrix' }),
      node('lag', 'Lag'),
      node('noise', 'Noise'),
      wire('own', 'fp', 'in', 'world'),
      wire('fp', 'a', 'in', 'world'),
      wire('fp', 'b', 'in', 'world'),
      wire('a', 'mix', 'aMatrix', 'world'),
      wire('b', 'mix', 'bMatrix', 'world'),
      wire('noise', 'lag', 'in'),
      wire('lag', 'mix', 'factor'),
      wire('mix', 'crate', 'constraints', 'outMatrix'),
    ]);
    const mix = full(group(full(stackOf(s, out('crate')), 'crate'), 'constraints').rows, 'mix');
    expect(mix.groups.map((g) => g.socket)).toEqual(['factor', 'aMatrix', 'bMatrix']);
    expect(ids(group(mix, 'factor').rows)).toEqual(['lag', 'noise']);
    expect(ids(group(mix, 'aMatrix').rows)).toEqual(['a', 'fp', 'own']);
    expect(group(mix, 'bMatrix').rows.map((r) => [r.kind, r.nodeId])).toEqual([
      ['node', 'b'],
      ['same', 'fp'],
    ]);
  });

  it('a step with an influence is one row with its factor, not six small nodes', () => {
    const s = chained(0.5);
    const rows = transform(s);
    expect(ids(rows).slice(0, 2)).toEqual(['tt', 'fp']);
    const tt = full(rows, 'tt');
    expect(tt.blend?.factor).not.toBeNull();
    expect(s.nodes[ids(group(tt, 'factor').rows)[0]].type).toBe('Value');
    const types = everyRow(stackOf(s, out('crate'))).map((r) => s.nodes[r.nodeId].type);
    expect(types).not.toContain('PolarSplit');
    expect(types).not.toContain('CombineTransform');
    expect(types).not.toContain('Mix');
  });

  it('a blend whose factors differ draws node by node instead of hiding a wire', () => {
    let s = chained(0.5);
    const blend = Object.values(s.nodes).find((n) => n.type === 'Mix')!;
    s = apply(s, [
      node('stray', 'Clamp'),
      { ...wire('stray', blend.id, 'factor'), replace: true } as Op,
    ]);
    const types = everyRow(stackOf(s, out('crate'))).map((r) => s.nodes[r.nodeId].type);
    expect(types).toContain('PolarSplit');
    expect(types).toContain('Clamp');
  });

  it('a blend its step does not read through draws node by node', () => {
    let s = chained(0.5);
    s = apply(s, [
      node('other', 'OwnWorld', { object: 'crate' }),
      { ...wire('other', 'tt', 'in', 'world'), replace: true } as Op,
    ]);
    const types = everyRow(stackOf(s, out('crate'))).map((r) => s.nodes[r.nodeId].type);
    expect(types).toContain('PolarSplit');
  });

  it('what reads the blend from outside counts as reading the step', () => {
    let s = chained(0.5);
    const end = (s.nodes.crate.inputs.constraints as NodeRef).node;
    s = apply(s, [node('reader', 'InvertTransform'), wire(end, 'reader', 'transform')]);
    expect(full(transform(s), 'tt').usedBy).toEqual(['reader']);
  });
});

describe('rule 7: a template', () => {
  const bodyNode = (id: string, type: string, params = {}, inputs = {}) => ({
    id,
    type,
    version: 1,
    params,
    inputs,
  });
  const INNER: TemplateDefinition = {
    type: 'template.Inner',
    label: 'Inner',
    inputs: { k: { type: 'Number', default: 0.2 } },
    output: { type: 'Number' },
    body: {
      nodes: { leaf: bodyNode('leaf', 'BodyInput', { input: 'k' }) },
      out: { node: 'leaf', socket: 'out' },
    },
  } as TemplateDefinition;
  const OUTER: TemplateDefinition = {
    type: 'template.Outer',
    label: 'Outer',
    inputs: { in: { type: 'Number' } },
    output: { type: 'Number' },
    body: {
      nodes: { leaf: bodyNode('leaf', 'BodyInput', { input: 'in' }) },
      out: { node: 'leaf', socket: 'out' },
    },
  } as TemplateDefinition;
  const nested = () =>
    apply(EMPTY, [
      node('def_i', TEMPLATE_DEFINITION_TYPE, { definition: INNER }),
      node('def_o', TEMPLATE_DEFINITION_TYPE, { definition: OUTER }),
      node('src', 'Clamp'),
      node('ol', 'BodyInput', { input: 'in' }),
      node('il', 'BodyInput', { input: 'k' }),
      node('inner', 'template.Inner', { locked: false }),
      node('math', 'Math'),
      node('outer', 'template.Outer', { locked: false }),
      node('outer2', 'template.Outer'),
      wire('il', 'inner', 'body'),
      wire('ol', 'math', 'a'),
      wire('inner', 'math', 'b'),
      wire('math', 'outer', 'body'),
      wire('src', 'outer', 'in'),
    ]);

  it('its inputs are routes, its body is inside, and it says how many instances there are', () => {
    const row = full(stackOf(nested(), out('outer')), 'outer');
    expect(row.groups.map((g) => g.socket)).toEqual(['in']);
    expect(ids(group(row, 'in').rows)).toEqual(['src']);
    expect(row.template?.instances).toBe(2);
    expect(row.template?.locked).toBe(false);
    expect(ids(row.template!.inside)).toEqual(['math']);
  });

  it('expands two levels deep, marking each boundary with the owner it reads', () => {
    const row = full(stackOf(nested(), out('outer')), 'outer');
    const math = full(row.template!.inside, 'math');
    const leaf = full(group(math, 'a').rows, 'ol');
    expect(leaf.boundary).toEqual({ input: 'in', owner: 'outer' });
    const inner = full(group(math, 'b').rows, 'inner');
    expect(inner.template?.exposed).toEqual(['k']);
    const innerLeaf = full(inner.template!.inside, 'il');
    expect(innerLeaf.boundary).toEqual({ input: 'k', owner: 'inner' });
  });

  it('a body node nothing outside reads has no consumers', () => {
    const row = full(stackOf(nested(), out('outer')), 'outer');
    expect(full(row.template!.inside, 'math').usedBy).toEqual([]);
  });
});

describe('nothing upstream goes missing', () => {
  /** What the wires reach from `start`, read off the graph without the translator. */
  function reachable(s: DagState, start: string): Set<string> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || !s.nodes[id]) continue;
      seen.add(id);
      for (const binding of Object.values(s.nodes[id].inputs))
        for (const ref of Array.isArray(binding) ? binding : binding ? [binding] : [])
          stack.push((ref as NodeRef).node);
    }
    return seen;
  }

  it('every node the wires reach has a row, in the default scene and every example', async () => {
    const projects = await buildAllExampleProjects();
    const states = [buildDefaultDagState(), ...projects.map((p) => p.state as DagState)];
    let rows = 0;
    let outputs = 0;
    for (const s of states) {
      for (const output of Object.values(s.outputs)) {
        outputs++;
        const every = everyRow(stackOf(s, output));
        rows += every.length;
        const drawn = new Set(every.map((r) => r.nodeId));
        const missing = [...reachable(s, output.node)].filter((id) => !drawn.has(id));
        expect(missing).toEqual([]);
        const fullRows = every.filter((r) => r.kind === 'node').map((r) => r.nodeId);
        expect(new Set(fullRows).size).toBe(fullRows.length);
        const keys = every.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
    expect(outputs).toBeGreaterThan(states.length);
    expect(rows).toBeGreaterThan(100); // not a census of nothing
  });
});
