// WebCodecsMediaDecode — the real browser MediaDecodeCapability.
//
// IMAGE: decoded via createImageBitmap (works everywhere a 2D canvas does) — the
//   bitmap is returned for the compositor to drawImage. Slice 1b ships this path
//   end-to-end (real, observable).
//
// VIDEO: decoded via WebCodecs VideoDecoder + an MP4 demuxer. DEFERRED to slice
//   1b.2 — it needs a demuxer dependency (mp4box-style) to turn the container into
//   encoded chunks + metadata, and a scrubber (1d viewer) to observe it against.
//   Until then probe()/decodeFrame() throw a clear, surfaced error for video so we
//   never ship a half-working VideoDecoder unobserved (no silent blank).
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4 / §10; vyapti V6.

import type { DecodedFrame, MediaDecodeCapability, MediaProbe } from './MediaDecodeCapability';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const VIDEO_NOT_YET =
  'Video decode is not implemented yet (Compositor spine slice 1b.2 — MP4 demuxer + WebCodecs VideoDecoder). Import a still image for now.';

function isImageName(fileName: string): boolean {
  return IMAGE_EXTS.has(fileName.split('.').pop()?.toLowerCase() ?? '');
}

export class WebCodecsMediaDecode implements MediaDecodeCapability {
  readonly id = 'webcodecs-media';
  readonly kind = 'webcodecs' as const;

  isAvailable(): boolean {
    return typeof createImageBitmap === 'function';
  }

  async probe(bytes: Uint8Array, fileName: string): Promise<MediaProbe> {
    if (!isImageName(fileName)) throw new Error(VIDEO_NOT_YET);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const probe: MediaProbe = {
      mediaKind: 'image',
      width: bitmap.width,
      height: bitmap.height,
      srcFps: 1,
      srcFrames: 1,
      durationSeconds: 0,
    };
    bitmap.close();
    return probe;
  }

  async decodeFrame(
    bytes: Uint8Array,
    probe: MediaProbe,
    _frameIndex: number,
  ): Promise<DecodedFrame> {
    if (probe.mediaKind !== 'image') throw new Error(VIDEO_NOT_YET);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    return { width: bitmap.width, height: bitmap.height, bitmap, rgba: null };
  }
}
