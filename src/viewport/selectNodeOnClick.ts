// selectNodeOnClick — the ONE viewport selection handler (#211). Clicking a
// renderable (a mesh wrapper, a light helper, a camera frustum) selects the
// PRODUCING DAG node; Shift adds to the multi-select set; stopPropagation so
// OrbitControls / fallthrough pickers don't also act on the click.
//
// This was duplicated THREE times — SceneChildNode.onClick (the superset, which
// also gates the Light Brush + resets the drill context), LightHelpers.selectOnClick,
// and CameraHelper's inline onClick. Now one source: a new helper kind inherits
// selection by calling `selectNode` / `selectNodeOnClick`, never by copy-paste
// (the renderable-node-protocol unification, #211).
//
// Discipline: lives in src/viewport/ but writes only through `useSelectionStore`
// (a UI projection, not the DAG) — V1 (DAG mutation only via Op) / V8 hold, the
// same contract LightHelpers/CameraHelpers already kept.

import { useLightBrushStore } from '../app/stores/lightBrushStore';
import { useSelectionStore } from '../app/stores/selectionStore';

/** The minimal click-event shape both R3F's ThreeEvent and a plain handler give. */
export interface SelectClickLike {
  stopPropagation: () => void;
  shiftKey: boolean;
}

/**
 * Select `pickId` (Shift = additive), stopping propagation. No-op when `pickId`
 * is null (selection routing unavailable) — and crucially it does NOT
 * stopPropagation in that case, matching every prior picker's early-return so an
 * unroutable click still falls through to OrbitControls.
 *
 * #1611 — while the Light Brush is on, a click is a brush stroke and never a selection: the
 * brush works on the SELECTED light, so a pick would leave it switched on with nothing to
 * paint. The click is left unconsumed as well, so it carries on to the surface behind — a
 * bone drawn over a body, a light or camera helper in front of it — and the mesh's own
 * handler takes the stroke there. The gate sits in this one handler so every helper that
 * earns selection through it is see-through to the brush, including the next one.
 */
export function selectNode(pickId: string | null, e: SelectClickLike): void {
  if (!pickId) return;
  if (useLightBrushStore.getState().active) return;
  e.stopPropagation();
  const sel = useSelectionStore.getState();
  if (e.shiftKey) sel.selectAdditive(pickId);
  else sel.select(pickId);
}

/** A ready-made onClick handler for the simple pickers (light / camera helpers). */
export function selectNodeOnClick(pickId: string | null) {
  return (e: SelectClickLike) => selectNode(pickId, e);
}
