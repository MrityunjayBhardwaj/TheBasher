// VideoStitch — impure node that describes "encode these frames into an
// MP4." Skeleton-only at the DAG level: the evaluator returns metadata
// (a VideoValue with sourceHash). Actual encoding lives in
// src/render/runVideoStitch.ts (Wave D2).
//
// pure: false. Sister to ComfyUIWorkflow's pure-flag policy — only
// impure nodes describe side-effecting operations.
//
// D-01 (locked): inputs flow over 'pass-input' (Image socket). The
// stylized output of ComfyUIWorkflow is `passKind: 'stylized'` — agents
// disambiguate by source-node, not socket type.
//
// D-05 (locked): codec defaults to h264. Real encoding via WebCodecs at
// the runVideoStitch seam; ffmpeg-wasm fallback deferred to follow-up
// (avoids bundle bloat + license review for v0.5).
//
// REF: project_p5_context D-01 / D-05; THESIS §28, §44; vyapti V2 + V8.

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { ImageValue, TimeValue, VideoCodec, VideoValue } from './types';

export const VIDEO_CODECS: readonly VideoCodec[] = ['h264'] as const;

export const VideoStitchParams = z.object({
  codec: z.enum(['h264']).default('h264'),
  fps: z.number().int().positive().default(30),
  /** OPFS path the stitched video writes to. Mutator authors per D-04
   *  parent dir (e.g. `renders/job1/final.mp4`). Empty default + `??`
   *  guard at every consumer keeps legacy projects loading. */
  outputPath: z.string().default(''),
});
export type VideoStitchParams = z.infer<typeof VideoStitchParams>;

export const VideoStitchNode: NodeDefinition<VideoStitchParams, VideoValue> = {
  type: 'VideoStitch',
  version: 1,
  pure: false,
  cost: 'medium',
  paramSchema: VideoStitchParams,
  inputs: {
    /** Stylized frames feeding the stitch. D-01 reuse: 'pass-input'
     *  carries both raw passes AND stylized output AND VideoStitch
     *  input. Per-kind closure BFS isolation (H22) keeps siblings
     *  apart. */
    'pass-input': { type: 'Image', cardinality: 'list' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'Video', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs): VideoValue {
    const frames = (inputs['pass-input'] as ImageValue[] | undefined) ?? [];
    const time = inputs.time as TimeValue | undefined;
    return {
      kind: 'Video',
      // V10 defensive defaults at every destructured field.
      codec: params.codec ?? 'h264',
      fps: params.fps ?? 30,
      frameCount: frames.length,
      outputPath: params.outputPath ?? '',
      sourceHash: hashValue({
        codec: params.codec ?? 'h264',
        fps: params.fps ?? 30,
        outputPath: params.outputPath ?? '',
        // Frame identity carries through each frame's stylized
        // sourceHash — different prompts → different stitch hash.
        frameHashes: frames.map((f) => f.sourceHash),
        time: time ?? null,
      }),
    };
  },
};
