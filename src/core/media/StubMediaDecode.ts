// StubMediaDecode — deterministic, dependency-free MediaDecodeCapability for
// tests + headless. No createImageBitmap, no WebCodecs, no DOM. probe() derives
// metadata from the file name + byte length; decodeFrame() fills a solid RGBA
// frame whose colour is a pure hash of (byte prefix, frameIndex) — so two decodes
// of the same (clip, frame) are byte-identical (V2) and different frames differ.
//
// V22: no Date.now / Math.random — every output is a pure function of the inputs.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4 / §15; vyapti V6 + V2 + V22; sibling:
//      StubComfyUICapability.

import type { DecodedFrame, MediaDecodeCapability, MediaProbe } from './MediaDecodeCapability';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

export interface StubMediaDecodeOptions {
  /** Frames a stubbed VIDEO reports (images always report 1). Default 30. */
  readonly videoFrames?: number;
  /** fps a stubbed VIDEO reports. Default 30. */
  readonly videoFps?: number;
  /** Reported dimensions. Default 320×240. */
  readonly width?: number;
  readonly height?: number;
}

export class StubMediaDecode implements MediaDecodeCapability {
  readonly id = 'stub-media';
  readonly kind = 'stub' as const;

  private readonly opts: Required<StubMediaDecodeOptions>;

  constructor(opts: StubMediaDecodeOptions = {}) {
    this.opts = {
      videoFrames: opts.videoFrames ?? 30,
      videoFps: opts.videoFps ?? 30,
      width: opts.width ?? 320,
      height: opts.height ?? 240,
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async probe(_bytes: Uint8Array, fileName: string): Promise<MediaProbe> {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const isImage = IMAGE_EXTS.has(ext);
    const srcFps = isImage ? 1 : this.opts.videoFps;
    const srcFrames = isImage ? 1 : this.opts.videoFrames;
    return {
      mediaKind: isImage ? 'image' : 'video',
      width: this.opts.width,
      height: this.opts.height,
      srcFps,
      srcFrames,
      durationSeconds: isImage ? 0 : srcFrames / srcFps,
    };
  }

  async decodeFrame(
    bytes: Uint8Array,
    probe: MediaProbe,
    frameIndex: number,
  ): Promise<DecodedFrame> {
    const [r, g, b] = colorFor(bytes, frameIndex);
    const { width, height } = probe;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return { width, height, bitmap: null, rgba };
  }
}

/** A deterministic RGB from a short byte prefix + the frame index (FNV-1a). */
function colorFor(bytes: Uint8Array, frameIndex: number): [number, number, number] {
  let h = 0x811c9dc5;
  const n = Math.min(bytes.length, 64);
  for (let i = 0; i < n; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= frameIndex & 0xff;
  h = Math.imul(h, 0x01000193);
  const u = h >>> 0;
  return [(u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
}
