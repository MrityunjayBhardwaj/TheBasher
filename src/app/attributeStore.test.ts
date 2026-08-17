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
import { coveredIndexCount, groupsFromMaterialIndex } from './materialGroups';

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
function put(
  entries: Record<string, AttributeData>,
  via: 'evaluate' | 'read' | 'prime' = 'evaluate',
) {
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
    // Restated, not floored, when #638 added the `overlay` origin: the whole record is
    // compared rather than one field, so a NEW origin reds here and has to be answered for
    // — which is the point. An origin nobody enumerates is an origin nobody counts.
    // EXACT, not a subset: the origin table is a growing population, so a row that only
    // checked `evaluate` would stay green when a new producer landed under a label nobody
    // reads. `modifier` joined at #644 — the generator tiling — and this red is the row
    // doing its job.
    expect(growthBySource()).toEqual({ evaluate: 2, read: 0, prime: 0, overlay: 0, modifier: 0 });
  });

  it('has NO async producer yet, and says so as a number', () => {
    // `prime` is the ASYNC road — a loader hook filling attributes after an OPFS read.
    // Nothing does that yet, and that zero is the census: the UV attribute arrives on the
    // synchronous `read` road instead, off geometry the registry had already built.
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

    expect(growthBySource()).toEqual({ evaluate: 0, read: 0, prime: 0, overlay: 0, modifier: 0 });
    expect(residentCount()).toBe(resident);
  });
});

// #638 (ns-1b step 9) — THE STORED ARRAY IS NOT THE DERIVATION'S SCRATCH SPACE.
//
// The store's declared limit 3 is that nothing ENFORCES immutability of a resident set: a
// reader gets the live `Int32Array`, and the content key was computed once, at insertion.
// So a reader that sorted, coalesced or renumbered in place would corrupt the set for every
// OTHER holder of that key — silently, since the key still names the old bytes, and the
// corruption would surface in a different mesh entirely. This phase adds the first reader
// that walks the whole face index on the render road, which is what makes the limit worth a
// test rather than a sentence.
describe('#638 a full render-side derivation leaves the stored bytes alone', () => {
  it('the resident Int32Array is byte-identical after the group layout is derived from it', () => {
    const values = [0, 0, 1, 1, 1, 0, 2, 2, 0, 0, 1, 0];
    const set = put({ material_index: faceIndex(values) });
    const stored = set.material_index.data as Int32Array;
    const before = Array.from(stored);

    // The derivation the renderer runs, over the resident bytes — not over a copy.
    const groups = groupsFromMaterialIndex(stored, values.length * 3);
    expect(groups).not.toBeNull();
    expect(groups!.length).toBeGreaterThan(1); // it really did walk and coalesce
    expect(coveredIndexCount(groups!, 3)).toBe(values.length * 3);

    // Same object, same bytes: read back through the store rather than through the local
    // reference, so a derivation that replaced the entry would also be caught.
    const again = read(mintAttributes({ material_index: faceIndex(values) })!.key)!;
    expect(again.material_index.data).toBe(stored);
    expect(Array.from(again.material_index.data as Int32Array)).toEqual(before);
  });
});
