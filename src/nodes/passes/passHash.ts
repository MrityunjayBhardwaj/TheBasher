// Shared sourceHash builder for pass nodes.
//
// Every pass evaluator returns an ImageValue whose `sourceHash` is a stable
// fingerprint of (passKind, params, scene, camera, time), the camera being the one on screen at
// the time when the evaluator hands it over (#1950, `filmed`). Equal sourceHash
// means the pass would render identical pixels — Wave B's RenderJob uses
// this to skip redundant per-frame work, and the agent uses it as the
// describable handle for a pass result.
//
// Pure: same inputs → same hash. Lives outside src/nodes/* per-file
// directories so all current + future pass nodes share one identical
// hashing rule (V14 mechanical guard for catalog reasoning).
//
// REF: THESIS §51 (caching correctness), project_p4_prompt locked
// decisions ("pure metadata = cache-correctness for the agent's 'this
// pass is unchanged' reasoning").

import { hashValue } from '../../core/dag/hash';
import type { ImageExtent } from '../../core/dag/types';
import type { CameraValue, ImagePassKind, SceneValue, TimeValue } from '../types';

/**
 * #1716 — what a render pass makes: a run of frames with no end of its own. A pass renders the
 * scene at whatever time it is asked for (its `time` socket), so the value at t is the frame at t
 * and the range is the consumer's to choose (a RenderJob's frameStart..frameEnd). A still input
 * fed a pass picks frame 0.
 */
export const RENDER_PASS_EXTENT: ImageExtent = { kind: 'frames', range: null };

export interface PassHashInputs {
  readonly passKind: ImagePassKind;
  readonly params: unknown;
  readonly scene: SceneValue | undefined;
  readonly camera: CameraValue | undefined;
  readonly time: TimeValue | undefined;
  /**
   * #1950 — the camera on screen at the time, as the evaluator hands it to a pass
   * (`filmedCameraOf`). When one is handed over it stands for the camera: the `camera` socket's
   * value and the scene's own `camera` are a switch's AUTHORED camera at every frame, so hashing
   * them would mark every frame changed when that camera moves, including frames another camera
   * films. `undefined` (no read registered, an evaluate called by hand) or null (no camera wired)
   * leaves the hash as the inputs alone give it.
   */
  readonly filmed?: unknown;
}

export function buildPassSourceHash(inputs: PassHashInputs): string {
  const filmed = inputs.filmed ?? null;
  if (filmed !== null) {
    return hashValue({
      passKind: inputs.passKind,
      params: inputs.params,
      scene: inputs.scene ? { ...inputs.scene, camera: null } : null,
      camera: filmed,
      time: inputs.time ?? null,
    });
  }
  return hashValue({
    passKind: inputs.passKind,
    params: inputs.params,
    scene: inputs.scene ?? null,
    camera: inputs.camera ?? null,
    time: inputs.time ?? null,
  });
}
