// Still workflows through the frame runner: a workflow whose file makes only stills is run once
// (#1946), and a picture file wired into a still input is sent as that file (#1947).

import { beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability, type ComfyInputs } from '../core/comfy';
import type { ComfyApiJson } from '../core/comfy/comfyGraph';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { MemoryStorage } from '../core/storage';
import { registerAllNodes } from '../nodes/registerAll';
import { compileWorkflowFrame, uploadKeyOf } from './compileWorkflowFrame';
import { dryRun, framePath } from './dryRun';
import { runComfyUIWorkflow } from './runComfyUIWorkflow';

/** A still workflow: a still input `render`, a text input `prompt`, a still output `still`. */
const STILL_FILE: ComfyApiJson = {
  '1': { class_type: 'basher_controller', inputs: { name: 'render', kind: 'image', image: '' } },
  '2': {
    class_type: 'basher_controller',
    inputs: { name: 'prompt', kind: 'string', values_json: '["a castle"]' },
  },
  '3': { class_type: 'KSampler', inputs: { positive: ['2', 0], latent_image: ['1', 0] } },
  '4': { class_type: 'basher_export', inputs: { name: 'still', kind: 'image', images: ['3', 0] } },
};

const META = { name: 'still', importedAt: 'x', fps: 30, frames: 1 };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function withStillWorkflow(s: DagState, frameStart = 0, frameEnd = 4): DagState {
  return applyOp(s, {
    type: 'addNode',
    nodeId: 'sw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      graph: { apiJson: STILL_FILE, meta: META },
      frameStart,
      frameEnd,
      outputPath: 'renders/job1/still',
    },
  }).next;
}

function recording(cap: StubComfyUICapability): ComfyInputs[] {
  const sent: ComfyInputs[] = [];
  const submitBatch = cap.submitBatch.bind(cap);
  cap.submitBatch = async (wf, inputs, onEvent) => {
    sent.push(inputs);
    return submitBatch(wf, inputs, onEvent);
  };
  return sent;
}

describe('a workflow that makes only stills', () => {
  it('is submitted once, at its first frame, however long its range', async () => {
    const state = withStillWorkflow(emptyDagState(), 3, 60);
    const storage = new MemoryStorage();
    const cap = new StubComfyUICapability();
    const sent = recording(cap);
    const completed: number[] = [];
    const report = await runComfyUIWorkflow('sw', state, {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: (f) => completed.push(f),
    });
    expect(sent).toHaveLength(1);
    expect(completed).toEqual([3]);
    expect(report.outputs).toEqual([framePath('renders/job1/still', 3)]);
    expect(await storage.exists(framePath('renders/job1/still', 3))).toBe(true);
  });

  it('is priced as one frame by the cost preview', async () => {
    const state = withStillWorkflow(emptyDagState(), 0, 60);
    const storage = new MemoryStorage();
    const report = await dryRun('sw', state, {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    expect(report.frames).toBe(1);
  });
});

describe('a picture file wired into a still input', () => {
  it("is sent as the file's own bytes, not the job's beauty pass", async () => {
    let s = withStillWorkflow(emptyDagState(), 0, 0);
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'img',
      nodeType: 'MediaClip',
      params: { src: 'renders/first_frame.png', mediaKind: 'image' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'img', socket: 'out' },
      to: { node: 'sw', socket: 'render' },
    }).next;
    const storage = new MemoryStorage();
    await storage.write('renders/first_frame.png', Uint8Array.of(1, 2, 3));
    await storage.write('renders/job1/beauty_0000.png', Uint8Array.of(9, 9, 9));
    const cap = new StubComfyUICapability();
    const sent = recording(cap);
    await runComfyUIWorkflow('sw', s, {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: () => {},
    });
    expect(sent[0].images[uploadKeyOf('1')]).toEqual(Uint8Array.of(1, 2, 3));
  });
});
