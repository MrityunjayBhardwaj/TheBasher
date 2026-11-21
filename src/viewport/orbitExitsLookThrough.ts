// orbitExitsLookThrough — an orbit drag in camera view comes back to the free view (#1708).
//
// Look-through is a viewport setting (Numpad 0, a double-clicked shot); orbit is off while it is on
// so the view cannot drift off the camera. Rather than ignore the drag, the drag leaves camera view,
// as a view rotate does in Blender's camera view. The drag that exits does not also orbit (the
// controls were off when it started); the next one orbits from where the camera stood.
//
// V8: writes only the viewport projection store.

import { useBoxSelectStore } from '../app/stores/boxSelectStore';
import { useGizmoStore } from '../app/stores/gizmoStore';
import { useLightBrushStore } from '../app/stores/lightBrushStore';
import { useViewportStore } from '../app/stores/viewportStore';

/** Pixels a pressed pointer travels before the gesture counts as an orbit, not a click. */
const ORBIT_EXIT_TRAVEL = 4;

/** #1708 — leave camera view when an orbit drag starts on `target`. Returns the detach. */
export function attachOrbitExitsLookThrough(target: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    start = useViewportStore.getState().lookThroughCamera ? { x: e.clientX, y: e.clientY } : null;
  };
  const onMove = (e: PointerEvent) => {
    if (!start || e.buttons === 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < ORBIT_EXIT_TRAVEL) return;
    start = null;
    // A gizmo handle, an armed box-select or the light brush owns the drag: none is an orbit.
    if (
      useGizmoStore.getState().dragging ||
      useBoxSelectStore.getState().active ||
      useLightBrushStore.getState().active
    )
      return;
    if (useViewportStore.getState().lookThroughCamera) {
      useViewportStore.getState().setLookThroughCamera(false);
    }
  };
  const onUp = () => {
    start = null;
  };
  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  return () => {
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
}
