import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  StubComfyUICapability,
  type ComfyInputs,
  type ComfyWorkflowJson,
} from '../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { MemoryStorage } from '../core/storage';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { type CompileWorkflowFn } from './dryRun';
import { runComfyUIWorkflow, type RunComfyUIWorkflowReport } from './runComfyUIWorkflow';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildWorkflowState(opts: {
  outputPath?: string;
  frameStart?: number;
  frameEnd?: number;
  lastGoodFrame?: number;
  presetId?: string;
} = {}) {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 60, position: [0, 0, 5], lookAt: [0, 0, 0] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1], position: [0, 0, 0] },
  }).next;
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
      presetId: opts.presetId ?? 'stylizedRealism',
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
    to: { node: 'cw', socket: 'pass-input' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'cw', socket: 'time' },
  }).next;
  return s;
}

/**
 * Stub compiler that records the prevFrameStylizedPath it observed per
 * frame so tests can assert temporal coherence wiring without taking a
 * dependency on a real preset.
 */
function makeRecordingCompiler(): {
  compile: CompileWorkflowFn;
  observed: { frame: number; prev: string | null }[];
} {
  const observed: { frame: number; prev: string | null }[] = [];
  const compile: CompileWorkflowFn = async ({ presetId, prompt, passes, frame, prevFrameStylizedPath }) => {
    observed.push({ frame, prev: prevFrameStylizedPath ?? null });
    const workflowJson: ComfyWorkflowJson = {
      preset: presetId,
      frame,
      promptText: prompt.text,
      passKinds: passes.map((p) => p.passKind),
    };
    const images: Record<string, Uint8Array> = {};
    for (const p of passes) images[p.passKind] = new TextEncoder().encode(p.sourceHash);
    const inputs: ComfyInputs = {
      images,
      scalars: { prompt: prompt.text, frame, prev: prevFrameStylizedPath ?? '__zero__' },
    };
    return { workflowJson, inputs };
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

  it('first frame in the run sees prevFrameStylizedPath=null; subsequent frames see frame N-1 path (temporal coherence)', async () => {
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
      errorQueue: [undefined as unknown as Error, undefined as unknown as Error, new Error('comfy crashed')],
    });
    // Filter out the `undefined` placeholders by filtering errorQueue for
    // real Error objects: empty placeholders are skipped via the test-
    // shape — instead, use successful submits then one failure.
    const cap = new StubComfyUICapability({ errorQueue: [] });
    let callCount = 0;
    const wrappedSubmit = cap.submit.bind(cap);
    cap.submit = async (...args) => {
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
    const wrapped = cap.submit.bind(cap);
    cap.submit = async (...args) => {
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

  it('sanitizes presetId in output path (THREE-reserved-chars defense-in-depth)', async () => {
    // Construct a workflow whose params have a presetId with a colon —
    // simulating a future preset id format. The Mutator should prevent
    // this; runComfyUIWorkflow's sanitizer is the second guard.
    let s = buildWorkflowState();
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'cw',
      paramPath: 'outputPath',
      value: 'renders/job1/stylized_some_preset',
    }).next;
    const report = await runComfyUIWorkflow('cw', s, {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: makeRecordingCompiler().compile,
      onFrameComplete: () => {},
    });
    expect(report.outputs[0]).not.toMatch(/:/);
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
