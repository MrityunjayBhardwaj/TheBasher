import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  evaluate,
  listNodeTypes,
  topoSort,
  applyOp,
  emptyDagState,
} from '../core/dag';
import { buildDefaultDagState, buildDefaultProject } from '../core/project/default';
import { ProjectSchema } from '../core/project/schema';
import { __reseedAllNodesForTests, registerAllNodes } from './registerAll';
import { SCATTER_MAX } from './ScatterNode';
import type {
  GroupValue,
  MaterialOverrideValue,
  RenderOutputValue,
  ScatterValue,
  SceneValue,
  TransformValue,
} from './types';

const ALL_TYPES = [
  'AmbientLight',
  'AreaLight',
  'BoxMesh',
  'DirectionalLight',
  'GltfAsset',
  'Group',
  'MaterialOverride',
  'OrthographicCamera',
  'PerspectiveCamera',
  'PointLight',
  'RenderOutput',
  'Scatter',
  'Scene',
  'SpotLight',
  'Transform',
];

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('default node registration', () => {
  it('registers all v0.5 P0+P1 node types', () => {
    expect(listNodeTypes().sort()).toEqual(ALL_TYPES);
  });

  it('registerAllNodes is idempotent', () => {
    registerAllNodes();
    registerAllNodes();
    expect(listNodeTypes().length).toBe(ALL_TYPES.length);
  });
});

describe('default project', () => {
  it('builds the THESIS App. C 5-node DAG', () => {
    const state = buildDefaultDagState();
    expect(Object.keys(state.nodes).sort()).toEqual([
      'n_box',
      'n_camera',
      'n_light',
      'n_render',
      'n_scene',
    ]);
    expect(state.outputs.scene).toEqual({ node: 'n_scene', socket: 'out' });
    expect(state.outputs.render).toEqual({ node: 'n_render', socket: 'out' });
  });

  it('topoSort produces dependencies-first order from n_render', () => {
    const state = buildDefaultDagState();
    const order = topoSort(state, 'n_render');
    const idx = (id: string) => order.indexOf(id);
    expect(idx('n_camera')).toBeLessThan(idx('n_scene'));
    expect(idx('n_light')).toBeLessThan(idx('n_scene'));
    expect(idx('n_box')).toBeLessThan(idx('n_scene'));
    expect(idx('n_scene')).toBeLessThan(idx('n_render'));
  });

  it('evaluator returns the expected scene shape', () => {
    const state = buildDefaultDagState();
    const result = evaluate(state, 'n_render');
    const value = result.value as RenderOutputValue;
    expect(value.kind).toBe('RenderOutput');
    expect(value.scene.kind).toBe('Scene');
    expect(value.scene.camera.kind).toBe('PerspectiveCamera');
    expect(value.scene.lights).toHaveLength(1);
    expect(value.scene.children).toHaveLength(1);
    expect(value.postFx.tonemap).toBe('ACES');
    expect(value.postFx.smaa).toBe(true);
  });

  it('serializes through ProjectSchema cleanly', () => {
    const project = buildDefaultProject();
    const parsed = ProjectSchema.parse(project);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.nodeVersions.PerspectiveCamera).toBe(1);
  });
});

describe('determinism harness — V2 twice-eval', () => {
  it('every pure node returns deep-equal output on two evaluations of the same state', () => {
    const state = buildDefaultDagState();
    const r1 = evaluate(state, 'n_render');
    const r2 = evaluate(state, 'n_render');
    expect(r1.hash).toBe(r2.hash);
    expect(r1.value).toEqual(r2.value);
    const v1 = r1.value as RenderOutputValue;
    const v2 = r2.value as RenderOutputValue;
    expect(v1.scene.camera.position).toEqual(v2.scene.camera.position);
    expect(v1.scene.children[0]).toEqual(v2.scene.children[0]);
  });

  it('hash propagates change from leaf to root (cache invalidation chain)', () => {
    const state = buildDefaultDagState();
    const before = evaluate(state, 'n_render').hash;
    const next = {
      ...state,
      nodes: {
        ...state.nodes,
        n_camera: {
          ...state.nodes.n_camera,
          params: {
            ...(state.nodes.n_camera.params as object),
            position: [10, 10, 10] as const,
          },
        },
      },
    };
    const after = evaluate(next, 'n_render').hash;
    expect(after).not.toBe(before);
  });

  it('Scene aggregator passes camera/lights/children through unchanged', () => {
    const state = buildDefaultDagState();
    const sceneVal = (evaluate(state, 'n_render').value as RenderOutputValue).scene as
      | SceneValue
      | undefined;
    expect(sceneVal).toBeDefined();
    const cam = sceneVal!.camera;
    if (cam.kind !== 'PerspectiveCamera') throw new Error('expected PerspectiveCamera');
    expect(cam.fov).toBe(45);
    const light = sceneVal!.lights[0];
    if (light.kind !== 'DirectionalLight') throw new Error('expected DirectionalLight');
    expect(light.intensity).toBeCloseTo(1.1);
    const child = sceneVal!.children[0];
    if (child.kind !== 'BoxMesh') throw new Error('expected BoxMesh');
    expect(child.size).toEqual([1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// P1 — new pure node coverage (V2)
// ---------------------------------------------------------------------------

function buildOne(nodeType: string, params: unknown) {
  let state = emptyDagState();
  state = applyOp(state, { type: 'addNode', nodeId: 'n', nodeType, params }).next;
  return state;
}

describe('P1 new node types — pure twice-eval', () => {
  it.each([
    ['OrthographicCamera', { zoom: 50, position: [0, 0, 5] }],
    ['AmbientLight', { intensity: 0.4 }],
    ['PointLight', { intensity: 1, position: [0, 2, 0] }],
    ['SpotLight', { intensity: 1, position: [0, 5, 0] }],
    ['AreaLight', { intensity: 5, position: [0, 5, 0], width: 2, height: 2 }],
    ['GltfAsset', { assetRef: 'assets/test.glb' }],
    ['Transform', { position: [1, 0, 0] }],
    ['Group', {}],
    [
      'MaterialOverride',
      { name: 'red', color: '#ff0000', roughness: 0.3, metalness: 0.1, opacity: 1 },
    ],
  ])('%s — twice-eval bit-exact', (type, params) => {
    const state = buildOne(type, params);
    const r1 = evaluate(state, 'n');
    const r2 = evaluate(state, 'n');
    expect(r1.hash).toBe(r2.hash);
    expect(r1.value).toEqual(r2.value);
  });
});

// ---------------------------------------------------------------------------
// ScatterNode — determinism + cap
// ---------------------------------------------------------------------------

describe('ScatterNode determinism (V2)', () => {
  function buildScatterState(density: number, seed: number) {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'asset',
      nodeType: 'BoxMesh',
      params: { size: [0.5, 0.5, 0.5] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'scatter',
      nodeType: 'Scatter',
      params: { density, seed, bounds: [4, 0, 4] },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'asset', socket: 'out' },
      to: { node: 'scatter', socket: 'assets' },
    }).next;
    return state;
  }

  it('seed=42 produces the same instance list across evaluations', () => {
    const state = buildScatterState(50, 42);
    const a = evaluate(state, 'scatter').value as ScatterValue;
    const b = evaluate(state, 'scatter').value as ScatterValue;
    expect(a.instances).toEqual(b.instances);
    expect(a.count).toBe(50);
    expect(a.seed).toBe(42);
  });

  it('different seed → different instance list', () => {
    const a = evaluate(buildScatterState(50, 42), 'scatter').value as ScatterValue;
    const b = evaluate(buildScatterState(50, 7), 'scatter').value as ScatterValue;
    expect(a.instances).not.toEqual(b.instances);
    expect(a.count).toBe(b.count);
  });

  it('changing density re-derives placement deterministically', () => {
    const a = evaluate(buildScatterState(20, 42), 'scatter').value as ScatterValue;
    const b = evaluate(buildScatterState(40, 42), 'scatter').value as ScatterValue;
    expect(a.count).toBe(20);
    expect(b.count).toBe(40);
    // First N samples are identical because mulberry32 produces the same
    // sequence for the same seed; density only changes how many we keep.
    for (let i = 0; i < a.count; i++) {
      expect(a.instances[i]).toEqual(b.instances[i]);
    }
  });

  it('rejects density above SCATTER_MAX (V0.5 cap, THESIS.md §53)', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'asset',
      nodeType: 'BoxMesh',
      params: { size: [0.5, 0.5, 0.5] },
    }).next;
    expect(() =>
      applyOp(state, {
        type: 'addNode',
        nodeId: 'scatter',
        nodeType: 'Scatter',
        params: { density: SCATTER_MAX + 1, seed: 1 },
      }),
    ).toThrow();
  });

  it('empty asset list → empty instance list (no crash)', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'scatter',
      nodeType: 'Scatter',
      params: { density: 100, seed: 1 },
    }).next;
    const v = evaluate(state, 'scatter').value as ScatterValue;
    expect(v.count).toBe(0);
    expect(v.instances).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SceneChild recursion — Transform → Group → MaterialOverride composes
// ---------------------------------------------------------------------------

describe('SceneChild recursion', () => {
  it('Transform wraps a child mesh', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'box',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'tx',
      nodeType: 'Transform',
      params: { position: [2, 0, 0] },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'tx', socket: 'target' },
    }).next;
    const v = evaluate(state, 'tx').value as TransformValue;
    expect(v.kind).toBe('Transform');
    expect(v.position).toEqual([2, 0, 0]);
    expect(v.child?.kind).toBe('BoxMesh');
  });

  it('Group flattens a child list', () => {
    let state = emptyDagState();
    for (const id of ['a', 'b']) {
      state = applyOp(state, {
        type: 'addNode',
        nodeId: id,
        nodeType: 'BoxMesh',
        params: { size: [1, 1, 1] },
      }).next;
    }
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'g',
      nodeType: 'Group',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 'g', socket: 'children' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'b', socket: 'out' },
      to: { node: 'g', socket: 'children' },
    }).next;
    const v = evaluate(state, 'g').value as GroupValue;
    expect(v.kind).toBe('Group');
    expect(v.children).toHaveLength(2);
    expect(v.children.every((c) => c.kind === 'BoxMesh')).toBe(true);
  });

  it('MaterialOverride wraps a child', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'box',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'mat',
      nodeType: 'MaterialOverride',
      params: { color: '#ff0000', roughness: 0.2 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'mat', socket: 'target' },
    }).next;
    const v = evaluate(state, 'mat').value as MaterialOverrideValue;
    expect(v.kind).toBe('MaterialOverride');
    expect(v.material.color).toBe('#ff0000');
    expect(v.material.roughness).toBeCloseTo(0.2);
    expect(v.child?.kind).toBe('BoxMesh');
  });
});
