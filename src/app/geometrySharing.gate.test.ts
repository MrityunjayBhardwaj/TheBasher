// The property that decides where material and per-object attributes may live (#605).
//
// `GeometryRef` reads like a per-object handle. It is not: it is a LOOKUP KEY into
// one process-wide, content-derived cache. Two nodes whose descriptors are equal
// resolve to the SAME `BufferGeometry` instance — not an equal one, the same one.
//
// That single fact answers #605's scope item 1 in the negative. The issue asks
// whether material should move "onto the geometry side" the way a reference
// substrate carries assignment as a primitive-class attribute riding along in the
// geometry container. It cannot ride on THIS container: two same-size boxes with
// different materials share one entry, so an assignment attached here would either
// collide or force the material into the cache key — which would shatter the
// sharing the registry exists to provide (a box per material, not a box).
//
// Where material actually lives is the data half of the object/data pair
// (`BoxData` = geometry + material + deliberately no transform), which is already
// the placement #605 asks for. `EvaluatedMesh`'s four sibling fields are a flat
// READ PROJECTION over that pair, and the flatness is deliberate — see the note at
// its declaration in nodes/types.ts.
//
// This gate exists so the "attach it to the geometry handle" design keeps failing
// against a measurement rather than being re-litigated from the type's shape.

import { describe, expect, it, beforeEach } from 'vitest';
import { clear, getForRead, size } from './geometryRegistry';
import type { GeometryRef } from '../nodes/types';

function boxRef(size: [number, number, number]): GeometryRef {
  return {
    key: `box|${size.join(',')}`,
    kind: 'box',
    descriptor: { kind: 'box', size },
  };
}

beforeEach(() => {
  clear();
});

describe('#605 — a GeometryRef is a SHARED handle, not a per-object container', () => {
  it('two independently built refs with equal content resolve to the SAME instance', () => {
    const a = getForRead(boxRef([1, 1, 1]));
    const b = getForRead(boxRef([1, 1, 1]));

    expect(a).not.toBeNull();
    // Identity, not equality. This is the whole finding: whatever is attached here
    // is attached to something two different objects are simultaneously holding.
    expect(a).toBe(b);
    expect(size()).toBe(1);
  });

  it('differing content resolves to a different instance (the key IS the content)', () => {
    const a = getForRead(boxRef([1, 1, 1]));
    const c = getForRead(boxRef([2, 1, 1]));

    expect(a).not.toBe(c);
    expect(size()).toBe(2);
  });

  it('sharing is what makes the cache a cache — N identical objects hold ONE instance', () => {
    const instances = new Set();
    for (let i = 0; i < 10; i++) instances.add(getForRead(boxRef([1, 1, 1])));

    // Asserting `size() === 1` alone would NOT test sharing: with the cache
    // writing but never reading, ten rebuilds overwrite one key and the entry
    // count still reads 1 while every caller holds a different object. Counting
    // DISTINCT INSTANCES is what separates those two worlds.
    expect(instances.size).toBe(1);
    // If material (or any per-object attribute) were part of this identity, ten
    // differently-shaded boxes would cost ten entries instead of one. That is the
    // cost the placement question is really trading against.
    expect(size()).toBe(1);
  });
});
