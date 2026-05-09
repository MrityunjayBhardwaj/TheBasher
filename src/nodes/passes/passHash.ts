// Shared sourceHash builder for pass nodes.
//
// Every pass evaluator returns an ImageValue whose `sourceHash` is a stable
// fingerprint of (passKind, params, scene, camera, time). Equal sourceHash
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
import type { CameraValue, ImagePassKind, SceneValue, TimeValue } from '../types';

export interface PassHashInputs {
  readonly passKind: ImagePassKind;
  readonly params: unknown;
  readonly scene: SceneValue | undefined;
  readonly camera: CameraValue | undefined;
  readonly time: TimeValue | undefined;
}

export function buildPassSourceHash(inputs: PassHashInputs): string {
  return hashValue({
    passKind: inputs.passKind,
    params: inputs.params,
    scene: inputs.scene ?? null,
    camera: inputs.camera ?? null,
    time: inputs.time ?? null,
  });
}
