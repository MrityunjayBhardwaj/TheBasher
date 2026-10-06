// #1318 — the batch render roads resolve the scene once per run, not once per frame.
//
// Each road evaluates per frame (a pass, its scene, its camera; a workflow's prompt and passes;
// a stitch's upstream for its metadata). Over a scene holding a character, every one of those
// reached the walk's whole-clip `RetargetClip` again. Measured on the "Camera Path + AI Walk"
// example over 6 frames, before the fix: render job 13 retargets, ComfyUI workflow 6, video
// stitch 6. With one evaluator cache per run: 1 each. The cost preview's dry run reads one frame,
// but each of its passes walked the scene again: 2 retargets for two passes, now 1.
//
// The graph is the example's own, with a Beauty pass, a render job, a workflow and a stitch
// wired onto its scene and camera, so the count comes from the real character chain.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { __retargetRunsForTests } from '../nodes/RetargetClip';
import { buildExampleProject } from '../core/project/examples';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { applyOp, type DagState } from '../core/dag';
import { StubComfyUICapability } from '../core/comfy';
import { runRenderJob } from './runRenderJob';
import { runComfyUIWorkflow } from './runComfyUIWorkflow';
import { dryRun, type CompileWorkflowFn } from './dryRun';
import { runVideoStitch, stubVideoEncoder } from './runVideoStitch';
import { stubEncoder } from './encoders/stubEncoder';

registerAllNodes();

const LAST_FRAME = 5; // frames 0..5 inclusive: 6 frames

/** The example (stored native, #1424: the load door changes nothing), with the batch roads wired onto its scene. */
async function exampleWithBatchRoads(): Promise<DagState> {
  const project = await buildExampleProject('example_camera_path_ai_walk');
  let s: DagState = project.state;
  const op = (o: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, o).next;
  };
  const wire = (from: string, to: string, socket: string) =>
    op({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } });

  op({ type: 'addNode', nodeId: 'pass', nodeType: 'BeautyPass', params: {} });
  wire('n_scene', 'pass', 'scene');
  wire('n_camera', 'pass', 'camera');
  wire('n_time', 'pass', 'time');

  op({
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: { jobId: 'j', frameStart: 0, frameEnd: LAST_FRAME, fps: 30, outputPath: 'r/j' },
  });
  wire('n_time', 'job', 'time');
  wire('pass', 'job', 'pass-input');

  op({
    type: 'addNode',
    nodeId: 'p',
    nodeType: 'Prompt',
    params: { text: 'a walk', negative: '', tags: [] },
  });
  op({
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      presetId: 'stylizedRealism',
      frameStart: 0,
      frameEnd: LAST_FRAME,
      lastGoodFrame: -1,
      outputPath: 'r/s',
    },
  });
  wire('p', 'cw', 'prompt');
  wire('pass', 'cw', 'pass-input');
  wire('n_time', 'cw', 'time');

  op({
    type: 'addNode',
    nodeId: 'stitch',
    nodeType: 'VideoStitch',
    params: { codec: 'h264', fps: 30, outputPath: 'r/v.mp4' },
  });
  wire('cw', 'stitch', 'pass-input');
  wire('n_time', 'stitch', 'time');
  return s;
}

const compile: CompileWorkflowFn = async ({ presetId, prompt, passes, frame }) => ({
  workflowJson: {
    preset: presetId,
    frame,
    promptText: prompt.text,
    passKinds: passes.map((q) => q.passKind),
  },
  inputs: { images: {}, scalars: { frame } },
});

/** Retarget runs caused by `run`. */
async function retargetsDuring(run: () => Promise<unknown>): Promise<number> {
  const before = __retargetRunsForTests();
  await run();
  return __retargetRunsForTests() - before;
}

describe('#1318 — the batch render roads retarget the walk once per run', () => {
  let state: DagState;
  beforeAll(async () => {
    state = await exampleWithBatchRoads();
  });

  it('render job: once for 6 frames (was 13)', async () => {
    const n = await retargetsDuring(async () => {
      const report = await runRenderJob('job', state, {
        storage: new MemoryStorage(),
        encoder: stubEncoder,
      });
      expect(report.framesWritten).toBe(LAST_FRAME + 1);
    });
    expect(n).toBe(1);
  }, 120_000);

  it('ComfyUI workflow, then the stitch that reads it: once each for 6 frames (was 6 each)', async () => {
    const storage = new MemoryStorage();
    const workflow = await retargetsDuring(async () => {
      const report = await runComfyUIWorkflow('cw', state, {
        capability: new StubComfyUICapability(),
        storage,
        compileWorkflow: compile,
        onFrameComplete: () => {},
      });
      expect(report.framesWritten).toBe(LAST_FRAME + 1);
    });
    const stitch = await retargetsDuring(async () => {
      const report = await runVideoStitch('stitch', state, { storage, encoder: stubVideoEncoder });
      expect(report.framesEncoded).toBe(LAST_FRAME + 1);
    });
    expect({ workflow, stitch }).toEqual({ workflow: 1, stitch: 1 });
  }, 120_000);

  it('dry run: once for its probe frame, across two passes (was 2)', async () => {
    let s2 = applyOp(state, {
      type: 'addNode',
      nodeId: 'depth',
      nodeType: 'DepthPass',
      params: {},
    }).next;
    for (const [from, to, socket] of [
      ['n_scene', 'depth', 'scene'],
      ['n_camera', 'depth', 'camera'],
      ['n_time', 'depth', 'time'],
      ['depth', 'cw', 'pass-input'],
    ] as const)
      s2 = applyOp(s2, {
        type: 'connect',
        from: { node: from, socket: 'out' },
        to: { node: to, socket },
      }).next;
    const passes = s2.nodes.cw.inputs['pass-input'];
    expect(Array.isArray(passes) ? passes.length : 0).toBe(2);
    const n = await retargetsDuring(() =>
      dryRun('cw', s2, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: compile,
      }),
    );
    expect(n).toBe(1);
  }, 120_000);
});
