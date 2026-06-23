// CameraSelect — pick the ACTIVE camera out of N by index (#231 Inc 3, the
// multi-camera "active" model). This is the ClipSelect / LightProfileSelect /
// LightRig (V63) switch pattern lifted to cameras: a scene can hold many cameras,
// but exactly ONE is active (Blender's per-scene active-camera pointer). The
// active choice is a SINGLE param (`active`, an index), so it is keyframeable for
// free (V57) — a shot can CUT from one camera to another at a frame (Blender's
// Bind-Camera-to-Markers, but animatable).
//
// Wiring: every camera node outputs `'SceneObject'` (Inc 1); they fan into
// `CameraSelect.cameras` (a list), and CameraSelect's single output feeds
// `Scene.camera`. A camera wired DIRECTLY into `Scene.camera` (every pre-change
// project) still works — `selectActiveCameraNode` falls back to it. CameraSelect
// is additive/optional, lazily inserted only when a 2nd camera appears.
//
// Index-correspondence (V44): the renderer / pose-resolver recover the active
// camera's NODE id from `inputs.cameras[active].node` (edge order), so the value
// `evaluate` returns and the id the resolver picks AGREE on which camera is live —
// they MUST clamp the index identically. `resolveCameraSelectIndex` is the one
// shared clamp both sides call (render == resolver, H40).
//
// REF: src/nodes/ClipSelect.ts + src/nodes/LightProfileSelect.ts (the switch
//      pattern); src/app/activeCamera.ts (`selectActiveCameraNode` resolve-through);
//      docs/BLENDER-DATA-MODEL-PARITY-231-DESIGN.md §2/§5 Inc 3; vyapti V44/V57/V63.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CameraValue, SceneObject } from './types';

export const CameraSelectParams = z.object({
  /** Index of the live camera into the `cameras` list (edge order). Clamped to a
   *  valid slot by `resolveCameraSelectIndex`; keyframeable → camera cuts. */
  active: z.number().int().default(0),
});
export type CameraSelectParams = z.infer<typeof CameraSelectParams>;

/**
 * The clamped active index, or null when the list is empty. The ONE place the
 * index is normalized — `CameraSelect.evaluate` (value side) and
 * `selectActiveCameraNode` (node-id side) both call it so they agree on which
 * camera is live regardless of an out-of-range / reordered `active` param.
 */
export function resolveCameraSelectIndex(active: number, count: number): number | null {
  if (count <= 0) return null;
  const i = Math.round(active);
  if (i < 0) return 0;
  if (i >= count) return count - 1;
  return i;
}

export const CameraSelectNode: NodeDefinition<CameraSelectParams, CameraValue | null> = {
  type: 'CameraSelect',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CameraSelectParams,
  inputs: {
    cameras: { type: 'SceneObject', cardinality: 'list' },
  },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): CameraValue | null {
    const raw = inputs.cameras;
    const candidates: readonly SceneObject[] = Array.isArray(raw)
      ? (raw as SceneObject[]).filter((c): c is SceneObject => c != null)
      : raw
        ? [raw as SceneObject]
        : [];
    const idx = resolveCameraSelectIndex(params.active, candidates.length);
    if (idx === null) return null;
    // The wired inputs are cameras; surface the active one as the CameraValue
    // Scene.camera expects. (A mis-wired non-camera would be transitional impurity
    // until Inc 4 flatten — the UI only wires cameras here.)
    return (candidates[idx] as CameraValue) ?? null;
  },
};
