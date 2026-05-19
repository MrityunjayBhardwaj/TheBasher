import { beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability } from '../../core/comfy';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../../core/dag';
import { MemoryStorage } from '../../core/storage';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { renderDryRunWorkflowTool } from './renderDryRunWorkflow';
import { renderSummarizeStylizedTool } from './renderSummarizeStylized';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildAiRenderState() {
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
  for (const [id, nodeType] of [
    ['beauty', 'BeautyPass'],
    ['depth', 'DepthPass'],
    ['normal', 'NormalPass'],
  ] as const) {
    s = applyOp(s, { type: 'addNode', nodeId: id, nodeType, params: {} }).next;
    for (const wire of [
      { from: 'scene', to: ['', 'scene'] },
      { from: 'cam', to: ['', 'camera'] },
      { from: 'time', to: ['', 'time'] },
    ] as const) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: wire.from, socket: 'out' },
        to: { node: id, socket: wire.to[1] },
      }).next;
    }
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
      presetId: 'stylizedRealism',
      frameStart: 0,
      frameEnd: 9,
      lastGoodFrame: -1,
      outputPath: 'renders/job1/stylized_stylizedRealism',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'p', socket: 'out' },
    to: { node: 'cw', socket: 'prompt' },
  }).next;
  for (const id of ['beauty', 'depth', 'normal'] as const) {
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
  return s;
}

async function seedRawPasses(storage: MemoryStorage, frame: number) {
  const padded = frame.toString().padStart(4, '0');
  await storage.write(`renders/job1/beauty_${padded}.png`, new TextEncoder().encode(`b${frame}`));
  await storage.write(`renders/job1/depth_${padded}.png`, new TextEncoder().encode(`d${frame}`));
  await storage.write(`renders/job1/normal_${padded}.png`, new TextEncoder().encode(`n${frame}`));
}

describe('agent.render.dryRunWorkflow', () => {
  it('returns extrapolation as JSON', async () => {
    const storage = new MemoryStorage();
    await seedRawPasses(storage, 0);
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'cw' },
      {
        dagState: buildAiRenderState(),
        comfyCapability: new StubComfyUICapability(),
        storage,
      },
    );
    expect(result.ops).toEqual([]);
    const parsed = JSON.parse(result.text!) as {
      workflowId: string;
      frames: number;
      estimatedSeconds: number;
      samplePath: string;
    };
    expect(parsed.workflowId).toBe('cw');
    expect(parsed.frames).toBe(10);
    expect(parsed.samplePath).toBe('renders/job1/stylized_stylizedRealism_0000.png');
  });

  it('returns Error text (not throw) when capability is missing', async () => {
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'cw' },
      { dagState: buildAiRenderState(), storage: new MemoryStorage() },
    );
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(/no ComfyUI capability/);
  });

  it('returns Error text when storage is missing', async () => {
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'cw' },
      { dagState: buildAiRenderState(), comfyCapability: new StubComfyUICapability() },
    );
    expect(result.text).toMatch(/no storage capability/);
  });

  it('returns Error text when workflowNodeId is unknown', async () => {
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'nope' },
      {
        dagState: buildAiRenderState(),
        comfyCapability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
      },
    );
    expect(result.text).toMatch(/workflowNodeId "nope" not found/);
  });

  it('returns Error text when target node is not a ComfyUIWorkflow', async () => {
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'p' },
      {
        dagState: buildAiRenderState(),
        comfyCapability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
      },
    );
    expect(result.text).toMatch(/expected a ComfyUIWorkflow/);
  });

  it('returns Error text when dryRun rejects (e.g. raw passes missing)', async () => {
    // Storage has NO raw passes seeded.
    const result = await renderDryRunWorkflowTool.handler(
      { workflowNodeId: 'cw' },
      {
        dagState: buildAiRenderState(),
        comfyCapability: new StubComfyUICapability(),
        storage: new MemoryStorage(),
      },
    );
    expect(result.text).toMatch(/dryRun failed/);
  });
});

describe('agent.render.summarizeStylized', () => {
  it('reports bytesPresent: false when bytes do not exist on disk yet', async () => {
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'cw', frame: 0 },
      { dagState: buildAiRenderState(), storage: new MemoryStorage() },
    );
    expect(result.ops).toEqual([]);
    const parsed = JSON.parse(result.text!) as {
      workflowId: string;
      presetId: string;
      frame: number;
      sourceHash: string;
      outputPath: string;
      bytesPresent: boolean;
      lastGoodFrame: number;
    };
    expect(parsed.workflowId).toBe('cw');
    expect(parsed.presetId).toBe('stylizedRealism');
    expect(parsed.frame).toBe(0);
    expect(parsed.outputPath).toBe('renders/job1/stylized_stylizedRealism_0000.png');
    expect(parsed.bytesPresent).toBe(false);
    expect(parsed.lastGoodFrame).toBe(-1);
    expect(parsed.sourceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reports bytesPresent: true when bytes exist at the D-04 path', async () => {
    const storage = new MemoryStorage();
    await storage.write(
      'renders/job1/stylized_stylizedRealism_0005.png',
      new Uint8Array([1, 2, 3]),
    );
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'cw', frame: 5 },
      { dagState: buildAiRenderState(), storage },
    );
    const parsed = JSON.parse(result.text!) as { bytesPresent: boolean };
    expect(parsed.bytesPresent).toBe(true);
  });

  it('reflects current lastGoodFrame from DAG params (resume progress)', async () => {
    let s = buildAiRenderState();
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'cw',
      paramPath: 'lastGoodFrame',
      value: 7,
    }).next;
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'cw', frame: 8 },
      { dagState: s, storage: new MemoryStorage() },
    );
    const parsed = JSON.parse(result.text!) as { lastGoodFrame: number };
    expect(parsed.lastGoodFrame).toBe(7);
  });

  it('returns Error text when workflowNodeId is unknown', async () => {
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'nope', frame: 0 },
      { dagState: buildAiRenderState(), storage: new MemoryStorage() },
    );
    expect(result.text).toMatch(/workflowNodeId "nope" not found/);
  });

  it('returns Error text when target node is not a ComfyUIWorkflow', async () => {
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'beauty', frame: 0 },
      { dagState: buildAiRenderState(), storage: new MemoryStorage() },
    );
    expect(result.text).toMatch(/expected a ComfyUIWorkflow/);
  });

  it('works without storage capability (bytesPresent silently false)', async () => {
    const result = await renderSummarizeStylizedTool.handler(
      { workflowNodeId: 'cw', frame: 0 },
      { dagState: buildAiRenderState() },
    );
    const parsed = JSON.parse(result.text!) as { bytesPresent: boolean };
    expect(parsed.bytesPresent).toBe(false);
  });
});
