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
import { runVideoStitch, stubVideoEncoder } from './runVideoStitch';

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

/** A shot's video workflow: a still input `first_frame`, a frames output `video`. */
const VIDEO_FILE: ComfyApiJson = {
  '1': {
    class_type: 'basher_controller',
    inputs: { name: 'first_frame', kind: 'image', image: '' },
  },
  '2': { class_type: 'WanImageToVideo', inputs: { start_image: ['1', 0] } },
  '3': { class_type: 'basher_export', inputs: { name: 'video', kind: 'video', images: ['2', 0] } },
};

describe("#1718 — one workflow's still into another's still input", () => {
  function stillIntoShot(): DagState {
    let s = withStillWorkflow(emptyDagState(), 0, 0);
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'vw',
      nodeType: 'ComfyUIWorkflow',
      params: {
        graph: { apiJson: VIDEO_FILE, meta: META },
        frameStart: 0,
        frameEnd: 2,
        outputPath: 'renders/shot1/video',
      },
    }).next;
    return applyOp(s, {
      type: 'connect',
      from: { node: 'sw', socket: 'still' },
      to: { node: 'vw', socket: 'first_frame' },
    }).next;
  }

  it('the shot is sent the picture the still workflow made, on every frame', async () => {
    const s = stillIntoShot();
    const storage = new MemoryStorage();
    const cap = new StubComfyUICapability();
    const sent = recording(cap);
    const deps = {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: () => {},
    };
    const still = await runComfyUIWorkflow('sw', s, deps);
    const stillBytes = await storage.read(still.outputs[0]);
    await runComfyUIWorkflow('vw', s, deps);
    // One still, then three frames of the shot.
    expect(sent).toHaveLength(4);
    for (const inputs of sent.slice(1)) {
      expect(inputs.images[uploadKeyOf('1')]).toEqual(stillBytes);
    }
  });

  it('a shot run before its still is made stops and says to make the still first', async () => {
    const storage = new MemoryStorage();
    await expect(
      runComfyUIWorkflow('vw', stillIntoShot(), {
        capability: new StubComfyUICapability(),
        storage,
        compileWorkflow: compileWorkflowFrame({ storage }),
        onFrameComplete: () => {},
      }),
    ).rejects.toThrow(/first_frame.*not at renders\/job1\/still_0000\.png yet/);
  });
});

describe('#1946 — a still workflow stitched into a video', () => {
  it('holds its one picture for every frame of the range', async () => {
    let s = withStillWorkflow(emptyDagState(), 0, 2);
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'stitch',
      nodeType: 'VideoStitch',
      params: { outputPath: 'renders/job1/held.mp4' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'sw', socket: 'still' },
      to: { node: 'stitch', socket: 'pass-input' },
    }).next;
    const storage = new MemoryStorage();
    await runComfyUIWorkflow('sw', s, {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: () => {},
    });
    const report = await runVideoStitch('stitch', s, { storage, encoder: stubVideoEncoder });
    expect(report.framesEncoded).toBe(3);
  });
});
