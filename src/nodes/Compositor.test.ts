// Compositor data-model unit tests (spine slice 1a) — the pure evaluators for
// MediaClip / Layer / Composition. No DAG plumbing: parse params via the schema
// and call evaluate(params, inputs, ctx) directly, the cheapest observation that
// the data model holds (V2 — value identifies its content; twice-eval stable).

import { describe, expect, it } from 'vitest';
import type { EvalCtx } from '../core/dag/types';
import { CompositionNode, CompositionParams } from './Composition';
import { LayerNode, LayerParams } from './Layer';
import { MediaClipNode, MediaClipParams, mediaClipFrameAt } from './MediaClip';
import type { ImageValue, LayerValue } from './types';

const ctxAt = (seconds: number): EvalCtx => ({
  time: { frame: Math.round(seconds * 30), seconds, normalized: 0 },
});

const fakeImage = (hash: string): ImageValue => ({
  kind: 'Image',
  passKind: 'beauty',
  descriptor: { width: 640, height: 480, format: 'rgba8' },
  sourceHash: hash,
});

describe('MediaClip', () => {
  it('maps comp time → a source-local frame index (video), clamped to the range', () => {
    const params = MediaClipParams.parse({ src: 'opfs/clip.mp4', srcFps: 30, srcFrames: 90 });
    expect(mediaClipFrameAt(params, 0)).toBe(0);
    expect(mediaClipFrameAt(params, 1)).toBe(30);
    expect(mediaClipFrameAt(params, 2)).toBe(60);
    // Past the end clamps to the last frame, never out of range.
    expect(mediaClipFrameAt(params, 100)).toBe(89);
  });

  it('a still image is always frame 0', () => {
    const params = MediaClipParams.parse({
      src: 'opfs/still.png',
      mediaKind: 'image',
      srcFrames: 1,
    });
    expect(mediaClipFrameAt(params, 0)).toBe(0);
    expect(mediaClipFrameAt(params, 5)).toBe(0);
  });

  it('evaluate returns an Image whose sourceHash varies by frame (V2)', () => {
    const params = MediaClipParams.parse({ src: 'opfs/clip.mp4', srcFps: 30, srcFrames: 90 });
    const a = MediaClipNode.evaluate(params, {}, ctxAt(0));
    const b = MediaClipNode.evaluate(params, {}, ctxAt(1));
    const a2 = MediaClipNode.evaluate(params, {}, ctxAt(0));
    expect(a.kind).toBe('Image');
    expect(a.descriptor.width).toBe(MediaClipParams.parse({}).width);
    expect(a.sourceHash).not.toBe(b.sourceHash); // different frame → different value
    expect(a.sourceHash).toBe(a2.sourceHash); // same frame → stable (twice-eval)
  });
});

describe('Layer', () => {
  it('forwards the source image + composite params, applying defaults', () => {
    const params = LayerParams.parse({ name: 'Plate', opacity: 0.5, startFrame: 12 });
    const src = fakeImage('img-1');
    const v = LayerNode.evaluate(params, { source: src }, ctxAt(0)) as LayerValue;
    expect(v.kind).toBe('Layer');
    expect(v.name).toBe('Plate');
    expect(v.opacity).toBe(0.5);
    expect(v.startFrame).toBe(12);
    expect(v.enabled).toBe(true);
    expect(v.blendMode).toBe('normal');
    expect(v.transform.scale).toEqual([1, 1]);
    expect(v.source).toBe(src);
  });

  it('a layer with no source is null (degenerate, no crash)', () => {
    const v = LayerNode.evaluate(LayerParams.parse({}), {}, ctxAt(0)) as LayerValue;
    expect(v.source).toBeNull();
  });
});

describe('Composition', () => {
  it('forwards layers in back→front order with canvas settings', () => {
    const back = LayerNode.evaluate(
      LayerParams.parse({ name: 'bg' }),
      { source: fakeImage('a') },
      ctxAt(0),
    ) as LayerValue;
    const front = LayerNode.evaluate(
      LayerParams.parse({ name: 'fg' }),
      { source: fakeImage('b') },
      ctxAt(0),
    ) as LayerValue;
    const params = CompositionParams.parse({ name: 'Comp 1', width: 1920, height: 1080, fps: 24 });
    const comp = CompositionNode.evaluate(params, { layers: [back, front] }, ctxAt(0));
    expect(comp.kind).toBe('Composition');
    expect(comp.width).toBe(1920);
    expect(comp.fps).toBe(24);
    expect(comp.layers.map((l) => l.name)).toEqual(['bg', 'fg']); // [0]=back … last=front
  });

  it('an empty comp has no layers (no crash)', () => {
    const comp = CompositionNode.evaluate(CompositionParams.parse({}), {}, ctxAt(0));
    expect(comp.layers).toEqual([]);
    expect(comp.background).toBe('#000000');
  });
});
