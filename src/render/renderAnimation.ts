// renderAnimation — export the timeline to a downloadable MP4 or PNG sequence
// (#189). Builds on the still render (#168): every frame goes through the SAME
// offscreen production path (renderSceneToImageCanvas — production camera,
// explicit resolution, chrome excluded, ACES/DoF), so an animation frame is just
// a still at a given playhead time. Here lives the format-agnostic frame LOOP +
// the two output SINKS; the action layer (renderAnimationAction.ts) builds the
// real frame source from timeStore + the live renderer and picks the sink.
//
// The loop is dependency-injected (setTime / waitForApply / capture) so it is
// unit-testable without a browser or a GPU. The sinks touch browser-only APIs
// (canvas.toBlob, VideoEncoder/VideoFrame) inside their methods, so importing
// this module never references them at module scope.
//
// REF: issue #189; #168 (still); renderToImage.ts (the shared render core);
// vyapti V37/V47/V51 (render parity); V38 (surface every outcome).

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { zip } from 'fflate';

export type RenderAnimationFormat = 'mp4' | 'png-sequence';

/** Thrown when a render is cancelled via the AbortSignal. The action layer maps
 *  it to a "cancelled" toast (not an error) and always restores the playhead. */
export class RenderAnimationAborted extends Error {
  constructor() {
    super('render animation aborted');
    this.name = 'RenderAnimationAborted';
  }
}

export interface AnimationOutput {
  blob: Blob;
  /** File extension WITHOUT the dot (`mp4` | `zip`). */
  ext: string;
  /** The format actually produced — may differ from the request if MP4 fell
   *  back to a PNG sequence (WebCodecs unavailable). */
  format: RenderAnimationFormat;
  frameCount: number;
}

/** The live, per-render frame source — injected so the loop stays pure. */
export interface AnimationFrameSource {
  /** Total frames to render (≥1). */
  frameCount: number;
  /** Frames per second (timestamps + the time→seconds mapping). */
  fps: number;
  /** Set the playhead to `seconds` (the live scene then applies it). */
  setTime(seconds: number): void;
  /** Resolve once the scene has applied the new time (e.g. await ≥1 rAF). */
  waitForApply(): Promise<void>;
  /** Capture the current production frame as a 2D canvas. */
  capture(): Promise<HTMLCanvasElement>;
}

/** A format-specific encoder the loop feeds frames to. */
export interface FrameSink {
  readonly format: RenderAnimationFormat;
  /** Encode / collect one rendered frame. */
  addFrame(canvas: HTMLCanvasElement, frameIndex: number): Promise<void>;
  /** Flush + produce the final downloadable blob. */
  finish(frameCount: number): Promise<AnimationOutput>;
  /** Release resources on cancel (no output produced). */
  abort(): void;
}

export interface RenderAnimationHooks {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Drive the frame source through the sink, frame by frame. For each frame:
 * advance the playhead, wait for the scene to apply it, capture, encode. Returns
 * the sink's final output. Throws {@link RenderAnimationAborted} if the signal
 * fires (after asking the sink to release resources).
 *
 * PURE of browser APIs — all of those live behind the injected source + sink.
 */
export async function renderAnimation(
  source: AnimationFrameSource,
  sink: FrameSink,
  hooks: RenderAnimationHooks = {},
): Promise<AnimationOutput> {
  const { frameCount, fps } = source;
  try {
    for (let f = 0; f < frameCount; f++) {
      if (hooks.signal?.aborted) throw new RenderAnimationAborted();
      source.setTime(f / fps);
      await source.waitForApply();
      const canvas = await source.capture();
      await sink.addFrame(canvas, f);
      hooks.onProgress?.(f + 1, frameCount);
    }
  } catch (e) {
    sink.abort();
    throw e;
  }
  return await sink.finish(frameCount);
}

/** PURE — a zero-padded, 1-indexed frame filename whose width fits `total`
 *  (so files sort lexicographically: frame_0001.png … frame_0120.png). */
export function frameFileName(index: number, total: number): string {
  const pad = Math.max(4, String(total).length);
  return `frame_${String(index + 1).padStart(pad, '0')}.png`;
}

/** PURE — even-rounded dimension. H.264 requires even width/height; the clamped
 *  render resolution can be odd, so MP4 encodes at the nearest even size. */
export function toEven(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

// ---------------------------------------------------------------------------
// PNG-sequence sink (fflate zip)
// ---------------------------------------------------------------------------

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Collect each frame's PNG bytes, then zip them on finish. The zip is the
 *  lossless, universally-supported deliverable (and the MP4 fallback). */
export function createPngSequenceSink(): FrameSink {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  return {
    format: 'png-sequence',
    async addFrame(canvas, frameIndex) {
      total = Math.max(total, frameIndex + 1);
      files[frameFileName(frameIndex, total)] = await canvasToPngBytes(canvas);
    },
    async finish(frameCount) {
      // Re-key with the FINAL total so the zero-padding width is consistent
      // across all frames (early frames were padded against a smaller total).
      const renamed: Record<string, Uint8Array> = {};
      const names = Object.keys(files).sort();
      names.forEach((name, i) => {
        renamed[frameFileName(i, frameCount)] = files[name];
      });
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        // level 0 (store): PNGs are already compressed; deflate wastes CPU.
        zip(renamed, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
      });
      const ab = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(ab).set(zipped);
      return {
        blob: new Blob([ab], { type: 'application/zip' }),
        ext: 'zip',
        format: 'png-sequence',
        frameCount,
      };
    },
    abort() {
      for (const k of Object.keys(files)) delete files[k];
    },
  };
}

// ---------------------------------------------------------------------------
// MP4 sink (WebCodecs VideoEncoder → mp4-muxer)
// ---------------------------------------------------------------------------

/** H.264 codec strings to probe, widest-support first. The first one
 *  `VideoEncoder.isConfigSupported` accepts for the resolution is used. */
const AVC_CODEC_CANDIDATES = ['avc1.640034', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];

/** True iff WebCodecs H.264 encoding is available for these dimensions. The
 *  action calls this to decide MP4-vs-fallback BEFORE starting the render. */
export async function isMp4Supported(width: number, height: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  return (await pickAvcCodec(toEven(width), toEven(height), fps)) !== null;
}

async function pickAvcCodec(width: number, height: number, fps: number): Promise<string | null> {
  for (const codec of AVC_CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
      });
      if (support.supported) return codec;
    } catch {
      // isConfigSupported can throw on a malformed codec string — try the next.
    }
  }
  return null;
}

/**
 * Build an MP4 sink, or null if WebCodecs H.264 isn't available (the caller
 * falls back to a PNG sequence — V38, never a silent failure). Encodes each
 * frame's canvas as a VideoFrame and muxes the chunks into an in-memory MP4.
 */
export async function createMp4Sink(
  width: number,
  height: number,
  fps: number,
): Promise<FrameSink | null> {
  const w = toEven(width);
  const h = toEven(height);
  const codec = await pickAvcCodec(w, h, fps);
  if (codec === null) return null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  // Bitrate scales with pixels×fps, capped so a 4K export doesn't balloon.
  const bitrate = Math.min(Math.round(w * h * fps * 0.12), 24_000_000);
  encoder.configure({ codec, width: w, height: h, framerate: fps, bitrate });

  // Reused even-sized scratch canvas — H.264 needs even dims; the render canvas
  // may be odd (resolution clamp). drawImage copies the top-left w×h.
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const sctx = scratch.getContext('2d');
  if (!sctx) throw new Error('renderAnimation: 2D context unavailable for MP4 frame');

  const frameDurationUs = Math.round(1_000_000 / fps);

  return {
    format: 'mp4',
    async addFrame(canvas, frameIndex) {
      if (encoderError) throw encoderError;
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(canvas, 0, 0);
      const frame = new VideoFrame(scratch, {
        timestamp: Math.round((frameIndex * 1_000_000) / fps),
        duration: frameDurationUs,
      });
      try {
        // Keyframe every second — seekable output without bloating size.
        encoder.encode(frame, { keyFrame: frameIndex % Math.max(1, Math.round(fps)) === 0 });
      } finally {
        frame.close();
      }
      // Backpressure: don't let the encode queue grow unbounded on long renders.
      while (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 0));
        if (encoderError) throw encoderError;
      }
    },
    async finish(frameCount) {
      await encoder.flush();
      if (encoderError) throw encoderError;
      muxer.finalize();
      const { buffer } = muxer.target;
      return {
        blob: new Blob([buffer], { type: 'video/mp4' }),
        ext: 'mp4',
        format: 'mp4',
        frameCount,
      };
    },
    abort() {
      try {
        encoder.close();
      } catch {
        // already closed / errored — nothing to release.
      }
    },
  };
}
