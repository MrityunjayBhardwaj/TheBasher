// Compositor data-model unit tests (spine slice 1a) — the pure evaluators for
// MediaClip / Layer / Composition. No DAG plumbing: parse params via the schema
// and call evaluate(params, inputs, ctx) directly, the cheapest observation that
// the data model holds (V2 — value identifies its content; twice-eval stable).

import { describe, expect, it } from 'vitest';
import type { EvalCtx } from '../core/dag/types';
import { CompositionNode, CompositionParams } from './Composition';
import { LayerNode, LayerParams } from './Layer';
import { MediaClipNode, MediaClipParams, mediaClipFrameAt } from './MediaClip';
import type { ImageValue } from './types';

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
  // #1879 — a layer is an Image-lane operator: `below` is the stack under it, `source` its own
  // picture, and its output is a handle on the stack with it on top.
  it('composites its picture over the stack below: a new image, of the same size', () => {
    const params = LayerParams.parse({ name: 'Plate', opacity: 0.5, startFrame: 12 });
    const below = fakeImage('below');
    const v = LayerNode.evaluate(params, { below, source: fakeImage('img-1') }, ctxAt(0));
    expect(v.kind).toBe('Image');
    expect(v.descriptor).toEqual(below.descriptor);
    expect(v.sourceHash).not.toBe(below.sourceHash);
  });

  it('its hash moves with its params, its picture, and the stack below', () => {
    const at = (p: Record<string, unknown>, below: string, source: string) =>
      LayerNode.evaluate(
        LayerParams.parse(p),
        { below: fakeImage(below), source: fakeImage(source) },
        ctxAt(0),
      ).sourceHash;
    const base = at({ opacity: 0.5 }, 'b', 's');
    expect(at({ opacity: 0.5 }, 'b', 's')).toBe(base); // twice-eval stable (V2)
    expect(at({ opacity: 0.6 }, 'b', 's')).not.toBe(base);
    expect(at({ opacity: 0.5 }, 'b2', 's')).not.toBe(base);
    expect(at({ opacity: 0.5 }, 'b', 's2')).not.toBe(base);
  });

  it('the back layer (nothing below) is a handle on its own picture', () => {
    const v = LayerNode.evaluate(LayerParams.parse({}), { source: fakeImage('a') }, ctxAt(0));
    expect(v.kind).toBe('Image');
  });

  it('a layer with nothing below and no picture is nothing (degenerate, no crash)', () => {
    expect(LayerNode.evaluate(LayerParams.parse({}), {}, ctxAt(0))).toBeUndefined();
  });

  it('hidden is `muted`, off by default', () => {
    expect(LayerParams.parse({}).muted).toBe(false);
  });
});

describe('Composition', () => {
  it('carries the top of its stack with canvas settings', () => {
    const top = fakeImage('top');
    const params = CompositionParams.parse({ name: 'Comp 1', width: 1920, height: 1080, fps: 24 });
    const comp = CompositionNode.evaluate(params, { in: top }, ctxAt(0));
    expect(comp.kind).toBe('Composition');
    expect(comp.width).toBe(1920);
    expect(comp.fps).toBe(24);
    expect(comp.image).toBe(top);
  });

  it('an empty comp has no image (no crash)', () => {
    const comp = CompositionNode.evaluate(CompositionParams.parse({}), {}, ctxAt(0));
    expect(comp.image).toBeNull();
    expect(comp.background).toBe('#000000');
  });
});
