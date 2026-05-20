// TransformClip — node-indexed counterpart to AnimationClip (issue #81).
//
// Where AnimationClip samples a Skeleton's bone-indexed keyframes and
// emits a PosedSkeleton, TransformClip samples scene-node-indexed
// keyframes and emits a TRS map keyed by `targetNodeId`. This is the
// shape glTF embedded animations need: tracks reference scene-graph
// node names, not skeleton bones. The mapping is filled in by the
// drop-time importer (Wave D); the renderer (Wave E) reads
// TransformClipValue.tracks[targetNodeId] and overrides the matching
// gltf.scene child's TRS.
//
// Discipline mirrors AnimationClip.ts:
//   - pure: true, V2 — output is a function of (params, inputs.time).
//   - NO three.js AnimationMixer / clock.
//   - Time enters through the `Time` input socket (V3).
//   - Rotation is **degrees Euler XYZ** — matches Transform.rotation
//     end-to-end (SceneFromDAG.tsx:266,426,449,525). The Wave-B
//     CHECKPOINT B3 will verify this against the producer side
//     (`degVec3ToRad` / `quaternionToEulerVec3`) before any importer
//     code lands.
//
// Wave A: stub evaluator returns an empty `tracks` map. The
// piecewise-linear sampler lands in Wave B.
//
// REF: THESIS.md §42, §49; vyapti V2/V3; CONTEXT.md D-01/D-03; issue #81.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { TransformClipValue, Vec3 } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const TransformClipParams = z.object({
  name: z.string().default('clip'),
  duration: z.number().positive().default(2),
  /** When 'loop', time folds into [0, duration). When 'clamp', time
   *  pre-/post-keyframes pin to the endpoints. */
  loop: z.enum(['loop', 'clamp']).default('clamp'),
  /**
   * Scene-node-indexed keyframes. Each row targets one scene child by
   * `targetNodeId` (built deterministically by the importer from
   * sanitised glTF node names) and supplies the full TRS at `time`.
   * The Wave-B sampler interpolates per-target piecewise-linearly.
   */
  keyframes: z
    .array(
      z.object({
        targetNodeId: z.string(),
        time: z.number().nonnegative(),
        position: Vec3Schema.default([0, 0, 0]),
        rotation: Vec3Schema.default([0, 0, 0]),
        scale: Vec3Schema.default([1, 1, 1]),
      }),
    )
    .default([]),
});
export type TransformClipParams = z.infer<typeof TransformClipParams>;

export const TransformClipNode: NodeDefinition<TransformClipParams, TransformClipValue> = {
  type: 'TransformClip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TransformClipParams,
  inputs: {
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'TransformClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, _inputs: ResolvedInputs): TransformClipValue {
    // Wave A stub: shape-conformant empty value. The piecewise-linear
    // sampler (using `params.keyframes` + `inputs.time`) lands in
    // Wave B. Returning `tracks: {}` is intentional — the renderer
    // (Wave E) treats absent target ids as "no override," which is
    // the correct behavior for a not-yet-imported clip.
    return {
      kind: 'TransformClip',
      name: params.name,
      duration: params.duration,
      tracks: {} as Readonly<Record<string, { position: Vec3; rotation: Vec3; scale: Vec3 }>>,
    };
  },
};
