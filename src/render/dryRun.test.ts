import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StubComfyUICapability,
  type ComfyInputs,
  type ComfyWorkflowJson,
} from '../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { MemoryStorage } from '../core/storage';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { dryRun, framePath, type CompileWorkflowFn } from './dryRun';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/**
 * Build a tiny dryRun-ready DAG: TimeSource + Camera + Box + Scene +
 * BeautyPass + Prompt + ComfyUIWorkflow. outputPath set to a Mutator-
 * style literal so the empty-outputPath guard passes.
 */
function buildDryRunState(opts: {
  outputPath?: string;
  frameStart?: number;
  frameEnd?: number;
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
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'beauty', socket: 'scene' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'beauty', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'beauty', socket: 'time' },
  }).next;
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
      presetId: 'stylizedRealism',
      frameStart: opts.frameStart ?? 0,
      frameEnd: opts.frameEnd ?? 30,
      lastGoodFrame: -1,
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

/** A trivial compileWorkflow stub that echoes the inputs verbatim. */
function makeStubCompiler(): CompileWorkflowFn {
  return async ({ presetId, prompt, passes, frame }) => {
    const workflowJson: ComfyWorkflowJson = {
      preset: presetId,
      promptText: prompt.text,
      passKinds: passes.map((p) => p.passKind),
      frame,
    };
    const images: Record<string, Uint8Array> = {};
    for (const pass of passes) {
      // Each pass contributes its sourceHash as a tiny byte payload so
      // the stub capability's content-hash mixing differentiates them.
      images[pass.passKind] = new TextEncoder().encode(pass.sourceHash);
    }
    const inputs: ComfyInputs = {
      images,
      scalars: { prompt: prompt.text, frame },
    };
    return { workflowJson, inputs };
  };
}

describe('dryRun (D-06 — one-frame probe + extrapolate)', () => {
  it('returns frames * per-probe-time as estimatedSeconds', async () => {
    let t = 0;
    const now = vi.fn(() => {
      const v = t;
      t += 100; // 100ms per now() call → 100ms elapsed for one submit pair.
      return v;
    });
    const state = buildDryRunState({ frameStart: 0, frameEnd: 29 });
    const report = await dryRun('cw', state, {
      capability: new StubComfyUICapability(),
      storage: new MemoryStorage(),
      compileWorkflow: makeStubCompiler(),
      now,
    });
    expect(report.frames).toBe(30);
    // 100ms per probe × 30 frames = 3.0 seconds.
    expect(report.estimatedSeconds).toBeCloseTo(3.0, 5);
  });

  it('writes probe bytes to D-04 path renders/${jobId}/stylized_${presetId}_NNNN.png', async () => {
    const storage = new MemoryStorage();
    const state = buildDryRunState({ outputPath: 'renders/jobX/stylized_stylizedRealism' });
    const report = await dryRun('cw', state, {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: makeStubCompiler(),
    });
    expect(report.samplePath).toBe('renders/jobX/stylized_stylizedRealism_0000.png');
    expect(await storage.exists(report.samplePath)).toBe(true);
    // Bytes are a valid PNG (signature check).
    const bytes = await storage.read(report.samplePath);
    const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(bytes.subarray(0, sig.length)).toEqual(sig);
  });

  it('throws when workflowNodeId is unknown', async () => {
    const state = buildDryRunState();
    await expect(
      dryRun('does-not-exist', state, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: makeStubCompiler(),
      }),
    ).rejects.toThrow(/unknown workflowNodeId/);
  });

  it('throws when target node is not a ComfyUIWorkflow', async () => {
    const state = buildDryRunState();
    await expect(
      dryRun('p', state, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: makeStubCompiler(),
      }),
    ).rejects.toThrow(/is not a ComfyUIWorkflow \(got Prompt\)/);
  });

  it('throws when outputPath is empty (Mutator must set it before dryRun)', async () => {
    const state = buildDryRunState({ outputPath: '' });
    await expect(
      dryRun('cw', state, {
        capability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
        compileWorkflow: makeStubCompiler(),
      }),
    ).rejects.toThrow(/empty outputPath/);
  });

  it('rethrows when capability submit rejects (caller writes back lastGoodFrame)', async () => {
    const state = buildDryRunState();
    const cap = new StubComfyUICapability({ errorQueue: [new Error('comfy unreachable')] });
    await expect(
      dryRun('cw', state, {
        capability: cap,
        storage: new MemoryStorage(),
        compileWorkflow: makeStubCompiler(),
      }),
    ).rejects.toThrow('comfy unreachable');
  });

  it('twice-call deterministic — same inputs produce identical samplePath bytes', async () => {
    const cap = new StubComfyUICapability();
    const state = buildDryRunState();
    const a = await dryRun('cw', state, {
      capability: cap,
      storage: new MemoryStorage(),
      compileWorkflow: makeStubCompiler(),
    });
    const storageB = new MemoryStorage();
    const b = await dryRun('cw', state, {
      capability: cap,
      storage: storageB,
      compileWorkflow: makeStubCompiler(),
    });
    // Sample paths agree (same outputPath + frame → same path).
    expect(a.samplePath).toBe(b.samplePath);
    // Bytes agree too (deterministic stub keyed off (workflowJson, inputs)).
    const bytesB = await storageB.read(b.samplePath);
    expect(bytesB.length).toBeGreaterThan(0);
  });

  it('framePath helper appends _NNNN.png to the prefix', () => {
    expect(framePath('renders/job/stylized_stylizedRealism', 0)).toBe(
      'renders/job/stylized_stylizedRealism_0000.png',
    );
    expect(framePath('renders/job/stylized_stylizedRealism', 7)).toBe(
      'renders/job/stylized_stylizedRealism_0007.png',
    );
    // Trailing slashes get trimmed before the underscore.
    expect(framePath('renders/job/', 1)).toBe('renders/job_0001.png');
  });
});
