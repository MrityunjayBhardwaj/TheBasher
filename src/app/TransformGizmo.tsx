// TransformGizmo — the one owner of a transform gizmo's lifetime (#657).
//
// ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────
//
// `@react-three/drei`'s `TransformControls` builds a three.js `TransformControls` in a
// `useMemo` and cleans up with `return () => void controls.detach()`. It detaches and never
// disposes. three.js puts the freeing in `dispose()` — `TransformControls.js:535`, which
// traverses the gizmo and disposes every child's geometry and material — and nothing calls
// it. Every mount site here is a conditional render (`{node ? <TransformControls/> : null}`),
// so a plain select/deselect is a full mount/unmount cycle.
//
// MEASURED on the Starter Scene, selecting and deselecting one object and touching nothing
// else — `renderer.info.memory.geometries`, which falls only on a real `dispose()`:
//
//   baseline  7  →  24  →  41  →  58  →  75  →  92
//
// **+17 per cycle, exactly linear, with no bound.** The scene graph is clean each time (the
// gizmo is gone, the scene is back to its 9 geometries), so nothing is retained in the graph
// — the GPU resources are simply never freed. The subtree holds 80 distinct geometries
// totalling 72.4 KB of vertex and index data, and selecting is not a rare action.
//
// ── WHY ONE WRAPPER RATHER THAN A CLEANUP AT EACH SITE ────────────────────────────────
//
// The invariant — *a `TransformControls` we mount is disposed when it goes away* — reaches
// all four mount sites, so it wants a single place that can enforce it. Four copies of the
// same effect is four chances to omit it, and the omission is invisible: nothing renders
// wrong, no test reds, the number just climbs. `transformGizmoOwnership.gate.test.ts` pins
// that this stays the only door.
//
// ── THE CALLBACK REF IS LOAD-BEARING, NOT STYLE ───────────────────────────────────────
//
// React detaches refs during the unmount commit, so an effect that runs `ref.current?.dispose()`
// on unmount can find `current` already `null` and free nothing — a fix that measures exactly
// like no fix. Holding the instance in state via a callback ref means the cleanup closes over
// the instance itself, so it cannot be nulled out from under us. Keying the effect on that
// instance also covers the case where the component stays mounted and drei rebuilds its
// controls: the memo depends on `[explCamera, explDomElement]`, so a camera change orphans
// one exactly as an unmount does, and the old one is disposed when the new one arrives.
//
// ⚠️ DISPOSE ONLY ON THE WAY OUT. The cleanup runs after React has removed the primitive, and
// drei's own layout-effect cleanup (`controls.detach()`) has already run by then, so nothing
// frees a geometry a frame that is still drawing it could reach.
//
// REF: node_modules/@react-three/drei/core/TransformControls.js (the cleanup that only
//      detaches); node_modules/three/examples/jsm/controls/TransformControls.js:535
//      (`dispose`); src/app/Gizmo.tsx + src/app/CurvePointHandles.tsx (the four sites);
//      issue #657.

import { useEffect, useState, type ElementRef } from 'react';
import { TransformControls, type TransformControlsProps } from '@react-three/drei';

type TransformControlsInstance = ElementRef<typeof TransformControls>;

/**
 * drei's `TransformControls`, plus the disposal it does not do.
 *
 * A drop-in replacement — every prop is forwarded untouched. It deliberately does NOT accept
 * a `ref`: the ref is how this component holds the instance it owns, and handing it out would
 * let a caller replace the one thing this module exists to keep hold of.
 */
export function TransformGizmo(props: TransformControlsProps): React.ReactElement {
  const [controls, setControls] = useState<TransformControlsInstance | null>(null);

  useEffect(() => {
    if (!controls) return;
    return () => {
      controls.dispose();
    };
  }, [controls]);

  return <TransformControls ref={setControls} {...props} />;
}
