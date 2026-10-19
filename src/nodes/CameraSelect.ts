// CameraSelect — pick the ACTIVE camera out of N (#231 Inc 3, the multi-camera "active" model).
// This is the ClipSelect / LightProfileSelect / LightRig (V63) switch pattern lifted to cameras:
// a scene can hold many cameras, but exactly ONE is active (Blender's per-scene active-camera
// pointer). The active choice is a SINGLE param (`active`), so it is keyframeable for free (V57) —
// a shot can CUT from one camera to another at a frame (Blender's Bind-Camera-to-Markers).
//
// Wiring: every camera node outputs `'SceneObject'` (Inc 1); they fan into
// `CameraSelect.cameras` (a list), and CameraSelect's single output feeds `Scene.camera`. A camera
// wired DIRECTLY into `Scene.camera` (every pre-change project) still works —
// `selectActiveCameraNode` falls back to it. CameraSelect is additive/optional, lazily inserted
// only when a 2nd camera appears.
//
// #1668 — `active` NAMES the camera (its node id), it does not count to it. It used to be an index
// into the list, so deleting any camera moved every later camera up one place while the keys kept
// their old numbers: shots that never used the deleted camera changed camera, silently. Blender
// has no such bug because a camera marker holds the camera OBJECT (`TimeMarker.camera`), and
// `BKE_scene_camera_switch_find` (scene.cc) skips a marker whose camera is gone. Both sides of the
// switch — the value `evaluate` returns and the node the resolver picks — go through ONE pick,
// `pickCameraSelect`, over the camera ids in wire order (the evaluator hands them over because
// `cameras` declares `sourceIds`), so they agree on which camera is live (render == resolver, H40).
//
// REF: src/nodes/ClipSelect.ts (picks by name); src/app/activeCamera.ts (`selectActiveCameraNode`);
//      ref/sources/blender-time-remap-v5.1.1/scene.cc `BKE_scene_camera_switch_find`;
//      docs/BLENDER-DATA-MODEL-PARITY-231-DESIGN.md §2/§5 Inc 3; vyapti V44/V57/V63.

import { z } from 'zod';
import type { NodeDefinition, NodeRef, ResolvedInputs } from '../core/dag/types';
import { inputSourceIds } from '../core/dag/types';
import type { CameraValue, SceneObject } from './types';
import { recomposeCameraObject } from './cameraRecompose';
import { discreteParam, optionsParam, type OptionsProvider } from './paramWidget';
import { ownName } from '../core/dag/nodeName';

/** The cameras this switch can pick: exactly the ones wired into it, which is what the pick reads.
 *  Labelled by the camera's own name (the core rung of the outliner's `nodeDisplayName`; the app
 *  module that holds the rest would put this node in the resolver's import ring, #814). */
const listedCameraOptions: OptionsProvider = (state, nodeId) => {
  const raw = state.nodes[nodeId]?.inputs.cameras;
  const edges = (Array.isArray(raw) ? raw : raw ? [raw] : []) as NodeRef[];
  return edges.map((e) => {
    const cam = state.nodes[e.node];
    return { value: e.node, label: (cam && ownName(cam)) ?? e.node };
  });
};

export const CameraSelectParams = z.object({
  /** The live camera's node id. Empty, or a camera no longer wired in, picks the first camera
   *  (`pickCameraSelect`). Keyframeable → camera cuts, each key naming its camera. A CHOICE, not an
   *  amount (#1663): a key holds until the next one, so a cut lands on its key. */
  active: discreteParam(
    optionsParam(
      z.string().default(''),
      // Wrapped so this module never reads an import during load (FollowPath's reason, #1065).
      (s, id) => listedCameraOptions(s, id),
      'first camera',
      'nodeId',
    ),
  ),
});
export type CameraSelectParams = z.infer<typeof CameraSelectParams>;

/**
 * Which of `cameraIds` (the switch's cameras, in wire order) is live when `active` names a camera:
 * its position, the first camera when `active` names none of them (empty, or a camera since
 * deleted or unwired), or null when the list is empty. The ONE pick — `CameraSelect.evaluate`
 * (value side) and `selectActiveCameraNode` (node side) both call it.
 */
export function pickCameraSelect(active: string, cameraIds: readonly string[]): number | null {
  if (cameraIds.length === 0) return null;
  const i = cameraIds.indexOf(active);
  return i < 0 ? 0 : i;
}

export const CameraSelectNode: NodeDefinition<CameraSelectParams, CameraValue | null> = {
  type: 'CameraSelect',
  version: 2,
  pure: true,
  cost: 'cheap',
  paramSchema: CameraSelectParams,
  // #1668 — `active` names a camera. On delete the sweep clears it (the switch then shows its
  // first camera) rather than leave it naming a node that is gone.
  idRefs: [{ path: 'active', shape: 'id', role: 'argument' }],
  migrations: {
    // A v1 `active` is an index into the wires, which only the project-format step (v22 → v23,
    // `migrateCameraCutsToIds`) can turn into a camera — it sees the edges. A v1 node reaching
    // here did not come through it (a hand-built node): its index names no camera, so it picks the
    // first, which is what an empty `active` says. #1679: when it drops a real index, it says so —
    // a silent drop is how a graph-build v23 file lost every cut without a trace.
    1: (old) => {
      const was = (old as { active?: unknown }).active;
      if (was !== undefined && was !== '')
        console.warn(
          `[CameraSelect v1 → v2] active ${JSON.stringify(was)} was an index into the wires; it names no camera here, so the switch shows its first camera (#1679).`,
        );
      return { ...(old as object), active: '' };
    },
  },
  inputs: {
    cameras: { type: 'SceneObject', cardinality: 'list', sourceIds: true },
  },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): CameraValue | null {
    const raw = inputs.cameras;
    const values: readonly unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const ids = inputSourceIds(inputs, 'cameras') ?? [];
    // Pair each camera with who it is BEFORE dropping empties, so the two lists stay aligned.
    const candidates = values
      .map((value, i) => ({ id: ids[i] ?? '', value: value as SceneObject | null }))
      .filter((c): c is { id: string; value: SceneObject } => c.value != null);
    const idx = pickCameraSelect(
      params.active,
      candidates.map((c) => c.id),
    );
    if (idx === null) return null;
    // #387 — the picked candidate may be an `Object` posing a `CameraData`; recompose it into the
    // flat CameraValue `Scene.camera` expects (fused → null → unchanged).
    const picked = candidates[idx].value;
    return recomposeCameraObject(picked) ?? (picked as CameraValue) ?? null;
  },
};
