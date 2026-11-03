import { events as pointerEvents } from '@react-three/fiber';
import type { EventManager, RootState } from '@react-three/fiber';
import type { Intersection } from 'three';
import { isUnderRenderOnly } from '../app/renderVisibility';

/**
 * #1755 — the DOM events the viewport ignores. R3F ray-tests the whole scene for every event it
 * listens to, and no 3D element in the viewport handles a wheel or a pointer-up (zoom is
 * `wheelZoom.ts` on the DOM; the transform gizmo listens to the DOM itself). On a big scene each
 * wheel notch cost ~45 ms of ray tests whose result nothing read. A 3D element that needs one of
 * these must add it back here, with the cost in mind.
 */
export const UNHANDLED_3D_EVENTS = ['onWheel', 'onPointerUp'] as const;

const ignore: EventListener = () => {};

/**
 * R3F's pointer events, with {@link UNHANDLED_3D_EVENTS} ignored, and (#1503) with every hit on a
 * 'render-only' body dropped. Such a body (its viewport flag off, its render flag on) stays mounted,
 * invisible, so the render can show it; three's raycaster does not skip invisible objects, so
 * without this a click would select what the viewport does not draw. Only that stamp is filtered:
 * every other hit, editor chrome included, is as it was.
 */
export function viewportEvents(
  store: Parameters<typeof pointerEvents>[0],
): EventManager<HTMLElement> {
  const events = pointerEvents(store);
  const handlers = { ...events.handlers! };
  // A no-op rather than a missing key: R3F's `Events` type requires every listener.
  for (const name of UNHANDLED_3D_EVENTS) handlers[name] = ignore;
  return {
    ...events,
    handlers,
    filter: (hits: Intersection[], _state: RootState) =>
      hits.filter((hit) => !isUnderRenderOnly(hit.object)),
  };
}
