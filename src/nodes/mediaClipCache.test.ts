// #1939 — a video clip read through one evaluator cache gives each time its own frame.
//
// MediaClip picks its source frame from the time it is evaluated at. Declared pure, the evaluator
// left the time out of its cache key, so one cache shared across frames (the ComfyUI run shares
// one for its whole walk, #1318) handed back the first frame it cached at every later time.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  createEvaluatorCache,
  emptyDagState,
  evaluate,
  type EvalCtx,
} from '../core/dag';
import { hashValue } from '../core/dag/hash';
import { registerAllNodes } from './registerAll';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const at = (frame: number): EvalCtx => ({ time: { frame, seconds: frame / 30, normalized: 0 } });
const clipFrame = (i: number) =>
  hashValue({ mediaClip: 'clips/run.mp4', mediaKind: 'video', frameIndex: i });

describe('#1939 — a video clip read through one cache gives each time its own frame', () => {
  it('steps 47, 0, 12 through a shared cache (a pure clip would repeat the first it cached)', () => {
    const s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'video',
      nodeType: 'MediaClip',
      params: { src: 'clips/run.mp4', mediaKind: 'video', srcFps: 30, srcFrames: 90 },
    }).next;
    const cache = createEvaluatorCache();
    const times = [47, 0, 12];
    const got = times.map(
      (f) =>
        (evaluate(s, 'video', { ctx: at(f), cache }).value as { sourceHash: string }).sourceHash,
    );
    expect(got).toEqual(times.map(clipFrame));
  });
});
