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
  it('registerAllMutators registers six starter mutators', () => {
    registerAllMutators();
    const mutators = listMutators();
    expect(mutators).toHaveLength(6);
    const names = mutators.map((m) => m.name).sort();
    expect(names).toEqual([
      'mutator.deleteNode',
      'mutator.duplicate',
      'mutator.rotate',
      'mutator.scale',
      'mutator.setMaterialColor',
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
      expect(result.reason).toMatch(/boom/);
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
    expect(parsed.mutators).toHaveLength(6);
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
