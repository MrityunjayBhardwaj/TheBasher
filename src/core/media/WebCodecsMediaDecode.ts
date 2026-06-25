// WebCodecsMediaDecode — the real browser MediaDecodeCapability.
//
// IMAGE: decoded via createImageBitmap (works everywhere a 2D canvas does) — the
//   bitmap is returned for the compositor to drawImage. Slice 1b ships this path
//   end-to-end (real, observable).
//
// VIDEO (slice 1b.2): decoded via an HTMLVideoElement — a blob URL of the bytes is
//   loaded once per source, then each frame is read by seeking to its time and
//   `createImageBitmap(video)`. This is the pragmatic, dependency-free path: the
//   element uses whatever decoders the browser ships (so it is codec-agnostic — an
//   H.264 mp4 in real Chrome/Safari, VP9/AV1 everywhere), and seeking is robust.
//   (The design doc's WebCodecs VideoDecoder + MP4 demuxer would give native-fps-
//   exact, frame-accurate decode without a re-sample; it needs a demuxer dependency
//   and avcC/av1C extraction — a later refinement. See KNOWN LIMITS below.)
//   A decode failure (unsupported codec / corrupt file) throws a clear error so the
//   caller surfaces it (V38 — never a silent blank).
//
// KNOWN LIMITS (1b.2): srcFps is a FIXED re-sample rate (30) — Basher samples the
//   video at 30fps rather than its native rate. Time-coverage is exact (frame N maps
//   to time N/30, spanning [0, duration]), so scrubbing covers the whole clip; only
//   the per-frame granularity is quantized. Native-fps detection needs a demuxer.
//
// V6: no caller outside `src/core/media/` reaches createImageBitmap / video decode
// directly. Switching the decoder is a constructor swap (pickMediaDecode).
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4 / §10; vyapti V6.

import type { DecodedFrame, MediaDecodeCapability, MediaProbe } from './MediaDecodeCapability';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

/** Basher's fixed video sampling rate for 1b.2 (see KNOWN LIMITS). */
const VIDEO_SAMPLE_FPS = 30;
/** Guard so a stuck load/seek rejects (surfaced) rather than hanging the composite. */
const VIDEO_OP_TIMEOUT_MS = 15_000;

function isImageName(fileName: string): boolean {
  return IMAGE_EXTS.has(fileName.split('.').pop()?.toLowerCase() ?? '');
}

/** Sniff the container from magic bytes so a blob URL (which has no extension) gets a
 *  MIME the media element can use. Falls back to mp4 (the common case). */
function sniffVideoMime(bytes: Uint8Array): string {
  // WebM / Matroska: 0x1A45DFA3 EBML header.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return 'video/webm';
  // ISO-BMFF / MP4: 'ftyp' box type at offset 4.
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return 'video/mp4';
  return 'video/mp4';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`video ${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** A loaded video source kept alive across frame requests (avoids reloading the
 *  whole clip per scrubbed frame). Seeks are serialized via `seekChain` so two
 *  concurrent frame requests can't race the single element's currentTime. */
interface VideoSource {
  readonly el: HTMLVideoElement;
  readonly url: string;
  readonly ready: Promise<void>;
  seekChain: Promise<unknown>;
}

/** A cheap content signature (length + sampled bytes) so the SAME clip reuses one
 *  loaded video element across its frames. A collision only reuses an element for
 *  byte-identical content — harmless. */
function sigOf(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 64));
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return `${bytes.length}:${h >>> 0}`;
}

const videoCache = new Map<string, VideoSource>();

function loadVideoSource(bytes: Uint8Array): VideoSource {
  const blob = new Blob([bytes as BlobPart], { type: sniffVideoMime(bytes) });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  el.src = url;
  const ready = withTimeout(
    new Promise<void>((resolve, reject) => {
      // 'loadeddata' → readyState >= HAVE_CURRENT_DATA: a frame exists + seeking works.
      el.addEventListener('loadeddata', () => resolve(), { once: true });
      el.addEventListener(
        'error',
        () => reject(new Error('video decode failed (unsupported codec or corrupt file)')),
        { once: true },
      );
    }),
    VIDEO_OP_TIMEOUT_MS,
    'load',
  );
  return { el, url, ready, seekChain: ready };
}

export class WebCodecsMediaDecode implements MediaDecodeCapability {
  readonly id = 'webcodecs-media';
  readonly kind = 'webcodecs' as const;

  isAvailable(): boolean {
    return typeof createImageBitmap === 'function' && typeof document !== 'undefined';
  }

  async probe(bytes: Uint8Array, fileName: string): Promise<MediaProbe> {
    if (isImageName(fileName)) {
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
    // Video: read metadata (dimensions + duration) from a one-shot element.
    const blob = new Blob([bytes as BlobPart], { type: sniffVideoMime(bytes) });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'metadata';
    el.src = url;
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          el.addEventListener('loadedmetadata', () => resolve(), { once: true });
          el.addEventListener(
            'error',
            () => reject(new Error('video probe failed (unsupported codec or corrupt file)')),
            { once: true },
          );
        }),
        VIDEO_OP_TIMEOUT_MS,
        'probe',
      );
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      const srcFrames = Math.max(1, Math.round(duration * VIDEO_SAMPLE_FPS));
      return {
        mediaKind: 'video',
        width: el.videoWidth || 1,
        height: el.videoHeight || 1,
        srcFps: VIDEO_SAMPLE_FPS,
        srcFrames,
        durationSeconds: duration,
      };
    } finally {
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
    }
  }

  async decodeFrame(
    bytes: Uint8Array,
    probe: MediaProbe,
    frameIndex: number,
  ): Promise<DecodedFrame> {
    if (probe.mediaKind === 'image') {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      return { width: bitmap.width, height: bitmap.height, bitmap, rgba: null };
    }

    const sig = sigOf(bytes);
    let source = videoCache.get(sig);
    if (!source) {
      source = loadVideoSource(bytes);
      videoCache.set(sig, source);
    }
    await source.ready;

    const fps = probe.srcFps > 0 ? probe.srcFps : VIDEO_SAMPLE_FPS;
    const duration =
      probe.durationSeconds > 0 ? probe.durationSeconds : Math.max(0, probe.srcFrames / fps);
    // Map frame index → time, clamped just inside the duration so the last frame is
    // reachable (seeking exactly to duration can fail to fire 'seeked').
    const time = Math.min(Math.max(frameIndex, 0) / fps, Math.max(0, duration - 1 / (fps * 2)));

    const src = source;
    const run = src.seekChain.then(async () => {
      const el = src.el;
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          if (Math.abs(el.currentTime - time) < 1e-3) {
            resolve(); // already at this frame — 'seeked' would not fire
            return;
          }
          const onSeeked = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error('video seek failed'));
          };
          const cleanup = () => {
            el.removeEventListener('seeked', onSeeked);
            el.removeEventListener('error', onError);
          };
          el.addEventListener('seeked', onSeeked);
          el.addEventListener('error', onError);
          el.currentTime = time;
        }),
        VIDEO_OP_TIMEOUT_MS,
        'seek',
      );
      const bitmap = await createImageBitmap(el);
      return { width: bitmap.width, height: bitmap.height, bitmap, rgba: null } as DecodedFrame;
    });
    // Keep the chain alive even if this seek failed, so the next request still runs.
    src.seekChain = run.catch(() => undefined);
    return run;
  }
}
