// composite — verify the PURE compositing core: which layers are visible at a
// frame (enabled / solo / trim), the source-frame remap, fit-contain geometry, and
// the blend-mode → canvas-op mapping.

import { describe, expect, it } from 'vitest';
import { blendOp, fitContain, planComposite, type ResolvedLayerInput } from './composite';

const SRC = {
  path: 'opfs/a.png',
  mediaKind: 'image' as const,
  width: 100,
  height: 100,
  srcFps: 1,
  srcFrames: 1,
};

function layer(over: Partial<ResolvedLayerInput> = {}): ResolvedLayerInput {
  return {
    layerId: 'l',
    enabled: true,
    solo: false,
    startFrame: 0,
    inPoint: 0,
    outPoint: 150, // a still spanning the comp
    opacity: 1,
    rotation: 0,
    position: [0, 0],
    scale: [1, 1],
    blendMode: 'normal',
    source: SRC,
    ...over,
  };
}

const COMP = { fps: 30, durationFrames: 150 };

describe('planComposite', () => {
  it('keeps enabled layers within their span, in back→front order', () => {
    const draws = planComposite(COMP, [layer({ layerId: 'bg' }), layer({ layerId: 'fg' })], 0);
    expect(draws.map((d) => d.layerId)).toEqual(['bg', 'fg']);
    expect(draws[0].sourceFrameIndex).toBe(0); // image → frame 0
  });

  it('drops a disabled layer', () => {
    const draws = planComposite(
      COMP,
      [layer({ layerId: 'on' }), layer({ layerId: 'off', enabled: false })],
      0,
    );
    expect(draws.map((d) => d.layerId)).toEqual(['on']);
  });

  it('drops a layer with no decodable source', () => {
    const draws = planComposite(
      COMP,
      [layer({ layerId: 'has' }), layer({ layerId: 'none', source: null })],
      0,
    );
    expect(draws.map((d) => d.layerId)).toEqual(['has']);
  });

  it('when any layer solos, only solo layers draw (eyeball ignored)', () => {
    const draws = planComposite(
      COMP,
      [layer({ layerId: 'a' }), layer({ layerId: 'solo', solo: true }), layer({ layerId: 'c' })],
      0,
    );
    expect(draws.map((d) => d.layerId)).toEqual(['solo']);
  });

  it('drops a layer whose span does not cover the playhead', () => {
    // startFrame 100, length = outPoint(120) - inPoint(0) = 120 → covers [100,220).
    const trimmed = layer({ layerId: 'late', startFrame: 100, outPoint: 120 });
    expect(planComposite(COMP, [trimmed], 0)).toEqual([]); // before it starts
    expect(planComposite(COMP, [trimmed], 100).map((d) => d.layerId)).toEqual(['late']);
  });

  it('remaps comp frame → source frame for a video source', () => {
    const video = layer({
      source: {
        path: 'v.mp4',
        mediaKind: 'video',
        width: 100,
        height: 100,
        srcFps: 30,
        srcFrames: 300,
      },
      startFrame: 0,
      inPoint: 0,
      outPoint: 300,
    });
    // compFrame 60 @ 30fps = 2s → source frame round(2 * 30) = 60.
    expect(planComposite(COMP, [video], 60)[0].sourceFrameIndex).toBe(60);
  });
});

describe('fitContain', () => {
  it('scales to fit preserving aspect', () => {
    expect(fitContain(100, 50, 200, 200)).toEqual({ dw: 200, dh: 100 }); // min(2,4)=2
    expect(fitContain(50, 100, 200, 200)).toEqual({ dw: 100, dh: 200 });
  });
  it('falls back to dst for a degenerate source', () => {
    expect(fitContain(0, 100, 320, 240)).toEqual({ dw: 320, dh: 240 });
  });
});

describe('blendOp', () => {
  it('maps blend modes to canvas composite ops', () => {
    expect(blendOp('normal')).toBe('source-over');
    expect(blendOp('add')).toBe('lighter');
    expect(blendOp('multiply')).toBe('multiply');
    expect(blendOp('screen')).toBe('screen');
  });
});
