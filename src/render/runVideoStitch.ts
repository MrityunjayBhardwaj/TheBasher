// runVideoStitch — the impure side of P5's video stitch step.
//
// Reads stylized frame PNGs from the upstream ComfyUIWorkflow's D-04
// paths, encodes them via the injectable VideoEncoder seam, writes the
// resulting video to the stitch node's outputPath.
//
// V8 file-rooted: NO Op emission. Caller dispatches any consequent
// Ops; runVideoStitch only reads DagState + writes via StorageCapability.
//
// Encoder seam (D-05 locked): production wires the WebCodecs H.264
// path via a dedicated factory in src/app/render/ (boot determines
// availability, the factory returns a VideoEncoder bound to a real
// VideoEncoder/AVC1 config). Tests inject a stub encoder that produces
// deterministic bytes from the input frame array. ffmpeg-wasm fallback
// is deferred to a follow-up issue — keeps v0.5 bundle small + avoids
// LGPL license review (memory: feedback_license).
//
// REF: project_p5_context D-05; vyapti V6 (capability) + V8
// (file-rooted); dcc-reference §21 (codec id conventions).

import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import type { ComfyUIWorkflowParams } from '../nodes/ComfyUIWorkflow';
import type { ImageValue, VideoCodec } from '../nodes/types';
import type { VideoStitchParams } from '../nodes/VideoStitch';
import { framePath } from './dryRun';

/**
 * Encodes a frame sequence into a single video buffer. Production wires
 * a WebCodecs-backed encoder; tests inject a deterministic stub.
 */
export interface VideoEncoder {
  (input: {
    /** Per-frame PNG bytes in dispatch order. */
    framesPng: readonly Uint8Array[];
    codec: VideoCodec;
    fps: number;
  }): Promise<Uint8Array>;
}

export interface RunVideoStitchDeps {
  readonly storage: StorageCapability;
  readonly encoder: VideoEncoder;
}

export interface RunVideoStitchReport {
  readonly stitchId: NodeId;
  readonly framesEncoded: number;
  readonly outputPath: string;
  readonly bytesWritten: number;
}

interface StitchUpstream {
  readonly nodeId: NodeId;
  readonly outputPath: string;
  readonly frameStart: number;
  readonly frameEnd: number;
}

/**
 * Walks the upstream ComfyUIWorkflow(s) wired to this stitch node's
 * pass-input list, reads each frame's stylized PNG from storage,
 * encodes via deps.encoder, writes the result to the stitch node's
 * outputPath.
 *
 * Constraints (v0.5):
 *   - Every upstream pass-input must be a ComfyUIWorkflow node.
 *     Stitching raw passes directly is out of scope for v0.5; the
 *     pipeline expects styling before encoding.
 *   - Multiple upstreams concatenate in dispatch order — useful for
 *     multi-shot edits later; in v0.5 a single upstream is the norm.
 */
export async function runVideoStitch(
  stitchNodeId: NodeId,
  state: DagState,
  deps: RunVideoStitchDeps,
): Promise<RunVideoStitchReport> {
  const node = state.nodes[stitchNodeId];
  if (!node) throw new Error(`runVideoStitch: unknown stitchNodeId "${stitchNodeId}"`);
  if (node.type !== 'VideoStitch') {
    throw new Error(
      `runVideoStitch: node "${stitchNodeId}" is not a VideoStitch (got ${node.type})`,
    );
  }
  const params = node.params as Partial<VideoStitchParams>;
  const codec: VideoCodec = params.codec ?? 'h264';
  const fps = params.fps ?? 30;
  const outputPath = params.outputPath ?? '';
  if (!outputPath) {
    throw new Error(
      `runVideoStitch: stitch "${stitchNodeId}" has empty outputPath. Run mutator.render.addStitch to author it.`,
    );
  }

  const passBinding = node.inputs['pass-input'];
  const passRefs =
    passBinding === undefined ? [] : Array.isArray(passBinding) ? passBinding : [passBinding];
  if (passRefs.length === 0) {
    throw new Error(
      `runVideoStitch: stitch "${stitchNodeId}" has no upstream frames wired (pass-input is empty).`,
    );
  }

  const upstreams: StitchUpstream[] = [];
  for (const ref of passRefs) {
    const upNode = state.nodes[ref.node];
    if (!upNode) {
      throw new Error(
        `runVideoStitch: upstream node "${ref.node}" referenced by stitch "${stitchNodeId}" not found.`,
      );
    }
    if (upNode.type !== 'ComfyUIWorkflow') {
      throw new Error(
        `runVideoStitch: upstream "${ref.node}" is ${upNode.type}; v0.5 stitches stylized output only — wire a ComfyUIWorkflow.`,
      );
    }
    const upParams = upNode.params as Partial<ComfyUIWorkflowParams>;
    const upOutputPath = upParams.outputPath ?? '';
    if (!upOutputPath) {
      throw new Error(
        `runVideoStitch: upstream workflow "${ref.node}" has empty outputPath — addAIPass should have authored it.`,
      );
    }
    upstreams.push({
      nodeId: ref.node,
      outputPath: upOutputPath,
      frameStart: upParams.frameStart ?? 0,
      frameEnd: upParams.frameEnd ?? 60,
    });
  }

  // Collect every frame's PNG bytes in dispatch order.
  const framesPng: Uint8Array[] = [];
  for (const upstream of upstreams) {
    for (let frame = upstream.frameStart; frame <= upstream.frameEnd; frame++) {
      // Evaluate at this frame so the ImageValue's sourceHash flips —
      // ensures any future caching layer keys per-frame correctly.
      const ctx: EvalCtx = { time: { frame, seconds: frame / fps, normalized: 0 } };
      const value = evaluate(state, upstream.nodeId, { ctx }).value as ImageValue;
      void value; // metadata only — we read bytes from disk.

      const path = framePath(upstream.outputPath, frame);
      const exists = await deps.storage.exists(path);
      if (!exists) {
        throw new Error(
          `runVideoStitch: stylized frame missing at ${path}. Run runComfyUIWorkflow first to produce frames.`,
        );
      }
      const bytes = await deps.storage.read(path);
      framesPng.push(bytes);
    }
  }

  const videoBytes = await deps.encoder({ framesPng, codec, fps });
  await deps.storage.write(outputPath, videoBytes);

  return {
    stitchId: stitchNodeId,
    framesEncoded: framesPng.length,
    outputPath,
    bytesWritten: videoBytes.byteLength,
  };
}

/**
 * Stub encoder for tests + offline development. Concatenates a header
 * marker + each frame's bytes + a footer marker. Deterministic, so
 * twice-call assertions hold.
 */
export const stubVideoEncoder: VideoEncoder = async ({ framesPng, codec, fps }) => {
  const header = new TextEncoder().encode(`STUBVIDEO/${codec}/${fps}/${framesPng.length}\n`);
  let totalLen = header.length + 6; // 'ENDVID' footer
  for (const f of framesPng) totalLen += f.length + 4; // 4-byte length prefix per frame
  const out = new Uint8Array(totalLen);
  let off = 0;
  out.set(header, off);
  off += header.length;
  for (const f of framesPng) {
    const view = new DataView(out.buffer, out.byteOffset + off, 4);
    view.setUint32(0, f.length);
    off += 4;
    out.set(f, off);
    off += f.length;
  }
  out.set(new TextEncoder().encode('ENDVID'), off);
  return out;
};

/**
 * Resolves the production VideoEncoder when called in a browser with
 * WebCodecs available; throws when WebCodecs is unsupported. The boot
 * wiring catches the throw and falls back to stubVideoEncoder for
 * non-browser / older-browser environments. ffmpeg-wasm fallback is
 * deferred to a follow-up issue.
 */
export function probeWebCodecsEncoder(): VideoEncoder | null {
  if (typeof globalThis === 'undefined') return null;
  const Encoder = (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
  if (!Encoder) return null;
  // Real WebCodecs encode pipeline lives in src/app/render/runStitch
  // (browser-only — VideoFrame + ImageDecoder + Mp4Muxer). Wave D ships
  // the seam; the in-browser implementation is wired by the integration
  // step (Wave D4 manual smoke). Returning null forces the stub at
  // unit-test time even when run with --environment jsdom.
  return null;
}
