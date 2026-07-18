import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubComfyUICapability, type ComfyInputs, type ComfyWorkflowJson } from '../../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { makeSplitCube } from '../../test-utils/splitCube';
import type { CompileWorkflowFn } from '../../render/dryRun';
import { useRenderJobsStore } from '../stores/renderJobsStore';
import { runWorkflow } from './runWorkflow';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useRenderJobsStore.setState({ inFlight: new Set() });
  useDagStore.getState().reset();
});

afterEach(() => {
  useDagStore.getState().reset();
});

function seedWorkflowDag(
  opts: {
    frameStart?: number;
    frameEnd?: number;
    lastGoodFrame?: number;
    outputPath?: string;
  } = {},
) {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 60, position: [0, 0, 5], lookAt: [0, 0, 0] },
  }).next;
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
    params: { text: 'a cube', negative: '', tags: [] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      presetId: 'stylizedRealism',
      frameStart: opts.frameStart ?? 0,
      frameEnd: opts.frameEnd ?? 2,
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
  // Hydrate into the real store so runWorkflow's useDagStore.getState() reads it.
  useDagStore.getState().hydrate(s);
}

const stubCompiler: CompileWorkflowFn = async ({ presetId, prompt, passes, frame }) => {
  const workflowJson: ComfyWorkflowJson = {
    preset: presetId,
    prompt: prompt.text,
    frame,
    passKinds: passes.map((p) => p.passKind),
  };
  const images: Record<string, Uint8Array> = {};
  for (const p of passes) images[p.passKind] = new TextEncoder().encode(p.sourceHash);
  const inputs: ComfyInputs = { images, scalars: { frame } };
  return { workflowJson, inputs };
};

describe('runWorkflow (Wave B2 — caller seam)', () => {
  it('completed: marks/clears inFlight and dispatches setParam Ops for each frame', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 2 });
    const result = await runWorkflow('cw', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.report.framesWritten).toBe(3);
    // After completion, inFlight is cleared.
    expect(useRenderJobsStore.getState().isInFlight('cw')).toBe(false);
    // V1: lastGoodFrame should reflect the final frame after dispatch
    // chain (Op dispatcher updates store params on each setParam).
    const after = useDagStore.getState().state.nodes.cw.params as { lastGoodFrame: number };
    expect(after.lastGoodFrame).toBe(2);
  });

  it('busy: a concurrent runWorkflow for the same id returns busy without doing work', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 2 });
    // Manually mark as in-flight to simulate the concurrent case.
    useRenderJobsStore.getState().markInFlight('cw');
    const result = await runWorkflow('cw', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    expect(result.status).toBe('busy');
    if (result.status !== 'busy') return;
    expect(result.workflowId).toBe('cw');
    // The original mark stays in place — the second call did not clear it.
    expect(useRenderJobsStore.getState().isInFlight('cw')).toBe(true);
  });

  it('failed: surfaces error + partialReport + clears inFlight', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 4 });
    const cap = new StubComfyUICapability();
    let count = 0;
    const wrapped = cap.submit.bind(cap);
    cap.submit = async (...args) => {
      count += 1;
      if (count === 3) throw new Error('comfy down');
      return wrapped(...args);
    };
    const result = await runWorkflow('cw', {
      capability: cap,
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.message).toMatch(/at frame 2/);
    expect(result.partialReport).toBeDefined();
    expect(result.partialReport!.lastGoodFrame).toBe(1);
    expect(result.partialReport!.framesWritten).toBe(2);
    // inFlight cleared even on failure (finally block).
    expect(useRenderJobsStore.getState().isInFlight('cw')).toBe(false);
    // Two successful frames advanced lastGoodFrame in the store.
    const after = useDagStore.getState().state.nodes.cw.params as { lastGoodFrame: number };
    expect(after.lastGoodFrame).toBe(1);
  });

  it('two sequential runs resume — first run errors at frame 2, second run completes 2..4', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 4 });
    const cap1 = new StubComfyUICapability();
    let count = 0;
    const wrapped1 = cap1.submit.bind(cap1);
    cap1.submit = async (...args) => {
      count += 1;
      if (count === 3) throw new Error('crash');
      return wrapped1(...args);
    };
    const r1 = await runWorkflow('cw', {
      capability: cap1,
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    expect(r1.status).toBe('failed');

    // Run 2: lastGoodFrame is now 1 (per the dispatch chain).
    const r2 = await runWorkflow('cw', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    expect(r2.status).toBe('completed');
    if (r2.status !== 'completed') return;
    expect(r2.report.framesWritten).toBe(3);
    expect(r2.report.outputs.map((p) => p.match(/_(\d+)\.png$/)![1])).toEqual([
      '0002',
      '0003',
      '0004',
    ]);
  });

  it('side-by-side workflows can run concurrently (different ids do not collide)', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 1 });
    // Add a second workflow node to the existing DAG.
    let s = useDagStore.getState().state;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cw2',
      nodeType: 'ComfyUIWorkflow',
      params: {
        presetId: 'stylizedRealism',
        frameStart: 0,
        frameEnd: 1,
        lastGoodFrame: -1,
        outputPath: 'renders/job2/stylized_stylizedRealism',
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'p', socket: 'out' },
      to: { node: 'cw2', socket: 'prompt' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'beauty', socket: 'out' },
      to: { node: 'cw2', socket: 'pass-input' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'cw2', socket: 'time' },
    }).next;
    useDagStore.getState().hydrate(s);

    const a = runWorkflow('cw', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    const b = runWorkflow('cw2', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe('completed');
    expect(rb.status).toBe('completed');
  });

  it('callback-driven dispatch — onFrameComplete writes setParam through useDagStore', async () => {
    seedWorkflowDag({ frameStart: 0, frameEnd: 2 });
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatch');
    await runWorkflow('cw', {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: stubCompiler,
    });
    // Three setParam Ops, one per frame.
    const setParamCalls = dispatchSpy.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'setParam',
    );
    expect(setParamCalls).toHaveLength(3);
    for (const call of setParamCalls) {
      const op = call[0] as { type: string; nodeId: string; paramPath: string };
      expect(op.nodeId).toBe('cw');
      expect(op.paramPath).toBe('lastGoodFrame');
    }
    dispatchSpy.mockRestore();
  });
});
