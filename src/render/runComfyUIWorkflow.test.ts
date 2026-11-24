import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StubComfyUICapability, type ComfyInputs, type ComfyWorkflowJson } from '../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { MemoryStorage } from '../core/storage';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { type CompileWorkflowFn } from './dryRun';
import { runComfyUIWorkflow, type RunComfyUIWorkflowReport } from './runComfyUIWorkflow';
import { BLACK_FRAME_PNG, compileWorkflowFrame, uploadKeyOf } from './compileWorkflowFrame';
import type { ComfyApiJson } from '../core/comfy/comfyGraph';

/** #1715 — a workflow file: a frames input `beauty`, a text input `prompt`, an input fed with the
 *  output's previous frame, and one frames output `out`. */
const FILE: ComfyApiJson = {
  '1': { class_type: 'basher_controller', inputs: { name: 'beauty', kind: 'video' } },
  '2': {
    class_type: 'basher_controller',
    inputs: { name: 'prompt', kind: 'string', values_json: '[""]' },
  },
  '3': {
    class_type: 'basher_controller',
    inputs: { name: 'previous', kind: 'image', image: '', feedback_of: 'out' },
  },
  '4': { class_type: 'KSampler', inputs: { positive: ['2', 0], latent_image: ['3', 0] } },
  '5': { class_type: 'basher_export', inputs: { name: 'out', kind: 'video', images: ['4', 0] } },
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function buildWorkflowState(
  opts: {
    outputPath?: string;
    frameStart?: number;
    frameEnd?: number;
    lastGoodFrame?: number;
  } = {},
) {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  // #387 C4 — the fused camera node type is retired; a camera is now an Object posing a
  // CameraData. `position` stays on the Object, the lens moves to the data half.
  s = makeSplitCamera(s, {
    objectId: 'cam',
    fov: 60,
    position: [0, 0, 5],
    lens: { lookAt: [0, 0, 0] },
  }).state;
  s = makeSplitCube(s, { objectId: 'box', size: [1, 1, 1], position: [0, 0, 0] }).state;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'beauty', nodeType: 'BeautyPass', params: {} }).next;
  for (const wire of [
    { from: 'scene', to: ['beauty', 'scene'] },
    { from: 'cam', to: ['beauty', 'camera'] },
    { from: 'time', to: ['beauty', 'time'] },
  ] as const) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: wire.from, socket: 'out' },
      to: { node: wire.to[0], socket: wire.to[1] },
    }).next;
  }
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'p',
    nodeType: 'Prompt',
    params: { text: 'a cinematic cube', negative: '', tags: [] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      graph: { apiJson: FILE, meta: { name: 'test', importedAt: 'x', fps: 30, frames: 1 } },
      frameStart: opts.frameStart ?? 0,
      frameEnd: opts.frameEnd ?? 4,
      lastGoodFrame: opts.lastGoodFrame ?? -1,
      outputPath: opts.outputPath ?? 'renders/job1/stylized_stylizedRealism',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'p', socket: 'out' },
    to: { node: 'cw', socket: 'prompt' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'beauty', socket: 'out' },
    to: { node: 'cw', socket: 'beauty' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'cw', socket: 'time' },
  }).next;
  return s;
}

/**
 * Stub compiler that records the fed path it observed per frame so tests can assert the
 * feedback wiring without reading pass bytes.
 */
function makeRecordingCompiler(): {
  compile: CompileWorkflowFn;
  observed: { frame: number; prev: string | null }[];
} {
  const observed: { frame: number; prev: string | null }[] = [];
  const compile: CompileWorkflowFn = async ({ apiJson, frame, inputs, fed }) => {
    observed.push({ frame, prev: fed['3'] ?? null });
    const prompt = inputs.prompt as { text?: string } | undefined;
    const beauty = inputs.beauty as { passKind: string; sourceHash: string } | undefined;
    const workflowJson: ComfyWorkflowJson = {
      ...apiJson,
      _test: { frame, promptText: prompt?.text, beauty: beauty?.passKind },
    };
    const images: Record<string, Uint8Array> = {};
    if (beauty) images.beauty = new TextEncoder().encode(beauty.sourceHash);
    const compiled: ComfyInputs = { images, scalars: { frame } };
    return { workflowJson, inputs: compiled };
  };
  return { compile, observed };
}

describe('runComfyUIWorkflow (Wave B1 — execute side)', () => {
  it('walks the frame range and writes one PNG per frame to D-04 paths', async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 4 });
    const storage = new MemoryStorage();
    const recorded = makeRecordingCompiler();
    const onFrameComplete = vi.fn();
    const report = await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: recorded.compile,
      onFrameComplete,
    });
    expect(report.framesWritten).toBe(5);
    expect(report.lastGoodFrame).toBe(4);
    expect(report.outputs).toEqual([
      'renders/job1/stylized_stylizedRealism_0000.png',
      'renders/job1/stylized_stylizedRealism_0001.png',
      'renders/job1/stylized_stylizedRealism_0002.png',
      'renders/job1/stylized_stylizedRealism_0003.png',
      'renders/job1/stylized_stylizedRealism_0004.png',
    ]);
    for (const p of report.outputs) {
      expect(await storage.exists(p)).toBe(true);
    }
    expect(onFrameComplete).toHaveBeenCalledTimes(5);
    expect(onFrameComplete.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it("#1715 — a fed input sees null on the first frame, then its output's frame N-1 path", async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 2 });
    const recorded = makeRecordingCompiler();
    await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: recorded.compile,
      onFrameComplete: () => {},
    });
    expect(recorded.observed).toEqual([
      { frame: 0, prev: null },
      { frame: 1, prev: 'renders/job1/stylized_stylizedRealism_0000.png' },
      { frame: 2, prev: 'renders/job1/stylized_stylizedRealism_0001.png' },
    ]);
  });

  it('resumes from lastGoodFrame + 1 — pre-set lastGoodFrame=2 over a 0..4 range writes frames 3..4 only', async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 4, lastGoodFrame: 2 });
    const storage = new MemoryStorage();
    const report = await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: makeRecordingCompiler().compile,
      onFrameComplete: () => {},
    });
    expect(report.framesWritten).toBe(2);
    expect(report.outputs).toEqual([
      'renders/job1/stylized_stylizedRealism_0003.png',
      'renders/job1/stylized_stylizedRealism_0004.png',
    ]);
    expect(report.lastGoodFrame).toBe(4);
  });

  it('resume scenario: first run errors at frame 2 → second run starts at frame 3 (after caller writes lastGoodFrame=1)', async () => {
    const baseState = buildWorkflowState({ frameStart: 0, frameEnd: 4 });

    // Run 1: stub configured to throw on the third submit (frames 0, 1, 2).
    const failingCap = new StubComfyUICapability({
      errorQueue: [
        undefined as unknown as Error,
        undefined as unknown as Error,
        new Error('comfy crashed'),
      ],
    });
    // Filter out the `undefined` placeholders by filtering errorQueue for
    // real Error objects: empty placeholders are skipped via the test-
    // shape — instead, use successful submits then one failure.
    const cap = new StubComfyUICapability({ errorQueue: [] });
    let callCount = 0;
    const wrappedSubmit = cap.submitBatch.bind(cap);
    cap.submitBatch = async (...args) => {
      callCount += 1;
      if (callCount === 3) throw new Error('comfy crashed');
      return wrappedSubmit(...args);
    };
    let lastGood = -1;
    await expect(
      runComfyUIWorkflow('cw', baseState, {
        capability: cap,
        storage: new MemoryStorage(),
        compileWorkflow: makeRecordingCompiler().compile,
        onFrameComplete: (f) => {
          lastGood = f;
        },
      }),
    ).rejects.toThrow(/at frame 2/);
    expect(lastGood).toBe(1); // frames 0 + 1 succeeded; 2 failed.
    void failingCap;

    // Run 2: caller would now dispatch setParam lastGoodFrame=1; mimic that.
    const resumedState = applyOp(baseState, {
      type: 'setParam',
      nodeId: 'cw',
      paramPath: 'lastGoodFrame',
      value: 1,
    }).next;
    const cap2 = new StubComfyUICapability();
    const storage2 = new MemoryStorage();
    const report2 = await runComfyUIWorkflow('cw', resumedState, {
      capability: cap2,
      storage: storage2,
      compileWorkflow: makeRecordingCompiler().compile,
      onFrameComplete: () => {},
    });
    expect(report2.framesWritten).toBe(3);
    expect(report2.outputs).toEqual([
      'renders/job1/stylized_stylizedRealism_0002.png',
      'renders/job1/stylized_stylizedRealism_0003.png',
      'renders/job1/stylized_stylizedRealism_0004.png',
    ]);
  });

  it('attaches a partialReport to the thrown error for diagnostics', async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 4 });
    const cap = new StubComfyUICapability();
    let count = 0;
    const wrapped = cap.submitBatch.bind(cap);
    cap.submitBatch = async (...args) => {
      count += 1;
      if (count === 2) throw new Error('flake');
      return wrapped(...args);
    };
    let thrown: Error | undefined;
    try {
      await runComfyUIWorkflow('cw', state, {
        capability: cap,
        storage: new MemoryStorage(),
        compileWorkflow: makeRecordingCompiler().compile,
        onFrameComplete: () => {},
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    const partial = (thrown as Error & { partialReport?: RunComfyUIWorkflowReport }).partialReport;
    expect(partial).toBeDefined();
    expect(partial!.lastGoodFrame).toBe(0);
    expect(partial!.framesWritten).toBe(1);
  });

  it('returns immediately (zero frames) when lastGoodFrame already covers frameEnd', async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 2, lastGoodFrame: 5 });
    const report = await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: makeRecordingCompiler().compile,
      onFrameComplete: () => {},
    });
    expect(report.framesWritten).toBe(0);
    expect(report.outputs).toEqual([]);
  });

  it('throws when outputPath is empty (Mutator must set it before run)', async () => {
    const state = buildWorkflowState({ outputPath: '' });
    await expect(
      runComfyUIWorkflow('cw', state, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: makeRecordingCompiler().compile,
        onFrameComplete: () => {},
      }),
    ).rejects.toThrow(/empty outputPath/);
  });

  it('twice-run determinism — same DAG + same stub run twice produces identical bytes per frame', async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 2 });
    const compileA = makeRecordingCompiler().compile;
    const storageA = new MemoryStorage();
    await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage: storageA,
      compileWorkflow: compileA,
      onFrameComplete: () => {},
    });
    const storageB = new MemoryStorage();
    await runComfyUIWorkflow('cw', state, {
      capability: new StubComfyUICapability(),
      storage: storageB,
      compileWorkflow: makeRecordingCompiler().compile,
      onFrameComplete: () => {},
    });
    for (let f = 0; f <= 2; f++) {
      const path = `renders/job1/stylized_stylizedRealism_${f.toString().padStart(4, '0')}.png`;
      const a = await storageA.read(path);
      const b = await storageB.read(path);
      expect(a).toEqual(b);
    }
  });

  it('#1715 — throws when the node holds no workflow file', async () => {
    const s = applyOp(buildWorkflowState(), {
      type: 'setParam',
      nodeId: 'cw',
      paramPath: 'graph',
      value: null,
    }).next;
    await expect(
      runComfyUIWorkflow('cw', s, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: makeRecordingCompiler().compile,
        onFrameComplete: () => {},
      }),
    ).rejects.toThrow(/no workflow file/);
  });
});

describe('#1715 — feedback through the real frame compiler and the stub', () => {
  it("frame 1's fed input is frame 0's output; frame 0's is the fallback (black)", async () => {
    const state = buildWorkflowState({ frameStart: 0, frameEnd: 1 });
    const storage = new MemoryStorage();
    // The beauty pass's frames, where a render job writes them (beside the output path).
    for (const f of [0, 1]) {
      await storage.write(`renders/job1/beauty_000${f}.png`, Uint8Array.of(7, f));
    }
    const cap = new StubComfyUICapability();
    const sent: ComfyInputs[] = [];
    const submitBatch = cap.submitBatch.bind(cap);
    cap.submitBatch = async (wf, inputs, onEvent) => {
      sent.push(inputs);
      return submitBatch(wf, inputs, onEvent);
    };
    const report = await runComfyUIWorkflow('cw', state, {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: () => {},
    });
    const fedKey = uploadKeyOf('3');
    expect(sent).toHaveLength(2);
    expect(sent[0].images[fedKey]).toEqual(BLACK_FRAME_PNG);
    const frame0 = await storage.read(report.outputs[0]);
    expect(sent[1].images[fedKey]).toEqual(frame0);
    // And the frames input carried that frame's beauty pass each time.
    expect(sent[0].images[uploadKeyOf('1')]).toEqual(Uint8Array.of(7, 0));
    expect(sent[1].images[uploadKeyOf('1')]).toEqual(Uint8Array.of(7, 1));
  });

  it('the fed marker keeps its own file on the first frame when it names one', async () => {
    const own = structuredClone(FILE);
    (own['3'].inputs as Record<string, unknown>).image = 'start.png';
    let state = buildWorkflowState({ frameStart: 0, frameEnd: 0 });
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'cw',
      paramPath: 'graph',
      value: { apiJson: own, meta: { name: 'test', importedAt: 'x', fps: 30, frames: 1 } },
    }).next;
    const storage = new MemoryStorage();
    await storage.write('renders/job1/beauty_0000.png', Uint8Array.of(1));
    const cap = new StubComfyUICapability();
    const sent: { wf: unknown; inputs: ComfyInputs }[] = [];
    const submitBatch = cap.submitBatch.bind(cap);
    cap.submitBatch = async (wf, inputs, onEvent) => {
      sent.push({ wf, inputs });
      return submitBatch(wf, inputs, onEvent);
    };
    await runComfyUIWorkflow('cw', state, {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      onFrameComplete: () => {},
    });
    expect(sent[0].inputs.images[uploadKeyOf('3')]).toBeUndefined();
    expect((sent[0].wf as ComfyApiJson)['3'].inputs.image).toBe('start.png');
  });
});

describe('V8 — file-rooted dispatch rule for runComfyUIWorkflow.ts', () => {
  it('runComfyUIWorkflow.ts does not import dag store or op machinery', () => {
    const file = readFileSync(path.resolve(__dirname, 'runComfyUIWorkflow.ts'), 'utf-8');
    const FORBIDDEN_IMPORTS =
      /from\s+['"][^'"]*(dagStore|useDagStore|dispatchAtomic|core\/dag\/ops)['"]/;
    expect(file).not.toMatch(FORBIDDEN_IMPORTS);
  });
});
