// Tests for agent tool registry and the four first-party tools.
//
// Each tool is tested with a twice-call pattern (THESIS.md §48): same args →
// same Op[] output, proving tool handlers are pure functions of (args, ctx).
//
// REF: vyapti V7 (tool handlers return Op[]), THESIS.md §20.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import {
  registerAllTools,
  getTool,
  listTools,
  __resetToolRegistryForTests,
  characterWalkToTool,
  cameraSnapshotTool,
  libraryImportTool,
  meshAddTool,
  dagInspectTool,
  dagExecTool,
} from './index';
import type { ToolContext } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetToolRegistryForTests();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('tool registry', () => {
  it('registers all twelve tools', () => {
    registerAllTools();
    const tools = listTools();
    expect(tools).toHaveLength(12);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'agent.getStrategy',
      'agent.identify',
      'agent.listMutators',
      'agent.listStrategies',
      'agent.proposePlan',
      'agent.render.summarizePass',
      'camera.snapshot',
      'character.walkTo',
      'dag.exec',
      'dag.inspect',
      'library.import',
      'mesh.add',
    ]);
  });

  it('refuses duplicate registration', () => {
    registerAllTools();
    expect(() => registerAllTools()).toThrow('Tool already registered: character.walkTo');
  });

  it('getTool returns undefined for missing tools', () => {
    expect(getTool('nonexistent')).toBeUndefined();
  });

  it('all tools have a non-empty paramSchema', () => {
    registerAllTools();
    for (const tool of listTools()) {
      expect(tool.paramSchema).toBeDefined();
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// character.walkTo
// ---------------------------------------------------------------------------

function buildBaselineCharacter(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  state = applyOp(state, { type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'clip',
    nodeType: 'AnimationClip',
    params: { name: 'walk', duration: 1, loop: true, keyframes: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'nav',
    nodeType: 'Navmesh',
    params: { halfSize: [10, 10], obstacles: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'loco',
    nodeType: 'LocomotionState',
    params: { speed: 1, loop: true },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'char',
    nodeType: 'Character',
    params: { name: 'alice' },
  }).next;
  // Wire skeleton → clip → loco → char
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'sk', socket: 'out' },
    to: { node: 'clip', socket: 'skeleton' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'clip', socket: 'out' },
    to: { node: 'loco', socket: 'clip' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'loco', socket: 'out' },
    to: { node: 'char', socket: 'locomotion' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'loco', socket: 'time' },
  }).next;
  return state;
}

describe('character.walkTo tool', () => {
  it('returns Op[] for a valid character + world point (twice-call)', () => {
    const ctx: ToolContext = { dagState: buildBaselineCharacter() };

    const result1 = characterWalkToTool.handler(
      { characterId: 'char', worldPoint: [5, 0, 3] },
      ctx,
    );
    const result2 = characterWalkToTool.handler(
      { characterId: 'char', worldPoint: [5, 0, 3] },
      ctx,
    );

    // Same inputs → same Op[] — pure function proof
    expect(result1.ops).toEqual(result2.ops);
    expect(result1.ops.length).toBeGreaterThanOrEqual(2); // at least addNode + connect

    // Every element is a valid Op shape
    for (const op of result1.ops) {
      expect(op).toMatchObject({ type: expect.any(String) });
    }
  });

  it('throws for missing character', () => {
    const ctx: ToolContext = { dagState: buildBaselineCharacter() };
    expect(() =>
      characterWalkToTool.handler({ characterId: 'nonexistent', worldPoint: [1, 0, 1] }, ctx),
    ).toThrow('character not found');
  });

  it('throws for missing navmesh', () => {
    const state = buildBaselineCharacter();
    // Remove the navmesh
    const { nav: _removed, ...rest } = state.nodes;
    void _removed;
    const ctx: ToolContext = { dagState: { ...state, nodes: rest } };
    expect(() =>
      characterWalkToTool.handler({ characterId: 'char', worldPoint: [1, 0, 1] }, ctx),
    ).toThrow('missing Navmesh');
  });
});

// ---------------------------------------------------------------------------
// camera.snapshot
// ---------------------------------------------------------------------------

function buildSceneWithCamera(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'scene',
    nodeType: 'Scene',
    params: {},
  }).next;
  // Wire scene as the active output
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, near: 0.1, far: 1000, position: [3, 2, 3], lookAt: [0, 0, 0] },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  // Also wire a render output
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  // Set the scene output
  state = {
    ...state,
    outputs: { ...state.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return state;
}

describe('camera.snapshot tool', () => {
  it('returns Op[] that replaces an existing camera (twice-call)', () => {
    const ctx: ToolContext = { dagState: buildSceneWithCamera() };

    const result1 = cameraSnapshotTool.handler(
      { fov: 60, position: [5, 3, 5], lookAt: [0, 0, 0] },
      ctx,
    );
    const result2 = cameraSnapshotTool.handler(
      { fov: 60, position: [5, 3, 5], lookAt: [0, 0, 0] },
      ctx,
    );

    expect(result1.ops).toEqual(result2.ops);
    // Should disconnect old + addNode + connect new = 3 ops
    expect(result1.ops).toHaveLength(3);
    expect(result1.ops[0].type).toBe('disconnect');
    expect(result1.ops[1].type).toBe('addNode');
    expect(result1.ops[2].type).toBe('connect');
  });

  it('returns Op[] with just addNode + connect when no camera is wired (twice-call)', () => {
    const state = buildSceneWithCamera();
    // Remove the existing camera connection
    const sceneNode = state.nodes['scene'];
    const { camera: _cam, ...restInputs } = sceneNode.inputs;
    void _cam;
    state.nodes['scene'] = { ...sceneNode, inputs: restInputs };
    const ctx: ToolContext = { dagState: state };

    const result1 = cameraSnapshotTool.handler(
      { fov: 45, position: [3, 3, 3], lookAt: [0, 0, 0] },
      ctx,
    );
    const result2 = cameraSnapshotTool.handler(
      { fov: 45, position: [3, 3, 3], lookAt: [0, 0, 0] },
      ctx,
    );

    expect(result1.ops).toEqual(result2.ops);
    expect(result1.ops).toHaveLength(2);
    expect(result1.ops[0].type).toBe('addNode');
    expect(result1.ops[1].type).toBe('connect');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() =>
      cameraSnapshotTool.handler({ fov: 45, position: [0, 0, 0], lookAt: [0, 0, 0] }, ctx),
    ).toThrow('no Scene output');
  });
});

// ---------------------------------------------------------------------------
// library.import
// ---------------------------------------------------------------------------

function buildSceneBaseline(): DagState {
  let state = emptyDagState();
  state = applyOp(state, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  state = {
    ...state,
    outputs: { ...state.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return state;
}

describe('library.import tool', () => {
  it('returns the 6-op drop chain (twice-call)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = libraryImportTool.handler(
      { assetRef: 'assets/cube.gltf', position: [1, 0, 1] },
      ctx,
    );
    const result2 = libraryImportTool.handler(
      { assetRef: 'assets/cube.gltf', position: [1, 0, 1] },
      ctx,
    );

    // Twice-call check: same args → same shape (ids contain randomness, so
    // we verify structural equality of types and connections instead of deep equality)
    expect(result1.ops.length).toBe(6);
    expect(result2.ops.length).toBe(6);

    // Structure: addNode gltf → addNode transform → connect → addNode group → connect → connect
    const types1 = result1.ops.map((o) => o.type);
    expect(types1).toEqual(['addNode', 'addNode', 'connect', 'addNode', 'connect', 'connect']);

    // The second result is structurally identical
    const types2 = result2.ops.map((o) => o.type);
    expect(types2).toEqual(types1);

    // Each connect references ids from preceding addNode calls
    const gltfId = (result1.ops[0] as { nodeId: string }).nodeId;
    const txId = (result1.ops[1] as { nodeId: string }).nodeId;
    const grpId = (result1.ops[3] as { nodeId: string }).nodeId;
    const connect1 = result1.ops[2] as { from: { node: string }; to: { node: string } };
    const connect2 = result1.ops[4] as { from: { node: string }; to: { node: string } };
    const connect3 = result1.ops[5] as { from: { node: string }; to: { node: string } };

    expect(connect1.from.node).toBe(gltfId);
    expect(connect1.to.node).toBe(txId);
    expect(connect2.from.node).toBe(txId);
    expect(connect2.to.node).toBe(grpId);
    expect(connect3.from.node).toBe(grpId);
    expect(connect3.to.node).toBe('scene');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() => libraryImportTool.handler({ assetRef: 'assets/cube.gltf' }, ctx)).toThrow(
      'no Scene output',
    );
  });
});

// ---------------------------------------------------------------------------
// mesh.add
// ---------------------------------------------------------------------------

describe('mesh.add tool', () => {
  it('returns Op[] for a Cube (twice-call — structural check)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = meshAddTool.handler({ kind: 'Cube', position: [0, 1, 0] }, ctx);
    const result2 = meshAddTool.handler({ kind: 'Cube', position: [0, 1, 0] }, ctx);

    // IDs are random so we check structural equality
    expect(result1.ops.length).toBe(result2.ops.length);
    const types1 = result1.ops.map((o) => o.type);
    const types2 = result2.ops.map((o) => o.type);
    expect(types2).toEqual(types1);

    // addNode(Cube) + connect → scene.children = 2 ops
    expect(result1.ops).toHaveLength(2);
    expect(result1.ops[0].type).toBe('addNode');
    expect(result1.ops[1].type).toBe('connect');
    // The same nodeType in both calls
    expect((result1.ops[0] as { nodeType: string }).nodeType).toBe('BoxMesh');
    expect((result2.ops[0] as { nodeType: string }).nodeType).toBe('BoxMesh');
  });

  it('returns Op[] for a PointLight with no connect (twice-call — structural check)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);
    const result2 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);

    expect(result1.ops.length).toBe(result2.ops.length);
    const types1 = result1.ops.map((o) => o.type);
    const types2 = result2.ops.map((o) => o.type);
    expect(types2).toEqual(types1);

    // PointLight is a light so it gets connected to scene.lights
    expect(result1.ops).toHaveLength(2);
    expect((result1.ops[0] as { nodeType: string }).nodeType).toBe('PointLight');
  });

  it('returns a single Op for cameras and empties', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result = meshAddTool.handler({ kind: 'Group', position: [0, 0, 0] }, ctx);
    // Group/Transform/PerspectiveCamera have no auto-connect to scene
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].type).toBe('addNode');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() => meshAddTool.handler({ kind: 'Cube', position: [0, 0, 0] }, ctx)).toThrow(
      'no Scene output',
    );
  });
});

// ---------------------------------------------------------------------------
// dag.inspect
// ---------------------------------------------------------------------------

describe('dag.inspect tool', () => {
  let baseCtx: ToolContext;

  beforeEach(() => {
    baseCtx = { dagState: buildSceneBaseline() };
  });

  it('returns text for scope=all', () => {
    const result = dagInspectTool.handler({ scope: 'all' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('nodeCount');
    expect(result.text).toContain('Scene');
  });

  it('returns text for scope=node with valid nodeId', () => {
    const result = dagInspectTool.handler({ scope: 'node', nodeId: 'scene' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('"Scene"');
  });

  it('returns error for scope=node with missing nodeId', () => {
    const result = dagInspectTool.handler({ scope: 'node', nodeId: 'nonexistent' }, baseCtx);
    expect(result.text).toContain('not found');
  });

  it('returns types list for scope=types', () => {
    const result = dagInspectTool.handler({ scope: 'types' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('BoxMesh');
    expect(result.text).toContain('Scene');
  });

  it('returns outputs for scope=output', () => {
    const result = dagInspectTool.handler({ scope: 'output' }, baseCtx);
    expect(result.text).toContain('scene');
  });
});

// ---------------------------------------------------------------------------
// dag.exec
// ---------------------------------------------------------------------------

describe('dag.exec tool', () => {
  it('returns the ops unchanged in a tool result', () => {
    const ops: import('../../core/dag/types').Op[] = [
      { type: 'addNode', nodeId: 'test', nodeType: 'BoxMesh', params: {} },
    ];
    const result = dagExecTool.handler(
      { description: 'add test cube', ops },
      { dagState: emptyDagState() },
    );
    expect(result.ops).toEqual(ops);
    expect(result.text).toContain('add test cube');
  });

  it('rejects empty ops array via zod', () => {
    const parsed = dagExecTool.paramSchema.safeParse({
      description: 'empty',
      ops: [],
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 Wave C — agent.render.summarizePass
// ---------------------------------------------------------------------------

import { renderSummarizePassTool } from './renderSummarizePass';

function buildJobScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
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
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: { jobId: 'jobA', frameStart: 0, frameEnd: 60, fps: 30, outputPath: 'renders/jobA' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job', socket: 'time' },
  }).next;
  for (const [passId, nodeType] of [
    ['beauty', 'BeautyPass'],
    ['idp', 'IDPass'],
  ] as const) {
    s = applyOp(s, { type: 'addNode', nodeId: passId, nodeType, params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: passId, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: passId, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: passId, socket: 'time' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: passId, socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    }).next;
  }
  return s;
}

describe('agent.render.summarizePass tool', () => {
  it('returns descriptor + sourceHash + storage path for a beauty pass at frame 0', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 0 }, ctx);
    expect(r.ops).toHaveLength(0);
    expect(r.text).toBeTruthy();
    const summary = JSON.parse(r.text!);
    expect(summary.jobId).toBe('jobA');
    expect(summary.passId).toBe('beauty');
    expect(summary.passKind).toBe('beauty');
    expect(summary.frame).toBe(0);
    expect(summary.fps).toBe(30);
    expect(summary.descriptor.format).toBe('rgba8');
    expect(summary.outputPath).toBe('renders/jobA/beauty_0000.png');
    expect(summary.sourceHash).toMatch(/^[0-9a-f]{8}$/);
    expect(summary.ambiguous).toBe(false);
  });

  it('sourceHash flips between frames at different times', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const f0 = JSON.parse(
      renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 0 }, ctx).text!,
    );
    const f30 = JSON.parse(
      renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 30 }, ctx).text!,
    );
    expect(f0.sourceHash).not.toBe(f30.sourceHash);
    expect(f30.outputPath).toBe('renders/jobA/beauty_0030.png');
  });

  it('id pass returns rgba16f format', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'job', passKind: 'id', frame: 0 }, ctx);
    const summary = JSON.parse(r.text!);
    expect(summary.passKind).toBe('id');
    expect(summary.descriptor.format).toBe('rgba16f');
    expect(summary.outputPath).toBe('renders/jobA/id_0000.png');
  });

  it('errors when jobId is unknown', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'nope', passKind: 'beauty', frame: 0 }, ctx);
    expect(r.text).toContain('not found');
  });

  it('errors when no pass of the requested kind is connected', () => {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'job',
      nodeType: 'RenderJob',
      params: { jobId: 'lonely' },
    }).next;
    const r = renderSummarizePassTool.handler(
      { jobId: 'job', passKind: 'beauty', frame: 0 },
      { dagState: s },
    );
    expect(r.text).toContain('no passes connected');
  });
});
