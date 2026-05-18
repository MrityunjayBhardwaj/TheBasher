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
    // 17 = the 16 prior + `mutator.randomize` (P7.2 / issue #26 path B —
    // per-target randomization, N × P ops in one atomic dispatch).
    // The 16 reflects #60 / hetvabhasa H36's earlier collapse of
    // clearChannel + deleteKeyframe into one parameterized
    // `removeKeyframes`.
    expect(mutators).toHaveLength(17);
    const names = mutators.map((m) => m.name).sort();
    expect(names).toEqual([
      'mutator.animation.retarget',
      'mutator.deleteNode',
      'mutator.duplicate',
      'mutator.randomize',
      'mutator.render.addAIPass',
      'mutator.render.addPass',
      'mutator.render.addStitch',
      'mutator.rotate',
      'mutator.scale',
      'mutator.setMaterialColor',
      'mutator.shot.create',
      'mutator.timeline.addChannel',
      'mutator.timeline.addLayer',
      'mutator.timeline.keyframe',
      'mutator.timeline.removeKeyframes',
      'mutator.timeline.simplifyChannel',
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
      expect(
        parse.success,
        `Mutator "${m.name}" specExample failed its own spec.parse: ` +
          (parse.success ? '' : parse.error.message),
      ).toBe(true);
    }
  });

  it('V14: no two Mutators share the same contract signature', () => {
    // Mechanical guard for vyapti V14 (Mutator non-redundancy). Two
    // Mutators with identical (requiredEdges, requiredNodeTypes,
    // preserves, lossy_kinds) tuples are almost always candidates for
    // parameterization rather than fork. This converts V14 from "code
    // review" to observable enforcement at registration time.
    //
    // SIGNATURE WIDENING (issue #60 / hetvabhasa H36, 2026-05-18): the
    // signature now includes the sorted set of `lossy[].kind` strings.
    // Reason: for two Mutators that differ only in what they DESTROY
    // (e.g. append vs delete a sample), the only honest discriminator
    // lives in `lossy`. The pre-widening signature read `preserves`
    // only, so honest delete-class contracts collided and the
    // mechanically-rewarded escape was a false `preserves` token —
    // the gate was green by certifying a lie. Widening the gate's
    // input set is the structural fix; see H36's five-limbed argument.
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
        lossyKinds: [...(m.contract.lossy ?? []).map((l) => l.kind)].sort(),
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
    const a = validatePlan(
      rotateMutator,
      { targetSelectors: ['box'], axis: 'y', deltaDeg: 90 },
      state,
      'r',
    );
    const b = validatePlan(
      rotateMutator,
      { targetSelectors: ['box'], axis: 'y', deltaDeg: 90 },
      state,
      'r',
    );
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
    const result = validatePlan(scaleMutator, { targetSelectors: ['box'], factor: 2 }, state, 's');
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
    const result = validatePlan(deleteNodeMutator, { targetSelectors: ['box'] }, state, 'del');
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
      contract: {
        ...rotateMutator.contract,
        requiredEdges: ['parent' as const, 'children' as const],
      },
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
    expect(parsed.mutators).toHaveLength(17);
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

import {
  addLayerMutator,
  addChannelMutator,
  keyframeMutator,
  simplifyChannelMutator,
  removeKeyframesMutator,
  shotCreateMutator,
} from './index';
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
    const r = validatePlan(addLayerMutator, { targetSelectors: ['wrapper'] }, state, 'rewrap');
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
    const r = validatePlan(shotCreateMutator, { cameraId: 'box', sceneId: 'scene' }, state, 's');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// P4 Wave C — render Mutators (THESIS §43)
// ---------------------------------------------------------------------------

import { addPassMutator } from './builders/addPass';

function buildSceneWithJob(): DagState {
  let s = buildSceneWithTime();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: { jobId: 'job', frameStart: 0, frameEnd: 1, fps: 30 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job', socket: 'time' },
  }).next;
  return s;
}

describe('mutator.render.addPass', () => {
  it('beauty: emits addNode + 4 connect ops (scene/camera/time + job)', () => {
    const state = buildSceneWithJob();
    const r = validatePlan(
      addPassMutator,
      { jobId: 'job', passKind: 'beauty', passId: 'job_beauty' },
      state,
      'add beauty',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(5);
    const addOp = r.ops[0];
    expect(addOp.type).toBe('addNode');
    if (addOp.type === 'addNode') {
      expect(addOp.nodeType).toBe('BeautyPass');
      expect(addOp.nodeId).toBe('job_beauty');
    }
    const connects = r.ops.filter((o) => o.type === 'connect');
    expect(connects).toHaveLength(4);
    // Final connect lands on the job's pass-input socket.
    const tail = connects[connects.length - 1];
    if (tail.type === 'connect') {
      expect(tail.to).toEqual({ node: 'job', socket: 'pass-input' });
      expect(tail.from).toEqual({ node: 'job_beauty', socket: 'out' });
    }
  });

  it('id: picks IDPass node type', () => {
    const state = buildSceneWithJob();
    const r = validatePlan(addPassMutator, { jobId: 'job', passKind: 'id' }, state, 'add id');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const addOp = r.ops[0];
    if (addOp.type === 'addNode') {
      expect(addOp.nodeType).toBe('IDPass');
      expect(addOp.nodeId).toBe('job_id');
    }
  });

  it('depth: picks DepthPass node type (P5 §43 amendment, D-02)', () => {
    const state = buildSceneWithJob();
    const r = validatePlan(addPassMutator, { jobId: 'job', passKind: 'depth' }, state, 'add depth');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const addOp = r.ops[0];
    if (addOp.type === 'addNode') {
      expect(addOp.nodeType).toBe('DepthPass');
      expect(addOp.nodeId).toBe('job_depth');
    }
  });

  it('normal: picks NormalPass node type (P5 §43 amendment, D-02)', () => {
    const state = buildSceneWithJob();
    const r = validatePlan(addPassMutator, { jobId: 'job', passKind: 'normal' }, state, 'add normal');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const addOp = r.ops[0];
    if (addOp.type === 'addNode') {
      expect(addOp.nodeType).toBe('NormalPass');
      expect(addOp.nodeId).toBe('job_normal');
    }
  });

  it('twice-call deterministic for same spec', () => {
    const state = buildSceneWithJob();
    const a = validatePlan(
      addPassMutator,
      { jobId: 'job', passKind: 'beauty', passId: 'job_beauty' },
      state,
      'a',
    );
    const b = validatePlan(
      addPassMutator,
      { jobId: 'job', passKind: 'beauty', passId: 'job_beauty' },
      state,
      'a',
    );
    expect(a).toEqual(b);
  });

  it('rejects when jobId targets a non-RenderJob (gate 4)', () => {
    const state = buildSceneWithJob();
    const r = validatePlan(
      addPassMutator,
      { jobId: 'box', passKind: 'beauty' },
      state,
      'wrong target',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects when no Scene exists (gate 4)', () => {
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
      nodeId: 'job',
      nodeType: 'RenderJob',
      params: { jobId: 'job' },
    }).next;
    const r = validatePlan(addPassMutator, { jobId: 'job', passKind: 'beauty' }, s, 'no scene');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// P5 Wave C — addAIPass Mutator (THESIS §28, §44)
// ---------------------------------------------------------------------------

import { addAIPassMutator } from './builders/addAIPass';

/**
 * Build a scene with a RenderJob that already has Beauty + Depth +
 * Normal passes wired (precondition for addAIPass with stylizedRealism).
 */
function buildSceneWithJobAndPasses(): DagState {
  let s = buildSceneWithJob();
  // Add three passes via direct ops (mirroring what addPass would emit).
  for (const [id, nodeType] of [
    ['beauty', 'BeautyPass'],
    ['depth', 'DepthPass'],
    ['normal', 'NormalPass'],
  ] as const) {
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
    s = applyOp(s, {
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    }).next;
  }
  return s;
}

describe('mutator.render.addAIPass', () => {
  it('emits Prompt + ComfyUIWorkflow + 5 connect ops in order', () => {
    const state = buildSceneWithJobAndPasses();
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'cinematic cube',
      },
      state,
      'add stylized',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2 addNode + 5 connect (1 prompt → workflow + 3 pass → workflow + 1 time → workflow).
    expect(r.ops).toHaveLength(7);
    expect(r.ops[0].type).toBe('addNode');
    if (r.ops[0].type === 'addNode') {
      expect(r.ops[0].nodeType).toBe('Prompt');
    }
    expect(r.ops[1].type).toBe('addNode');
    if (r.ops[1].type === 'addNode') {
      expect(r.ops[1].nodeType).toBe('ComfyUIWorkflow');
      const params = r.ops[1].params as {
        presetId: string;
        outputPath: string;
        lastGoodFrame: number;
      };
      expect(params.presetId).toBe('stylizedRealism');
      // D-04: outputPath = ${jobOutputPath}/stylized_${sanitize(presetId)}
      expect(params.outputPath).toBe('renders/job/stylized_stylizedRealism');
      expect(params.lastGoodFrame).toBe(-1);
    }
    const connects = r.ops.slice(2).filter((o) => o.type === 'connect');
    expect(connects).toHaveLength(5);
  });

  it('inherits frame range from RenderJob when not explicitly overridden', () => {
    let s = buildSceneWithJobAndPasses();
    // Override the RenderJob's frame range.
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'job',
      paramPath: 'frameStart',
      value: 5,
    }).next;
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'job',
      paramPath: 'frameEnd',
      value: 25,
    }).next;
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'a cube',
      },
      s,
      'inherit range',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wfOp = r.ops.find(
      (o) => o.type === 'addNode' && o.nodeType === 'ComfyUIWorkflow',
    );
    if (wfOp && wfOp.type === 'addNode') {
      const params = wfOp.params as { frameStart: number; frameEnd: number };
      expect(params.frameStart).toBe(5);
      expect(params.frameEnd).toBe(25);
    }
  });

  it('rejects when a required pass is missing on the RenderJob (precondition)', () => {
    let s = buildSceneWithJob(); // no passes wired
    // Wire only Beauty + Depth (missing Normal).
    for (const [id, nodeType] of [
      ['beauty', 'BeautyPass'],
      ['depth', 'DepthPass'],
    ] as const) {
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
      s = applyOp(s, {
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: 'job', socket: 'pass-input' },
      }).next;
    }
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'a cube',
      },
      s,
      'missing pass',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.gate).toBe(4);
      expect(r.reason).toMatch(/Missing: \[normal\]/);
    }
  });

  it('rejects when jobId targets a non-RenderJob (gate 4)', () => {
    const state = buildSceneWithJobAndPasses();
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'box',
        presetId: 'stylizedRealism',
        promptText: 'x',
      },
      state,
      'wrong target',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects when presetId is unknown (zod schema rejection — gate 2)', () => {
    const state = buildSceneWithJobAndPasses();
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'anime', // not registered in v0.5
        promptText: 'a cube',
      } as unknown as Parameters<typeof validatePlan>[1],
      state,
      'unknown preset',
    );
    expect(r.ok).toBe(false);
  });

  it('twice-call deterministic for same spec', () => {
    const state = buildSceneWithJobAndPasses();
    const a = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'a cube',
        promptId: 'p_test',
        workflowId: 'wf_test',
      },
      state,
      'a',
    );
    const b = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'a cube',
        promptId: 'p_test',
        workflowId: 'wf_test',
      },
      state,
      'a',
    );
    expect(a).toEqual(b);
  });

  it('sanitizes presetId in workflow outputPath (defense-in-depth)', () => {
    const state = buildSceneWithJobAndPasses();
    const r = validatePlan(
      addAIPassMutator,
      {
        jobId: 'job',
        presetId: 'stylizedRealism',
        promptText: 'a cube',
      },
      state,
      'sanitize',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wfOp = r.ops.find((o) => o.type === 'addNode' && o.nodeType === 'ComfyUIWorkflow');
    if (wfOp && wfOp.type === 'addNode') {
      const params = wfOp.params as { outputPath: string };
      // No reserved chars survive in the constructed path.
      expect(params.outputPath).not.toMatch(/[[\].:]/);
    }
  });
});

// ---------------------------------------------------------------------------
// P5 Wave D — addStitch Mutator (THESIS §28, §44)
// ---------------------------------------------------------------------------

import { addStitchMutator } from './builders/addStitch';

function buildSceneWithJobAndWorkflow(): DagState {
  let s = buildSceneWithJobAndPasses();
  // Add a Prompt + ComfyUIWorkflow as if addAIPass had been called.
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'prompt',
    nodeType: 'Prompt',
    params: { text: 'a cube', negative: '', tags: [] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      presetId: 'stylizedRealism',
      frameStart: 0,
      frameEnd: 4,
      lastGoodFrame: -1,
      outputPath: 'renders/job/stylized_stylizedRealism',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'prompt', socket: 'out' },
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

describe('mutator.render.addStitch', () => {
  it('emits VideoStitch + 2 connect ops; outputPath defaults to ${jobOutputPath}/final.mp4', () => {
    const state = buildSceneWithJobAndWorkflow();
    const r = validatePlan(
      addStitchMutator,
      { jobId: 'job', workflowId: 'cw' },
      state,
      'add stitch',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(3);
    expect(r.ops[0].type).toBe('addNode');
    if (r.ops[0].type === 'addNode') {
      expect(r.ops[0].nodeType).toBe('VideoStitch');
      const params = r.ops[0].params as {
        codec: string;
        fps: number;
        outputPath: string;
      };
      expect(params.codec).toBe('h264');
      expect(params.outputPath).toBe('renders/job/final.mp4');
    }
    const connects = r.ops.slice(1).filter((o) => o.type === 'connect');
    expect(connects).toHaveLength(2);
  });

  it('rejects when workflowId is not a ComfyUIWorkflow', () => {
    const state = buildSceneWithJobAndWorkflow();
    const r = validatePlan(
      addStitchMutator,
      { jobId: 'job', workflowId: 'beauty' },
      state,
      'wrong type',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects when jobId is not a RenderJob', () => {
    const state = buildSceneWithJobAndWorkflow();
    const r = validatePlan(
      addStitchMutator,
      { jobId: 'box', workflowId: 'cw' },
      state,
      'wrong job',
    );
    expect(r.ok).toBe(false);
  });

  it('explicit outputPath overrides default', () => {
    const state = buildSceneWithJobAndWorkflow();
    const r = validatePlan(
      addStitchMutator,
      {
        jobId: 'job',
        workflowId: 'cw',
        outputPath: 'renders/custom/movie.mp4',
      },
      state,
      'custom path',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.ops[0].type === 'addNode') {
      const params = r.ops[0].params as { outputPath: string };
      expect(params.outputPath).toBe('renders/custom/movie.mp4');
    }
  });

  it('twice-call deterministic for same spec', () => {
    const state = buildSceneWithJobAndWorkflow();
    const a = validatePlan(
      addStitchMutator,
      { jobId: 'job', workflowId: 'cw', stitchId: 's' },
      state,
      'a',
    );
    const b = validatePlan(
      addStitchMutator,
      { jobId: 'job', workflowId: 'cw', stitchId: 's' },
      state,
      'a',
    );
    expect(a).toEqual(b);
  });
});

describe('mutator.timeline.simplifyChannel', () => {
  function numberChannelWith(
    keyframes: Array<{ time: number; value: number; easing?: 'linear' | 'cubic' }>,
  ): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        keyframes: keyframes.map((k) => ({ time: k.time, value: k.value, easing: k.easing ?? 'linear' })),
      },
    }).next;
    return s;
  }

  function vec3ChannelWith(
    keyframes: Array<{ time: number; value: [number, number, number] }>,
  ): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
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
        keyframes: keyframes.map((k) => ({ time: k.time, value: k.value, easing: 'cubic' })),
      },
    }).next;
    return s;
  }

  it('drops collinear interior keyframes on a Number channel', () => {
    // 5 keyframes on a straight line — RDP should keep endpoints only.
    const state = numberChannelWith([
      { time: 0, value: 0 },
      { time: 0.25, value: 0.25 },
      { time: 0.5, value: 0.5 },
      { time: 0.75, value: 0.75 },
      { time: 1, value: 1 },
    ]);
    const r = validatePlan(simplifyChannelMutator, { channelId: 'ch', tolerance: 0.01 }, state, 'simplify');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    const keyframes = op.value as Array<{ time: number; value: number }>;
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0].time).toBe(0);
    expect(keyframes[1].time).toBe(1);
  });

  it('keeps a peak that exceeds tolerance', () => {
    // V-shape: midpoint deviates from the (0,0)→(1,0) line by 1 unit.
    const state = numberChannelWith([
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ]);
    const r = validatePlan(simplifyChannelMutator, { channelId: 'ch', tolerance: 0.01 }, state, 'peak');
    // Peak deviates well beyond tolerance → all 3 kept; nothing to simplify → no ops.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(0);
  });

  it('aggressive tolerance flattens everything to endpoints', () => {
    const state = numberChannelWith([
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ]);
    const r = validatePlan(simplifyChannelMutator, { channelId: 'ch', tolerance: 1 }, state, 'flat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    const keyframes = op.value as Array<{ time: number }>;
    expect(keyframes).toHaveLength(2);
  });

  it('preserves a constant axis on Vec3 (3D distance, not per-axis)', () => {
    // y is constant; x/z trace a 5-step segment along x with deviation
    // small enough that RDP simplifies the line.
    const state = vec3ChannelWith([
      { time: 0, value: [0, 5, 0] },
      { time: 0.25, value: [0.25, 5, 0] },
      { time: 0.5, value: [0.5, 5, 0] },
      { time: 0.75, value: [0.75, 5, 0] },
      { time: 1, value: [1, 5, 0] },
    ]);
    const r = validatePlan(simplifyChannelMutator, { channelId: 'ch', tolerance: 0.01 }, state, 'vec3 line');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    const keyframes = op.value as Array<{ time: number; value: [number, number, number] }>;
    expect(keyframes).toHaveLength(2);
    // Both endpoints' y must still be 5.
    expect(keyframes[0].value[1]).toBe(5);
    expect(keyframes[1].value[1]).toBe(5);
  });

  it('returns no-op for Quat / Color channels (skipped in v0.5)', () => {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch_q',
      nodeType: 'KeyframeChannelQuat',
      params: {
        name: 'rot',
        target: 'box',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0, 1], easing: 'cubic' },
          { time: 0.5, value: [0, 0.707, 0, 0.707], easing: 'cubic' },
          { time: 1, value: [0, 1, 0, 0], easing: 'cubic' },
        ],
      },
    }).next;
    const r = validatePlan(simplifyChannelMutator, { channelId: 'ch_q', tolerance: 0.5 }, s, 'quat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(0);
  });

  it('rejects when channelId is not a KeyframeChannel (gate 4)', () => {
    const state = numberChannelWith([{ time: 0, value: 0 }]);
    const r = validatePlan(simplifyChannelMutator, { channelId: 'box', tolerance: 0.1 }, state, 'wrong type');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mutator.timeline.removeKeyframes — parameterized "remove keyframes by
// scope": scope:'all' supersedes the pre-P7 clearChannel Mutator (Blender
// Shift-Alt-I Clear); scope:{time} supersedes the P7-Wave-B deleteKeyframe
// Mutator (Blender Alt-I delete-at-playhead). Provenance: issue #60 /
// hetvabhasa H36 — V14's signature was widened to read `lossy[].kind`
// and caught the two as parameterization candidates of the same
// destructive op at different scales.
// ---------------------------------------------------------------------------

describe('mutator.timeline.removeKeyframes', () => {
  function stateWith2NumberSamples(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    return s;
  }

  function stateWith3Vec3Samples(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
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
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'cubic' },
          { time: 1, value: [10, 0, 0], easing: 'cubic' },
          { time: 2, value: [20, 0, 0], easing: 'cubic' },
        ],
      },
    }).next;
    return s;
  }

  // --- scope: 'all' (was clearChannel) ----------------------------------

  it("scope:'all' emits setParam(keyframes, []) on a populated channel", () => {
    const state = stateWith2NumberSamples();
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'ch', scope: 'all' },
      state,
      'clear',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    expect(op.paramPath).toBe('keyframes');
    expect(op.value).toEqual([]);
  });

  it("scope:'all' is a no-op when channel is already empty", () => {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'layer',
      nodeType: 'AnimationLayer',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: { name: 'val', target: 'box', paramPath: 'opacity', keyframes: [] },
    }).next;
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'ch', scope: 'all' },
      s,
      'noop',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(0);
  });

  // --- scope: { time } (was deleteKeyframe) -----------------------------

  it('scope:{time} removes the sample at an existing time → 2 samples, one setParam op', () => {
    const state = stateWith3Vec3Samples();
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'ch', scope: { time: 1 } },
      state,
      'del key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    expect(op.paramPath).toBe('keyframes');
    const keyframes = op.value as Array<{ time: number }>;
    expect(keyframes).toHaveLength(2);
    expect(keyframes.map((k) => k.time)).toEqual([0, 2]);
  });

  it('scope:{time} is a no-op when no sample exists at time (Blender Alt-I parity)', () => {
    const state = stateWith3Vec3Samples();
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'ch', scope: { time: 1.5 } },
      state,
      'del non-existent',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(0); // [] — state byte-unchanged, not a hard fail
  });

  // --- preconditions (gate 4) -------------------------------------------

  it('rejects when channelId is not a KeyframeChannel (gate 4)', () => {
    const state = stateWith3Vec3Samples();
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'box', scope: 'all' },
      state,
      'wrong type',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects when channelId is missing from DAG (gate 4)', () => {
    const state = stateWith3Vec3Samples();
    const r = validatePlan(
      removeKeyframesMutator,
      { channelId: 'nonexistent', scope: 'all' },
      state,
      'missing',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  // --- registration -----------------------------------------------------

  it('is registered inside registerAllMutators() — V14 loop is NOT blind to it', () => {
    // The V14 collision loop iterates `listMutators()` AFTER
    // `registerAllMutators()`; a Mutator registered only at a separate
    // boot-time call list would be invisible to it. Asserting
    // membership here guarantees the V14 assertion exercises
    // removeKeyframes' (now-honest) signature.
    registerAllMutators();
    const names = listMutators().map((m) => m.name);
    expect(names).toContain('mutator.timeline.removeKeyframes');
    expect(names).not.toContain('mutator.timeline.clearChannel'); // retired
    expect(names).not.toContain('mutator.timeline.deleteKeyframe'); // retired
  });
});

// ---------------------------------------------------------------------------
// V14 DEEPER NON-REDUNDANCY — Op-shape probe (issue #22)
//
// The contract-signature guard above ("V14: no two Mutators share the same
// contract signature") catches contract clones. It does NOT catch the
// deeper smell: two Mutators whose contract signatures DIFFER (a tweaked
// `preserves`, a different `requiredNodeTypes`) but which still emit an
// IDENTICAL Op-shape on a real probe scene. That is a
// parameterization-vs-fork case the mechanical signature cannot see — the
// exact class issue #60 surfaced one level up (clearChannel vs
// deleteKeyframe were the same destructive op at different scales; the
// only honest discriminator lived in `lossy`, not in the op stream).
//
// This probe runs each registered Mutator through `validatePlan` on a
// scene topology it actually applies to, reduces `plan.ops` to a
// structural shape signature (type + paramPath / socket shape / nodeType;
// ids, values and literals stripped), and asserts no two Mutators share an
// identical signature.
//
// FIRST RUN FINDING (resolved, see `shapeSignature` below): the raw
// op-shape signature collided keyframe vs simplifyChannel — both emit
// `[setParam('keyframes', …)]` because a channel's whole keyframes array
// is one value-typed param. Classified as a legitimate
// same-shape-different-domain case (their honest discriminator lives in
// the contract's preserves/lossy, NOT the op vocabulary — unlike #60
// where BOTH matched). Per the issue's own "accept a per-type signature"
// caveat, the signature now appends the same honest contract
// discriminator the contract-signature V14 already uses. A collision
// here therefore still means a real #60-class finding (op-shape AND
// discriminator both match).
//
// Architecture decision (the issue's "small architecture decision"): NO
// production `probeSpec` hook on MutatorDefinition — that would touch all
// 16 builders for a test-only concern. Instead the probe table lives
// here, reusing the existing scene builders (different Mutators
// legitimately need different topologies — that is why those builders
// exist). Two extra local builders (`buildSceneWithChannel`,
// `buildSceneForRetarget`) cover the channel-family and retarget
// topologies the 5 render/scene builders do not carry.
//
// Completeness guard (the H36 lesson — a probe tuned-to-green or gone
// blind is worthless): every name in `listMutators()` MUST have a
// probe-table entry, exactly like the registration-membership guard from
// #60. A new Mutator added without a probe entry fails CI.
// ---------------------------------------------------------------------------

import {
  rotateMutator as _rotateM,
  translateMutator as _translateM,
  scaleMutator as _scaleM,
  setMaterialColorMutator as _setColorM,
  duplicateMutator as _dupM,
  deleteNodeMutator as _delM,
  addLayerMutator as _addLayerM,
  addChannelMutator as _addChannelM,
  keyframeMutator as _keyframeM,
  simplifyChannelMutator as _simplifyM,
  removeKeyframesMutator as _removeKfM,
  shotCreateMutator as _shotM,
  retargetMutator as _retargetM,
  addPassMutator as _addPassM,
  addAIPassMutator as _addAIPassM,
  addStitchMutator as _addStitchM,
  randomizeMutator as _randomizeM,
} from './index';
import type { MutatorDefinition, MutatorValidationResult } from './index';
import type { Op } from '../../core/dag/types';

describe('V14 deeper non-redundancy — Op-shape probe (issue #22)', () => {
  // A channel scene: collinear KeyframeChannelNumber so simplifyChannel
  // actually emits a setParam (a flat/no-op channel would emit zero ops
  // and the probe would compare empty signatures). Has a populated
  // channel `ch` for keyframe / simplifyChannel / removeKeyframes, plus a
  // bare AnimationLayer `box_layer` for addChannel.
  function buildSceneWithChannel(): DagState {
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
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        // 5 collinear samples — RDP drops the 3 interior ones, so
        // simplifyChannel emits a real setParam (not a no-op).
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 0.25, value: 0.25, easing: 'linear' },
          { time: 0.5, value: 0.5, easing: 'linear' },
          { time: 0.75, value: 0.75, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    return s;
  }

  // retarget needs an AnimationClip + two Skeletons + a TimeSource.
  // buildSceneWithTime already carries `time`; Skeleton / AnimationClip
  // default params are valid as-is.
  function buildSceneForRetarget(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'src_skel',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'tgt_skel',
      nodeType: 'Skeleton',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'src_clip',
      nodeType: 'AnimationClip',
      params: {},
    }).next;
    return s;
  }

  // Probe table: every registered Mutator → a builder that yields a scene
  // it applies to + a real, valid spec resolving against THAT scene's
  // node ids (adapted from each Mutator's specExample). A probe spec that
  // gate-rejects is a broken probe → the test fails loudly with the
  // rejection reason; it is never skipped.
  interface ProbeEntry {
    mutator: MutatorDefinition<unknown>;
    build: () => DagState;
    spec: unknown;
  }

  const PROBE_TABLE: Record<string, ProbeEntry> = {
    'mutator.rotate': {
      mutator: _rotateM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'], axis: 'y', deltaDeg: 45 },
    },
    'mutator.translate': {
      mutator: _translateM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'], delta: [1, 0, 0] },
    },
    'mutator.scale': {
      mutator: _scaleM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'], factor: 2 },
    },
    'mutator.setMaterialColor': {
      mutator: _setColorM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'], color: '#00ff00' },
    },
    'mutator.duplicate': {
      mutator: _dupM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'], offset: [1, 0, 0] },
    },
    'mutator.deleteNode': {
      mutator: _delM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { targetSelectors: ['box'] },
    },
    'mutator.timeline.addLayer': {
      mutator: _addLayerM as MutatorDefinition<unknown>,
      build: buildSceneWithTime,
      spec: { targetSelectors: ['box'], layerName: 'BoxLayer', layerIds: ['box_layer'] },
    },
    'mutator.timeline.addChannel': {
      mutator: _addChannelM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: {
        layerId: 'box_layer',
        target: 'box',
        paramPath: 'position',
        valueType: 'vec3',
        channelId: 'box_pos_channel',
        initialKeyframe: { time: 0, value: [0, 0, 0], easing: 'cubic' },
      },
    },
    'mutator.timeline.keyframe': {
      mutator: _keyframeM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', time: 0.5, value: 9 },
    },
    'mutator.timeline.simplifyChannel': {
      mutator: _simplifyM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', tolerance: 0.01 },
    },
    'mutator.timeline.removeKeyframes': {
      mutator: _removeKfM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', scope: { time: 0.5 } },
    },
    'mutator.shot.create': {
      mutator: _shotM as MutatorDefinition<unknown>,
      build: buildSceneWithJob,
      spec: {
        cameraId: 'cam',
        sceneId: 'scene',
        name: 'Opening',
        startTime: 0,
        endTime: 4,
        shotId: 'shot_opening',
      },
    },
    'mutator.animation.retarget': {
      mutator: _retargetM as MutatorDefinition<unknown>,
      build: buildSceneForRetarget,
      spec: {
        sourceClipId: 'src_clip',
        sourceSkeletonId: 'src_skel',
        targetSkeletonId: 'tgt_skel',
        mapPresetId: 'mixamoToGltf',
        outputClipId: 'src_clip_retargeted',
      },
    },
    'mutator.render.addPass': {
      mutator: _addPassM as MutatorDefinition<unknown>,
      build: buildSceneWithJob,
      spec: { jobId: 'job', passKind: 'beauty', passId: 'job_beauty' },
    },
    'mutator.render.addAIPass': {
      mutator: _addAIPassM as MutatorDefinition<unknown>,
      build: buildSceneWithJobAndPasses,
      spec: { jobId: 'job', presetId: 'stylizedRealism', promptText: 'cinematic cube' },
    },
    'mutator.render.addStitch': {
      mutator: _addStitchM as MutatorDefinition<unknown>,
      build: buildSceneWithJobAndWorkflow,
      spec: { jobId: 'job', workflowId: 'cw' },
    },
    // P7.2 — issue #26 path B. `box` + `sibling` are both BoxMesh
    // (material.color + rotation vec3 + size vec3 → all three properties
    // compatible per canColor/canRotation/canScale). Deliberately NOT
    // `sphere` (SphereMesh lacks `rotation` → D-10 gate-4 reject → 0 ops
    // → probe goes blind, the exact #22-sister of H36). Seed pinned so
    // the probe sees a deterministic 6-op stream every run.
    'mutator.randomize': {
      mutator: _randomizeM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: {
        targetSelectors: ['box', 'sibling'],
        properties: ['color', 'rotation', 'scale'],
        ranges: {
          color: { h: [0, 360], s: [0.5, 1], l: [0.4, 0.6] },
          rotation: { axis: 'random', degRange: [0, 360] },
          scale: { factor: [0.5, 1.5] },
        },
        seed: 42,
      },
    },
  };

  // Reduce one Op to a structural shape token: keep STRUCTURE
  // (type, paramPath, socket names, nodeType), strip ids / values /
  // literals. The granularity is deliberate — nodeType + paramPath +
  // socket shape is what distinguishes a parameterization (same shape,
  // different scale) from a legitimate distinct op (different domain).
  function opShape(op: Op): unknown {
    switch (op.type) {
      case 'addNode':
        return { type: 'addNode', nodeType: op.nodeType };
      case 'removeNode':
        return { type: 'removeNode' };
      case 'setParam':
        return { type: 'setParam', paramPath: op.paramPath };
      case 'connect':
        return {
          type: 'connect',
          fromSocket: op.from.socket,
          toSocket: op.to.socket,
        };
      case 'disconnect':
        return {
          type: 'disconnect',
          fromSocket: op.from.socket,
          toSocket: op.to.socket,
        };
      default: {
        // Exhaustiveness: a new Op variant must extend this reducer or
        // the probe silently goes blind to it (the H36 trap one level
        // down). Fail loudly instead.
        const _exhaustive: never = op;
        throw new Error(`opShape: unhandled Op variant ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // The probe surfaced a real, expected finding (issue #22): `keyframe`
  // and `simplifyChannel` emit an IDENTICAL raw op stream
  // `[setParam('keyframes', …)]`. Classification: this is a LEGITIMATE
  // same-shape-different-domain case, NOT a true redundancy, and it is
  // structurally different from the #60 (clearChannel/deleteKeyframe)
  // collapse:
  //
  //   - #60: identical CONTRACT signature (same preserves AND same
  //     lossy) AND identical op-shape → genuinely the same destructive
  //     op at two scales → correctly parameterized into one Mutator.
  //
  //   - #22 here: the op stream is identical only because a channel's
  //     entire `keyframes` array is a single value-typed param, so
  //     EVERY channel edit is one `setParam('keyframes', …)`. The op
  //     vocabulary physically cannot carry the distinction. But the
  //     CONTRACT signatures already differ honestly and load-bearingly:
  //     `keyframe` preserves animation-shape + keyframe-density with no
  //     lossy (append/replace one sample); `simplifyChannel` drops
  //     keyframe-density and carries lossy:['keyframe-density'] (RDP
  //     reduction). Different operations, same mechanical op token.
  //
  // Resolution per the issue's OWN caveat ("the test must group by node
  // type or accept a per-type signature"): the probe signature carries
  // the op-shape AS PRIMARY signal and APPENDS the same honest
  // discriminator the contract-signature V14 already uses (sorted
  // preserves + sorted lossy kinds). This is the inverse of the H36
  // trap: H36 was REMOVING a real discriminator to go green; here we
  // ADD the already-established honest discriminator so the deeper
  // probe stops false-positiving on a pair the shallower check already
  // separates correctly. The probe stays genuine — two Mutators with
  // identical op-shape AND identical contract discriminator still
  // collide here, which IS the real #60-class redundancy finding.
  function contractDiscriminator(m: MutatorDefinition<unknown>): unknown {
    return {
      preserves: [...m.contract.preserves].sort(),
      lossyKinds: [...(m.contract.lossy ?? []).map((l) => l.kind)].sort(),
    };
  }

  function shapeSignature(ops: Op[], m: MutatorDefinition<unknown>): string {
    return JSON.stringify({
      ops: ops.map(opShape),
      contract: contractDiscriminator(m),
    });
  }

  it('completeness guard: every registered Mutator has a probe-table entry', () => {
    // The H36 lesson, applied to the probe itself: a Mutator added
    // without a probe entry would make this deeper V14 check blind to
    // it — exactly like the registration-membership guard #60 added for
    // the contract-signature loop. New Mutator without a probe entry →
    // CI fails here.
    registerAllMutators();
    const registered = listMutators()
      .map((m) => m.name)
      .sort();
    const probed = Object.keys(PROBE_TABLE).sort();
    expect(probed).toEqual(registered);
  });

  it('no two Mutators emit an identical Op-shape signature on a probe scene', () => {
    registerAllMutators();
    const seen = new Map<string, string>();

    for (const [name, entry] of Object.entries(PROBE_TABLE)) {
      const scene = entry.build();
      const result: MutatorValidationResult = validatePlan(
        entry.mutator,
        entry.spec,
        scene,
        `probe:${name}`,
      );

      // A probe spec that gate-rejects is a BROKEN probe, not a pass —
      // fail loudly with the rejection so the table gets fixed, never
      // skip (skipping is how a probe goes blind).
      expect(
        result.ok,
        `Probe spec for "${name}" was gate-rejected — broken probe, fix the ` +
          `probe table entry. ` +
          (result.ok
            ? ''
            : `gate ${result.gate} (${result.label}): ${result.reason}`),
      ).toBe(true);
      if (!result.ok) continue;

      const sig = shapeSignature(result.ops, entry.mutator);
      const prior = seen.get(sig);
      // On collision: BOTH names + the shared signature (mirrors the
      // contract-signature V14 message style). A collision here means
      // the two Mutators emit the same op-shape AND carry the same
      // honest contract discriminator — i.e. the real #60-class
      // parameterization-vs-fork finding. Do NOT tune the reducer to
      // hide it; surface it for the orchestrator to classify.
      expect(
        prior,
        `Mutators "${name}" and "${prior}" emit an identical Op-shape ` +
          `signature AND share the same contract discriminator on their ` +
          `probe scenes: ${sig}. This is a genuine parameterization-vs-fork ` +
          `finding (issue #22 / the #60 pattern) — the op stream AND the ` +
          `honest preserves/lossy discriminator both match. Investigate ` +
          `(parameterize, like removeKeyframes did) before silencing.`,
      ).toBeUndefined();
      seen.set(sig, name);
    }
  });
});
