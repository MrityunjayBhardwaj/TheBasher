// #1855 — a node type's parent and gathering sockets are kept per definition, so they are scanned
// once rather than on every evaluation. A type registered again is a new definition: its answer is
// read afresh, never the one the old definition gave.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, registerNodeType } from './registry';
import { gatheringSocketOf, parentSocketOf } from './worldChildren';

function register(type: string, inputs: Record<string, object>): void {
  registerNodeType({
    type,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs,
    outputs: { out: { type: 'Object', cardinality: 'single' } },
    evaluate: () => undefined,
  } as never);
}

afterEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('a type’s parent and gathering sockets (#1855)', () => {
  it('the real types answer as their definitions mark them', () => {
    __resetRegistryForTests();
    registerAllNodes();
    expect(parentSocketOf('Object')).toBe('parent');
    expect(gatheringSocketOf('Group')).toBe('children');
    expect(parentSocketOf('BoxData')).toBeNull();
    expect(gatheringSocketOf('NoSuchType')).toBeNull();
  });

  it('a type registered again is read afresh, not from what its old definition answered', () => {
    __resetRegistryForTests();
    register('T1855', {
      kids: { type: 'Object', cardinality: 'multi', gathersChildren: true },
      up: { type: 'Object', cardinality: 'single', world: true },
    });
    expect(gatheringSocketOf('T1855')).toBe('kids');
    expect(parentSocketOf('T1855')).toBe('up');
    // Asked twice: the second answer comes from the memo and must be the same.
    expect(gatheringSocketOf('T1855')).toBe('kids');

    __resetRegistryForTests();
    register('T1855', {
      held: { type: 'Object', cardinality: 'multi', gathersChildren: true },
    });
    expect(gatheringSocketOf('T1855')).toBe('held');
    expect(parentSocketOf('T1855')).toBeNull();
  });
});
