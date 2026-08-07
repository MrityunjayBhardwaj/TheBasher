// The registry's residue, measured in bytes rather than entries (#588, closing out #575's
// geometry-lifetime phase).
//
// WHY THIS GATE EXISTS. #587's sweep bounds growth and states its own limit in ENTRIES —
// "up to one growth budget of dead ones waits for the next churn". Nothing can be decided in
// that unit. An entry is a unit box or the merged output of an array modifier over a dense
// mesh, and those differ by orders of magnitude, so whether the residue deserves a second
// sweep cadence is a question `size()` structurally cannot answer. These cases pin the
// instrument that can, BEFORE it is used to take that decision — an instrument trusted for a
// fork it has never been falsified on is just a number with authority.
//
// Every case below is written to red on a specific wrong implementation, named in its
// comment. The three that matter are: bytes must not be a function of the entry COUNT,
// shared storage must be counted once, and the index must not be forgotten.
//
// REF: src/app/geometryRegistry.ts (`residentBytes`); src/viewport/geometrySweep.ts (the
//      declared limit this is here to price); issues #588, #587, #575, #544.

import { BufferAttribute, BufferGeometry } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import { clear, getForRead, prime, residentBytes, size } from './geometryRegistry';

afterEach(() => clear());

const sphereRef = (key: string, w: number, h: number): GeometryRef => ({
  key,
  kind: 'sphere',
  descriptor: { kind: 'sphere', radius: 1, widthSegments: w, heightSegments: h },
});

/** A ref that only ever reaches the cache through `prime`, so the test controls the bytes. */
const primedRef = (key: string): GeometryRef => ({
  key,
  kind: 'baked',
  descriptor: { kind: 'baked', hash: key, vertexCount: 0 },
});

describe('geometryRegistry.residentBytes', () => {
  it('is zero on an empty cache, and returns to zero after clear', () => {
    expect(residentBytes()).toBe(0);
    getForRead(sphereRef('s|8,6', 8, 6));
    expect(residentBytes()).toBeGreaterThan(0);
    clear();
    expect(residentBytes()).toBe(0);
  });

  // THE CASE THE WHOLE INSTRUMENT EXISTS FOR. Two caches of exactly ONE entry each, whose
  // costs differ by more than an order of magnitude. Reds on any implementation that derives
  // bytes from `size()` — which is the shortcut that would make this a second name for the
  // number we already had, and the reason #587's limit could not be decided.
  it('is NOT a function of the entry count — one dense entry outweighs one sparse entry', () => {
    getForRead(sphereRef('s|4,3', 4, 3));
    const sparse = residentBytes();
    expect(size()).toBe(1);

    clear();
    getForRead(sphereRef('s|64,48', 64, 48));
    const dense = residentBytes();
    expect(size()).toBe(1);

    expect(dense).toBeGreaterThan(sparse * 10);
  });

  // Reds on dropping the `seen` set. Two entries, two attributes, ONE underlying buffer:
  // dropping either entry alone frees nothing, so counting the storage twice would inflate
  // the residue in exactly the direction that argues for building a cadence.
  it('counts storage shared between two entries ONCE, at the buffer’s full length', () => {
    const shared = new Float32Array(300); // 1200 bytes, one ArrayBuffer
    const first = new BufferGeometry();
    first.setAttribute('position', new BufferAttribute(shared.subarray(0, 150), 3));
    const second = new BufferGeometry();
    second.setAttribute('position', new BufferAttribute(shared.subarray(150), 3));

    prime(primedRef('shared|a'), first);
    prime(primedRef('shared|b'), second);

    expect(size()).toBe(2);
    // 1200, not 2400 (double-counted) and not 600 (view length instead of buffer length).
    expect(residentBytes()).toBe(shared.buffer.byteLength);
  });

  // Reds on removing `account(geom.index)`. An indexed geometry's index is real storage and
  // is a large fraction of a triangle-dense mesh — forgetting it understates precisely the
  // arm that would justify the cadence.
  it('counts the index, not only the attributes', () => {
    const attributes = new Float32Array(90); // 360 bytes
    const withoutIndex = new BufferGeometry();
    withoutIndex.setAttribute('position', new BufferAttribute(attributes, 3));
    prime(primedRef('idx|without'), withoutIndex);
    const unindexed = residentBytes();

    clear();

    const indexed = new BufferGeometry();
    indexed.setAttribute('position', new BufferAttribute(new Float32Array(90), 3));
    indexed.setIndex(new BufferAttribute(new Uint16Array(30), 1)); // 60 bytes
    prime(primedRef('idx|with'), indexed);

    expect(residentBytes()).toBe(unindexed + 60);
  });

  // Reds on dropping the morph loop. Morph targets are per-vertex copies of the base
  // attribute — the one kind of entry whose bytes can dwarf everything else it carries.
  it('counts morph targets', () => {
    const base = new BufferGeometry();
    base.setAttribute('position', new BufferAttribute(new Float32Array(90), 3));
    prime(primedRef('morph|without'), base);
    const plain = residentBytes();

    clear();

    const morphed = new BufferGeometry();
    morphed.setAttribute('position', new BufferAttribute(new Float32Array(90), 3));
    morphed.morphAttributes.position = [
      new BufferAttribute(new Float32Array(90), 3),
      new BufferAttribute(new Float32Array(90), 3),
    ];
    prime(primedRef('morph|with'), morphed);

    expect(residentBytes()).toBe(plain + 2 * 360);
  });

  // The residue this phase is about, stated at the unit tier: entries the sweep has not
  // collected are entries whose bytes are still held. Asserts the DELTA rather than a total,
  // so it cannot pass by the cache happening to be empty — the population is asserted first.
  it('holds the bytes of every uncollected entry, so a residue of N entries has a price', () => {
    const before = residentBytes();
    expect(size()).toBe(0);

    for (let i = 0; i < 8; i++) getForRead(sphereRef(`s|residue-${i}`, 16, 12 + i));
    expect(size()).toBe(8);

    const held = residentBytes() - before;
    expect(held).toBeGreaterThan(0);

    // And the price is per-entry, not per-cache: half the population holds materially less.
    clear();
    for (let i = 0; i < 4; i++) getForRead(sphereRef(`s|residue-${i}`, 16, 12 + i));
    expect(size()).toBe(4);
    expect(residentBytes()).toBeLessThan(held);
  });
});
