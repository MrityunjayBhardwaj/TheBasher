// #1570 — a node type's body-input declarations are checked when it registers (#1548).
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, listNodeTypes, getNodeType, registerNodeType } from './index';

beforeEach(() => __resetRegistryForTests());

const NUMBER = { type: 'Number', cardinality: 'single' } as const;
const base = {
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: z.object({}),
  inputs: {},
  outputs: { out: NUMBER },
  evaluate: () => 0,
};
const register = (def: object) => registerNodeType(def as never);

describe('#1570 — body-input declarations are refused when nothing would honour them', () => {
  it('an owner must have a body socket', () => {
    expect(() =>
      register({ ...base, type: 'NoBody', inputs: { in: NUMBER }, bodyInputs: { prev: NUMBER } }),
    ).toThrow(/NoBody.*bodyInputs \(prev\).*no input marked `body: true`/s);
    expect(() =>
      register({
        ...base,
        type: 'Owner',
        inputs: { body: { ...NUMBER, body: true } },
        bodyInputs: { prev: NUMBER },
      }),
    ).not.toThrow();
  });

  const leaf = { ...base, bodyInputLeaf: true, paramSchema: z.object({ input: z.string() }) };

  it('a leaf has exactly one output', () => {
    expect(() =>
      register({ ...leaf, type: 'TwoOut', outputs: { out: NUMBER, other: NUMBER } }),
    ).toThrow(/TwoOut.*exactly one output.*declares 2 \(out, other\)/s);
    expect(() => register({ ...leaf, type: 'NoOut', outputs: {} })).toThrow(/declares 0 \(none\)/);
  });

  it('a leaf has no inputs of its own', () => {
    expect(() => register({ ...leaf, type: 'Wired', inputs: { in: NUMBER } })).toThrow(
      /Wired.*no inputs of its own.*declares in/s,
    );
  });

  it('a leaf names its input in an `input` param', () => {
    expect(() => register({ ...leaf, type: 'Nameless', paramSchema: z.object({}) })).toThrow(
      /Nameless.*`input` param/s,
    );
    expect(() => register({ ...leaf, type: 'Leaf' })).not.toThrow();
  });

  it('the shipped types pass, and the check had something to look at', () => {
    registerAllNodes();
    const defs = listNodeTypes().map((t) => getNodeType(t)!);
    expect(defs.filter((d) => d.bodyInputs).map((d) => d.type)).toEqual(['Solver']);
    expect(
      defs
        .filter((d) => d.bodyInputLeaf)
        .map((d) => d.type)
        .sort(),
    ).toEqual(['BodyInput', 'BodyInputVec']);
  });
});
