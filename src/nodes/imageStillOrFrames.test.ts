// #1716 — an Image socket carries a still or a run of frames, and says which.
//
// Done when: wiring a still into a frames input plays it held, and wiring frames into a still
// input picks the stated frame. Asserted at the evaluation level, on the identity of the frame a
// consumer actually receives (the value's `sourceHash`, which is what the decode and the render
// key their pixels on), at several times; never on a flag alone.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StubComfyUICapability, type ComfyInputs } from '../core/comfy';
import {
  __resetRegistryForTests,
  applyOp,
  createEvaluatorCache,
  emptyDagState,
  evaluate,
  registerNodeType,
  type DagState,
  type EvalCtx,
  type EvaluatorCache,
} from '../core/dag';
import { hashValue } from '../core/dag/hash';
import { MemoryStorage } from '../core/storage';
import type { CompileWorkflowFn } from '../render/dryRun';
import { runComfyUIWorkflow } from '../render/runComfyUIWorkflow';
import { registerAllNodes } from './registerAll';
import type { ImageValue } from './types';

const at = (frame: number, fps = 30): EvalCtx => ({
  time: { frame, seconds: frame / fps, normalized: 0 },
});

/** The identity MediaClip gives source frame `i` of `src` (its evaluator's own hash terms). */
const clipFrame = (src: string, i: number) =>
  hashValue({ mediaClip: src, mediaKind: 'video', frameIndex: i });

/** #1715 — a still workflow file: a still image input `picture`, a still output `result` (an
 *  export saved before `kind` existed reads as a still). */
const GRAPH = {
  apiJson: {
    '1': { class_type: 'basher_controller', inputs: { name: 'picture', kind: 'image' } },
    '2': { class_type: 'basher_controller', inputs: { name: 'prompt', kind: 'string' } },
    '3': { class_type: 'basher_export', inputs: { name: 'result', images: ['9', 0] } },
  },
  meta: { name: 'flux_still', importedAt: 'test', fps: 30, frames: 1 },
};
/** A video workflow file: a frames input `frames`, a frames output `clip`. */
const VIDEO_GRAPH = {
  apiJson: {
    '1': { class_type: 'basher_controller', inputs: { name: 'frames', kind: 'video' } },
    '2': { class_type: 'basher_controller', inputs: { name: 'prompt', kind: 'string' } },
    '3': { class_type: 'basher_export', inputs: { name: 'clip', kind: 'video', images: ['9', 0] } },
  },
  meta: { name: 'wan_video', importedAt: 'test', fps: 30, frames: 1 },
};
/** The output socket of each workflow node id these tests make. */
const OUT_OF: Record<string, string> = { still: 'result', preset: 'clip', video: 'clip' };

function registerProbes() {
  // Two consumers that hand back exactly what arrived on their Image input: the value the
  // evaluator delivered, nothing re-derived.
  for (const [type, takes] of [
    ['ProbeStillIn', 'still'],
    ['ProbeFramesIn', 'frames'],
  ] as const) {
    registerNodeType({
      type,
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: { img: { type: 'Image', cardinality: 'single', takes } },
      outputs: { out: { type: 'Image', cardinality: 'single' } },
      evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.img,
    } as never);
  }
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  registerProbes();
});

function add(s: DagState, nodeId: string, nodeType: string, params: object = {}): DagState {
  return applyOp(s, { type: 'addNode', nodeId, nodeType, params }).next;
}
function wire(s: DagState, from: string, to: string, socket: string): DagState {
  const fromSocket = s.nodes[from]?.type === 'ComfyUIWorkflow' ? OUT_OF[from] : 'out';
  return applyOp(s, {
    type: 'connect',
    from: { node: from, socket: fromSocket },
    to: { node: to, socket },
  }).next;
}

/** A video clip of 90 frames at 30 fps. */
function withVideo(s: DagState, id = 'video'): DagState {
  return add(s, id, 'MediaClip', {
    src: 'clips/run.mp4',
    mediaKind: 'video',
    srcFps: 30,
    srcFrames: 90,
  });
}
/** A still picture. */
function withPicture(s: DagState, id = 'picture'): DagState {
  return add(s, id, 'MediaClip', { src: 'stills/ref.png', mediaKind: 'image' });
}
/** An imported (still) ComfyUI workflow with the timeline's time wired into it. */
function withStillWorkflow(s: DagState, id = 'still'): DagState {
  s = add(s, 'time', 'TimeSource');
  s = add(s, id, 'ComfyUIWorkflow', { graph: GRAPH });
  return wire(s, 'time', id, 'time');
}
/** A render pass driven by the timeline. */
function withBeauty(s: DagState): DagState {
  s = add(s, 'beautyTime', 'TimeSource');
  s = add(s, 'beauty', 'BeautyPass');
  return wire(s, 'beautyTime', 'beauty', 'time');
}

const image = (s: DagState, id: string, ctx: EvalCtx, cache?: EvaluatorCache) =>
  evaluate(s, id, {
    ctx,
    cache,
    ...(s.nodes[id]?.type === 'ComfyUIWorkflow' ? { socket: OUT_OF[id] } : {}),
  }).value as ImageValue;

// Late first: a cache that kept the first frame it saw would hand frame 47 back at 0 and 12.
const TIMES = [47, 0, 12] as const;

describe('#1716 — every producer says whether it makes a still or frames', () => {
  it('classifies the image producers truthfully', () => {
    let s = emptyDagState();
    s = withVideo(s);
    s = withPicture(s);
    s = withStillWorkflow(s);
    s = withBeauty(s);
    s = add(s, 'preset', 'ComfyUIWorkflow', { graph: VIDEO_GRAPH, frameStart: 10, frameEnd: 40 });
    s = add(s, 'grade', 'ColorCorrect', { brightness: 1.2 });
    s = wire(s, 'video', 'grade', 'target');

    expect(image(s, 'picture', at(5)).extent).toEqual({ kind: 'still' });
    expect(image(s, 'video', at(5)).extent).toEqual({
      kind: 'frames',
      range: { start: 0, end: 89, fps: 30 },
    });
    expect(image(s, 'still', at(5)).extent).toEqual({ kind: 'still' });
    expect(image(s, 'preset', at(5)).extent).toEqual({
      kind: 'frames',
      range: { start: 10, end: 40, fps: 30 },
    });
    expect(image(s, 'beauty', at(5)).extent).toEqual({ kind: 'frames', range: null });
    // An effect passes its source's extent on: a graded video is still a video.
    expect(image(s, 'grade', at(5)).extent).toEqual(image(s, 'video', at(5)).extent);
  });
});

describe('#1716 — a still into a frames input plays it held', () => {
  for (const cached of [false, true]) {
    const label = cached ? 'one cache across frames' : 'uncached';

    it(`a picture holds the same frame at every time (${label})`, () => {
      let s = withPicture(emptyDagState());
      s = add(s, 'consumer', 'ProbeFramesIn');
      s = wire(s, 'picture', 'consumer', 'img');
      const cache = cached ? createEvaluatorCache() : undefined;
      const got = TIMES.map((f) => image(s, 'consumer', at(f), cache));
      expect(new Set(got.map((v) => v.sourceHash)).size).toBe(1);
      for (const v of got) expect(v.extent).toEqual({ kind: 'still' });
    });

    it(`a still ComfyUI output holds even with the timeline wired into it (${label})`, () => {
      let s = withStillWorkflow(emptyDagState());
      s = add(s, 'consumer', 'ProbeFramesIn');
      s = wire(s, 'still', 'consumer', 'img');
      const cache = cached ? createEvaluatorCache() : undefined;
      const got = TIMES.map((f) => image(s, 'consumer', at(f), cache));
      expect(got.map((v) => v.sourceHash)).toEqual(TIMES.map(() => got[0].sourceHash));
      for (const v of got) expect(v.extent).toEqual({ kind: 'still' });
    });
  }

  it('the preset video workflow, run frame by frame, is handed the same still every frame', async () => {
    let s = withStillWorkflow(emptyDagState());
    s = add(s, 'p', 'Prompt', { text: 'a cube', negative: '', tags: [] });
    s = add(s, 'video', 'ComfyUIWorkflow', {
      graph: VIDEO_GRAPH,
      frameStart: 0,
      frameEnd: 4,
      outputPath: 'renders/job/stylized',
    });
    s = wire(s, 'p', 'video', 'prompt');
    s = wire(s, 'still', 'video', 'frames');
    const seen = await runRecording(s, 'video', 'frames');
    expect(seen.map((x) => x.frame)).toEqual([0, 1, 2, 3, 4]);
    const hashes = seen.map((x) => x.passes[0].sourceHash);
    expect(hashes).toEqual(hashes.map(() => hashes[0]));
  });
});

describe('#1716 — frames into a still input pick the stated frame (the first)', () => {
  for (const cached of [false, true]) {
    const label = cached ? 'one cache across frames' : 'uncached';

    it(`a video picks source frame 0 at every time (${label})`, () => {
      let s = withVideo(emptyDagState());
      s = add(s, 'consumer', 'ProbeStillIn');
      s = wire(s, 'video', 'consumer', 'img');
      const cache = cached ? createEvaluatorCache() : undefined;
      for (const f of TIMES) {
        const v = image(s, 'consumer', at(f), cache);
        expect(v.sourceHash, `at frame ${f}`).toBe(clipFrame('clips/run.mp4', 0));
        expect(v.extent).toEqual({ kind: 'still', pickedFrame: 0 });
      }
      // Control: the same wire into a frames input steps through the clip.
      let t = withVideo(emptyDagState());
      t = add(t, 'consumer', 'ProbeFramesIn');
      t = wire(t, 'video', 'consumer', 'img');
      const stepping = cached ? createEvaluatorCache() : undefined;
      expect(TIMES.map((f) => image(t, 'consumer', at(f), stepping).sourceHash)).toEqual(
        TIMES.map((f) => clipFrame('clips/run.mp4', f)),
      );
    });

    it(`a render pass picks timeline frame 0 at every time (${label})`, () => {
      let s = withBeauty(emptyDagState());
      s = add(s, 'consumer', 'ProbeStillIn');
      s = wire(s, 'beauty', 'consumer', 'img');
      const frame0 = image(s, 'beauty', at(0)).sourceHash;
      expect(image(s, 'beauty', at(47)).sourceHash).not.toBe(frame0); // the pass does move
      const cache = cached ? createEvaluatorCache() : undefined;
      for (const f of TIMES) {
        const v = image(s, 'consumer', at(f), cache);
        expect(v.sourceHash, `at frame ${f}`).toBe(frame0);
        expect(v.extent).toEqual({ kind: 'still', pickedFrame: 0 });
      }
    });

    it(`a preset workflow's frames 10..40 pick frame 10, its first (${label})`, () => {
      let s = add(emptyDagState(), 'time', 'TimeSource');
      s = add(s, 'preset', 'ComfyUIWorkflow', { graph: VIDEO_GRAPH, frameStart: 10, frameEnd: 40 });
      s = wire(s, 'time', 'preset', 'time');
      s = add(s, 'consumer', 'ProbeStillIn');
      s = wire(s, 'preset', 'consumer', 'img');
      const frame10 = image(s, 'preset', at(10)).sourceHash;
      expect(image(s, 'preset', at(0)).sourceHash).not.toBe(frame10);
      const cache = cached ? createEvaluatorCache() : undefined;
      for (const f of TIMES) {
        const v = image(s, 'consumer', at(f), cache);
        expect(v.sourceHash, `at frame ${f}`).toBe(frame10);
        expect(v.extent).toEqual({ kind: 'still', pickedFrame: 10 });
      }
    });
  }

  it('a still ComfyUI workflow, run by the ComfyUI runner, is run once and handed frame 0 of the video', async () => {
    let s = withVideo(emptyDagState());
    s = add(s, 'p', 'Prompt', { text: 'a cube', negative: '', tags: [] });
    s = add(s, 'still', 'ComfyUIWorkflow', {
      graph: GRAPH,
      frameStart: 0,
      frameEnd: 3,
      outputPath: 'renders/job/still',
    });
    s = wire(s, 'p', 'still', 'prompt');
    s = wire(s, 'video', 'still', 'picture');
    const seen = await runRecording(s, 'still', 'picture');
    // #1946 — a workflow that makes only stills is run once, at its first frame.
    expect(seen.map((x) => x.frame)).toEqual([0]);
    for (const x of seen) {
      expect(x.passes[0].sourceHash, `at frame ${x.frame}`).toBe(clipFrame('clips/run.mp4', 0));
      expect(x.passes[0].extent).toEqual({ kind: 'still', pickedFrame: 0 });
    }
  });
});

/** Run the ComfyUI runner with a compiler that records the picture its image input `socket`
 *  is handed per frame. */
async function runRecording(s: DagState, workflowId: string, socket: string) {
  const seen: { frame: number; passes: readonly ImageValue[] }[] = [];
  const compile: CompileWorkflowFn = async ({ apiJson, inputs, frame }) => {
    seen.push({ frame, passes: [inputs[socket] as ImageValue] });
    const compiled: ComfyInputs = { images: {}, scalars: { frame } };
    return {
      workflowJson: { ...apiJson, _frame: { class_type: 'x', inputs: { frame } } },
      inputs: compiled,
    };
  };
  await runComfyUIWorkflow(workflowId, s, {
    capability: new StubComfyUICapability(),
    storage: new MemoryStorage(),
    compileWorkflow: compile,
    onFrameComplete: () => {},
  });
  return seen;
}

describe('#1716 — only an Image input can say still or frames', () => {
  it('refuses `takes` on an input that does not accept Image', () => {
    expect(() =>
      registerNodeType({
        type: 'ProbeNumberTakes',
        version: 1,
        pure: true,
        cost: 'cheap',
        paramSchema: z.object({}),
        inputs: { n: { type: 'Number', cardinality: 'single', takes: 'still' } },
        outputs: { out: { type: 'Number', cardinality: 'single' } },
        evaluate: () => 0,
      } as never),
    ).toThrow(/declares `takes`.*does not accept Image/);
  });
});
