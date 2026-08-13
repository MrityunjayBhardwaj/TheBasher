// geometrySweep — the live-scene half of geometry's lifetime (#587, closes the growth half
// of #544).
//
// THE SPLIT, and why the boundary is here. `geometryRegistry` owns the Map and the
// disposal; it takes the set of live instances as an argument and has no idea what a scene
// is. This module owns the walk that produces that set, and the cadence that decides when
// to take it. The two concerns fail in different ways — the registry's failure is freeing
// something in use, this module's is failing to look — and keeping them apart means the
// registry stays unit-testable against a hand-built set with no three.js scene at all.
//
// WHY ATTACHMENT AND NOT A REFCOUNT. Measured in #586: a plain drag's growth is 100% the
// attach door, but a MODIFIER drag costs twice as much and half of it is minted by
// `geometryRegistry.build`'s own recursion — a source box the splice makes a scene child of
// nothing, which no consumer ever calls for and no door could ever count. Attachment asks
// the question directly and is immune to the route a holder took.
//
// ── OBSERVED IN A BROWSER (121 transient writes per arm, the same scene #586 measured) ──
//
//   arm                    registry: before → peak → after      GPU geometries
//   drag a plain box            2  →  64  →  60                  15 → 77 → 73
//   drag through an Array      60  →  66  →  37                  73 → 76 → 33
//
// Against P5a's un-swept numbers, the peaks are the finding: the same drags reached 122 and
// 362. The GPU column is the one this feature does not compute — `renderer.info.memory
// .geometries` counts live GPU allocations and falls only on a real `dispose()`, so the
// array arm's 76 → 33 is memory actually returned rather than Map keys deleted.
//
// A third arm held the drag DOWN for 200 frames: a sweep ran mid-drag (the population fell
// while the hand was still on the param) and the object went on drawing at the dragged size,
// 50 units. That is the arm that matters — the two arms above sample after release, when the
// object has snapped back to its authored size and "still drawing" would prove nothing.
//
// ⚠️ THE LIMIT #587 DECLARED HERE IS NOW CLOSED (#588), and the way it closed is the point.
// The budget bounds GROWTH and then stops: once a drag ends nothing grows, so nothing is due,
// and up to one budget of dead entries used to sit there until the next churn — both arms
// above settle above their starting size. That was recorded as a limit rather than fixed,
// because it was stated in ENTRIES and no decision can be taken in that unit.
//
// Priced in bytes it decided itself. The same ~50-entry residue costs 0.05 MB on a plain box
// and 12.5 MB on a 64×48 sphere through an ArrayModifier — 250× apart at equal entry count,
// scaling with mesh density and modifier count, i.e. with the dials a user turns. Hence the
// second trigger below (`SWEEP_QUIET_FRAMES`). See `geometryRegistry.residentBytes`.
//
// ── OBSERVED AFTER THE QUIET TRIGGER (one arm per page, so no arm inherits the last one's
//    leftovers — the isolation the #587 run above lacked) ──
//
//   arm                        entries: before → peak → settle    residue      GPU geometries
//   idle (control)                 1  →   1  →   1                0 / 840 B      flat
//   plain box drag                 1  →  65  →   1                0 / 0.00 MB    7 → 71 → 7
//   sphere 64×48 + Array(3)        2  →  66  →   2                0 / 0.00 MB   15 → 47 → 15
//
// Both arms return to their exact starting population, and the GPU column returns with them —
// that number falls only on a real `dispose()`, so this is memory handed back rather than Map
// keys deleted. The PEAKS are unchanged from #587 (64/66 → 65/66), which is the other half of
// the claim: trigger 2 collects the residue without weakening trigger 1's bound during churn.
//
// ⚠️ WHAT IS STILL NOT CLAIMED: this bounds the population, it does not make the cache
// minimal at every instant. Between the last write and the quiet sweep the residue is still
// held, and a scene that never goes quiet never reaches trigger 2 — it stays bounded by the
// budget, which is the guarantee that was always on offer.
//
// REF: src/app/geometryRegistry.ts (`sweep`, and the measured growth model); issues #587,
//      #586, #544, #575; src/viewport/sceneBounds.ts (the walk precedent — note the
//      difference in chrome handling, below).

import type { BufferGeometry, Mesh, Object3D } from 'three';
import { sweep, size as registrySize, type GeometrySweepResult } from '../app/geometryRegistry';

/**
 * Every `BufferGeometry` currently attached to ANY object under `root`.
 *
 * ⚠️ IT DOES NOT PRUNE EDITOR CHROME, and that is the one place this deliberately diverges
 * from `sceneBounds.ts:53`. Bounds want the authored scene, so chrome is noise there. A
 * sweep wants every instance something is DRAWING, and the cost of the two mistakes is not
 * symmetric: counting a chrome geometry that the registry does not own keeps an entry that
 * did not need keeping, while missing one disposes a geometry still on screen. Anything
 * this walk cannot see, it must not free.
 *
 * ⚠️ AND IT DOES NOT TEST `isMesh`, for the same reason. `Line`, `LineSegments` and `Points`
 * hold a `geometry` and draw it, and this viewport has five such objects today
 * (`CurveLine`, `LightHelpers`, `NullGlyph`, `DiffOverlay`, `CameraHelpers`). None of them
 * take a registry instance right now — which is exactly the sort of fact that is true until
 * someone adds the sixth, and the failure would be a line silently drawing nothing, in the
 * browser only. The filter is "carries a geometry", because that is the question, and
 * `isMesh` is merely the most common answer to it.
 */
export function collectAttachedGeometry(root: Object3D): Set<BufferGeometry> {
  const live = new Set<BufferGeometry>();
  const walk = (o: Object3D): void => {
    const geom = (o as Partial<Mesh>).geometry;
    if (geom) live.add(geom);
    for (const child of o.children) walk(child);
  };
  walk(root);
  return live;
}

/**
 * How much the population may grow between two sweeps.
 *
 * Not a cache ceiling — the registry has no ceiling and does not want one; a scene with
 * 4000 distinct authored geometries is legitimate and every entry in it is attached. This
 * is the budget for how much UNVERIFIED growth is allowed to accumulate before the walk is
 * worth its cost, so it trades a scene traversal against entries held a little longer.
 *
 * 64 puts roughly two sweeps inside the 121-frame drag #586 measured, which keeps the
 * population flat DURING a drag rather than only after it — the difference between "VRAM
 * settles when you let go" and "VRAM does not climb while you work", and the second is what
 * #544 actually asks for.
 */
export const SWEEP_GROWTH_BUDGET = 64;

/**
 * How many frames the population must sit UNCHANGED before the residue is collected (#588).
 *
 * WHY A SECOND TRIGGER AT ALL, and the number that bought it. The budget above bounds growth
 * during churn and then, by construction, stops: once a drag ends nothing grows, so nothing
 * is ever due again, and up to one budget of dead entries waits for the next churn. #587
 * recorded that as a declared limit stated in ENTRIES — a unit that cannot decide anything.
 * Priced in bytes (#588), the same ~50-entry residue costs **0.05 MB** on a plain box and
 * **12.5 MB** on a 64×48 sphere through an ArrayModifier: a 250× spread at equal entry count,
 * scaling with the two dials a user actually turns. 12.5 MB of VRAM held for nothing after
 * every modifier drag is worth a second trigger; 0.05 MB would not have been.
 *
 * 30 frames is half a second at 60Hz. During a drag the population changes essentially every
 * frame, so thirty unchanged ones mean churn has genuinely stopped rather than paused between
 * two writes. A slower scene makes the wait longer in wall-clock terms, which is harmless:
 * firing early is safe anyway, because the sweep checks attachment rather than trusting the
 * cadence.
 *
 * ⚠️ PREMISE: THE CANVAS RUNS `frameloop="always"`. This counts frames, so on-demand
 * rendering would stop the counter a frame or two after the last change and the quiet sweep
 * would silently never fire — the residue would come back with no test going red. That is a
 * property of a file this module does not own, so it is pinned by a gate rather than by this
 * comment. See `geometrySweep.gate.test.ts`.
 */
export const SWEEP_QUIET_FRAMES = 30;

/** Population at the end of the last sweep — the baseline the budget is measured from. */
let lastSweptSize = 0;
/** Population on the previous frame, so "did anything change?" is answerable. */
let lastSeenSize = 0;
/** Consecutive frames the population has not moved. */
let quietFrames = 0;
/** Sweeps taken since the page loaded — monotonic, so "has one run yet?" is an EVENT. */
let sweepsTaken = 0;
/** Entries disposed across every sweep so far — monotonic, so a SPAN is a subtraction. */
let disposedTotal = 0;

/**
 * What the cadence has actually done: how many sweeps ran, and what the last one freed.
 *
 * WHY THIS IS READ-ONLY STATE AND NOT A RETURN VALUE. `sweepIfDue` already returns the
 * result "so a caller (or a gate) can tell 'swept and freed nothing' from 'did not sweep'",
 * and the only caller — `GeometryLifetime` — discards it, because a component that renders
 * nothing has nowhere to put it. The distinction the return value exists to draw is
 * therefore unavailable to anyone, which is the gap #656 was diagnosed through.
 *
 * ⚠️ THE COUNTER IS THE PART THAT MATTERS, and a duration cannot substitute for it. The
 * quiet trigger is denominated in FRAMES; every consumer that has tried to wait for it has
 * been written in MILLISECONDS, and a population merely waiting out its thirty frames is
 * indistinguishable from a settled one to any wall-clock observer. `sweeps` turns "the
 * cache has been verified" from a duration you hope was long enough into an event you can
 * wait for: after a sweep, every resident non-exempt entry has just been checked against
 * attachment, and the latch in `sweepIfDue` guarantees none is collected until the
 * population next grows.
 */
export function sweepStats(): { sweeps: number; disposed: number } {
  return { sweeps: sweepsTaken, disposed: disposedTotal };
}

/**
 * Sweep if either trigger is due; otherwise do nothing and pay only a `Map.size` read.
 *
 * TWO TRIGGERS, ANSWERING DIFFERENT QUESTIONS. The budget bounds the population *while* it
 * grows — the difference between "VRAM settles when you let go" and "VRAM does not climb
 * while you work". The quiet period collects what the budget leaves behind by design, which
 * is everything under one budget's worth at the moment churn stops. Neither subsumes the
 * other: the budget never fires on a settled scene, and the quiet period never fires during
 * a drag.
 *
 * Returns the sweep's result, or `null` when no sweep was due — so a caller (or a gate) can
 * tell "swept and freed nothing" from "did not sweep", which are the two readings of an
 * unchanged population and mean opposite things.
 *
 * ⚠️ IT CANNOT RE-FIRE ON A SETTLED SCENE, and that is the quiet trigger's whole risk. Each
 * sweep re-marks `lastSweptSize` at the population it leaves behind, so the very next frame
 * reads "nothing unverified" and returns before touching the scene. Without that the quiet
 * path would walk the entire graph every frame forever, costing nothing visible — a full
 * traversal produces the same correct population — which is exactly the kind of regression
 * that survives review and has an arm on it below rather than a comment here.
 *
 * ⚠️ SAFE TO CALL MID-DRAG, and it is meant to be. The instance the current frame is drawing
 * is attached by definition, so the check protects it; what the sweep collects is the frames
 * behind it, which is exactly the garbage. The one ordering this relies on is that the caller
 * runs AFTER React has committed — see the mount site.
 */
export function sweepIfDue(root: Object3D): GeometrySweepResult | null {
  const current = registrySize();

  // ── Trigger 1: unverified growth past the budget. Bounds the population DURING churn.
  if (current > lastSweptSize + SWEEP_GROWTH_BUDGET) return runSweep(root);

  // A shrinking population (a project switch, a `clear()`) must lower the mark too, or the
  // budget silently becomes "grow back to the old high-water mark first".
  if (current < lastSweptSize) lastSweptSize = current;

  // ── Trigger 2: a quiet period. Collects the residue trigger 1 leaves once churn stops.
  if (current !== lastSeenSize) {
    lastSeenSize = current;
    quietFrames = 0;
    return null;
  }
  // Settled AND already swept down to here: nothing is unverified, so there is nothing a
  // walk could discover. This is the latch that stops the quiet path re-firing forever.
  if (current <= lastSweptSize) return null;
  if (++quietFrames < SWEEP_QUIET_FRAMES) return null;
  return runSweep(root);
}

/** Take the sweep and re-mark every cadence baseline from its result. */
function runSweep(root: Object3D): GeometrySweepResult {
  const result = sweep(collectAttachedGeometry(root));
  sweepsTaken++;
  disposedTotal += result.disposed;
  lastSweptSize = registrySize();
  lastSeenSize = lastSweptSize;
  quietFrames = 0;
  return result;
}

/** Test seam: forget the last sweep's high-water mark and the quiet-period counter. */
export function __resetSweepCadenceForTests(): void {
  lastSweptSize = 0;
  lastSeenSize = 0;
  quietFrames = 0;
  sweepsTaken = 0;
  disposedTotal = 0;
}
