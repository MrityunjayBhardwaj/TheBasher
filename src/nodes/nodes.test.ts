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
  AnimationClipValue,
  AnimationLayerValue,
  CharacterValue,
  CutValue,
  GroupValue,
  ImageValue,
  PromptValue,
  KeyframeChannelColorValue,
  KeyframeChannelNumberValue,
  KeyframeChannelQuatValue,
  KeyframeChannelVec3Value,
  MaterialOverrideValue,
  PosedSkeletonValue,
  RenderOutputValue,
  ScatterValue,
  SceneValue,
  ShotValue,
  SkeletonValue,
  TimeValue,
  TransformValue,
  VideoValue,
  WalkPathValue,
} from './types';

const ALL_TYPES = [
  'AmbientLight',
  'AnimationClip',
  'AnimationLayer',
  'AreaLight',
  'BeautyPass',
  'BoneNameMap',
  'BoxMesh',
  'Character',
  'ClipSelect',
  'ComfyUIWorkflow',
  'Cut',
  'DepthPass',
  'DirectionalLight',
  'GltfAsset',
  'Group',
  'IDPass',
  'KeyframeChannelColor',
  'KeyframeChannelNumber',
  'KeyframeChannelQuat',
  'KeyframeChannelVec3',
  'LocomotionState',
  'MaterialOverride',
  'Navmesh',
  'NormalPass',
  'OrthographicCamera',
  'PerspectiveCamera',
  'PointLight',
  'PosedSkeleton',
  'Prompt',
  'RenderJob',
  'RenderOutput',
  'Scatter',
  'Scene',
  'Shot',
  'Skeleton',
  'SphereMesh',
  'SpotLight',
  'TimeSource',
  'Transform',
  'TransformClip',
  'VideoStitch',
  'WalkPath',
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
  it('builds the THESIS App. C DAG with the canonical n_time clock', () => {
    const state = buildDefaultDagState();
    expect(Object.keys(state.nodes).sort()).toEqual([
      'n_box',
      'n_camera',
      'n_light',
      'n_render',
      'n_scene',
      'n_time',
    ]);
    expect(state.outputs.scene).toEqual({ node: 'n_scene', socket: 'out' });
    expect(state.outputs.render).toEqual({ node: 'n_render', socket: 'out' });
  });

  it('seeds n_time as the canonical TimeSource (THESIS §49 — Time is first-class)', () => {
    // Locks the deductive contract every time-consuming Mutator relies on
    // (addChannel preconditions, future render-clock mutators). Removing
    // n_time without this test passing means the precondition assertion
    // "Default projects seed `n_time`" has become a lie.
    const state = buildDefaultDagState();
    expect(state.nodes.n_time).toBeDefined();
    expect(state.nodes.n_time.type).toBe('TimeSource');
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

// ---------------------------------------------------------------------------
// P2 — Time-aware pure nodes (vyapti V3 first-use)
//
// Each pure consumer of Time MUST be bit-exact at any given t and re-evaluate
// when the upstream TimeSource's hash flips. The harness samples each node at
// multiple times and checks: same t → same output; different t → different
// output (where the node depends on time non-trivially). The TimeSource node
// itself is `pure: false` (it's the only legal time source in the system).
// ---------------------------------------------------------------------------

const TIME_SAMPLES = [0, 0.5, 1, 2.5, 5];

function evalAt<T>(state: ReturnType<typeof emptyDagState>, target: string, seconds: number): T {
  const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
  return evaluate(state, target, { ctx }).value as T;
}

describe('P2 — Time socket plumbing (V3)', () => {
  it('TimeSource produces a TimeValue equal to ctx.time', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    const v = evalAt<TimeValue>(state, 'time', 2.5);
    expect(v.seconds).toBe(2.5);
    expect(v.frame).toBe(150);
  });

  it('TimeSource hash flips when t changes (drives downstream cache invalidation)', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    const h0 = evaluate(state, 'time', {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).hash;
    const h1 = evaluate(state, 'time', {
      ctx: { time: { frame: 60, seconds: 1, normalized: 0 } },
    }).hash;
    expect(h0).not.toBe(h1);
  });
});

describe('P2 — Skeleton (pure)', () => {
  it('default 3-bone stick figure — twice-eval bit-exact', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sk',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    const a = evaluate(state, 'sk');
    const b = evaluate(state, 'sk');
    expect(a.hash).toBe(b.hash);
    const sk = a.value as SkeletonValue;
    expect(sk.bones).toHaveLength(3);
    expect(sk.bones[0].name).toBe('root');
  });
});

describe('P2 — PosedSkeleton (pure, time-aware)', () => {
  function buildPosed() {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sk',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'posed',
      nodeType: 'PosedSkeleton',
      params: { amplitude: 0.2, frequency: 1 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'sk', socket: 'out' },
      to: { node: 'posed', socket: 'skeleton' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'posed', socket: 'time' },
    }).next;
    return state;
  }

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildPosed();
    const a = evalAt<PosedSkeletonValue>(state, 'posed', t);
    const b = evalAt<PosedSkeletonValue>(state, 'posed', t);
    expect(a).toEqual(b);
  });

  it('different t produces different pose (time actually flows through the socket)', () => {
    const state = buildPosed();
    const a = evalAt<PosedSkeletonValue>(state, 'posed', 0);
    const b = evalAt<PosedSkeletonValue>(state, 'posed', 0.5);
    expect(a.poses[1].rotation).not.toEqual(b.poses[1].rotation);
  });
});

describe('P2 — AnimationClip (pure, time-aware)', () => {
  function buildClip() {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sk',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'clip',
      nodeType: 'AnimationClip',
      params: {
        name: 'walk',
        duration: 2,
        loop: true,
        keyframes: [
          { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
          { bone: 1, time: 2, position: [0, 1, 0], rotation: [0, 0, 0] },
        ],
      },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'sk', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'clip', socket: 'time' },
    }).next;
    return state;
  }

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildClip();
    const a = evalAt<AnimationClipValue>(state, 'clip', t);
    const b = evalAt<AnimationClipValue>(state, 'clip', t);
    expect(a).toEqual(b);
  });

  it('keyframe interpolation: at t=0.5 torso rotation.y is between 0 and 0.5', () => {
    const state = buildClip();
    const v = evalAt<AnimationClipValue>(state, 'clip', 0.5);
    const torsoRot = v.pose.poses[1].rotation;
    expect(torsoRot[1]).toBeCloseTo(0.25, 5);
  });

  it('looping: t=2.0 wraps to t=0 (start of clip)', () => {
    const state = buildClip();
    const v0 = evalAt<AnimationClipValue>(state, 'clip', 0);
    const vWrap = evalAt<AnimationClipValue>(state, 'clip', 2.0);
    expect(vWrap.pose.poses[1].rotation).toEqual(v0.pose.poses[1].rotation);
  });
});

describe('P2 — WalkPath (pure)', () => {
  function buildPath(
    navmeshObstacles: { center: [number, number]; halfSize: [number, number] }[] = [],
  ) {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'nav',
      nodeType: 'Navmesh',
      params: { halfSize: [10, 10], obstacles: navmeshObstacles },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'wp',
      nodeType: 'WalkPath',
      params: { from: [-3, 0, 0], to: [3, 0, 0], sampleCount: 8 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'nav', socket: 'out' },
      to: { node: 'wp', socket: 'navmesh' },
    }).next;
    return state;
  }

  it('twice-eval bit-exact', () => {
    const state = buildPath();
    const a = evaluate(state, 'wp');
    const b = evaluate(state, 'wp');
    expect(a.hash).toBe(b.hash);
    expect(a.value).toEqual(b.value);
  });

  it('without obstacles: samples land on the straight line', () => {
    const state = buildPath();
    const v = evaluate(state, 'wp').value as WalkPathValue;
    expect(v.samples).toHaveLength(8);
    expect(v.samples[0]).toEqual([-3, 0, 0]);
    expect(v.samples[7]).toEqual([3, 0, 0]);
  });

  it('with an obstacle in the middle: samples are pushed out — none lie inside the obstacle', () => {
    const state = buildPath([{ center: [0, 0], halfSize: [1, 1] }]);
    const v = evaluate(state, 'wp').value as WalkPathValue;
    for (const s of v.samples) {
      const inside = Math.abs(s[0] - 0) < 1 && Math.abs(s[2] - 0) < 1;
      expect(inside).toBe(false);
    }
  });

  it('clamps samples to navmesh half-extents', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'nav',
      nodeType: 'Navmesh',
      params: { halfSize: [2, 2], obstacles: [] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'wp',
      nodeType: 'WalkPath',
      params: { from: [-100, 0, 0], to: [100, 0, 0], sampleCount: 4 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'nav', socket: 'out' },
      to: { node: 'wp', socket: 'navmesh' },
    }).next;
    const v = evaluate(state, 'wp').value as WalkPathValue;
    for (const s of v.samples) {
      expect(s[0]).toBeGreaterThanOrEqual(-2);
      expect(s[0]).toBeLessThanOrEqual(2);
    }
  });
});

describe('P2 — LocomotionState + Character (pure, time-aware integrating chain)', () => {
  function buildLocoChain() {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sk',
      nodeType: 'Skeleton',
      params: {},
    }).next;
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
      nodeId: 'wp',
      nodeType: 'WalkPath',
      params: { from: [-3, 0, 0], to: [3, 0, 0], sampleCount: 8 },
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
    // Wires
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'sk', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'clip', socket: 'time' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'nav', socket: 'out' },
      to: { node: 'wp', socket: 'navmesh' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'wp', socket: 'out' },
      to: { node: 'loco', socket: 'path' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'clip', socket: 'out' },
      to: { node: 'loco', socket: 'clip' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'loco', socket: 'time' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'loco', socket: 'out' },
      to: { node: 'char', socket: 'locomotion' },
    }).next;
    return state;
  }

  it.each(TIME_SAMPLES)('full chain twice-eval bit-exact at t=%d', (t) => {
    const state = buildLocoChain();
    const a = evalAt<CharacterValue>(state, 'char', t);
    const b = evalAt<CharacterValue>(state, 'char', t);
    expect(a).toEqual(b);
  });

  it('character moves along the path as time advances', () => {
    const state = buildLocoChain();
    const at0 = evalAt<CharacterValue>(state, 'char', 0);
    const at3 = evalAt<CharacterValue>(state, 'char', 3);
    expect(at0.position[0]).not.toBe(at3.position[0]);
  });

  it('looping: at t=path.length/speed the position wraps to start', () => {
    const state = buildLocoChain();
    // path is x in [-3, 3], length 6, speed 1 → period 6 seconds.
    const at0 = evalAt<CharacterValue>(state, 'char', 0);
    const atPeriod = evalAt<CharacterValue>(state, 'char', 6);
    expect(atPeriod.position[0]).toBeCloseTo(at0.position[0], 5);
  });
});

// ---------------------------------------------------------------------------
// P2 — Multi-character cache isolation (Wave D acceptance #4)
// Two Characters with separate LocomotionStates must produce two distinct
// hashes, and changing one Character's locomotion params must not flip the
// other's hash.
// ---------------------------------------------------------------------------

describe('P2 — multi-character cache isolation (acceptance #4)', () => {
  function buildTwoCharacters() {
    let state = emptyDagState();
    // Shared time + skeleton (legitimate sharing — same value).
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sk',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    // Shared navmesh.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'nav',
      nodeType: 'Navmesh',
      params: { halfSize: [10, 10], obstacles: [] },
    }).next;
    // Per-character paths/clips/locos.
    for (const id of ['a', 'b'] as const) {
      const xFrom = id === 'a' ? -3 : -2;
      const xTo = id === 'a' ? 3 : 2;
      state = applyOp(state, {
        type: 'addNode',
        nodeId: `clip_${id}`,
        nodeType: 'AnimationClip',
        params: { name: `walk_${id}`, duration: 1, loop: true, keyframes: [] },
      }).next;
      state = applyOp(state, {
        type: 'addNode',
        nodeId: `wp_${id}`,
        nodeType: 'WalkPath',
        params: { from: [xFrom, 0, 0], to: [xTo, 0, 0], sampleCount: 6 },
      }).next;
      state = applyOp(state, {
        type: 'addNode',
        nodeId: `loco_${id}`,
        nodeType: 'LocomotionState',
        params: { speed: id === 'a' ? 1 : 1.5, loop: true },
      }).next;
      state = applyOp(state, {
        type: 'addNode',
        nodeId: `char_${id}`,
        nodeType: 'Character',
        params: { name: id },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'sk', socket: 'out' },
        to: { node: `clip_${id}`, socket: 'skeleton' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'time', socket: 'out' },
        to: { node: `clip_${id}`, socket: 'time' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'nav', socket: 'out' },
        to: { node: `wp_${id}`, socket: 'navmesh' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: `wp_${id}`, socket: 'out' },
        to: { node: `loco_${id}`, socket: 'path' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: `clip_${id}`, socket: 'out' },
        to: { node: `loco_${id}`, socket: 'clip' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'time', socket: 'out' },
        to: { node: `loco_${id}`, socket: 'time' },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: `loco_${id}`, socket: 'out' },
        to: { node: `char_${id}`, socket: 'locomotion' },
      }).next;
    }
    return state;
  }

  it('two characters produce distinct hashes (no cache cross-pollination)', () => {
    const state = buildTwoCharacters();
    const a = evalAt<CharacterValue>(state, 'char_a', 1);
    const b = evalAt<CharacterValue>(state, 'char_b', 1);
    expect(a.position).not.toEqual(b.position);
  });

  it("changing character A's locomotion speed does NOT flip character B's hash", () => {
    const state = buildTwoCharacters();
    const ctx = { time: { frame: 60, seconds: 1, normalized: 0 } };
    const hashB_before = evaluate(state, 'char_b', { ctx }).hash;
    // Mutate A only.
    const next = {
      ...state,
      nodes: {
        ...state.nodes,
        loco_a: { ...state.nodes.loco_a, params: { speed: 5, loop: true } },
      },
    };
    const hashB_after = evaluate(next, 'char_b', { ctx }).hash;
    expect(hashB_after).toBe(hashB_before);
    // And A's hash DOES flip.
    const hashA_before = evaluate(state, 'char_a', { ctx }).hash;
    const hashA_after = evaluate(next, 'char_a', { ctx }).hash;
    expect(hashA_after).not.toBe(hashA_before);
  });
});

// ---------------------------------------------------------------------------
// P3 — Timeline = animation nodes (THESIS §42)
//
// Each KeyframeChannel<T> is a pure consumer of a Time socket — same (params,
// time) → same value. AnimationLayer aggregates channels and mutes them at
// the gate. Shot/Cut are editorial wrappers (data forwarders).
// ---------------------------------------------------------------------------

function buildChannelState(nodeType: string, params: unknown) {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'ch',
    nodeType,
    params,
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'ch', socket: 'time' },
  }).next;
  return state;
}

describe('P3 — KeyframeChannelNumber (pure, time-aware)', () => {
  const params = {
    name: 'intensity',
    target: 'light',
    paramPath: 'intensity',
    keyframes: [
      { time: 0, value: 0, easing: 'linear' as const },
      { time: 1, value: 10, easing: 'linear' as const },
    ],
  };

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildChannelState('KeyframeChannelNumber', params);
    const a = evalAt<KeyframeChannelNumberValue>(state, 'ch', t);
    const b = evalAt<KeyframeChannelNumberValue>(state, 'ch', t);
    expect(a).toEqual(b);
  });

  it('linear interp: at t=0.5 value is exactly 5', () => {
    const state = buildChannelState('KeyframeChannelNumber', params);
    const v = evalAt<KeyframeChannelNumberValue>(state, 'ch', 0.5);
    expect(v.value).toBeCloseTo(5, 6);
    expect(v.valueType).toBe('number');
    expect(v.target).toBe('light');
    expect(v.paramPath).toBe('intensity');
  });

  it('cubic easing: at t=0.5 smoothstep(0.5)=0.5 still hits midpoint', () => {
    const cubic = {
      ...params,
      keyframes: [
        { time: 0, value: 0, easing: 'cubic' as const },
        { time: 1, value: 10, easing: 'cubic' as const },
      ],
    };
    const state = buildChannelState('KeyframeChannelNumber', cubic);
    const v = evalAt<KeyframeChannelNumberValue>(state, 'ch', 0.5);
    expect(v.value).toBeCloseTo(5, 6);
    // off-midpoint — cubic ≠ linear
    const v2 = evalAt<KeyframeChannelNumberValue>(state, 'ch', 0.25);
    expect(v2.value).toBeCloseTo(0.25 * 0.25 * (3 - 2 * 0.25) * 10, 6);
  });

  it('out-of-range clamps to first/last keyframe', () => {
    const state = buildChannelState('KeyframeChannelNumber', params);
    expect(evalAt<KeyframeChannelNumberValue>(state, 'ch', -1).value).toBe(0);
    expect(evalAt<KeyframeChannelNumberValue>(state, 'ch', 5).value).toBe(10);
  });

  it('empty channel returns 0', () => {
    const state = buildChannelState('KeyframeChannelNumber', { ...params, keyframes: [] });
    expect(evalAt<KeyframeChannelNumberValue>(state, 'ch', 0).value).toBe(0);
  });

  it('keyframes inserted out-of-time-order still interpolate correctly', () => {
    const state = buildChannelState('KeyframeChannelNumber', {
      ...params,
      keyframes: [
        { time: 1, value: 10, easing: 'linear' as const },
        { time: 0, value: 0, easing: 'linear' as const },
      ],
    });
    expect(evalAt<KeyframeChannelNumberValue>(state, 'ch', 0.5).value).toBeCloseTo(5, 6);
  });
});

describe('P3 — KeyframeChannelVec3 (pure, time-aware)', () => {
  const params = {
    name: 'pos',
    target: 'box',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0] as const, easing: 'linear' as const },
      { time: 1, value: [10, 20, 30] as const, easing: 'linear' as const },
    ],
  };

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildChannelState('KeyframeChannelVec3', params);
    const a = evalAt<KeyframeChannelVec3Value>(state, 'ch', t);
    const b = evalAt<KeyframeChannelVec3Value>(state, 'ch', t);
    expect(a).toEqual(b);
  });

  it('per-component lerp at t=0.5 → [5, 10, 15]', () => {
    const state = buildChannelState('KeyframeChannelVec3', params);
    const v = evalAt<KeyframeChannelVec3Value>(state, 'ch', 0.5);
    expect(v.valueType).toBe('vec3');
    expect(v.value[0]).toBeCloseTo(5, 6);
    expect(v.value[1]).toBeCloseTo(10, 6);
    expect(v.value[2]).toBeCloseTo(15, 6);
  });
});

describe('P3 — KeyframeChannelQuat (pure, time-aware)', () => {
  // Identity → 90° around Y as quaternion (sin(45°)=0.7071, cos(45°)=0.7071).
  const q0 = [0, 0, 0, 1] as const;
  const q1 = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as const;
  const params = {
    name: 'rot',
    target: 'box',
    paramPath: 'rotation',
    keyframes: [
      { time: 0, value: q0, easing: 'linear' as const },
      { time: 1, value: q1, easing: 'linear' as const },
    ],
  };

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildChannelState('KeyframeChannelQuat', params);
    const a = evalAt<KeyframeChannelQuatValue>(state, 'ch', t);
    const b = evalAt<KeyframeChannelQuatValue>(state, 'ch', t);
    expect(a).toEqual(b);
  });

  it('slerp result stays unit-length (V2 invariant for quaternion math)', () => {
    const state = buildChannelState('KeyframeChannelQuat', params);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = evalAt<KeyframeChannelQuatValue>(state, 'ch', t);
      const len = Math.sqrt(v.value[0] ** 2 + v.value[1] ** 2 + v.value[2] ** 2 + v.value[3] ** 2);
      expect(len).toBeCloseTo(1, 5);
    }
  });
});

describe('P3 — KeyframeChannelColor (pure, time-aware)', () => {
  const params = {
    name: 'col',
    target: 'mat',
    paramPath: 'color',
    keyframes: [
      { time: 0, value: '#ff0000', easing: 'linear' as const },
      { time: 1, value: '#0000ff', easing: 'linear' as const },
    ],
  };

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildChannelState('KeyframeChannelColor', params);
    const a = evalAt<KeyframeChannelColorValue>(state, 'ch', t);
    const b = evalAt<KeyframeChannelColorValue>(state, 'ch', t);
    expect(a).toEqual(b);
  });

  it('hex output is 7-char #rrggbb at every sample', () => {
    const state = buildChannelState('KeyframeChannelColor', params);
    for (const t of [0, 0.5, 1]) {
      const v = evalAt<KeyframeChannelColorValue>(state, 'ch', t);
      expect(v.value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('endpoints round-trip exactly', () => {
    const state = buildChannelState('KeyframeChannelColor', params);
    expect(evalAt<KeyframeChannelColorValue>(state, 'ch', 0).value).toBe('#ff0000');
    expect(evalAt<KeyframeChannelColorValue>(state, 'ch', 1).value).toBe('#0000ff');
  });
});

describe('P3 — AnimationLayer (pure aggregator)', () => {
  function buildLayer(layerParams: unknown, channelCount = 1) {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    for (let i = 0; i < channelCount; i++) {
      state = applyOp(state, {
        type: 'addNode',
        nodeId: `ch${i}`,
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: `ch${i}`,
          target: 'box',
          paramPath: 'foo',
          keyframes: [
            { time: 0, value: i, easing: 'linear' },
            { time: 1, value: i + 1, easing: 'linear' },
          ],
        },
      }).next;
      state = applyOp(state, {
        type: 'connect',
        from: { node: 'time', socket: 'out' },
        to: { node: `ch${i}`, socket: 'time' },
      }).next;
    }
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'box',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: layerParams,
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'layer', socket: 'target' },
    }).next;
    for (let i = 0; i < channelCount; i++) {
      state = applyOp(state, {
        type: 'connect',
        from: { node: `ch${i}`, socket: 'out' },
        to: { node: 'layer', socket: 'animation' },
      }).next;
    }
    return state;
  }

  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildLayer({ name: 'L', weight: 1, mute: false, solo: false, boneMask: [] }, 2);
    const a = evalAt<AnimationLayerValue>(state, 'layer', t);
    const b = evalAt<AnimationLayerValue>(state, 'layer', t);
    expect(a).toEqual(b);
  });

  it('passes channels through when mute=false', () => {
    const state = buildLayer({ name: 'L', weight: 1, mute: false, solo: false, boneMask: [] }, 2);
    const v = evalAt<AnimationLayerValue>(state, 'layer', 0.5);
    expect(v.active).toHaveLength(2);
    expect(v.target?.kind).toBe('BoxMesh');
  });

  it('mute=true → active is empty (channel inputs ignored)', () => {
    const state = buildLayer({ name: 'L', weight: 1, mute: true, solo: false, boneMask: [] }, 2);
    const v = evalAt<AnimationLayerValue>(state, 'layer', 0.5);
    expect(v.active).toHaveLength(0);
    // Target still passes through so the renderer still draws the wrapped mesh.
    expect(v.target?.kind).toBe('BoxMesh');
    expect(v.mute).toBe(true);
  });

  it('boneMask + solo pass through to the value verbatim (Wave C consumes them)', () => {
    const state = buildLayer(
      { name: 'L', weight: 0.5, mute: false, solo: true, boneMask: ['arm.l', 'arm.r'] },
      1,
    );
    const v = evalAt<AnimationLayerValue>(state, 'layer', 0);
    expect(v.weight).toBe(0.5);
    expect(v.solo).toBe(true);
    expect(v.boneMask).toEqual(['arm.l', 'arm.r']);
  });
});

describe('P3 — Shot + Cut (editorial)', () => {
  function buildShot(name: string, nodeId: string) {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'cam',
      nodeType: 'PerspectiveCamera',
      params: { fov: 45, near: 0.1, far: 100, position: [0, 0, 5], lookAt: [0, 0, 0] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'scene',
      nodeType: 'Scene',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: nodeId,
      nodeType: 'Shot',
      params: { name, startTime: 0, endTime: 2 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: nodeId, socket: 'camera' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: nodeId, socket: 'scene' },
    }).next;
    return state;
  }

  it('Shot forwards camera + scene at twice-eval', () => {
    const state = buildShot('s1', 'shot');
    const a = evaluate(state, 'shot').value as ShotValue;
    const b = evaluate(state, 'shot').value as ShotValue;
    expect(a).toEqual(b);
    expect(a.name).toBe('s1');
    expect(a.camera?.kind).toBe('PerspectiveCamera');
    expect(a.scene?.kind).toBe('Scene');
  });

  it('Cut wires two Shots with transitionFrame stored verbatim', () => {
    let state = buildShot('a', 'shotA');
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'shotB',
      nodeType: 'Shot',
      params: { name: 'b', startTime: 2, endTime: 4 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: 'shotB', socket: 'camera' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: 'shotB', socket: 'scene' },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'cut',
      nodeType: 'Cut',
      params: { transitionFrame: 12 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'shotA', socket: 'out' },
      to: { node: 'cut', socket: 'from' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'shotB', socket: 'out' },
      to: { node: 'cut', socket: 'to' },
    }).next;
    const v = evaluate(state, 'cut').value as CutValue;
    expect(v.transitionFrame).toBe(12);
    expect(v.from?.name).toBe('a');
    expect(v.to?.name).toBe('b');
  });
});

describe('P3 — AnimationLayer channel patcher (Wave C)', () => {
  function buildAnimatedBoxState(channelValue: [number, number, number] = [0, 5, 0]) {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'box',
      nodeType: 'BoxMesh',
      params: {
        size: [1, 1, 1],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        material: { name: 'default', color: '#ff0000' },
      },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: 'box',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: channelValue, easing: 'linear' },
        ],
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'ch', socket: 'time' },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: { name: 'L', weight: 1, mute: false, solo: false, boneMask: [] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'layer', socket: 'target' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'ch', socket: 'out' },
      to: { node: 'layer', socket: 'animation' },
    }).next;
    return s;
  }

  it('patches the wrapped target.position at t=1 (full channel)', () => {
    const state = buildAnimatedBoxState([0, 5, 0]);
    const v = evalAt<AnimationLayerValue>(state, 'layer', 1);
    expect(v.target?.kind).toBe('BoxMesh');
    if (v.target?.kind === 'BoxMesh') {
      expect(v.target.position).toEqual([0, 5, 0]);
    }
  });

  it('blends toward original at weight=0.5 (half-strength channel)', () => {
    let state = buildAnimatedBoxState([0, 10, 0]);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'layer',
      paramPath: 'weight',
      value: 0.5,
    }).next;
    const v = evalAt<AnimationLayerValue>(state, 'layer', 1);
    if (v.target?.kind === 'BoxMesh') {
      // Original [0,0,0], channel [0,10,0], weight 0.5 → [0,5,0]
      expect(v.target.position[1]).toBeCloseTo(5, 6);
    }
  });

  it('mute=true leaves the static target unchanged (channel ignored)', () => {
    let state = buildAnimatedBoxState([0, 99, 0]);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'layer',
      paramPath: 'mute',
      value: true,
    }).next;
    const v = evalAt<AnimationLayerValue>(state, 'layer', 1);
    if (v.target?.kind === 'BoxMesh') {
      expect(v.target.position).toEqual([0, 0, 0]);
    }
  });

  it('twice-eval bit-exact when patched (channel application is pure)', () => {
    const state = buildAnimatedBoxState([1, 2, 3]);
    const a = evalAt<AnimationLayerValue>(state, 'layer', 0.5);
    const b = evalAt<AnimationLayerValue>(state, 'layer', 0.5);
    expect(a).toEqual(b);
  });

  it('empty paramPath is a no-op — target unchanged', () => {
    let state = buildAnimatedBoxState([0, 5, 0]);
    // Mutate the channel's paramPath via setParam — empty string sentinel.
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'ch',
      paramPath: 'paramPath',
      value: '',
    }).next;
    const v = evalAt<AnimationLayerValue>(state, 'layer', 1);
    if (v.target?.kind === 'BoxMesh') {
      expect(v.target.position).toEqual([0, 0, 0]);
    }
  });
});

// ---------------------------------------------------------------------------
// P4 — Render graph = render nodes (THESIS §43)
//
// BeautyPass + IDPass are pure consumers of (Scene, Camera, Time). The
// evaluator returns metadata only — descriptor + sourceHash. Same inputs
// → same hash; different inputs (params, time, scene, camera) → different
// hash. Wave B's RenderJob uses sourceHash to skip redundant per-frame
// pixel work.
// ---------------------------------------------------------------------------

function buildPassState(passType: 'BeautyPass' | 'IDPass') {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'scene',
    nodeType: 'Scene',
    params: {},
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'pass',
    nodeType: passType,
    params: {},
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'pass', socket: 'scene' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'pass', socket: 'camera' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'pass', socket: 'time' },
  }).next;
  return state;
}

describe('P4 — BeautyPass (pure metadata)', () => {
  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildPassState('BeautyPass');
    const a = evalAt<ImageValue>(state, 'pass', t);
    const b = evalAt<ImageValue>(state, 'pass', t);
    expect(a).toEqual(b);
  });

  it('evaluates to an Image with passKind beauty + default 1280x720 rgba8', () => {
    const state = buildPassState('BeautyPass');
    const v = evalAt<ImageValue>(state, 'pass', 0);
    expect(v.kind).toBe('Image');
    expect(v.passKind).toBe('beauty');
    expect(v.descriptor).toEqual({ width: 1280, height: 720, format: 'rgba8' });
    expect(v.sourceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sourceHash flips when time changes', () => {
    const state = buildPassState('BeautyPass');
    const a = evalAt<ImageValue>(state, 'pass', 0);
    const b = evalAt<ImageValue>(state, 'pass', 1);
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('sourceHash flips when scene changes (box position mutated)', () => {
    const state = buildPassState('BeautyPass');
    const a = evalAt<ImageValue>(state, 'pass', 0);
    const next = {
      ...state,
      nodes: {
        ...state.nodes,
        box: { ...state.nodes.box, params: { size: [1, 1, 1], position: [5, 0, 0] } },
      },
    };
    const b = evalAt<ImageValue>(next, 'pass', 0);
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('sourceHash flips when params (width) change', () => {
    const stateA = buildPassState('BeautyPass');
    const stateB = applyOp(stateA, {
      type: 'setParam',
      nodeId: 'pass',
      paramPath: 'width',
      value: 640,
    }).next;
    const a = evalAt<ImageValue>(stateA, 'pass', 0);
    const b = evalAt<ImageValue>(stateB, 'pass', 0);
    expect(a.sourceHash).not.toBe(b.sourceHash);
    expect(b.descriptor.width).toBe(640);
  });
});

describe('P4 — IDPass (pure metadata)', () => {
  it.each(TIME_SAMPLES)('twice-eval bit-exact at t=%d', (t) => {
    const state = buildPassState('IDPass');
    const a = evalAt<ImageValue>(state, 'pass', t);
    const b = evalAt<ImageValue>(state, 'pass', t);
    expect(a).toEqual(b);
  });

  it('evaluates to an Image with passKind id + default 1280x720 rgba16f', () => {
    const state = buildPassState('IDPass');
    const v = evalAt<ImageValue>(state, 'pass', 0);
    expect(v.kind).toBe('Image');
    expect(v.passKind).toBe('id');
    expect(v.descriptor).toEqual({ width: 1280, height: 720, format: 'rgba16f' });
  });

  it('sourceHash differs from BeautyPass with same inputs (passKind discriminates)', () => {
    const beautyState = buildPassState('BeautyPass');
    const idState = buildPassState('IDPass');
    const beauty = evalAt<ImageValue>(beautyState, 'pass', 0);
    const id = evalAt<ImageValue>(idState, 'pass', 0);
    expect(beauty.sourceHash).not.toBe(id.sourceHash);
  });
});

describe('P5 — DepthPass + NormalPass (§43 amendment, D-02)', () => {
  it.each(TIME_SAMPLES)('DepthPass twice-eval bit-exact at t=%d', (t) => {
    const state = buildPassState('DepthPass');
    const a = evalAt<ImageValue>(state, 'pass', t);
    const b = evalAt<ImageValue>(state, 'pass', t);
    expect(a).toEqual(b);
  });

  it.each(TIME_SAMPLES)('NormalPass twice-eval bit-exact at t=%d', (t) => {
    const state = buildPassState('NormalPass');
    const a = evalAt<ImageValue>(state, 'pass', t);
    const b = evalAt<ImageValue>(state, 'pass', t);
    expect(a).toEqual(b);
  });

  it('DepthPass evaluates to Image with passKind depth + 1280x720 rgba8', () => {
    const v = evalAt<ImageValue>(buildPassState('DepthPass'), 'pass', 0);
    expect(v.passKind).toBe('depth');
    expect(v.descriptor).toEqual({ width: 1280, height: 720, format: 'rgba8' });
  });

  it('NormalPass evaluates to Image with passKind normal + 1280x720 rgba8', () => {
    const v = evalAt<ImageValue>(buildPassState('NormalPass'), 'pass', 0);
    expect(v.passKind).toBe('normal');
    expect(v.descriptor).toEqual({ width: 1280, height: 720, format: 'rgba8' });
  });

  it('Depth + Normal sourceHashes are distinct from Beauty given same scene/camera/time (passKind discriminates)', () => {
    const beauty = evalAt<ImageValue>(buildPassState('BeautyPass'), 'pass', 0);
    const depth = evalAt<ImageValue>(buildPassState('DepthPass'), 'pass', 0);
    const normal = evalAt<ImageValue>(buildPassState('NormalPass'), 'pass', 0);
    const hashes = new Set([beauty.sourceHash, depth.sourceHash, normal.sourceHash]);
    expect(hashes.size).toBe(3);
  });

  it('DepthPass sourceHash flips when time advances', () => {
    const state = buildPassState('DepthPass');
    const a = evalAt<ImageValue>(state, 'pass', 0);
    const b = evalAt<ImageValue>(state, 'pass', 1);
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('NormalPass sourceHash flips when scene mutates', () => {
    const state = buildPassState('NormalPass');
    const a = evalAt<ImageValue>(state, 'pass', 0);
    const next = {
      ...state,
      nodes: {
        ...state.nodes,
        box: { ...state.nodes.box, params: { size: [1, 1, 1], position: [3, 0, 0] } },
      },
    };
    const b = evalAt<ImageValue>(next, 'pass', 0);
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });
});

describe('P5 — Prompt (pure data node)', () => {
  function buildPromptState(params: Partial<PromptValue> = {}) {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'p',
      nodeType: 'Prompt',
      params: {
        text: params.text ?? 'a stylized cube',
        negative: params.negative ?? '',
        tags: params.tags ?? [],
      },
    }).next;
    return s;
  }

  it('twice-eval bit-exact', () => {
    const state = buildPromptState({ text: 'test', tags: ['cinematic'] });
    const a = evaluate(state, 'p').value as PromptValue;
    const b = evaluate(state, 'p').value as PromptValue;
    expect(a).toEqual(b);
    expect(a).toEqual({
      kind: 'Prompt',
      text: 'test',
      negative: '',
      tags: ['cinematic'],
    });
  });

  it('returns params verbatim with defaults applied (V10 — fields absent → empty defaults)', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'p',
      nodeType: 'Prompt',
      params: { text: 'minimal' },
    }).next;
    const v = evaluate(s, 'p').value as PromptValue;
    expect(v).toEqual({
      kind: 'Prompt',
      text: 'minimal',
      negative: '',
      tags: [],
    });
  });

  it('hydrate-seam load with missing schema fields produces defaults (H14 mitigation)', () => {
    // Mimic a project saved before `negative` and `tags` existed: only
    // `text` is present in params. The evaluator's `?? default` keeps
    // the value shape stable for downstream consumers.
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'p',
      nodeType: 'Prompt',
      params: { text: 'legacy' },
    }).next;
    // Force-mutate the stored params to simulate a hydrate that bypassed
    // zod's .default() (the H14 trap shape).
    const next = {
      ...s,
      nodes: {
        ...s.nodes,
        p: { ...s.nodes.p, params: { text: 'legacy' } as Record<string, unknown> },
      },
    };
    const v = evaluate(next, 'p').value as PromptValue;
    expect(v.negative).toBe('');
    expect(v.tags).toEqual([]);
  });
});

describe('P5 — ComfyUIWorkflow (impure metadata, D-01/D-03/D-04)', () => {
  /**
   * Build a tiny DAG: TimeSource + Prompt + BeautyPass + DepthlikeStub +
   * ComfyUIWorkflow connected through 'pass-input'. We use BeautyPass for
   * both pass-input slots so we don't take a dependency on Wave A4's
   * DepthPass / NormalPass landing first — the sourceHash only cares
   * about the upstream Image's passKind + sourceHash, both well-defined
   * for BeautyPass.
   */
  function buildComfyState(
    opts: {
      promptText?: string;
      promptNegative?: string;
      presetId?: 'stylizedRealism';
      boxPosition?: [number, number, number];
    } = {},
  ) {
    const promptText = opts.promptText ?? 'a cinematic cube';
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
      params: { size: [1, 1, 1], position: opts.boxPosition ?? [0, 0, 0] },
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
      params: { text: promptText, negative: opts.promptNegative ?? '', tags: [] },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cw',
      nodeType: 'ComfyUIWorkflow',
      params: {
        presetId: opts.presetId ?? 'stylizedRealism',
        frameStart: 0,
        frameEnd: 30,
        lastGoodFrame: -1,
        outputPath: 'renders/job1/stylized_stylizedRealism',
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

  it('twice-eval bit-exact at frame 0', () => {
    const state = buildComfyState();
    const a = evaluate(state, 'cw').value as ImageValue;
    const b = evaluate(state, 'cw').value as ImageValue;
    expect(a).toEqual(b);
  });

  it('emits Image with passKind stylized + default 1280x720 rgba8 (D-01)', () => {
    const state = buildComfyState();
    const v = evaluate(state, 'cw').value as ImageValue;
    expect(v.kind).toBe('Image');
    expect(v.passKind).toBe('stylized');
    expect(v.descriptor).toEqual({ width: 1280, height: 720, format: 'rgba8' });
    expect(v.sourceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sourceHash flips when prompt text changes', () => {
    const a = evaluate(buildComfyState({ promptText: 'a cube' }), 'cw').value as ImageValue;
    const b = evaluate(buildComfyState({ promptText: 'a sphere' }), 'cw').value as ImageValue;
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('sourceHash flips when upstream pass bytes change (box position mutated)', () => {
    const a = evaluate(buildComfyState({ boxPosition: [0, 0, 0] }), 'cw').value as ImageValue;
    const b = evaluate(buildComfyState({ boxPosition: [5, 0, 0] }), 'cw').value as ImageValue;
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('D-04 default outputPath is empty string (Mutator authors the literal at build time)', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cw',
      nodeType: 'ComfyUIWorkflow',
      params: {},
    }).next;
    expect(s.nodes.cw.params.outputPath).toBe('');
    expect(s.nodes.cw.params.lastGoodFrame).toBe(-1);
    expect(s.nodes.cw.params.presetId).toBe('stylizedRealism');
  });

  it('hydrate-seam load with missing width/height fields produces defaults (V10 / H14)', () => {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'cw', nodeType: 'ComfyUIWorkflow', params: {} }).next;
    // Strip width/height as if loaded from a project saved before they
    // landed. Evaluator's `?? default` rebuilds the descriptor.
    const next = {
      ...s,
      nodes: {
        ...s.nodes,
        cw: {
          ...s.nodes.cw,
          params: {
            presetId: 'stylizedRealism',
            frameStart: 0,
            frameEnd: 30,
            lastGoodFrame: -1,
            outputPath: '',
          } as Record<string, unknown>,
        },
      },
    };
    const v = evaluate(next, 'cw').value as ImageValue;
    expect(v.descriptor.width).toBe(1280);
    expect(v.descriptor.height).toBe(720);
  });
});

describe('P5 — VideoStitch (impure metadata, D-01/D-05)', () => {
  function buildStitchState(opts: { codec?: 'h264'; fps?: number; outputPath?: string } = {}) {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    // Use a Prompt node as a fake stylized-image source — but Prompt
    // doesn't emit Image. Use BeautyPass instead, which emits Image
    // and gives us a consistent sourceHash test surface. (For Wave D
    // metadata-only purposes, the upstream's passKind doesn't matter
    // — VideoStitch hashes whatever Image arrives.)
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
    s = applyOp(s, { type: 'addNode', nodeId: 'pass', nodeType: 'BeautyPass', params: {} }).next;
    for (const wire of [
      { from: 'scene', to: ['pass', 'scene'] },
      { from: 'cam', to: ['pass', 'camera'] },
      { from: 'time', to: ['pass', 'time'] },
    ] as const) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: wire.from, socket: 'out' },
        to: { node: wire.to[0], socket: wire.to[1] },
      }).next;
    }
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'stitch',
      nodeType: 'VideoStitch',
      params: {
        codec: opts.codec ?? 'h264',
        fps: opts.fps ?? 30,
        outputPath: opts.outputPath ?? 'renders/job1/final.mp4',
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'pass', socket: 'out' },
      to: { node: 'stitch', socket: 'pass-input' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'stitch', socket: 'time' },
    }).next;
    return s;
  }

  it('emits Video metadata with codec + fps + frameCount + outputPath + sourceHash', () => {
    const v = evaluate(buildStitchState(), 'stitch').value as VideoValue;
    expect(v.kind).toBe('Video');
    expect(v.codec).toBe('h264');
    expect(v.fps).toBe(30);
    expect(v.frameCount).toBe(1);
    expect(v.outputPath).toBe('renders/job1/final.mp4');
    expect(v.sourceHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('twice-eval bit-exact', () => {
    const state = buildStitchState();
    const a = evaluate(state, 'stitch').value as VideoValue;
    const b = evaluate(state, 'stitch').value as VideoValue;
    expect(a).toEqual(b);
  });

  it('sourceHash flips when outputPath changes', () => {
    const a = evaluate(buildStitchState({ outputPath: 'renders/job1/a.mp4' }), 'stitch')
      .value as VideoValue;
    const b = evaluate(buildStitchState({ outputPath: 'renders/job1/b.mp4' }), 'stitch')
      .value as VideoValue;
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('sourceHash flips when fps changes', () => {
    const a = evaluate(buildStitchState({ fps: 24 }), 'stitch').value as VideoValue;
    const b = evaluate(buildStitchState({ fps: 60 }), 'stitch').value as VideoValue;
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('hydrate-seam load with missing fields produces defaults (V10 / H14)', () => {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'stitch', nodeType: 'VideoStitch', params: {} }).next;
    // Strip fields as if loaded from a project saved before they landed.
    const next = {
      ...s,
      nodes: {
        ...s.nodes,
        stitch: { ...s.nodes.stitch, params: {} as Record<string, unknown> },
      },
    };
    const v = evaluate(next, 'stitch').value as VideoValue;
    expect(v.codec).toBe('h264');
    expect(v.fps).toBe(30);
    expect(v.outputPath).toBe('');
  });
});
