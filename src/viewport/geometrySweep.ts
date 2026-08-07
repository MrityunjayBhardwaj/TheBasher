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
// ⚠️ DECLARED LIMIT — this bounds GROWTH, it does not minimise the population. After a drag
// ends nothing grows, so nothing is due, and up to one budget of dead entries sits there
// until the next churn: both arms above settle above their starting size, on purpose. The
// alternative is a quiet-period sweep, which is a cadence with its own failure modes for at
// most `SWEEP_GROWTH_BUDGET` entries. Not built; recorded so nobody reads the residue as a
// leak, and so the case for building it starts from this number.
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

let lastSweptSize = 0;

/**
 * Sweep if the population has grown past the budget since the last one; otherwise do
 * nothing and pay only a `Map.size` read.
 *
 * Returns the sweep's result, or `null` when no sweep was due — so a caller (or a gate) can
 * tell "swept and freed nothing" from "did not sweep", which are the two readings of an
 * unchanged population and mean opposite things.
 *
 * ⚠️ SAFE TO CALL MID-DRAG, and it is meant to be. The instance the current frame is drawing
 * is attached by definition, so the check protects it; what the sweep collects is the 63
 * frames behind it, which is exactly the garbage. The one ordering this relies on is that
 * the caller runs AFTER React has committed — see the mount site.
 */
export function sweepIfDue(root: Object3D): GeometrySweepResult | null {
  const current = registrySize();
  if (current <= lastSweptSize + SWEEP_GROWTH_BUDGET) {
    // A shrinking population (a project switch, a `clear()`) must lower the mark too, or the
    // budget silently becomes "grow back to the old high-water mark first".
    if (current < lastSweptSize) lastSweptSize = current;
    return null;
  }
  const result = sweep(collectAttachedGeometry(root));
  lastSweptSize = registrySize();
  return result;
}

/** Test seam: forget the last sweep's high-water mark. */
export function __resetSweepCadenceForTests(): void {
  lastSweptSize = 0;
}
