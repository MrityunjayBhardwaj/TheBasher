// wheelZoom — the viewport's wheel and trackpad zoom, sized by how far the wheel moved (#1128).
//
// drei builds the editor's OrbitControls from three-stdlib (2.36.1), whose wheel handler reads
// only the SIGN of `deltaY` and dollies a fixed `0.95^zoomSpeed` per event
// (`three-stdlib/controls/OrbitControls.js:358`, `:492-498`). A mouse notch is one event; a
// trackpad sends dozens a second, each a full 5% jump applied in a single frame (damping eases
// only rotate and pan, `:191-196`, `:225`). Measured in the running app: a deltaY-4 event moved the
// camera exactly as far as a deltaY-100 one, and near the origin each jump grew the box on screen
// by up to half its size.
//
// The `three` we ship (0.169) fixed this in its own OrbitControls, and this is that rule:
// the step is `0.95^(zoomSpeed · |deltaY| · 0.01)`, line and page wheel modes are converted to
// pixels first, and a trackpad pinch — which the browser reports as a wheel event with `ctrlKey`
// set, though no Control key is down — is amplified ×10
// (`three/examples/jsm/controls/OrbitControls.js:541-544`, `:1080-1110`, `:1495-1519`).
// A mouse notch (deltaY 100) keeps exactly today's 0.95.
//
// The stdlib controls keep every other gesture; `enableZoom` is turned off on them so their own
// wheel handler stands down, and this one dollies through their public `dollyIn`/`dollyOut`, so
// the distance limits the bounds-fit sets still clamp.

import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface WheelInput {
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}

export interface WheelDolly {
  /** `in` moves toward the target (deltaY < 0), `out` away; null for a zero delta. */
  readonly direction: 'in' | 'out' | null;
  /** The factor handed to `dollyIn` / `dollyOut`: in (0, 1], 1 meaning no movement. */
  readonly scale: number;
}

const LINE_PX = 16;
const PAGE_PX = 100;
const PINCH_GAIN = 10;

/**
 * How far one wheel event dollies. `controlHeld` is whether a real Control key is down: then
 * `ctrlKey` is the director's modifier, not a pinch, and is not amplified.
 */
export function wheelDolly(input: WheelInput, zoomSpeed: number, controlHeld: boolean): WheelDolly {
  let delta = input.deltaY;
  if (input.deltaMode === 1) delta *= LINE_PX;
  else if (input.deltaMode === 2) delta *= PAGE_PX;
  if (input.ctrlKey && !controlHeld) delta *= PINCH_GAIN;
  if (!Number.isFinite(delta) || delta === 0) return { direction: null, scale: 1 };
  return {
    direction: delta < 0 ? 'in' : 'out',
    scale: Math.pow(0.95, zoomSpeed * Math.abs(delta * 0.01)),
  };
}

/**
 * Listen for wheel zoom on `element` and dolly `controls` by `wheelDolly`. Returns the detach.
 * Honours `controls.enabled` (off while a gizmo drags and while looking through the camera), and
 * brackets each event with the controls' `start` / `end`, as their own wheel handler did, so the
 * view pose is still saved when a zoom ends.
 */
export function attachWheelZoom(element: HTMLElement, controls: OrbitControlsImpl): () => void {
  let controlHeld = false;
  const doc = element.ownerDocument;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Control') controlHeld = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control') controlHeld = false;
  };
  const onWheel = (e: WheelEvent) => {
    if (!controls.enabled) return;
    e.preventDefault();
    const { direction, scale } = wheelDolly(e, controls.zoomSpeed, controlHeld);
    if (direction === null) return;
    controls.dispatchEvent({ type: 'start', target: controls });
    if (direction === 'in') controls.dollyIn(scale);
    else controls.dollyOut(scale);
    controls.dispatchEvent({ type: 'end', target: controls });
  };
  doc.addEventListener('keydown', onKeyDown, { passive: true, capture: true });
  doc.addEventListener('keyup', onKeyUp, { passive: true, capture: true });
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    doc.removeEventListener('keydown', onKeyDown, { capture: true });
    doc.removeEventListener('keyup', onKeyUp, { capture: true });
    element.removeEventListener('wheel', onWheel);
  };
}
