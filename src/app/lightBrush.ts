// lightBrush — the Light Brush's decision layer (epic #201, slice #207): turn a
// viewport mesh hit into the setParam Op that repositions the SELECTED rig light.
// Keeps the impure part (extracting hit point / world normal / view ray from the
// R3F event) to a thin shell in SceneFromDAG; this layer is a pure function of
// (state, seconds, selected id, hit geometry, mode) so the decision is testable.
//
// The brushed light keeps its RADIUS (its shell of the rig sphere) — the brush
// changes WHERE on the sphere, exactly like a panel drag (V62) — and is placed via
// the brush core; on a miss it falls back to the +Y pole of the shell. Only a
// SELECTED rig light is brushable (an AreaLight aimed by a Track-To); otherwise
// null (the caller no-ops and the panel shows a "select a light" hint).
//
// REF: src/app/resolveLightBrushPlacement.ts; src/app/studioLightRig.ts;
//      src/app/resolveStudioLightTransform.ts (studioLightPanelXY → radius);
//      vyapti V62 (one coordinate system with the panel), V60.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { enumerateStudioLights, resolveRigTarget } from './studioLightRig';
import { studioLightPanelXY } from './resolveStudioLightTransform';
import { resolveLightBrushPlacement } from './resolveLightBrushPlacement';
import type { LightBrushMode } from './stores/lightBrushStore';

type Vec3 = [number, number, number];

/** A light at the rig centre (radius ~0) has no meaningful shell to brush on; fall
 *  back to a sensible default distance so the brush still places it usefully. */
const FALLBACK_RADIUS = 6;

/**
 * Build the setParam Op that paints the selected rig light onto the rig sphere at
 * the brushed point, or null when nothing is brushable (no selection / the
 * selection isn't a rig light). Pure over (state, seconds, selectedId, hit data).
 */
export function buildLightBrushOp(
  state: DagState,
  seconds: number,
  selectedId: string | null,
  hit: Vec3,
  normalWorld: Vec3,
  viewDir: Vec3,
  mode: LightBrushMode,
): Op | null {
  if (!selectedId) return null;
  const light = enumerateStudioLights(state.nodes).find((l) => l.nodeId === selectedId);
  if (!light) return null;

  const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
  const centre = resolveRigTarget(state, ctx);
  const rRaw = studioLightPanelXY(light.position, centre).radius;
  const radius = rRaw > 0.01 ? rRaw : FALLBACK_RADIUS;

  const placement = resolveLightBrushPlacement(hit, normalWorld, viewDir, centre, radius, mode);
  const position: Vec3 = placement
    ? placement.position
    : [centre[0], centre[1] + radius, centre[2]]; // miss → top of the shell

  return { type: 'setParam', nodeId: light.nodeId, paramPath: 'position', value: position };
}
