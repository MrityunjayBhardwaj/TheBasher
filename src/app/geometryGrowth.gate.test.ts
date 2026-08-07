// GATE — the geometry registry's GROWTH LAW, pinned per origin (#586, P5a of #575/#544).
//
// ⚠️ THIS GATE ASSERTS THE DEFECT, NOT THE FIX. Every case below says "the population grew
// and nothing freed it", which is the opposite of what the lifetime slice will assert. That
// is deliberate and it is why the two live in different issues: a baseline and its own
// repair cannot be gated in one file without one arm contradicting the other. When the
// lifetime lands, these numbers change and this file is the record of what they were.
//
// WHY PER-ORIGIN AND NOT A TOTAL. The candidate fixes for #544 are not interchangeable, and
// the axis that separates them is not how MUCH the cache grows but WHERE the entries come
// from. A refcount can only be placed on a door; `internal` entries pass through no door at
// all — `build` resolves an `array`/`mirror` source through `get`, caching a box that no
// consumer ever attaches. A total cannot see the difference. These cases can, and the last
// one is the whole argument: attaching N array refs leaves 2N entries, and a refcount at the
// attach door would be told about exactly N of them.
//
// Falsified per ARM: each case names one origin and asserts the others stayed at zero, so
// mis-tagging one call site reds that case alone rather than shifting a single total.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { clear, getForAttach, getForRead, growthBySource, prime, size } from './geometryRegistry';
import { BoxGeometry } from 'three';
import type { GeometryRef } from '../nodes/types';

// `clear` resets the counters with the cache, so every case starts from a stated zero
// rather than from whatever the previous case left ([[H251]] — a census that goes green by
// its subject emptying; here the subject must be empty at the START and not at the end).
beforeEach(() => clear());

const ZERO = { attach: 0, read: 0, internal: 0, prime: 0 };

/** The 2s-at-60fps drag #544 quotes: 121 distinct sizes, one per frame. */
const DRAG_FRAMES = 121;
const dragSize = (f: number): [number, number, number] => {
  const s = 1 + (3 * f) / (DRAG_FRAMES - 1);
  return [s, s, s];
};

describe('#586 — the growth law, per origin', () => {
  it('starts empty, and says so before anything is measured', () => {
    expect(size()).toBe(0);
    expect(growthBySource()).toEqual(ZERO);
  });

  // ── SOURCE 1: the attach door ────────────────────────────────────────────────────────
  it('a 121-frame box drag through the attach door leaves exactly 121 entries, all attributed to attach', () => {
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f)));

    expect(size()).toBe(DRAG_FRAMES);
    expect(growthBySource()).toEqual({ ...ZERO, attach: DRAG_FRAMES });
  });

  // The second half of the measurement, and the reason #537 shipped: growth is a function
  // of how many DISTINCT values were visited, never of how many times each was produced
  // ([[V163]]). Scrubbing back over the same frames must cost nothing at all.
  it('replaying the SAME frames adds no entry and no growth — the key is content-derived', () => {
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f)));
    const afterFirstPass = size();

    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f)));

    expect(size()).toBe(afterFirstPass);
    expect(growthBySource().attach).toBe(DRAG_FRAMES); // the replay contributed zero
  });

  // ── SOURCE 2: the read doors ─────────────────────────────────────────────────────────
  // Six production sites resolve geometry to COMPUTE from it and discard it, and every one
  // of them caches on miss exactly as an attach does — the doors are the same function.
  // A reader that runs during a drag therefore grows the registry with entries no attach
  // site ever asked for.
  it('a read caches on miss too, and is attributed to the read door', () => {
    for (let f = 0; f < DRAG_FRAMES; f++) getForRead(boxGeometryRef(dragSize(f)));

    expect(size()).toBe(DRAG_FRAMES);
    expect(growthBySource()).toEqual({ ...ZERO, read: DRAG_FRAMES });
  });

  it('a read AFTER an attach of the same key is a hit — the two doors share one entry', () => {
    getForAttach(boxGeometryRef([1, 1, 1]));
    getForRead(boxGeometryRef([1, 1, 1]));

    expect(size()).toBe(1);
    expect(growthBySource()).toEqual({ ...ZERO, attach: 1 });
  });

  // ── SOURCE 3: build's own recursion — THE ONE A DOOR CANNOT SEE ──────────────────────
  it('an array drag leaves TWO entries per frame: the merged result, and a source nothing attaches', () => {
    for (let f = 0; f < DRAG_FRAMES; f++) {
      getForAttach(arrayGeometryRef(boxGeometryRef(dragSize(f)), 3, [1, 0, 0]));
    }

    // 2N, not N. The attach door was called N times and is told about N.
    expect(size()).toBe(2 * DRAG_FRAMES);
    expect(growthBySource()).toEqual({
      ...ZERO,
      attach: DRAG_FRAMES,
      internal: DRAG_FRAMES,
    });
  });

  it('a mirror drag has the same shape — the recursion is a property of build, not of array', () => {
    for (let f = 0; f < DRAG_FRAMES; f++) {
      getForAttach(mirrorGeometryRef(boxGeometryRef(dragSize(f)), 'x', 0));
    }

    expect(size()).toBe(2 * DRAG_FRAMES);
    expect(growthBySource()).toEqual({
      ...ZERO,
      attach: DRAG_FRAMES,
      internal: DRAG_FRAMES,
    });
  });

  // The sharpest form of the same fact, stated as identity rather than as a count: the
  // source instance IS in the cache, reachable, and no consumer ever attached it.
  it('the source cached by build is the very instance a later read hits', () => {
    const source = boxGeometryRef([2, 2, 2]);
    getForAttach(arrayGeometryRef(source, 3, [1, 0, 0]));
    expect(growthBySource().internal).toBe(1);

    const hit = getForRead(source); // no build — the entry build left behind
    expect(hit).not.toBeNull();
    expect(size()).toBe(2);
    expect(growthBySource().read).toBe(0); // it was a HIT, so it grew nothing
  });

  // ── SOURCE 4: prime, the asynchronous door ───────────────────────────────────────────
  it('a primed baked geometry is its own origin — it is not built and not attributed to a door', () => {
    const ref: GeometryRef = {
      key: 'baked|abc-8',
      kind: 'baked',
      descriptor: { kind: 'baked', hash: 'abc', vertexCount: 8 },
    };
    expect(getForRead(ref)).toBeNull(); // a baked MISS builds nothing
    expect(growthBySource()).toEqual(ZERO);

    prime(ref, new BoxGeometry(1, 1, 1));

    expect(size()).toBe(1);
    expect(growthBySource()).toEqual({ ...ZERO, prime: 1 });
  });

  // ── THE POPULATION IS NEVER BOUNDED, AND THE ENTRIES ARE NOT FREE ────────────────────
  // #544's residual in one case: a heavier primitive, a longer session, nothing evicting.
  // The gate is that the total equals the number of distinct values visited — i.e. that
  // the cache has no ceiling of any kind, which is precisely the thing P5b will change.
  it('nothing bounds the population — 500 distinct spheres leave 500 entries', () => {
    const N = 500;
    for (let f = 0; f < N; f++) getForAttach(sphereGeometryRef(1 + f / N, 16, 8));

    expect(size()).toBe(N);
    expect(growthBySource()).toEqual({ ...ZERO, attach: N });
  });

  it('the counters sum to the population while nothing evicts — and that identity is the check', () => {
    getForAttach(boxGeometryRef([1, 1, 1]));
    getForRead(boxGeometryRef([2, 2, 2]));
    getForAttach(arrayGeometryRef(boxGeometryRef([3, 3, 3]), 2, [1, 0, 0]));

    const g = growthBySource();
    const inserted = g.attach + g.read + g.internal + g.prime;
    expect(inserted).toBe(size());
    // Once an eviction exists, this identity breaks by exactly the number freed — which is
    // how the lifetime slice will read its own effect off these same two seams.
    expect(inserted).toBe(4);
  });
});
