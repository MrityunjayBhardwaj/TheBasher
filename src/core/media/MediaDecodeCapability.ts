// MediaDecodeCapability — the V6 boundary between the Compositor and the
// browser's media-decode machinery (the Compositor spine, slice 1b;
// docs/COMPOSITOR-DESIGN.md §4.4 / §10).
//
// Two impls ship:
//   WebCodecsMediaDecode — real browser decode. Images via createImageBitmap;
//     video via WebCodecs VideoDecoder + an MP4 demuxer (DEFERRED to slice 1b.2 —
//     needs a demuxer dependency; the method throws a clear "not yet" until then).
//   StubMediaDecode — deterministic, dependency-free synthesis for tests + headless
//     (mirrors StubComfyUICapability / StubMediaDecode pattern). A solid colour
//     keyed by (src, frameIndex); two decodes of the same (src, frame) are
//     byte-identical (V2-friendly), and different frames differ.
//
// V6: no caller outside `src/core/media/` reaches `createImageBitmap` / WebCodecs
// directly. Switching the decoder is a constructor swap (pickMediaDecode).
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4; vyapti V6 (capability) + V2; sibling
//      capabilities: ComfyUICapability, StorageCapability.

/** Media metadata, probed at import time and stored on the MediaClip node params
 *  (so it doubles as the decode-time descriptor — one shape, no re-probe). */
export interface MediaProbe {
  readonly mediaKind: 'video' | 'image';
  readonly width: number;
  readonly height: number;
  /** Source frame rate. 1 for a still image. */
  readonly srcFps: number;
  /** Total source frames. 1 for a still image. */
  readonly srcFrames: number;
  /** Source duration in seconds (frames / fps). 0 for a still image. */
  readonly durationSeconds: number;
}

/** A decoded frame. The browser path yields a drawable `bitmap`; the stub/headless
 *  path yields raw `rgba` (which the 2D-canvas compositor can `putImageData`).
 *  At least one of `bitmap` / `rgba` is non-null. */
export interface DecodedFrame {
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap | null;
  readonly rgba: Uint8ClampedArray | null;
}

export interface MediaDecodeCapability {
  readonly id: string;
  readonly kind: 'webcodecs' | 'stub';

  /** True iff this decoder can run in the current environment. */
  isAvailable(): boolean;

  /** Read the media's metadata from its bytes. Throws on an unsupported format. */
  probe(bytes: Uint8Array, fileName: string): Promise<MediaProbe>;

  /**
   * Decode the frame at `frameIndex` (clamped by the caller via
   * `mediaClipFrameAt`). `probe` is the descriptor stored on the MediaClip.
   * Throws on a decode failure (callers surface it — never silently blank).
   */
  decodeFrame(bytes: Uint8Array, probe: MediaProbe, frameIndex: number): Promise<DecodedFrame>;
}
