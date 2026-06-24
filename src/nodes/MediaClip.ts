// MediaClip — a baked-media layer source for the Compositor. Wraps an imported
// video or image (stored in OPFS at `src`) and exposes it as a time-varying
// `Image` producer: evaluate reads `ctx.time` and returns the ImageValue for the
// source-local frame at that time. The actual pixel decode happens at the
// viewer/runtime seam (a MediaDecodeCapability, slice 1b) — the evaluator stays
// pure metadata (V2/V3), keying the sourceHash on (src, frameIndex) so the agent
// + cache can reason about which frame a value denotes.
//
// Time model: evaluate maps the INCOMING ctx time → a source-local frame index
// (image = always 0; video = round(seconds * srcFps), clamped to [0, srcFrames)).
// Layer-level trim/offset (startFrame / inPoint) is applied by the compositor,
// which re-evaluates this node at a time-shifted ctx (docs/COMPOSITOR-DESIGN.md
// §4.4 / §6) — NOT baked here.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4; vyapti V2 (pure eval) + V34 (one substrate);
//      sibling source kinds: Shot (scene), ComfyUIWorkflow (generator).

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import type { NodeDefinition } from '../core/dag/types';
import type { EvalCtx } from '../core/dag/types';
import { DEFAULT_IMAGE_DESCRIPTOR, type ImageValue } from './types';

export const MEDIA_CLIP_KINDS = ['video', 'image'] as const;
export type MediaClipKind = (typeof MEDIA_CLIP_KINDS)[number];

export const MediaClipParams = z.object({
  name: z.string().default('Clip'),
  /** OPFS path the imported bytes live at (content-addressed by the ingest path).
   *  Empty default + `?? ''` guards keep legacy projects loading (V10/H14). */
  src: z.string().default(''),
  mediaKind: z.enum(MEDIA_CLIP_KINDS).default('video'),
  /** Source frame rate (video). Drives the comp-time → source-frame mapping. */
  srcFps: z.number().positive().default(30),
  /** Total source frames (video). 1 for a still image. Clamps the frame index. */
  srcFrames: z.number().int().positive().default(1),
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type MediaClipParams = z.infer<typeof MediaClipParams>;

/** Source-local frame index for this clip at ctx time. Image → 0; video →
 *  round(seconds * srcFps) clamped to [0, srcFrames-1]. Pure + exported so the
 *  compositor/decoder uses the SAME mapping (no drift — H40 discipline). */
export function mediaClipFrameAt(params: MediaClipParams, seconds: number): number {
  if ((params.mediaKind ?? 'video') === 'image') return 0;
  const fps = params.srcFps ?? 30;
  const frames = params.srcFrames ?? 1;
  const idx = Math.round(seconds * fps);
  return Math.max(0, Math.min(frames - 1, idx));
}

export const MediaClipNode: NodeDefinition<MediaClipParams, ImageValue> = {
  type: 'MediaClip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MediaClipParams,
  inputs: {},
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, _inputs, ctx: EvalCtx): ImageValue {
    const frameIndex = mediaClipFrameAt(params, ctx.time.seconds);
    return {
      kind: 'Image',
      passKind: 'beauty',
      descriptor: {
        width: params.width ?? DEFAULT_IMAGE_DESCRIPTOR.width,
        height: params.height ?? DEFAULT_IMAGE_DESCRIPTOR.height,
        format: 'rgba8',
      },
      sourceHash: hashValue({
        mediaClip: params.src ?? '',
        mediaKind: params.mediaKind ?? 'video',
        frameIndex,
      }),
    };
  },
};
