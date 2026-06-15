// Unit tests for the render-animation LOOP + pure helpers. The loop is
// dependency-injected (setTime / waitForApply / capture / sink), so it runs with
// fakes — no browser, no GPU, no WebCodecs. The sinks themselves (canvas.toBlob,
// VideoEncoder) are browser-only and covered by the e2e.

import { describe, it, expect, vi } from 'vitest';
import {
  renderAnimation,
  frameFileName,
  toEven,
  RenderAnimationAborted,
  type AnimationFrameSource,
  type FrameSink,
} from './renderAnimation';

/** A fake canvas — the loop only passes it through to the sink. */
const FAKE_CANVAS = {} as HTMLCanvasElement;

function fakeSource(over: Partial<AnimationFrameSource> = {}): AnimationFrameSource {
  return {
    frameCount: 3,
    fps: 30,
    setTime: vi.fn(),
    waitForApply: vi.fn(async () => {}),
    capture: vi.fn(async () => FAKE_CANVAS),
    ...over,
  };
}

function fakeSink(): FrameSink & { added: number[] } {
  const added: number[] = [];
  return {
    added,
    format: 'png-sequence',
    addFrame: vi.fn(async (_c: HTMLCanvasElement, i: number) => {
      added.push(i);
    }),
    finish: vi.fn(async (frameCount: number) => ({
      blob: new Blob(['x']),
      ext: 'zip',
      format: 'png-sequence' as const,
      frameCount,
    })),
    abort: vi.fn(),
  };
}

describe('frameFileName', () => {
  it('is 1-indexed and zero-padded to fit the total (lexicographic sort)', () => {
    expect(frameFileName(0, 120)).toBe('frame_0001.png');
    expect(frameFileName(119, 120)).toBe('frame_0120.png');
  });
  it('pads to at least 4 digits even for short clips', () => {
    expect(frameFileName(0, 3)).toBe('frame_0001.png');
  });
  it('widens the pad for >9999 frames', () => {
    expect(frameFileName(0, 12_345)).toBe('frame_00001.png');
  });
});

describe('toEven', () => {
  it('rounds an odd dimension down to even (H.264 requires even dims)', () => {
    expect(toEven(1921)).toBe(1920);
    expect(toEven(1080)).toBe(1080);
    expect(toEven(1)).toBe(0);
  });
});

describe('renderAnimation loop', () => {
  it('advances the playhead per frame at f/fps, applies, captures, encodes in order', async () => {
    const source = fakeSource({ frameCount: 3, fps: 30 });
    const sink = fakeSink();
    const out = await renderAnimation(source, sink);

    expect((source.setTime as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [0],
      [1 / 30],
      [2 / 30],
    ]);
    expect(source.waitForApply).toHaveBeenCalledTimes(3);
    expect(source.capture).toHaveBeenCalledTimes(3);
    expect(sink.added).toEqual([0, 1, 2]);
    expect(sink.finish).toHaveBeenCalledWith(3);
    expect(out.frameCount).toBe(3);
  });

  it('reports progress as done/total after each frame', async () => {
    const source = fakeSource({ frameCount: 3 });
    const sink = fakeSink();
    const onProgress = vi.fn();
    await renderAnimation(source, sink, { onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('aborts before the first frame when the signal is already aborted', async () => {
    const source = fakeSource();
    const sink = fakeSink();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(renderAnimation(source, sink, { signal: ctrl.signal })).rejects.toBeInstanceOf(
      RenderAnimationAborted,
    );
    expect(source.capture).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledTimes(1);
    expect(sink.finish).not.toHaveBeenCalled();
  });

  it('aborts mid-render and releases the sink without finishing', async () => {
    const ctrl = new AbortController();
    const source = fakeSource({
      frameCount: 5,
      // Abort after the second frame's apply.
      waitForApply: vi.fn(async () => {
        if ((source.capture as ReturnType<typeof vi.fn>).mock.calls.length >= 2) ctrl.abort();
      }),
    });
    const sink = fakeSink();
    await expect(renderAnimation(source, sink, { signal: ctrl.signal })).rejects.toBeInstanceOf(
      RenderAnimationAborted,
    );
    expect(sink.abort).toHaveBeenCalledTimes(1);
    expect(sink.finish).not.toHaveBeenCalled();
    // It stopped early — fewer than all 5 frames encoded.
    expect(sink.added.length).toBeLessThan(5);
  });

  it('releases the sink and rethrows when a frame encode fails', async () => {
    const source = fakeSource({ frameCount: 3 });
    const sink = fakeSink();
    sink.addFrame = vi.fn(async () => {
      throw new Error('encode boom');
    });
    await expect(renderAnimation(source, sink)).rejects.toThrow('encode boom');
    expect(sink.abort).toHaveBeenCalledTimes(1);
    expect(sink.finish).not.toHaveBeenCalled();
  });
});
