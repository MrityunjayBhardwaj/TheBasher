// #1549 — a wire that carries a type its input does not take.
//
// A Number wired into a Vector3 input was refused, and the refusal named the two types and
// nothing else. It now converts on the way in, as Blender's `float_to_float3` does (the number
// on all three axes), and a wire that cannot convert says what would make it work. A type a
// socket already takes is never converted: `ParamDriver.in` takes either and must know which.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, evaluate, registerNodeType } from '../core/dag';
import { listNodeTypes, requireNodeType } from '../core/dag/registry';
import { arriving, conversionsInto, inputTakes } from '../core/dag/socketConversion';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import { acceptedTypes, type Op, type SocketTypeName } from '../core/dag/types';
import { replayStatefulAt } from '../app/statefulOps';
import { registerAllNodes } from './registerAll';

const NUMBER = { type: 'Number', cardinality: 'single' } as const;
const VECTOR3 = { type: 'Vector3', cardinality: 'single' } as const;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  // A Number that is not 0, so a conversion can be told from a default.
  registerNodeType({
    type: 'Seven',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: {},
    outputs: { out: NUMBER },
    evaluate: () => 7,
  } as never);
  // A Vector3 whose axes all differ, so an average can be told from any one axis.
  registerNodeType({
    type: 'ThreeSixTwelve',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: {},
    outputs: { out: VECTOR3 },
    evaluate: () => [3, 6, 12],
  } as never);
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket },
});

describe('a Number into a Vector3 input (#1549)', () => {
  it('is accepted and arrives as the number on all three axes', () => {
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('sum', 'Vec3Math', { op: 'add' }),
      wire('seven', 'sum', 'a'),
    ]);
    // a = [7, 7, 7]; b is unwired, the origin.
    expect(evaluate(s, 'sum').value).toEqual([7, 7, 7]);
  });

  it('reads the same on every axis when the vector is broken apart again', () => {
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('axes', 'VecBreak3'),
      wire('seven', 'axes', 'v'),
    ]);
    expect(evaluate(s, 'axes').value).toEqual({ x: 7, y: 7, z: 7 });
  });

  it('fills a Solver`s vector state when its rule gives a Number', () => {
    // The body is read by the Solver's cook, not by the evaluator's input resolution.
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('S', 'Solver', { seedFrame: 0 }),
      wire('seven', 'S', 'bodies'),
    ]);
    const at = (frame: number) =>
      replayStatefulAt(s, 'S', { time: { frame, seconds: frame / 60, normalized: 0 } }) as {
        outVec: unknown;
      };
    expect(at(0).outVec).toEqual([0, 0, 0]); // the seed: its (absent) target
    expect(at(1).outVec).toEqual([7, 7, 7]);
  });

  it('converts each wire of a list input on its own', () => {
    registerNodeType({
      type: 'VecList',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: { vs: { type: 'Vector3', cardinality: 'list' } },
      outputs: { out: VECTOR3 },
      evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.vs,
    } as never);
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('vec', 'MakeVec3'),
      wire('seven', 'vec', 'y'),
      node('list', 'VecList'),
      wire('seven', 'list', 'vs'),
      wire('vec', 'list', 'vs'),
    ]);
    // The Number wire is converted; the Vector3 wire beside it is left as it is.
    expect(evaluate(s, 'list').value).toEqual([
      [7, 7, 7],
      [0, 7, 0],
    ]);
  });

  it('is what a leaf reads when its owner`s Vector3 input is wired from a Number', () => {
    // A stateless owner: its leaf reads the owner's own socket of that name.
    registerNodeType({
      type: 'VecOwner',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: { inputVec: VECTOR3, body: { ...VECTOR3, body: true } },
      outputs: { out: VECTOR3 },
      bodyInputs: { inputVec: VECTOR3 },
      evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.body,
    } as never);
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('leaf', 'BodyInputVec', { input: 'inputVec' }),
      node('owner', 'VecOwner'),
      wire('leaf', 'owner', 'body'),
      wire('seven', 'owner', 'inputVec'),
    ]);
    expect(evaluate(s, 'leaf').value).toEqual([7, 7, 7]);
    expect(evaluate(s, 'owner').value).toEqual([7, 7, 7]);
  });
});

describe('a type a socket already takes is never converted (#1549)', () => {
  it('a driver fed a Number folds a number, and fed a Vector3 folds a vector', () => {
    const base = [
      node('seven', 'Seven'),
      node('vec', 'MakeVec3'),
      wire('seven', 'vec', 'x'),
      node('drv', 'ParamDriver', { target: 't', paramPath: 'p', blendMode: 'replace', order: 0 }),
    ];
    const scalar = apply(emptyDagState(), [...base, wire('seven', 'drv', 'in')]);
    const vector = apply(emptyDagState(), [...base, wire('vec', 'drv', 'in')]);
    const sample = (s: DagState) =>
      (evaluate(s, 'drv').value as { sample: (seconds: number) => unknown }).sample(0);
    expect(sample(scalar)).toBe(7);
    expect(sample(vector)).toEqual([7, 0, 0]);
  });

  it('an input that takes both has no conversion at all', () => {
    const into = requireNodeType('ParamDriver').inputs.in;
    expect(acceptedTypes(into)).toEqual(['Number', 'Vector3']);
    expect(conversionsInto(into)).toBeNull();
  });
});

describe('a Vector3 into a Number input (#1590)', () => {
  it('the premise: the vector is [3, 6, 12]', () => {
    const s = apply(emptyDagState(), [node('vec', 'ThreeSixTwelve')]);
    expect(evaluate(s, 'vec').value).toEqual([3, 6, 12]);
  });

  it('is accepted and arrives as the average of its axes, as Blender averages them', () => {
    const s = apply(emptyDagState(), [
      node('vec', 'ThreeSixTwelve'),
      node('seven', 'Seven'),
      node('sum', 'Math', { op: 'add' }),
      wire('vec', 'sum', 'a'),
      wire('seven', 'sum', 'b'),
    ]);
    // (3 + 6 + 12) / 3 = 7, plus 7. Not the first axis (10), the sum (28) or the length (20.7).
    expect(evaluate(s, 'sum').value).toBe(14);
  });

  it('is the same from the other door, a node added already wired', () => {
    const s = apply(emptyDagState(), [
      node('vec', 'ThreeSixTwelve'),
      {
        type: 'addNode',
        nodeId: 'sum',
        nodeType: 'Math',
        params: { op: 'add' },
        inputs: { a: { node: 'vec', socket: 'out' } },
      } as Op,
    ]);
    expect(evaluate(s, 'sum').value).toBe(7);
  });

  it('there and back: a Number through a Vector3 input and out through a Number input', () => {
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('sum', 'Vec3Math', { op: 'add' }),
      wire('seven', 'sum', 'a'),
      node('back', 'Math', { op: 'add' }),
      wire('sum', 'back', 'a'),
    ]);
    expect(evaluate(s, 'back').value).toBe(7);
  });

  it('a value that is not a vector passes through untouched', () => {
    const into = requireNodeType('Math').inputs.a;
    expect(arriving(into, 'Vector3', [3, 6, 12])).toBe(7);
    expect(arriving(into, 'Vector3', undefined)).toBeUndefined();
    expect(arriving(into, 'Vector3', [1, 2])).toEqual([1, 2]);
    expect(arriving(into, 'Number', 5)).toBe(5);
  });
});

describe('a wire that cannot convert says why (#1549)', () => {
  it('two types with nothing between them names both and says a converter is needed', () => {
    const s = apply(emptyDagState(), [
      node('sk', 'Skeleton', { bones: [] }),
      node('sum', 'Math', { op: 'add' }),
    ]);
    expect(() => apply(s, [wire('sk', 'sum', 'a', 'pose')])).toThrow(
      'connect: type mismatch Skeleton.pose:PosedSkeleton → Math.a:Number — there is no ' +
        'conversion from PosedSkeleton to Number, so a converter node is needed between them',
    );
  });

  it('a value that is not what its type promises passes through untouched', () => {
    const into = requireNodeType('Vec3Math').inputs.a;
    expect(arriving(into, 'Number', undefined)).toBeUndefined();
    expect(arriving(into, 'Number', 2)).toEqual([2, 2, 2]);
    expect(arriving(into, 'Vector3', [1, 2, 3])).toEqual([1, 2, 3]);
    expect(arriving(into, undefined, 2)).toBe(2);
  });
});

describe('every pair of plain-value types that can meet has an answer (#1549)', () => {
  it('each is taken as it is or converted; none is refused', () => {
    // The plain-value types any socket carries. A new one (a Color socket, a Boolean socket)
    // lands here with no answer for its pairs and reddens this test.
    const VALUE: readonly SocketTypeName[] = [
      'Number',
      'Vector2',
      'Vector3',
      'Quaternion',
      'Color',
      'Boolean',
    ];
    const produced = new Set<SocketTypeName>();
    const inputs: { at: string; desc: ReturnType<typeof requireNodeType>['inputs'][string] }[] = [];
    for (const id of listNodeTypes()) {
      if (id === 'Seven' || id === 'ThreeSixTwelve') continue;
      const def = requireNodeType(id);
      for (const out of Object.values(def.outputs)) {
        if (VALUE.includes(out.type)) produced.add(out.type);
      }
      for (const [socket, desc] of Object.entries(def.inputs)) {
        if (acceptedTypes(desc).some((t) => VALUE.includes(t)))
          inputs.push({ at: `${id}.${socket}`, desc });
      }
    }
    expect([...produced].sort()).toEqual(['Number', 'Vector3']);
    expect(inputs).toHaveLength(19);

    const answers: Record<string, number> = { taken: 0, converted: 0, refused: 0 };
    for (const { desc } of inputs) {
      for (const from of produced) {
        if (acceptedTypes(desc).includes(from)) answers.taken += 1;
        else if (inputTakes(desc, from)) answers.converted += 1;
        else answers.refused += 1;
      }
    }
    // 19 inputs × 2 produced types = 38. Number inputs (14): take a Number, convert a Vector3
    // (#1590; refused before). Vector3 inputs (4): take a Vector3, convert a Number. The one
    // that takes both: 2 taken.
    expect(answers).toEqual({ taken: 20, converted: 18, refused: 0 });
  });
});
