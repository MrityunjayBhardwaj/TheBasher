// MediaDecodeCapability tests (Compositor spine 1b) — the StubMediaDecode
// probe + decode are pure + deterministic (V2/V22), the seam every headless
// test + the compositor's 1d composite snapshot relies on.

import { describe, expect, it } from 'vitest';
import { StubMediaDecode } from './StubMediaDecode';

describe('StubMediaDecode.probe', () => {
  it('classifies an image extension as a 1-frame still', async () => {
    const probe = await new StubMediaDecode().probe(new Uint8Array([1, 2, 3]), 'plate.png');
    expect(probe.mediaKind).toBe('image');
    expect(probe.srcFrames).toBe(1);
    expect(probe.srcFps).toBe(1);
    expect(probe.durationSeconds).toBe(0);
  });

  it('classifies a non-image as a video with the configured frame/fps', async () => {
    const probe = await new StubMediaDecode({ videoFrames: 48, videoFps: 24 }).probe(
      new Uint8Array([1]),
      'shot.mp4',
    );
    expect(probe.mediaKind).toBe('video');
    expect(probe.srcFrames).toBe(48);
    expect(probe.srcFps).toBe(24);
    expect(probe.durationSeconds).toBe(2);
  });
});

describe('StubMediaDecode.decodeFrame', () => {
  const decode = new StubMediaDecode({ width: 4, height: 3 });
  const probe = {
    mediaKind: 'video' as const,
    width: 4,
    height: 3,
    srcFps: 30,
    srcFrames: 30,
    durationSeconds: 1,
  };

  it('fills a solid opaque RGBA frame of the probed size', async () => {
    const f = await decode.decodeFrame(new Uint8Array([9, 8, 7]), probe, 0);
    expect(f.rgba).not.toBeNull();
    expect(f.rgba!.length).toBe(4 * 3 * 4);
    expect(f.rgba![3]).toBe(255); // alpha
    expect(f.bitmap).toBeNull();
  });

  it('is stable per (bytes, frame) and varies across frames (V2)', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const a = await decode.decodeFrame(bytes, probe, 0);
    const a2 = await decode.decodeFrame(bytes, probe, 0);
    const b = await decode.decodeFrame(bytes, probe, 1);
    expect(Array.from(a.rgba!.slice(0, 3))).toEqual(Array.from(a2.rgba!.slice(0, 3)));
    expect(Array.from(a.rgba!.slice(0, 3))).not.toEqual(Array.from(b.rgba!.slice(0, 3)));
  });
});
