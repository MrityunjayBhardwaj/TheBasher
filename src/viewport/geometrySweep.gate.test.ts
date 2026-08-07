// GATE — geometry's lifetime (#587, closing the growth half of #544).
//
// This is the file `geometryGrowth.gate.test.ts` is the "before" of. That one asserts the
// DEFECT — 121 frames leave 121 entries and nothing frees them. This one asserts the bound.
// They are deliberately not merged: a baseline and its repair state opposite things, and a
// single file asserting both would have one arm contradicting the other.
//
// ⚠️ EVERY CASE ASSERTS THAT DISPOSALS HAPPENED BEFORE IT ASSERTS WHAT SURVIVED. A sweep
// that freed nothing satisfies "nothing attached was disposed" perfectly, and a sweep that
// never ran satisfies it better still ([[H251]] — a census green because its subject is
// empty). `disposed` is checked first in each case, and it is checked as an EXACT count
// wherever the number is determined.
//
// The walk is exercised over real `Mesh`/`Group` objects rather than a hand-built Set,
// because the two halves fail differently — the registry's failure is freeing something in
// use, the walk's is failing to see it — and a Set fixture would test only the first.

import { describe, expect, it, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene } from 'three';
import {
  clear,
  getForAttach,
  getForRead,
  growthBySource,
  prime,
  size,
} from '../app/geometryRegistry';
import type { GeometryRef } from '../nodes/types';
import { arrayGeometryRef, boxGeometryRef } from '../app/modifierGeometry';
import {
  SWEEP_GROWTH_BUDGET,
  __resetSweepCadenceForTests,
  collectAttachedGeometry,
  sweepIfDue,
} from './geometrySweep';

beforeEach(() => {
  clear();
  __resetSweepCadenceForTests();
});

const DRAG_FRAMES = 121;
const dragSize = (f: number): [number, number, number] => {
  const s = 1 + (3 * f) / (DRAG_FRAMES - 1);
  return [s, s, s];
};

/** A scene holding one mesh per geometry — the shape the walk actually meets. */
function sceneDrawing(...geoms: (ReturnType<typeof getForAttach> | null)[]): Scene {
  const scene = new Scene();
  const group = new Group(); // nested, so a flat walk would miss them
  for (const g of geoms) {
    if (!g) continue;
    group.add(new Mesh(g, new MeshBasicMaterial()));
  }
  scene.add(group);
  return scene;
}

/** Force a sweep regardless of the budget, by asking past it. */
function sweepNow(scene: Scene) {
  __resetSweepCadenceForTests();
  const before = size();
  const result = sweepIfDue(scene);
  return { result, before };
}

describe('#587 — the sweep frees what nothing draws', () => {
  // ── THE GOAL SCENARIO ────────────────────────────────────────────────────────────────
  // A drag. Nothing unmounts: the SAME mesh is re-pointed at a new geometry every frame,
  // which is what a re-render with a new key does. This is the case the whole phase exists
  // for, and the one an unmount-driven design would never have covered.
  it('bounds a 121-frame drag in which NOTHING unmounts', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    for (let f = 0; f < DRAG_FRAMES; f++) {
      const geom = getForAttach(boxGeometryRef(dragSize(f)));
      mesh.geometry = geom!; // the same mounted mesh, a new instance each frame
    }
    expect(size()).toBe(DRAG_FRAMES); // the defect, reproduced first

    const { result } = sweepNow(scene);

    expect(result).not.toBeNull();
    expect(result!.disposed).toBe(DRAG_FRAMES - 1); // every frame but the one on screen
    expect(size()).toBe(1);
    expect(mesh.geometry).toBe(getForRead(boxGeometryRef(dragSize(DRAG_FRAMES - 1))));
  });

  it('frees BOTH halves of a modifier drag — including the source no door can see', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    for (let f = 0; f < DRAG_FRAMES; f++) {
      mesh.geometry = getForAttach(arrayGeometryRef(boxGeometryRef(dragSize(f)), 3, [1, 0, 0]))!;
    }
    // 2N: the merged results plus the sources `build` recursed into (#586's measurement).
    expect(size()).toBe(2 * DRAG_FRAMES);
    expect(growthBySource().internal).toBe(DRAG_FRAMES);

    const { result } = sweepNow(scene);

    // Every entry but the attached one goes — INCLUDING the last frame's source, which is
    // itself attached to nothing. A refcount at the attach door would have kept all 121.
    expect(result!.disposed).toBe(2 * DRAG_FRAMES - 1);
    expect(size()).toBe(1);
  });

  // ── WHAT MUST SURVIVE ────────────────────────────────────────────────────────────────
  it('never disposes an attached instance, in a sweep that disposed plenty', () => {
    const kept = getForAttach(boxGeometryRef([9, 9, 9]));
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f)));
    const scene = sceneDrawing(kept);

    const { result } = sweepNow(scene);

    expect(result!.disposed).toBe(DRAG_FRAMES); // the sweep did real work…
    expect(result!.attached).toBe(1); // …and this is what it spared
    expect(size()).toBe(1);
    // Identity, not just the count: the surviving entry IS the instance on the mesh.
    expect(getForRead(boxGeometryRef([9, 9, 9]))).toBe(kept);
    // And it is still usable — a disposed BufferGeometry keeps its attributes, so the
    // count alone would not distinguish "spared" from "disposed but still in the Map".
    expect(kept!.getAttribute('position')).toBeTruthy();
  });

  it('spares a primed baked entry that nothing is drawing — the exemption is load-bearing', () => {
    const ref: GeometryRef = {
      key: 'baked|abc-8',
      kind: 'baked',
      descriptor: { kind: 'baked', hash: 'abc', vertexCount: 8 },
    };
    prime(ref, new BoxGeometry(1, 1, 1));
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f)));

    const { result } = sweepNow(new Scene()); // an EMPTY scene: nothing is attached at all

    expect(result!.disposed).toBe(DRAG_FRAMES); // everything rebuildable went…
    expect(result!.exempt).toBe(1); // …and the one that is not, stayed
    expect(getForRead(ref)).not.toBeNull();
    // Why it matters, in one line: `bakedGeometryLoader.promiseCache` is keyed by ref.key
    // and never cleared, so a miss here re-throws a SETTLED promise and suspends forever.
    // Baked bytes are also authoritative — the registry cannot rebuild them from params.
  });

  it('sees a mesh nested arbitrarily deep, not just the scene root’s children', () => {
    const kept = getForAttach(boxGeometryRef([5, 5, 5]));
    // Enough unattached entries to make a sweep due — the cadence is a real precondition
    // here, not scaffolding, and a helper that forced past it would be testing a function
    // no caller can reach.
    for (let f = 0; f < SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f)));

    const scene = new Scene();
    let node: Group = new Group();
    scene.add(node);
    for (let d = 0; d < 6; d++) {
      const next = new Group();
      node.add(next);
      node = next;
    }
    node.add(new Mesh(kept!, new MeshBasicMaterial()));

    const { result } = sweepNow(scene);

    expect(result!.disposed).toBe(SWEEP_GROWTH_BUDGET);
    expect(result!.attached).toBe(1); // found at depth 7 — a shallow walk would report 0
    expect(collectAttachedGeometry(scene).has(kept!)).toBe(true);
  });

  // ── THE CADENCE ──────────────────────────────────────────────────────────────────────
  it('does not walk the scene until the budget is exceeded', () => {
    const scene = new Scene();
    for (let f = 0; f < SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f)));

    // At the budget exactly: no sweep. `null` is not "swept and freed nothing" — the
    // distinction is the whole reason the return type is nullable.
    expect(sweepIfDue(scene)).toBeNull();
    expect(size()).toBe(SWEEP_GROWTH_BUDGET);

    getForAttach(boxGeometryRef(dragSize(SWEEP_GROWTH_BUDGET))); // one past it
    const result = sweepIfDue(scene);
    expect(result).not.toBeNull();
    expect(result!.disposed).toBe(SWEEP_GROWTH_BUDGET + 1);
  });

  it('re-arms after a sweep, so a long drag is bounded rather than swept once', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    let sweeps = 0;
    let disposed = 0;
    // Four budgets' worth of drag, one write per frame, sweeping on the frame cadence.
    for (let f = 0; f < SWEEP_GROWTH_BUDGET * 4; f++) {
      mesh.geometry = getForAttach(boxGeometryRef(dragSize(f % DRAG_FRAMES)))!;
      const r = sweepIfDue(scene);
      if (r) {
        sweeps++;
        disposed += r.disposed;
      }
    }

    expect(sweeps).toBeGreaterThan(1); // it re-armed — not a single sweep at the start
    expect(disposed).toBeGreaterThan(0);
    // The population never runs away: bounded by the budget plus what is drawn.
    expect(size()).toBeLessThanOrEqual(SWEEP_GROWTH_BUDGET + 1);
  });

  it('lowers its mark when the population shrinks, so a cleared cache re-arms immediately', () => {
    const scene = new Scene();
    for (let f = 0; f <= SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f)));
    expect(sweepIfDue(scene)).not.toBeNull(); // marks at the post-sweep size

    clear(); // a project switch
    for (let f = 0; f <= SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f)));

    // Without the shrink handling, the mark would still sit at the old high-water figure
    // and this second budget's worth would accumulate unswept.
    const result = sweepIfDue(scene);
    expect(result).not.toBeNull();
    expect(result!.disposed).toBe(SWEEP_GROWTH_BUDGET + 1);
  });
});
