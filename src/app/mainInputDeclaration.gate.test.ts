// mainInputDeclaration — every node type with inputs says which one continues a stack (#1814).
//
// The stack view draws a node's main input flat underneath it and every other input as a group
// (#1815). Guessing that input makes the panel lie: "the first socket" is the weights on a Houdini
// Blend CHOP and the material on a Box. So each type declares it, or declares that it has none, and
// this census runs over the real registry: a new node with inputs reds here until it answers.
//
// REF: src/core/dag/types.ts (`NodeDefinition.mainInput`); src/core/dag/registry.ts
//      (`mainInputOfType`, `assertMainInput`); the mockup on issue #1815;
//      ref GROUND_TRUTH_STACK_VIEWS "What #1805 should copy / avoid"; issues #1805 #1814.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  defineNodeType,
  getNodeType,
  listNodeTypes,
  mainInputOfType,
  registerNodeType,
} from '../core/dag/registry';
import { templateNodeType } from '../core/dag/templates';
import { registerAllNodes } from '../nodes/registerAll';

beforeAll(() => {
  if (listNodeTypes().length === 0) registerAllNodes();
});

const withInputs = () =>
  listNodeTypes().filter((type) => Object.keys(getNodeType(type)?.inputs ?? {}).length > 0);

const undeclared = () => withInputs().filter((type) => mainInputOfType(type) === undefined);

/** A definition for the refusals and the control; only its sockets and declarations matter. */
const synthetic = (type: string, extra: object) =>
  ({
    type,
    version: 1,
    pure: true,
    cost: 'cheap',
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: () => 0,
    ...extra,
  }) as never;

const NUMBER = { type: 'Number', cardinality: 'single' };

describe('the census', () => {
  it('every node type with inputs declares a main input or none', () => {
    expect(withInputs().length).toBeGreaterThan(60); // not a census of nothing
    expect(undeclared()).toEqual([]);
  });

  it('reds on a type that declares neither (the control)', () => {
    registerNodeType(synthetic('tmpUndeclared', { inputs: { in: NUMBER } }));
    expect(undeclared()).toContain('tmpUndeclared');
    // Declaring "none" is an answer, and is not the same as saying nothing.
    registerNodeType(synthetic('tmpNone', { inputs: { in: NUMBER }, mainInput: null }));
    expect(undeclared()).not.toContain('tmpNone');
    expect(mainInputOfType('tmpNone')).toBeNull();
  });
});

describe('what the #1815 mockup draws', () => {
  it.each([
    ['BevelModifier', 'target'], // an operator answers through its chain
    ['Transform', 'target'],
    ['TrackTo', 'in'],
    ['FollowPath', 'in'],
    ['CurveRemap', 'in'],
    ['Noise', 't'],
    ['Clamp', 'in'],
    ['Lag', 'in'],
  ])('%s continues flat through %s', (type, socket) => {
    expect(mainInputOfType(type)).toBe(socket);
  });

  // The Object draws TRANSFORM and GEOMETRY as two groups; Mix, Math and Solver draw routes.
  it.each(['Object', 'Mix', 'Math', 'Solver'])('%s has none: always a group', (type) => {
    expect(mainInputOfType(type)).toBeNull();
  });
});

// A template registers when its project loads, so the census over the shipped types never meets one.
it('a template has none: its inputs are routes (#1815 rule 7)', () => {
  const def = {
    type: 'tmpTemplate',
    inputs: { in: { type: 'Number' } },
    output: { type: 'Number' },
  } as never;
  defineNodeType(templateNodeType(def));
  expect(mainInputOfType('tmpTemplate')).toBeNull();
});

describe('a main input that could not continue a stack is refused', () => {
  const NAMED = { inputs: { in: NUMBER }, mainInput: 'in' };
  it.each([
    ['names no input', { inputs: { in: NUMBER }, mainInput: 'nope' }, /does not declare/],
    [
      'is a list',
      { inputs: { in: { ...NUMBER, cardinality: 'list' } }, mainInput: 'in' },
      /cardinality/,
    ],
    [
      'only exists under some params',
      { inputs: { in: { ...NUMBER, available: { param: 'p', in: ['a'] } } }, mainInput: 'in' },
      /under some params/,
    ],
    [
      'repeats the chain',
      {
        ...NAMED,
        chain: { input: 'in', scope: 'none', bypass: { kind: 'none' }, section: 'none' },
      },
      /both chain and mainInput/,
    ],
  ])('one that %s', (label, extra, reason) => {
    expect(() => registerNodeType(synthetic(`tmpRefused ${label}`, extra))).toThrow(reason);
  });
});
