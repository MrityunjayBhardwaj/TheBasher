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
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { BoxGeometry, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Scene } from 'three';
import {
  clear,
  getForAttach,
  getForRead,
  growthBySource,
  prime,
  size,
  type GeometrySweepResult,
} from '../app/geometryRegistry';
import type { GeometryRef } from '../nodes/types';
import { stripComments } from '../test-utils/sourceScan';
import { arrayGeometryRef, boxGeometryRef } from '../app/modifierGeometry';
import {
  SWEEP_GROWTH_BUDGET,
  SWEEP_QUIET_FRAMES,
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
      const geom = getForAttach(boxGeometryRef(dragSize(f), null));
      mesh.geometry = geom!; // the same mounted mesh, a new instance each frame
    }
    expect(size()).toBe(DRAG_FRAMES); // the defect, reproduced first

    const { result } = sweepNow(scene);

    expect(result).not.toBeNull();
    expect(result!.disposed).toBe(DRAG_FRAMES - 1); // every frame but the one on screen
    expect(size()).toBe(1);
    expect(mesh.geometry).toBe(getForRead(boxGeometryRef(dragSize(DRAG_FRAMES - 1), null)));
  });

  it('frees BOTH halves of a modifier drag — including the source no door can see', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    for (let f = 0; f < DRAG_FRAMES; f++) {
      mesh.geometry = getForAttach(
        arrayGeometryRef(boxGeometryRef(dragSize(f), null), 3, [1, 0, 0]),
      )!;
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
    const kept = getForAttach(boxGeometryRef([9, 9, 9], null));
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f), null));
    const scene = sceneDrawing(kept);

    const { result } = sweepNow(scene);

    expect(result!.disposed).toBe(DRAG_FRAMES); // the sweep did real work…
    expect(result!.attached).toBe(1); // …and this is what it spared
    expect(size()).toBe(1);
    // Identity, not just the count: the surviving entry IS the instance on the mesh.
    expect(getForRead(boxGeometryRef([9, 9, 9], null))).toBe(kept);
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
    for (let f = 0; f < DRAG_FRAMES; f++) getForAttach(boxGeometryRef(dragSize(f), null));

    const { result } = sweepNow(new Scene()); // an EMPTY scene: nothing is attached at all

    expect(result!.disposed).toBe(DRAG_FRAMES); // everything rebuildable went…
    expect(result!.exempt).toBe(1); // …and the one that is not, stayed
    expect(getForRead(ref)).not.toBeNull();
    // Why it matters, in one line: `bakedGeometryLoader.promiseCache` is keyed by ref.key
    // and never cleared, so a miss here re-throws a SETTLED promise and suspends forever.
    // Baked bytes are also authoritative — the registry cannot rebuild them from params.
  });

  it('sees a mesh nested arbitrarily deep, not just the scene root’s children', () => {
    const kept = getForAttach(boxGeometryRef([5, 5, 5], null));
    // Enough unattached entries to make a sweep due — the cadence is a real precondition
    // here, not scaffolding, and a helper that forced past it would be testing a function
    // no caller can reach.
    for (let f = 0; f < SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f), null));

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

  it('spares a geometry drawn by a Line, which is not a Mesh', () => {
    const kept = getForAttach(boxGeometryRef([7, 7, 7], null));
    for (let f = 0; f < SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f), null));

    const scene = new Scene();
    scene.add(new Line(kept!, new LineBasicMaterial()));

    const { result } = sweepNow(scene);

    // An `isMesh` filter reports 0 attached here and disposes a geometry that is drawing.
    // Nothing in the viewport feeds a registry instance to a <line> today; five objects
    // that COULD are already there, and the symptom would be browser-only silence.
    expect(result!.disposed).toBe(SWEEP_GROWTH_BUDGET);
    expect(result!.attached).toBe(1);
    expect(kept!.getAttribute('position')).toBeTruthy();
  });

  // ── THE CADENCE ──────────────────────────────────────────────────────────────────────
  it('does not walk the scene until the budget is exceeded', () => {
    const scene = new Scene();
    for (let f = 0; f < SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f), null));

    // At the budget exactly: no sweep. `null` is not "swept and freed nothing" — the
    // distinction is the whole reason the return type is nullable.
    expect(sweepIfDue(scene)).toBeNull();
    expect(size()).toBe(SWEEP_GROWTH_BUDGET);

    getForAttach(boxGeometryRef(dragSize(SWEEP_GROWTH_BUDGET), null)); // one past it
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
      mesh.geometry = getForAttach(boxGeometryRef(dragSize(f % DRAG_FRAMES), null))!;
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

  // A sweep that keeps everything must still COUNT as a sweep, or the budget is measured
  // from the wrong baseline and a big static scene pays for a full traversal every frame
  // forever. It costs nothing visible — the population is correct either way — which is
  // exactly why it needs an arm rather than a comment.
  it('stops walking a static scene after one pass, even when that pass freed nothing', () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    const BIG = SWEEP_GROWTH_BUDGET * 3;
    for (let f = 0; f < BIG; f++) {
      const geom = getForAttach(boxGeometryRef([200 + f, 1, 1], null));
      group.add(new Mesh(geom!, new MeshBasicMaterial()));
    }

    let sweeps = 0;
    for (let frame = 0; frame < 10; frame++) if (sweepIfDue(scene)) sweeps++;

    expect(sweeps).toBe(1); // ten frames, one walk
    expect(size()).toBe(BIG); // and it kept the scene it is drawing
  });

  // The mark is an ABSOLUTE population, so it only means "budget since the last sweep"
  // while the population is monotonic. A big scene leaves the mark high; empty that scene
  // and the mark becomes a debt the next project has to grow back into before anything is
  // ever swept again. Reaching that branch needs a sweep that KEEPS a lot — a first draft of
  // this case swept an empty scene, which leaves the mark at 0 and tests nothing.
  it('lowers its mark when a big scene goes away, instead of billing the next one for it', () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);

    // A large scene, all of it drawn: the sweep keeps every entry and marks high.
    const BIG = SWEEP_GROWTH_BUDGET * 3;
    for (let f = 0; f < BIG; f++) {
      const geom = getForAttach(boxGeometryRef([100 + f, 1, 1], null));
      group.add(new Mesh(geom!, new MeshBasicMaterial()));
    }
    const first = sweepIfDue(scene);
    expect(first).not.toBeNull();
    expect(first!.attached).toBe(BIG); // nothing freed — the mark is now BIG, not 0
    expect(first!.disposed).toBe(0);

    // The project closes: the meshes go, and the cache is dropped with them.
    scene.remove(group);
    clear();
    expect(sweepIfDue(scene)).toBeNull(); // nothing due — and THIS is the call that must
    // notice the population fell, and lower the mark to match.

    // A new project, one budget's worth of churn.
    for (let f = 0; f <= SWEEP_GROWTH_BUDGET; f++) getForAttach(boxGeometryRef(dragSize(f), null));

    // Without the shrink handling the mark still reads BIG, so this is 65 <= 192 + 64 and
    // no sweep happens at all — the new project runs unbounded until it grows past the old
    // one's high-water mark.
    const result = sweepIfDue(scene);
    expect(result).not.toBeNull();
    expect(result!.disposed).toBe(SWEEP_GROWTH_BUDGET + 1);
  });
});

// ── THE QUIET-PERIOD TRIGGER (#588) ─────────────────────────────────────────────────────
//
// The budget above bounds growth and then, by construction, stops. Once churn ends nothing
// grows, so nothing is due, and the leftovers sit there. #587 declared that as a limit
// because it was stated in ENTRIES; priced in bytes it was 12.5 MB on a modifier stack over
// a mid-density mesh, which is what bought this trigger.
//
// The two failure modes are opposite and both have arms: it must FIRE once churn stops, and
// it must NOT keep firing afterwards — an un-latched version walks the whole scene graph
// every frame forever while producing an entirely correct population, so nothing observable
// goes wrong and no ordinary test notices.
describe('#588 — the quiet period collects what the budget leaves behind', () => {
  /** Run `n` frames with no writes at all, returning every sweep that fired. */
  function idleFrames(scene: Scene, n: number): GeometrySweepResult[] {
    const swept: GeometrySweepResult[] = [];
    for (let f = 0; f < n; f++) {
      const r = sweepIfDue(scene);
      if (r) swept.push(r);
    }
    return swept;
  }

  /** A drag that ends BELOW the budget, so trigger 1 can never fire and only trigger 2 can. */
  function dragUnderBudget(scene: Scene, mesh: Mesh, frames: number) {
    for (let f = 0; f < frames; f++) {
      mesh.geometry = getForAttach(boxGeometryRef(dragSize(f), null))!;
      sweepIfDue(scene); // the real per-frame cadence, not a forced sweep
    }
  }

  it('frees the residue a drag leaves, which the budget alone never would', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    const CHURN = SWEEP_GROWTH_BUDGET - 4; // deliberately under the budget
    dragUnderBudget(scene, mesh, CHURN);

    // The precondition, asserted rather than assumed: trigger 1 did NOT fire, so what
    // follows is attributable to the quiet period and to nothing else.
    expect(size()).toBe(CHURN);

    const swept = idleFrames(scene, SWEEP_QUIET_FRAMES);

    expect(swept).toHaveLength(1);
    expect(swept[0].disposed).toBe(CHURN - 1); // every frame but the one on screen
    expect(size()).toBe(1);
    expect(mesh.geometry).toBe(getForRead(boxGeometryRef(dragSize(CHURN - 1), null)));
  });

  it('waits the full quiet period — it does not fire on the first settled frame', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);
    dragUnderBudget(scene, mesh, SWEEP_GROWTH_BUDGET - 4);

    // One frame short of the period: still nothing. A trigger that fired immediately would
    // walk the scene on every frame that happened not to insert, which during a drag with
    // any cache hit in it is most of them.
    expect(idleFrames(scene, SWEEP_QUIET_FRAMES - 1)).toHaveLength(0);
    expect(sweepIfDue(scene)).not.toBeNull(); // and on the very next one, it fires
  });

  // THE LATCH. This is the case the whole design risk sits in: an un-latched quiet trigger
  // leaves the population exactly as correct as a latched one, so only a count of WALKS can
  // tell them apart.
  it('sweeps ONCE per quiet period, not once per frame, on a scene that has settled', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);
    dragUnderBudget(scene, mesh, SWEEP_GROWTH_BUDGET - 4);

    const swept = idleFrames(scene, SWEEP_QUIET_FRAMES * 5);

    expect(swept).toHaveLength(1); // five periods' worth of frames, one walk
    expect(size()).toBe(1);
  });

  // A scene loaded and then left alone still has entries the cadence has never verified, so
  // one pass is correct — an entry inserted before any sweep is indistinguishable from
  // residue until something looks. What must NOT happen is a second pass. Written the other
  // way round first ("never fires with nothing to collect"), which was a claim about the
  // design that the design does not make.
  it('verifies a freshly loaded scene exactly once, then stops looking', () => {
    const scene = new Scene();
    const group = new Group();
    scene.add(group);
    for (let i = 0; i < 12; i++) {
      const geom = getForAttach(boxGeometryRef([3 + i, 1, 1], null));
      group.add(new Mesh(geom!, new MeshBasicMaterial()));
    }

    const swept = idleFrames(scene, SWEEP_QUIET_FRAMES * 4);

    expect(swept).toHaveLength(1); // four periods, one walk
    expect(swept[0].attached).toBe(12); // it looked at the real scene…
    expect(swept[0].disposed).toBe(0); // …and correctly freed nothing
    expect(size()).toBe(12);
  });

  // Primed baked entries count toward the population but can never be disposed, so they are
  // permanently "unverified growth" from the cadence's point of view. Without the latch
  // being marked from the POST-sweep population, a scene holding one primed entry that
  // nothing draws would walk the graph every quiet period forever, achieving nothing. The
  // exemption is also the road that hangs the app if it is ever got wrong — the loader's
  // promise cache is never cleared — so it is worth pinning against the new trigger too.
  it('latches after sweeping a scene whose leftovers are all exempt', () => {
    const ref: GeometryRef = {
      key: 'baked|quiet-8',
      kind: 'baked',
      descriptor: { kind: 'baked', hash: 'quiet', vertexCount: 8 },
    };
    prime(ref, new BoxGeometry(1, 1, 1));

    const scene = new Scene(); // nothing drawn at all
    const swept = idleFrames(scene, SWEEP_QUIET_FRAMES * 4);

    expect(swept).toHaveLength(1); // one walk, not one per period
    expect(swept[0].exempt).toBe(1);
    expect(swept[0].disposed).toBe(0);
    expect(getForRead(ref)).not.toBeNull(); // and the primed entry survived
  });

  it('re-arms: a second burst of churn gets its own quiet sweep', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    dragUnderBudget(scene, mesh, 20);
    expect(idleFrames(scene, SWEEP_QUIET_FRAMES)).toHaveLength(1);
    expect(size()).toBe(1);

    // A second, disjoint burst — new keys, so this is real growth and not a cache hit.
    for (let f = 0; f < 20; f++) {
      mesh.geometry = getForAttach(boxGeometryRef([50 + f, 1, 1], null))!;
      sweepIfDue(scene);
    }
    expect(size()).toBe(21); // 20 new + the one still drawn from before

    const second = idleFrames(scene, SWEEP_QUIET_FRAMES);
    expect(second).toHaveLength(1);
    expect(second[0].disposed).toBe(20);
    expect(size()).toBe(1);
  });

  it('resets its counter when the population moves, so churn cannot age into a sweep', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    // Insert once every few frames, forever short of the quiet period. The counter must
    // restart on each insertion; if it merely accumulated, a slow drag would sweep mid-churn
    // on a schedule nobody chose.
    let swept = 0;
    for (let burst = 0; burst < 6; burst++) {
      mesh.geometry = getForAttach(boxGeometryRef([80 + burst, 1, 1], null))!;
      for (let f = 0; f < SWEEP_QUIET_FRAMES - 2; f++) if (sweepIfDue(scene)) swept++;
    }
    expect(swept).toBe(0);
    expect(size()).toBe(6);
  });

  it('does not disturb the budget trigger — a drag past it still sweeps on growth', () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    scene.add(mesh);

    // Every frame inserts, so the population never sits still and trigger 2 can never fire.
    // Anything that sweeps here is trigger 1, unchanged by this slice.
    let swept = 0;
    for (let f = 0; f < SWEEP_GROWTH_BUDGET * 2; f++) {
      mesh.geometry = getForAttach(boxGeometryRef(dragSize(f % DRAG_FRAMES), null))!;
      if (sweepIfDue(scene)) swept++;
    }
    expect(swept).toBeGreaterThan(0);
    expect(size()).toBeLessThanOrEqual(SWEEP_GROWTH_BUDGET + 1);
  });

  // ⚠️ THE PREMISE, PINNED WHERE IT CAN BREAK. `SWEEP_QUIET_FRAMES` counts FRAMES, so the
  // trigger exists only for as long as frames keep arriving after the last change. R3F's
  // default is `frameloop="always"`; switching the Canvas to `"demand"` — a plausible battery
  // optimisation, made in a different file for an unrelated reason — stops the loop a frame
  // or two after the last invalidation, the counter never reaches 30, and the residue comes
  // back with every test in this file still green. The failure is silent, remote, and
  // invisible to any test of this module, which is exactly what makes it worth a census.
  // ⚠️ IT IS DELIBERATELY BROADER THAN THE PREMISE. What the trigger actually needs is that
  // the Canvas *`GeometryLifetime` is mounted in* keeps ticking; this asserts it of every
  // Canvas in `src/`. There is exactly one today, so the two coincide — but a second one
  // added later for its own reasons (a thumbnail renderer, an offscreen capture) could
  // legitimately want `"demand"` and would red here. That red is the point: it is cheaper to
  // be told "say which Canvas hosts the lifetime" than to have the trigger silently retire
  // because the answer changed. The narrower check would need to know the mount site, which
  // is a React fact this file cannot read.
  it('the Canvas still runs an always-on frameloop, which the quiet trigger depends on', () => {
    const canvases = sourceFiles().filter(([, src]) => /<Canvas[\s>]/.test(stripComments(src)));
    // Assert the subject is non-empty before asserting anything about it: a census whose
    // corpus silently emptied — a rename, a narrowed walk — would pass while checking nothing.
    expect(canvases.length).toBeGreaterThan(0);

    for (const [path, src] of canvases) {
      const frameloop = /frameloop\s*=\s*\{?\s*['"]?(\w+)/.exec(stripComments(src));
      // Either unset (R3F defaults to "always") or explicitly "always". Anything else stops
      // the frame counter, and whoever changes it should land here rather than in a bug report.
      expect(frameloop?.[1] ?? 'always', `${path} changed the frameloop`).toBe('always');
    }
  });
});
