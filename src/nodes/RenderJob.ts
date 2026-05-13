// RenderJob — the only impure node added in P4 (THESIS §43).
//
// RenderJob's job is dispatch: given a list of pass nodes (via the
// 'pass-input' edge kind, the first concrete use of that EdgeKind) and a
// frame range, walk the frames and write per-frame per-pass PNG bytes to
// StorageCapability. The actual frame-by-frame execution lives in
// `src/render/runRenderJob.ts` — this evaluator only returns a metadata
// record (JobResultValue) describing the dispatch.
//
// The evaluator is `pure: false` so the project keeps the discipline that
// only impure nodes describe side-effecting operations. RenderJob has no
// downstream consumers in v0.5 (it's a sink), so the impurity does not
// invalidate any other cache. THESIS §43 lists RenderJob alongside the
// pure passes; only RenderJob is impure because only RenderJob's value is
// the description of an action that produces files.
//
// REF: THESIS §43, vyapti V2 (impurity must be declared), V8 (no dispatch
// from src/render/), project_p4_prompt locked decisions.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { ImageValue, JobResultValue } from './types';

export const RenderJobParams = z.object({
  jobId: z.string().default('job'),
  frameStart: z.number().int().nonnegative().default(0),
  /** Inclusive end frame. Default ships a 60-frame (2s @ 30fps) job. */
  frameEnd: z.number().int().nonnegative().default(60),
  fps: z.number().int().positive().default(30),
  /** Output prefix in StorageCapability. Frames append `${pass}_${frame}.png`. */
  outputPath: z.string().default('renders/job'),
});
export type RenderJobParams = z.infer<typeof RenderJobParams>;

export const RenderJobNode: NodeDefinition<RenderJobParams, JobResultValue> = {
  type: 'RenderJob',
  version: 1,
  pure: false,
  cost: 'medium',
  paramSchema: RenderJobParams,
  inputs: {
    /** Pass nodes feeding the dispatch — socket name MUST equal the
     *  EdgeKind literal so per-kind closure BFS isolates pass siblings
     *  (H22). 'pass-input' is the only socket on any node carrying this
     *  edge kind in v0.5. */
    'pass-input': { type: 'Image', cardinality: 'list' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'JobResult', cardinality: 'single' } },
  inspectorSections: ['render'],
  evaluate(params, inputs: ResolvedInputs): JobResultValue {
    const passes = (inputs['pass-input'] as ImageValue[] | undefined) ?? [];
    return {
      kind: 'JobResult',
      jobId: params.jobId,
      frames: {
        start: params.frameStart,
        end: params.frameEnd,
        fps: params.fps,
      },
      passKinds: passes.map((p) => p.passKind),
      outputPath: params.outputPath,
    };
  },
};
