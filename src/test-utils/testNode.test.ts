// testNode — proof that the builder is spelling-blind where the grep gate is not (#622).
//
// The point of these cases is not that the builder constructs an object. It is that the
// rejection does not depend on how the type was WRITTEN — the property a grep can never
// have, and the reason this exists alongside the retirement gate rather than replacing it.

import { describe, expect, it } from 'vitest';
import { snapshotRegistry } from '../core/dag/registry';
import { SPLIT_KINDS, SPLIT_KIND_NAMES } from './splitKinds';
import { assertLiveNodeType, testNode, testNodes } from './testNode';

/** The retired kinds, derived the same way the retirement gate derives them. */
function retiredTypes(): string[] {
  return [...new Set(SPLIT_KIND_NAMES.flatMap((k) => [...SPLIT_KINDS[k].fusedTypes]))].sort();
}

describe('testNode builds only what the product can build', () => {
  it('builds a live type with the hand-literal shape', () => {
    const n = testNode('n1', 'Object', { params: { a: 1 }, inputs: { data: { node: 'd' } } });
    expect(n).toEqual({
      id: 'n1',
      type: 'Object',
      params: { a: 1 },
      inputs: { data: { node: 'd' } },
    });
  });

  it('defaults params and inputs so it drops into an existing literal fixture', () => {
    expect(testNode('n1', 'Object')).toEqual({
      id: 'n1',
      type: 'Object',
      params: {},
      inputs: {},
    });
  });

  it('builds an id-keyed map', () => {
    const map = testNodes(['a', 'Object'], ['b', 'BoxData', { params: { size: 1 } }]);
    expect(Object.keys(map).sort()).toEqual(['a', 'b']);
    expect(map.b.params).toEqual({ size: 1 });
  });

  it('registers on demand, so a fixture built before the suite seeds still validates', () => {
    // The ordering trap this closes: validating against an empty table would pass every
    // type, including a retired one, and read exactly like a clean fixture.
    expect(Object.keys(snapshotRegistry()).length).toBeGreaterThan(20);
  });
});

describe('a retired kind is unbuildable, however it is spelled', () => {
  it('rejects every retired type', () => {
    const retired = retiredTypes();
    expect(retired.length).toBeGreaterThanOrEqual(9); // guard the guard
    for (const t of retired) {
      expect(() => testNode('n', t), `${t} must be unbuildable`).toThrow(/not a registered/);
    }
  });

  it('rejects a type assembled at RUNTIME — the case no grep can see', () => {
    // Every spelling the retirement gate's three patterns cannot match. If the builder
    // only rejected literals it would be a grep with extra steps.
    const parts = ['Box', 'Mesh'];
    const computed = parts.join(''); // 'BoxMesh'
    const fromVariable = retiredTypes()[0];
    const templated = `${'Sphere'}${'Mesh'}`;

    expect(() => testNode('n', computed)).toThrow(/not a registered/);
    expect(() => testNode('n', fromVariable)).toThrow(/not a registered/);
    expect(() => testNode('n', templated)).toThrow(/not a registered/);
    // ...and through the map builder, which is where a fixture usually reaches for it.
    expect(() => testNodes(['a', 'Object'], ['b', computed])).toThrow(/not a registered/);
  });

  it('names the type and points at the two legitimate ways out', () => {
    let msg = '';
    try {
      testNode('n', 'BoxMesh');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("'BoxMesh'");
    expect(msg).toMatch(/retarget/i);
    expect(msg).toMatch(/RELIC_IS_THE_SUBJECT/);
  });

  it('rejects a type that never existed at all, not just a retired one', () => {
    expect(() => assertLiveNodeType('NotAThing')).toThrow(/not a registered/);
  });
});
