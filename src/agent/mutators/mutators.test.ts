// Mutator tests — per-builder determinism, precondition coverage, and
// end-to-end five-gate validator behavior.
//
// REF: P2.5.2 PLAN §5 Wave C; vyapti V13/V14.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import {
  __resetMutatorRegistryForTests,
  getMutator,
  listMutators,
  registerAllMutators,
  registerMutator,
  validatePlan,
} from './index';
import { rotateMutator } from './builders/rotate';
import { translateMutator } from './builders/translate';
import { scaleMutator } from './builders/scale';
import { setMaterialColorMutator } from './builders/setMaterialColor';
import { duplicateMutator } from './builders/duplicate';
import { deleteNodeMutator } from './builders/deleteNode';
import { proposePlanTool, listMutatorsTool } from './tool';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetMutatorRegistryForTests();
});

function buildScene(): DagState {
  // Two cubes and a sphere wired into a Scene aggregator. scene is the
  // anchor output for the project.
  let s = emptyDagState();
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
    nodeId: 'sibling',
    nodeType: 'BoxMesh',
    params: {
      size: [1, 1, 1],
      position: [3, 0, 0],
      rotation: [0, 0, 0],
      material: { name: 'default', color: '#00ff00' },
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'sphere',
    nodeType: 'SphereMesh',
    params: { radius: 1, position: [0, 2, 0] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'sibling', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'sphere', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = {
    ...s,
    outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return s;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('mutator catalog', () => {
  it('registerAllMutators registers all first-party mutators', () => {
    registerAllMutators();
    const mutators = listMutators();
    expect(mutators).toHaveLength(10);
    const names = mutators.map((m) => m.name).sort();
    expect(names).toEqual([
      'mutator.deleteNode',
      'mutator.duplicate',
      'mutator.rotate',
      'mutator.scale',
      'mutator.setMaterialColor',
      'mutator.shot.create',
      'mutator.timeline.addChannel',
      'mutator.timeline.addLayer',
      'mutator.timeline.keyframe',
      'mutator.translate',
    ]);
  });

  it('refuses duplicate registration', () => {
    registerMutator(rotateMutator);
    expect(() => registerMutator(rotateMutator)).toThrow(
      'Mutator already registered: mutator.rotate',
    );
  });

  it('getMutator returns undefined for missing names', () => {
    expect(getMutator('nonexistent')).toBeUndefined();
  });

  it('every Mutator carries a specExample that parses through its own spec schema', () => {
    // #23 fix: agent.listMutators returns specExample so the LLM can
    // copy field names instead of guessing. This test guards drift —
    // a Mutator whose specExample stops parsing through its own zod
    // schema (param renamed, type changed) fails CI immediately.
    registerAllMutators();
    for (const m of listMutators()) {
      const parse = m.spec.safeParse(m.specExample);
      expect(parse.success, `Mutator "${m.name}" specExample failed its own spec.parse: ` +
        (parse.success ? '' : parse.error.message)).toBe(true);
    }
  });

  it('V14: no two Mutators share the same contract signature', () => {
    // Mechanical guard for vyapti V14 (Mutator non-redundancy). Two
    // Mutators with identical (requiredEdges, requiredNodeTypes,
    // preserves) tuples are almost always candidates for parameterization
    // rather than fork. This converts V14 from "code review" to
    // observable enforcement at registration time.
    //
    // A future deeper check would assert no two Mutators emit the same
    // Op-shape on a probe scene; deferred — see follow-up issue.
    registerAllMutators();
    const seen = new Map<string, string>();
    for (const m of listMutators()) {
      const sig = JSON.stringify({
        requiredEdges: [...m.contract.requiredEdges].sort(),
        requiredNodeTypes: [...m.contract.requiredNodeTypes].sort(),
        preserves: [...m.contract.preserves].sort(),
      });
      const prior = seen.get(sig);
      expect(
        prior,
        `Mutators "${m.name}" and "${prior}" share the same contract signature ${sig}`,
      ).toBeUndefined();
      seen.set(sig, m.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-mutator determinism + behavior
// ---------------------------------------------------------------------------

describe('rotate mutator', () => {
  it('emits a single setParam Op with the additive delta', () => {
    const state = buildScene();
    const result = validatePlan(
      rotateMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 45 },
      state,
      'rotate box',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(1);
      const op = result.ops[0];
      expect(op.type).toBe('setParam');
      if (op.type === 'setParam') {
        expect(op.paramPath).toBe('rotation');
        expect(op.value).toEqual([45, 0, 0]);
      }
    }
  });

  it('twice-call returns the same Op[] (deterministic)', () => {
    const state = buildScene();
    const a = validatePlan(rotateMutator, { targetSelectors: ['box'], axis: 'y', deltaDeg: 90 }, state, 'r');
    const b = validatePlan(rotateMutator, { targetSelectors: ['box'], axis: 'y', deltaDeg: 90 }, state, 'r');
    expect(a).toEqual(b);
  });

  it('precondition fails for a node with no rotation param', () => {
    const state = buildScene();
    const result = validatePlan(
      rotateMutator,
      { targetSelectors: ['scene'], axis: 'x', deltaDeg: 45 },
      state,
      'rotate scene',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(4);
  });
});

describe('translate mutator', () => {
  it('adds delta to position', () => {
    const state = buildScene();
    const result = validatePlan(
      translateMutator,
      { targetSelectors: ['box'], delta: [5, 0, 0] },
      state,
      't',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const op = result.ops[0];
      if (op.type === 'setParam') expect(op.value).toEqual([5, 0, 0]);
    }
  });
});

describe('scale mutator', () => {
  it('scales BoxMesh size by uniform factor', () => {
    const state = buildScene();
    const result = validatePlan(
      scaleMutator,
      { targetSelectors: ['box'], factor: 2 },
      state,
      's',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const op = result.ops[0];
      if (op.type === 'setParam') {
        expect(op.paramPath).toBe('size');
        expect(op.value).toEqual([2, 2, 2]);
      }
    }
  });

  it('scales SphereMesh radius', () => {
    const state = buildScene();
    const result = validatePlan(
      scaleMutator,
      { targetSelectors: ['sphere'], factor: 3 },
      state,
      's',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const op = result.ops[0];
      if (op.type === 'setParam') {
        expect(op.paramPath).toBe('radius');
        expect(op.value).toBe(3);
      }
    }
  });

  it('precondition fails for a node with no size or radius', () => {
    const state = buildScene();
    const result = validatePlan(
      scaleMutator,
      { targetSelectors: ['scene'], factor: 2 },
      state,
      's',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(4);
  });
});

describe('setMaterialColor mutator', () => {
  it('writes material.color for meshes', () => {
    const state = buildScene();
    const result = validatePlan(
      setMaterialColorMutator,
      { targetSelectors: ['box'], color: '#0000ff' },
      state,
      'paint',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const op = result.ops[0];
      if (op.type === 'setParam') {
        expect(op.paramPath).toBe('material.color');
        expect(op.value).toBe('#0000ff');
      }
    }
  });

  it('rejects non-hex color via spec validation', () => {
    // Spec validation lives at the tool boundary (proposePlanTool gate 2).
    // The validatePlan helper assumes a parsed spec, but we can exercise
    // the tool directly to confirm.
    expect(() =>
      setMaterialColorMutator.spec.parse({ targetSelectors: ['box'], color: 'red' }),
    ).toThrow();
  });
});

describe('duplicate mutator', () => {
  it('emits addNode + connect chain into the same consumer', () => {
    const state = buildScene();
    const result = validatePlan(
      duplicateMutator,
      { targetSelectors: ['box'], offset: [2, 0, 0] },
      state,
      'dup',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const addNode = result.ops.find((o) => o.type === 'addNode');
      const connect = result.ops.find((o) => o.type === 'connect');
      expect(addNode).toBeDefined();
      expect(connect).toBeDefined();
      if (addNode && addNode.type === 'addNode') {
        expect(addNode.nodeId).toBe('box_copy1');
        const params = addNode.params as { position: [number, number, number] };
        expect(params.position).toEqual([2, 0, 0]);
      }
    }
  });

  it('chained duplication does not pile suffix', () => {
    let state = buildScene();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'box_copy1',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1], position: [2, 0, 0], rotation: [0, 0, 0] },
    }).next;
    const result = validatePlan(
      duplicateMutator,
      { targetSelectors: ['box_copy1'], offset: [1, 0, 0] },
      state,
      'dup again',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const addNode = result.ops.find((o) => o.type === 'addNode');
      if (addNode && addNode.type === 'addNode') {
        expect(addNode.nodeId).toBe('box_copy2');
      }
    }
  });
});

describe('deleteNode mutator', () => {
  it('emits disconnect for each consumer, then removeNode', () => {
    const state = buildScene();
    const result = validatePlan(
      deleteNodeMutator,
      { targetSelectors: ['box'] },
      state,
      'del',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const disconnects = result.ops.filter((o) => o.type === 'disconnect');
      const removes = result.ops.filter((o) => o.type === 'removeNode');
      expect(disconnects.length).toBeGreaterThan(0);
      expect(removes).toHaveLength(1);
      // disconnect must come before removeNode (order matters for the Op layer)
      const lastDisIdx = result.ops.findLastIndex((o) => o.type === 'disconnect');
      const removeIdx = result.ops.findIndex((o) => o.type === 'removeNode');
      expect(removeIdx).toBeGreaterThan(lastDisIdx);
    }
  });

  it('refuses to delete an output anchor', () => {
    const state = buildScene();
    const result = validatePlan(
      deleteNodeMutator,
      { targetSelectors: ['scene'] },
      state,
      'del scene',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(4);
      expect(result.reason).toMatch(/output/);
    }
  });
});

// ---------------------------------------------------------------------------
// Five-gate validator
// ---------------------------------------------------------------------------

describe('validatePlan — five gates', () => {
  it('gate 1: rejects ops referencing non-existent nodes', () => {
    const state = buildScene();
    const fakeMutator = {
      ...rotateMutator,
      // Forge a mutator that references a missing id.
      build: () => [
        { type: 'setParam' as const, nodeId: 'ghost', paramPath: 'rotation', value: [0, 0, 0] },
      ],
      buildClosureSpec: () => ({ rootSelectors: ['box'], followedEdges: ['parent' as const] }),
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(1);
  });

  it('gate 2: rejects setParam values that fail paramSchema', () => {
    const state = buildScene();
    const fakeMutator = {
      ...rotateMutator,
      build: () => [
        // size must be positive — this should fail paramSchema.
        { type: 'setParam' as const, nodeId: 'box', paramPath: 'size', value: [-1, -1, -1] },
      ],
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(2);
  });

  it('gate 3: rejects ops that target a node outside the closure', () => {
    const state = buildScene();
    const fakeMutator = {
      ...rotateMutator,
      // Closure roots = ['box']; build emits an op against 'sibling'.
      build: () => [
        { type: 'setParam' as const, nodeId: 'sibling', paramPath: 'rotation', value: [45, 0, 0] },
      ],
      buildClosureSpec: () => ({ rootSelectors: ['box'], followedEdges: ['parent' as const] }),
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(3);
  });

  it('gate 4: required node type missing inside closure → reject', () => {
    const state = buildScene();
    const fakeMutator = {
      ...rotateMutator,
      contract: { ...rotateMutator.contract, requiredNodeTypes: ['Navmesh'] },
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(4);
      expect(result.reason).toMatch(/Navmesh/);
    }
  });

  it('gate 5: exception inside build() is caught and returned as gate 5', () => {
    const state = buildScene();
    const fakeMutator = {
      ...rotateMutator,
      build: () => {
        throw new Error('boom');
      },
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(5);
      expect(result.label).toBe('build_exception');
      expect(result.reason).toMatch(/boom/);
    }
  });

  it('gate 1 contract_edges: rejects when buildClosureSpec drops a required edge', () => {
    const state = buildScene();
    // Forge a Mutator whose contract requires 'parent' but whose
    // buildClosureSpec returns no edges — that's a contract violation
    // the LLM cannot cause (Mutators are statically defined) but the
    // gate guards against drift between contract and spec.
    const fakeMutator = {
      ...rotateMutator,
      contract: { ...rotateMutator.contract, requiredEdges: ['parent' as const, 'children' as const] },
      buildClosureSpec: () => ({
        rootSelectors: ['box'],
        followedEdges: ['parent' as const], // missing 'children'
      }),
    };
    const result = validatePlan(
      fakeMutator,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(1);
      expect(result.label).toBe('contract_edges');
      expect(result.reason).toMatch(/children/);
    }
  });

  it('rejection labels disambiguate the two gate-4 paths', () => {
    const state = buildScene();
    // contract_scope path: requiredNodeTypes missing in closure.
    const missingType = {
      ...rotateMutator,
      contract: { ...rotateMutator.contract, requiredNodeTypes: ['Navmesh'] },
    };
    const a = validatePlan(
      missingType,
      { targetSelectors: ['box'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.gate).toBe(4);
      expect(a.label).toBe('contract_scope');
    }

    // precondition path: scene has no rotation param.
    const b = validatePlan(
      rotateMutator,
      { targetSelectors: ['scene'], axis: 'x', deltaDeg: 0 },
      state,
      'forge',
    );
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.gate).toBe(4);
      expect(b.label).toBe('precondition');
    }
  });
});

// ---------------------------------------------------------------------------
// Tools (agent.listMutators + agent.proposePlan)
// ---------------------------------------------------------------------------

describe('agent.listMutators tool', () => {
  it('returns metadata for every registered mutator', () => {
    registerAllMutators();
    const r = listMutatorsTool.handler({}, { dagState: emptyDagState() });
    expect(r.ops).toEqual([]);
    const parsed = JSON.parse(r.text!) as { mutators: { name: string }[] };
    expect(parsed.mutators).toHaveLength(10);
  });
});

describe('agent.proposePlan tool', () => {
  it('routes a valid spec through five gates and returns ops', () => {
    registerAllMutators();
    const state = buildScene();
    const r = proposePlanTool.handler(
      {
        mutator: 'mutator.rotate',
        intent: 'rotate box 45° X',
        spec: { targetSelectors: ['box'], axis: 'x', deltaDeg: 45 },
      },
      { dagState: state },
    );
    expect(r.ops.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.text!) as { ok: boolean; closureRoots: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.closureRoots).toEqual(['box']);
  });

  it('returns structured rejection (ops:[]) on gate failure', () => {
    registerAllMutators();
    const state = buildScene();
    const r = proposePlanTool.handler(
      {
        mutator: 'mutator.rotate',
        intent: 'rotate scene',
        spec: { targetSelectors: ['scene'], axis: 'x', deltaDeg: 45 }, // scene has no rotation
      },
      { dagState: state },
    );
    expect(r.ops).toEqual([]);
    const parsed = JSON.parse(r.text!) as { ok: boolean; gate: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.gate).toBe(4);
  });

  it('returns gate-1 rejection for unknown mutator names', () => {
    registerAllMutators();
    const state = buildScene();
    const r = proposePlanTool.handler(
      { mutator: 'mutator.nonexistent', intent: 'x', spec: {} },
      { dagState: state },
    );
    expect(r.ops).toEqual([]);
    const parsed = JSON.parse(r.text!) as { ok: boolean; gate: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.gate).toBe(1);
  });

  it('returns gate-2 rejection for malformed spec', () => {
    registerAllMutators();
    const state = buildScene();
    const r = proposePlanTool.handler(
      {
        mutator: 'mutator.rotate',
        intent: 'x',
        spec: { axis: 'x', deltaDeg: 45 }, // missing targetSelectors
      },
      { dagState: state },
    );
    expect(r.ops).toEqual([]);
    const parsed = JSON.parse(r.text!) as { ok: boolean; gate: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.gate).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P3 Wave B — animation Mutators (issue #34)
// ---------------------------------------------------------------------------

import { addLayerMutator, addChannelMutator, keyframeMutator, shotCreateMutator } from './index';
import { applyOp } from '../../core/dag';

function buildSceneWithTime() {
  let s = buildScene();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  return s;
}

describe('mutator.timeline.addLayer', () => {
  it('emits addNode + disconnect + connect chain that wraps the target', () => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addLayerMutator,
      { targetSelectors: ['box'], layerName: 'BoxLayer', layerIds: ['box_layer'] },
      state,
      'wrap box',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.ops.map((o) => o.type);
    // addNode AnimationLayer + disconnect (box → scene) + connect (layer → scene)
    // + connect (box → layer.target)
    expect(types).toContain('addNode');
    expect(types).toContain('disconnect');
    // 1 disconnect + 2 connects (consumer rewire + target wire)
    expect(types.filter((t) => t === 'connect').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === 'disconnect').length).toBe(1);
    const addNodeOp = r.ops.find((o) => o.type === 'addNode');
    if (addNodeOp?.type === 'addNode') {
      expect(addNodeOp.nodeType).toBe('AnimationLayer');
      expect(addNodeOp.nodeId).toBe('box_layer');
    }
  });

  it('twice-call is deterministic for the same spec', () => {
    const state = buildSceneWithTime();
    const a = validatePlan(
      addLayerMutator,
      { targetSelectors: ['box'], layerName: 'L', layerIds: ['box_layer'] },
      state,
      'wrap',
    );
    const b = validatePlan(
      addLayerMutator,
      { targetSelectors: ['box'], layerName: 'L', layerIds: ['box_layer'] },
      state,
      'wrap',
    );
    expect(a).toEqual(b);
  });

  it('rejects re-wrapping an existing AnimationLayer (gate 4)', () => {
    let state = buildSceneWithTime();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'wrapper',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    const r = validatePlan(
      addLayerMutator,
      { targetSelectors: ['wrapper'] },
      state,
      'rewrap',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

describe('mutator.timeline.addChannel', () => {
  function stateWithLayer() {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'L' },
    }).next;
    return s;
  }

  it('creates a KeyframeChannelVec3 wired to layer + time', () => {
    const state = stateWithLayer();
    const r = validatePlan(
      addChannelMutator,
      {
        layerId: 'box_layer',
        target: 'box',
        paramPath: 'position',
        valueType: 'vec3',
        channelId: 'box_pos_channel',
        initialKeyframe: { time: 0, value: [0, 0, 0], easing: 'cubic' },
      },
      state,
      'add channel',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(3);
    const addNodeOp = r.ops[0];
    expect(addNodeOp.type).toBe('addNode');
    if (addNodeOp.type === 'addNode') {
      expect(addNodeOp.nodeType).toBe('KeyframeChannelVec3');
      expect(addNodeOp.nodeId).toBe('box_pos_channel');
    }
    // Connects: time → channel, channel → layer.animation
    const connects = r.ops.filter((o) => o.type === 'connect');
    expect(connects).toHaveLength(2);
  });

  it.each([
    ['number', 'KeyframeChannelNumber'],
    ['vec3', 'KeyframeChannelVec3'],
    ['quat', 'KeyframeChannelQuat'],
    ['color', 'KeyframeChannelColor'],
  ])('valueType=%s → nodeType=%s', (valueType, nodeType) => {
    const state = stateWithLayer();
    const validValue: Record<string, unknown> = {
      number: 1,
      vec3: [0, 0, 0],
      quat: [0, 0, 0, 1],
      color: '#ff0000',
    };
    const r = validatePlan(
      addChannelMutator,
      {
        layerId: 'box_layer',
        target: 'box',
        paramPath: 'p',
        valueType,
        initialKeyframe: { time: 0, value: validValue[valueType] },
      },
      state,
      't',
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0].type === 'addNode') {
      expect(r.ops[0].nodeType).toBe(nodeType);
    }
  });

  it('rejects when layerId is not an AnimationLayer (gate 4)', () => {
    const state = stateWithLayer();
    const r = validatePlan(
      addChannelMutator,
      { layerId: 'box', target: 'box', paramPath: 'p', valueType: 'number' },
      state,
      'wrong layer',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects mismatched initialKeyframe value shape (gate 4)', () => {
    const state = stateWithLayer();
    const r = validatePlan(
      addChannelMutator,
      {
        layerId: 'box_layer',
        target: 'box',
        paramPath: 'p',
        valueType: 'vec3',
        initialKeyframe: { time: 0, value: 1 }, // number, not vec3
      },
      state,
      'shape mismatch',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects when no TimeSource exists (gate 4)', () => {
    let s = buildScene(); // scene without TimeSource
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    const r = validatePlan(
      addChannelMutator,
      { layerId: 'box_layer', target: 'box', paramPath: 'p', valueType: 'number' },
      s,
      'no time',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

describe('mutator.timeline.keyframe', () => {
  function stateWithChannel() {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: 'box',
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'cubic' }],
      },
    }).next;
    return s;
  }

  it('appends a new keyframe and sorts by time', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 1, value: [10, 0, 0] },
      state,
      'kf',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    expect(op.paramPath).toBe('keyframes');
    const keyframes = op.value as Array<{ time: number }>;
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0].time).toBe(0);
    expect(keyframes[1].time).toBe(1);
  });

  it('replaces the sample at the same time', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 0, value: [99, 99, 99] },
      state,
      're-key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    const keyframes = op.value as Array<{ time: number; value: unknown }>;
    expect(keyframes).toHaveLength(1); // not 2
    expect(keyframes[0].value).toEqual([99, 99, 99]);
  });

  it('rejects when channelId is not a KeyframeChannel (gate 4)', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'box', time: 0, value: 1 },
      state,
      'wrong type',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects mismatched value shape (gate 4)', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 0.5, value: 1 }, // channel is vec3
      state,
      'shape',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

describe('mutator.shot.create', () => {
  function stateWithCamera() {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cam',
      nodeType: 'PerspectiveCamera',
      params: { fov: 45, near: 0.1, far: 100, position: [0, 0, 5], lookAt: [0, 0, 0] },
    }).next;
    return s;
  }

  it('emits addNode Shot + 2 connects', () => {
    const state = stateWithCamera();
    const r = validatePlan(
      shotCreateMutator,
      {
        cameraId: 'cam',
        sceneId: 'scene',
        name: 'Opening',
        startTime: 0,
        endTime: 4,
        shotId: 'shot_opening',
      },
      state,
      's',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(3);
    const addOp = r.ops[0];
    if (addOp.type !== 'addNode') throw new Error('expected addNode');
    expect(addOp.nodeId).toBe('shot_opening');
    expect(addOp.nodeType).toBe('Shot');
  });

  it('rejects endTime < startTime (gate 4)', () => {
    const state = stateWithCamera();
    const r = validatePlan(
      shotCreateMutator,
      { cameraId: 'cam', sceneId: 'scene', startTime: 5, endTime: 1 },
      state,
      's',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects when cameraId points at a non-Camera node (gate 4)', () => {
    const state = stateWithCamera();
    const r = validatePlan(
      shotCreateMutator,
      { cameraId: 'box', sceneId: 'scene' },
      state,
      's',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});
