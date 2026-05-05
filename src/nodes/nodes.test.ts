import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, evaluate, listNodeTypes, topoSort } from '../core/dag';
import { buildDefaultDagState, buildDefaultProject } from '../core/project/default';
import { ProjectSchema } from '../core/project/schema';
import { __reseedAllNodesForTests, registerAllNodes } from './registerAll';
import type { RenderOutputValue, SceneValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('default node registration', () => {
  it('registers all five P0 node types', () => {
    expect(listNodeTypes().sort()).toEqual([
      'BoxMesh',
      'DirectionalLight',
      'PerspectiveCamera',
      'RenderOutput',
      'Scene',
    ]);
  });

  it('registerAllNodes is idempotent', () => {
    registerAllNodes();
    registerAllNodes();
    expect(listNodeTypes().length).toBe(5);
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
    // Spot-check structural equality element-wise.
    const v1 = r1.value as RenderOutputValue;
    const v2 = r2.value as RenderOutputValue;
    expect(v1.scene.camera.position).toEqual(v2.scene.camera.position);
    expect(v1.scene.children[0].material.color).toEqual(v2.scene.children[0].material.color);
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
    expect(sceneVal!.camera.fov).toBe(45);
    expect(sceneVal!.lights[0].intensity).toBeCloseTo(1.1);
    expect(sceneVal!.children[0].size).toEqual([1, 1, 1]);
  });
});
