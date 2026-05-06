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
  it('registers all four tools', () => {
    registerAllTools();
    const tools = listTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'camera.snapshot',
      'character.walkTo',
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
  state = applyOp(state, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} })
    .next;
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
    expect(result1).toEqual(result2);
    expect(result1.length).toBeGreaterThanOrEqual(2); // at least addNode + connect

    // Every element is a valid Op shape
    for (const op of result1) {
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
    const { 'nav': _removed, ...rest } = state.nodes;
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

    expect(result1).toEqual(result2);
    // Should disconnect old + addNode + connect new = 3 ops
    expect(result1).toHaveLength(3);
    expect(result1[0].type).toBe('disconnect');
    expect(result1[1].type).toBe('addNode');
    expect(result1[2].type).toBe('connect');
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

    expect(result1).toEqual(result2);
    expect(result1).toHaveLength(2);
    expect(result1[0].type).toBe('addNode');
    expect(result1[1].type).toBe('connect');
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
    expect(result1.length).toBe(6);
    expect(result2.length).toBe(6);

    // Structure: addNode gltf → addNode transform → connect → addNode group → connect → connect
    const types1 = result1.map((o) => o.type);
    expect(types1).toEqual([
      'addNode',
      'addNode',
      'connect',
      'addNode',
      'connect',
      'connect',
    ]);

    // The second result is structurally identical
    const types2 = result2.map((o) => o.type);
    expect(types2).toEqual(types1);

    // Each connect references ids from preceding addNode calls
    const gltfId = (result1[0] as { nodeId: string }).nodeId;
    const txId = (result1[1] as { nodeId: string }).nodeId;
    const grpId = (result1[3] as { nodeId: string }).nodeId;
    const connect1 = result1[2] as { from: { node: string }; to: { node: string } };
    const connect2 = result1[4] as { from: { node: string }; to: { node: string } };
    const connect3 = result1[5] as { from: { node: string }; to: { node: string } };

    expect(connect1.from.node).toBe(gltfId);
    expect(connect1.to.node).toBe(txId);
    expect(connect2.from.node).toBe(txId);
    expect(connect2.to.node).toBe(grpId);
    expect(connect3.from.node).toBe(grpId);
    expect(connect3.to.node).toBe('scene');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() =>
      libraryImportTool.handler({ assetRef: 'assets/cube.gltf' }, ctx),
    ).toThrow('no Scene output');
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
    expect(result1.length).toBe(result2.length);
    const types1 = result1.map((o) => o.type);
    const types2 = result2.map((o) => o.type);
    expect(types2).toEqual(types1);

    // addNode(Cube) + connect → scene.children = 2 ops
    expect(result1).toHaveLength(2);
    expect(result1[0].type).toBe('addNode');
    expect(result1[1].type).toBe('connect');
    // The same nodeType in both calls
    expect((result1[0] as { nodeType: string }).nodeType).toBe('BoxMesh');
    expect((result2[0] as { nodeType: string }).nodeType).toBe('BoxMesh');
  });

  it('returns Op[] for a PointLight with no connect (twice-call — structural check)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);
    const result2 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);

    expect(result1.length).toBe(result2.length);
    const types1 = result1.map((o) => o.type);
    const types2 = result2.map((o) => o.type);
    expect(types2).toEqual(types1);

    // PointLight is a light so it gets connected to scene.lights
    expect(result1).toHaveLength(2);
    expect((result1[0] as { nodeType: string }).nodeType).toBe('PointLight');
  });

  it('returns a single Op for cameras and empties', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result = meshAddTool.handler({ kind: 'Group', position: [0, 0, 0] }, ctx);
    // Group/Transform/PerspectiveCamera have no auto-connect to scene
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('addNode');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() => meshAddTool.handler({ kind: 'Cube', position: [0, 0, 0] }, ctx)).toThrow(
      'no Scene output',
    );
  });
});
