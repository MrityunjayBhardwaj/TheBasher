// importMediaClip op-builder test (Compositor spine 1b) — the pure mapping from a
// probe + OPFS path to the MediaClip addNode op. The op's params must round-trip
// through MediaClipParams so a fresh node hydrates cleanly (V10).

import { describe, expect, it } from 'vitest';
import type { MediaProbe } from '../../core/media';
import { MediaClipParams } from '../../nodes/MediaClip';
import { buildMediaClipOps } from './importMediaClip';

const imageProbe: MediaProbe = {
  mediaKind: 'image',
  width: 1920,
  height: 1080,
  srcFps: 1,
  srcFrames: 1,
  durationSeconds: 0,
};

describe('buildMediaClipOps', () => {
  it('builds ONE addNode op carrying the probed params', () => {
    const ops = buildMediaClipOps('media_1', 'plate', 'user-imports/plate/plate.png', imageProbe);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.type).toBe('addNode');
    expect(op).toMatchObject({
      nodeId: 'media_1',
      nodeType: 'MediaClip',
      params: {
        name: 'plate',
        src: 'user-imports/plate/plate.png',
        mediaKind: 'image',
        width: 1920,
        height: 1080,
        srcFrames: 1,
      },
    });
  });

  it("the op's params parse cleanly through the node schema (V10 hydrate)", () => {
    const ops = buildMediaClipOps('media_1', 'clip', 'user-imports/clip/clip.mp4', {
      mediaKind: 'video',
      width: 1280,
      height: 720,
      srcFps: 30,
      srcFrames: 90,
      durationSeconds: 3,
    });
    const params = (ops[0] as { params: unknown }).params;
    const parsed = MediaClipParams.parse(params);
    expect(parsed.src).toBe('user-imports/clip/clip.mp4');
    expect(parsed.mediaKind).toBe('video');
    expect(parsed.srcFrames).toBe(90);
  });
});
