// #633 (ns-1) — the store's instrument: growth is attributed on insertion, residency is a
// number, and a re-derived set is a HIT rather than a second entry.
//
// The store ships with no eviction (stated as limit 1 in its header). That is only an
// acceptable position while growth is measurable, which is what this file pins: if a future
// producer starts minting a fresh key per evaluate — the failure that would make an
// unbounded store expensive rather than merely unbounded — the resident count moves and this
// reds, instead of the problem surfacing as a memory report two phases later.
//
// REF: src/app/attributeStore.ts; src/nodes/attributeKey.ts; issues #633, #586, #587, #588.

import { beforeEach, describe, expect, it } from 'vitest';
import { mintAttributes } from '../nodes/attributeKey';
import type { AttributeData } from '../nodes/attributes';
import { growthBySource, insert, read, residentCount, resetGrowth } from './attributeStore';

const faceIndex = (values: number[]): AttributeData => ({
  domain: 'face',
  type: 'int',
  count: values.length,
  data: new Int32Array(values),
});

const cornerUv = (data: number[]): AttributeData => ({
  domain: 'corner',
  type: 'float2',
  count: data.length / 2,
  data: new Float32Array(data),
});

/** Mint, insert, and hand back the resident set — the shape a producer will use. */
function put(entries: Record<string, AttributeData>, via: 'evaluate' | 'prime' = 'evaluate') {
  const minted = mintAttributes(entries);
  expect(minted).not.toBeNull();
  return insert(minted!.key, minted!.set, via);
}

beforeEach(() => {
  resetGrowth();
});

describe('#633 attribute store — content keying', () => {
  it('returns the RESIDENT set for a second insert of equal content', () => {
    const first = put({ material_index: faceIndex([0, 0, 1]) });
    const second = put({ material_index: faceIndex([0, 0, 1]) });

    // Equal by reference, not merely equal by value — two producers deriving the same
    // attributes converge on one object, which is what makes re-derivation free.
    expect(second).toBe(first);
  });

  it('reads back what was inserted, and nothing for a key never inserted', () => {
    const minted = mintAttributes({ UVMap: cornerUv([0, 0, 1, 0, 0, 1]) })!;
    insert(minted.key, minted.set, 'evaluate');

    expect(read(minted.key)).toBe(minted.set);
    expect(read('a key nothing ever minted')).toBeNull();
  });
});

describe('#633 attribute store — growth is attributed, and residency is a number', () => {
  it('counts an insertion once, against the road that caused it', () => {
    // Content distinct from every other case in this file: the store is process-wide by
    // design and never evicts, so a shared value would make this a hit for the wrong reason.
    const before = residentCount();

    put({ material_index: faceIndex([2, 2, 3]) });
    put({ material_index: faceIndex([2, 2, 3]) }); // a hit — must not count
    put({ material_index: faceIndex([2, 3, 3]) }); // different content — must count

    expect(residentCount()).toBe(before + 2);
    expect(growthBySource()).toEqual({ evaluate: 2, prime: 0 });
  });

  it('has NO async producer yet, and says so as a number', () => {
    // `prime` exists so the first async filler has to declare itself rather than be
    // counted as an evaluate. Until then its count is zero, and that zero is the census.
    put({ material_index: faceIndex([0]) });
    expect(growthBySource().prime).toBe(0);
  });

  it('pins the resident count for a fixed scene', () => {
    // Three objects: two boxes with IDENTICAL attributes and one sphere with its own.
    // The scene has three meshes and five attributes; the store holds TWO entries, because
    // identity is content and the two boxes are the same content.
    const boxAttributes = { material_index: faceIndex([0]), UVMap: cornerUv([0, 0, 1, 0, 0, 1]) };
    const sphereAttributes = {
      material_index: faceIndex([1]),
      UVMap: cornerUv([0, 0, 0.5, 0, 0, 0.5]),
    };

    const before = residentCount();
    put(boxAttributes);
    put(boxAttributes);
    put(sphereAttributes);

    expect(residentCount() - before).toBe(2);
    expect(growthBySource().evaluate).toBe(2);
  });

  it('resetGrowth zeroes the counters WITHOUT evicting (limit 1, stated as behaviour)', () => {
    put({ material_index: faceIndex([7]) });
    const resident = residentCount();

    resetGrowth();

    expect(growthBySource()).toEqual({ evaluate: 0, prime: 0 });
    expect(residentCount()).toBe(resident);
  });
});
