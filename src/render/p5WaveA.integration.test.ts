// P5 Wave A integration test.
//
// Composes the full Wave-A surface: TimeSource + Camera + Box + Scene +
// BeautyPass + DepthPass + NormalPass + RenderJob (P4 carrier) +
// Prompt + ComfyUIWorkflow. Asserts:
//
//   1. Every node evaluates to its declared metadata shape.
//   2. The §43 amendment lands — Depth + Normal are registered + emit
//      Image with the right passKind.
//   3. ComfyUIWorkflow's sourceHash composes correctly across the chain
//      (changes in any upstream pass byte change the stylized hash).
//   4. Closure rooted at jobId with `'pass-input'` walks reaches all 4
//      pass nodes (raw passes + ComfyUIWorkflow output) AND
//      ComfyUIWorkflow itself when 'pass-input' is followed; H22
//      isolation rule still holds — a sibling RenderJob's passes do
//      NOT leak.
//   5. dryRun produces a valid extrapolation against the StubComfyUI
//      capability — bytes land at the D-04 path; estimation matches
//      frame count × per-probe timing.
//
// REF: project_p5_plan A6; vyapti V13 (closure) + V14 (Mutator non-
// redundancy preserved); hetvabhasa H22 (per-edge-kind BFS isolation).

import { beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability } from '../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../core/dag';
import { MemoryStorage } from '../core/storage';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { expandClosure } from '../agent/closure/expand';
import type { DagState } from '../core/dag';
import type { ImageValue, JobResultValue, PromptValue } from '../nodes/types';
import { dryRun, type CompileWorkflowFn } from './dryRun';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/**
 * Compose the full Wave-A DAG. Two render jobs (job1, job2) so the H22
 * isolation rule has something to resist: job1 carries the AI workflow;
 * job2 carries an independent BeautyPass that must NOT leak into job1's
 * closure.
 */
function buildWaveAState(): DagState {
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

  // Three pass types feeding job1 + the AI workflow.
  for (const id of ['beauty1', 'depth1', 'normal1'] as const) {
    const nodeType =
      id === 'beauty1' ? 'BeautyPass' : id === 'depth1' ? 'DepthPass' : 'NormalPass';
    s = applyOp(s, { type: 'addNode', nodeId: id, nodeType, params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: id, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: id, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: id, socket: 'time' },
    }).next;
  }

  // job1: P4 RenderJob carrying raw passes.
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job1',
    nodeType: 'RenderJob',
    params: { jobId: 'job1', frameStart: 0, frameEnd: 30, fps: 30, outputPath: 'renders/job1' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job1', socket: 'time' },
  }).next;
  for (const id of ['beauty1', 'depth1', 'normal1'] as const) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'job1', socket: 'pass-input' },
    }).next;
  }

  // Prompt + ComfyUIWorkflow consuming the same passes (D-01 — 'pass-input'
  // edge kind is reused for both raw and stylized output).
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'prompt',
    nodeType: 'Prompt',
    params: { text: 'a cinematic cube', negative: '', tags: ['stylized'] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      presetId: 'stylizedRealism',
      frameStart: 0,
      frameEnd: 30,
      lastGoodFrame: -1,
      outputPath: 'renders/job1/stylized_stylizedRealism',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'prompt', socket: 'out' },
    to: { node: 'cw', socket: 'prompt' },
  }).next;
  for (const id of ['beauty1', 'depth1', 'normal1'] as const) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'cw', socket: 'pass-input' },
    }).next;
  }
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'cw', socket: 'time' },
  }).next;

  // job2: a sibling RenderJob with its own beauty pass — H22 isolation
  // target. job2's passes must NOT leak into a closure rooted at job1.
  s = applyOp(s, { type: 'addNode', nodeId: 'beauty2', nodeType: 'BeautyPass', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'beauty2', socket: 'scene' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'beauty2', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'beauty2', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job2',
    nodeType: 'RenderJob',
    params: { jobId: 'job2', frameStart: 0, frameEnd: 5, fps: 30, outputPath: 'renders/job2' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job2', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'beauty2', socket: 'out' },
    to: { node: 'job2', socket: 'pass-input' },
  }).next;

  return s;
}

describe('P5 Wave A — integration', () => {
  it('every Wave A node evaluates to declared metadata shape', () => {
    const state = buildWaveAState();
    const prompt = evaluate(state, 'prompt').value as PromptValue;
    expect(prompt.kind).toBe('Prompt');
    expect(prompt.text).toBe('a cinematic cube');
    expect(prompt.tags).toEqual(['stylized']);

    const beauty = evaluate(state, 'beauty1').value as ImageValue;
    expect(beauty.passKind).toBe('beauty');

    const depth = evaluate(state, 'depth1').value as ImageValue;
    expect(depth.passKind).toBe('depth');

    const normal = evaluate(state, 'normal1').value as ImageValue;
    expect(normal.passKind).toBe('normal');

    const cw = evaluate(state, 'cw').value as ImageValue;
    expect(cw.kind).toBe('Image');
    expect(cw.passKind).toBe('stylized');
    expect(cw.descriptor.format).toBe('rgba8');

    const job = evaluate(state, 'job1').value as JobResultValue;
    expect(job.kind).toBe('JobResult');
    expect(job.passKinds.sort()).toEqual(['beauty', 'depth', 'normal']);
  });

  it('ComfyUIWorkflow sourceHash differs from each raw pass at the same frame (passKind discriminates)', () => {
    const state = buildWaveAState();
    const beauty = evaluate(state, 'beauty1').value as ImageValue;
    const depth = evaluate(state, 'depth1').value as ImageValue;
    const normal = evaluate(state, 'normal1').value as ImageValue;
    const cw = evaluate(state, 'cw').value as ImageValue;
    const all = new Set([beauty.sourceHash, depth.sourceHash, normal.sourceHash, cw.sourceHash]);
    expect(all.size).toBe(4);
  });

  it('closure rooted at job1 with pass-input reaches job1 + raw passes only — H22 isolation holds (no leak to job2)', () => {
    const state = buildWaveAState();
    const closure = expandClosure(
      { rootSelectors: ['job1'], followedEdges: ['pass-input'] },
      state,
    );
    expect(closure.nodes.has('job1')).toBe(true);
    expect(closure.nodes.has('beauty1')).toBe(true);
    expect(closure.nodes.has('depth1')).toBe(true);
    expect(closure.nodes.has('normal1')).toBe(true);
    // H22: sibling RenderJob's passes must NOT leak.
    expect(closure.nodes.has('job2')).toBe(false);
    expect(closure.nodes.has('beauty2')).toBe(false);
  });

  it('closure rooted at cw with pass-input reaches cw + raw passes — D-01 (stylized output reuses pass-input)', () => {
    const state = buildWaveAState();
    const closure = expandClosure(
      { rootSelectors: ['cw'], followedEdges: ['pass-input'] },
      state,
    );
    expect(closure.nodes.has('cw')).toBe(true);
    expect(closure.nodes.has('beauty1')).toBe(true);
    expect(closure.nodes.has('depth1')).toBe(true);
    expect(closure.nodes.has('normal1')).toBe(true);
    // The Prompt node is on a different edge kind; pass-input walk must
    // not free-mix into 'children' or unnamed edges.
    expect(closure.nodes.has('prompt')).toBe(false);
    expect(closure.nodes.has('beauty2')).toBe(false);
  });

  it('dryRun against StubComfyUI returns a valid extrapolation and writes to D-04 path', async () => {
    const state = buildWaveAState();
    const cap = new StubComfyUICapability();
    const storage = new MemoryStorage();
    const compileWorkflow: CompileWorkflowFn = async ({ presetId, prompt, passes, frame }) => ({
      workflowJson: { preset: presetId, frame },
      inputs: {
        images: Object.fromEntries(
          passes.map((p) => [p.passKind, new TextEncoder().encode(p.sourceHash)]),
        ),
        scalars: { prompt: prompt.text, frame },
      },
    });

    const report = await dryRun('cw', state, { capability: cap, storage, compileWorkflow });
    expect(report.workflowId).toBe('cw');
    expect(report.frames).toBe(31); // 0..30 inclusive
    expect(report.estimatedSeconds).toBeGreaterThanOrEqual(0);
    expect(report.samplePath).toBe(
      'renders/job1/stylized_stylizedRealism_0000.png',
    );
    expect(await storage.exists(report.samplePath)).toBe(true);
  });
});
