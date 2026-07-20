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
import { randomizeMutator } from './builders/randomize';
import { retargetMutator } from './builders/retarget';
import { addModifierMutator } from './builders/addModifier';
import { addChannelModifierMutator } from './builders/addChannelModifier';
import { setChannelExtendMutator } from './builders/setChannelExtend';
import { setKeyframeInterpMutator } from './builders/setKeyframeInterp';
import { createActionMutator } from './builders/createAction';
import { addStripMutator } from './builders/addStrip';
import { setStripTimingMutator } from './builders/setStripTiming';
import { setStripBlendMutator } from './builders/setStripBlend';
import { setTrackStateMutator } from './builders/setTrackState';
import { enumerateModifierStack, findConsumer } from '../../app/operatorStack';
import { getBoneNameMapPreset } from '../../core/import/boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';
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
    // 26 = the prior 21 + the five #283 Phase 4 NLA mutators: 4A createAction+addStrip,
    // 4B setStripTiming+setStripBlend, 4C setTrackState. (21 was 20 + `setKeyframeInterp`;
    // 20 was 19 + `setChannelExtend`; 19 was 18 + `addChannelModifier`; 18 was 17 +
    // `geometry.addModifier`; 17 = pre-#199 18 − `addLayer`.)
    expect(mutators).toHaveLength(26);
    const names = mutators.map((m) => m.name).sort();
    expect(names).toEqual([
      'mutator.animation.retarget',
      'mutator.deleteNode',
      'mutator.duplicate',
      'mutator.geometry.addModifier',
      'mutator.nla.addStrip',
      'mutator.nla.createAction',
      'mutator.nla.setStripBlend',
      'mutator.nla.setStripTiming',
      'mutator.nla.setTrackState',
      'mutator.randomize',
      'mutator.render.addAIPass',
      'mutator.render.addPass',
      'mutator.render.addStitch',
      'mutator.rotate',
      'mutator.scale',
      'mutator.setMaterialColor',
      'mutator.shot.create',
      'mutator.timeline.addChannel',
      'mutator.timeline.addChannelModifier',
      'mutator.timeline.bakeGltfChannel',
      'mutator.timeline.keyframe',
      'mutator.timeline.removeKeyframes',
      'mutator.timeline.setChannelExtend',
      'mutator.timeline.setKeyframeInterp',
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

describe('addModifier mutator (geometry OperatorStack — #209)', () => {
  function applyOps(
    state: DagState,
    ops: ReturnType<typeof validatePlan> extends { ops: infer O } ? O : never,
  ): DagState {
    return (ops as { type: string }[]).reduce((s, op) => applyOp(s, op as never).next, state);
  }

  it('passes all five gates and wires Box → ArrayModifier → Scene', () => {
    const state = buildScene();
    const result = validatePlan(
      addModifierMutator,
      { target: 'box', modifierType: 'ArrayModifier', count: 3, offset: [2, 0, 0] },
      state,
      'array the box',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // addNode(ArrayModifier) + disconnect + 2× connect.
    expect(result.ops.some((o) => o.type === 'addNode')).toBe(true);
    const next = applyOps(state, result.ops);
    const stack = enumerateModifierStack(next, 'box');
    expect(stack).toHaveLength(1);
    expect(stack[0].type).toBe('ArrayModifier');
    // The box now feeds the modifier; the modifier feeds the scene's children.
    expect(findConsumer(next, 'box')).toEqual({ node: stack[0].nodeId, socket: 'target' });
    expect(findConsumer(next, stack[0].nodeId)).toEqual({ node: 'scene', socket: 'children' });
  });

  it('mints a deterministic modifierId (target + short type)', () => {
    const state = buildScene();
    const result = validatePlan(
      addModifierMutator,
      { target: 'box', modifierType: 'ArrayModifier' },
      state,
      'array',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const add = result.ops.find((o) => o.type === 'addNode');
    expect(add && add.type === 'addNode' ? add.nodeId : null).toBe('box_array');
  });

  it('precondition fails for an unknown target', () => {
    const state = buildScene();
    const result = validatePlan(
      addModifierMutator,
      { target: 'ghost', modifierType: 'ArrayModifier' },
      state,
      'array ghost',
    );
    expect(result.ok).toBe(false);
  });

  it('wires a MirrorModifier with its axis param (and does not leak Array params)', () => {
    const state = buildScene();
    const result = validatePlan(
      addModifierMutator,
      // offset is Array's Vec3 param — it must NOT reach the Mirror node (whose
      // schema expects a scalar offset). Only `axis` is relevant to a Mirror.
      { target: 'box', modifierType: 'MirrorModifier', axis: 'z', offset: [2, 0, 0] },
      state,
      'mirror the box',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const add = result.ops.find((o) => o.type === 'addNode');
    expect(add && add.type === 'addNode' ? add.params : null).toEqual({ axis: 'z' });
    const next = applyOps(state, result.ops);
    const stack = enumerateModifierStack(next, 'box');
    expect(stack).toHaveLength(1);
    expect(stack[0].type).toBe('MirrorModifier');
  });
});

describe('addChannelModifier mutator (F-Modifier stack — #281 / V88 D2)', () => {
  function applyOps(state: DagState, ops: { type: string }[]): DagState {
    return ops.reduce((s, op) => applyOp(s, op as never).next, state);
  }
  function channelScene(
    type: 'KeyframeChannelNumber' | 'KeyframeChannelVec3',
    modifiers?: unknown[],
  ): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: type,
      params: {
        name: 'val',
        target: 'box',
        paramPath: type === 'KeyframeChannelVec3' ? 'position' : 'opacity',
        keyframes:
          type === 'KeyframeChannelVec3'
            ? [{ time: 0, value: [5, 0, 0], easing: 'linear' }]
            : [{ time: 0, value: 5, easing: 'linear' }],
        ...(modifiers ? { modifiers } : {}),
      },
    }).next;
    return s;
  }

  it('appends a defaulted noise modifier via one setParam("modifiers")', () => {
    const state = channelScene('KeyframeChannelNumber');
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'noise' },
      state,
      'add noise',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    expect(op.type === 'setParam' && op.paramPath).toBe('modifiers');
    if (op.type !== 'setParam') return;
    const mods = op.value as Array<{ type: string; strength: number }>;
    expect(mods).toHaveLength(1);
    // defaultModifier('noise') defaults — the single wiring authority.
    expect(mods[0].type).toBe('noise');
    expect(mods[0].strength).toBe(1);
  });

  it('applies overrides onto the default (author a tuned modifier in one call)', () => {
    const state = channelScene('KeyframeChannelNumber');
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'noise', overrides: { strength: 3, offset: 10 } },
      state,
      'add tuned noise',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const m = (r.ops[0].value as Array<Record<string, number>>)[0];
    expect(m.strength).toBe(3);
    expect(m.offset).toBe(10);
    expect(m.scale).toBe(1); // untouched default preserved
  });

  it('appends to an existing stack, preserving order', () => {
    const state = channelScene('KeyframeChannelNumber', [
      { type: 'noise', blend: 'add', strength: 1, scale: 1, phase: 0, offset: 0, depth: 1 },
    ]);
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'generator' },
      state,
      'append generator',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const mods = r.ops[0].value as Array<{ type: string }>;
    expect(mods.map((m) => m.type)).toEqual(['noise', 'generator']);
  });

  it('inserts at an explicit index', () => {
    const state = channelScene('KeyframeChannelNumber', [
      { type: 'generator', additive: true, coefficients: [0, 1] },
    ]);
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'noise', index: 0 },
      state,
      'prepend noise',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const mods = r.ops[0].value as Array<{ type: string }>;
    expect(mods.map((m) => m.type)).toEqual(['noise', 'generator']);
  });

  it('rejects an out-of-range index', () => {
    const state = channelScene('KeyframeChannelNumber');
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'noise', index: 5 },
      state,
      'bad index',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an override that violates the modifier schema', () => {
    const state = channelScene('KeyframeChannelNumber');
    // depth is int 1..8; 99 is out of range → merged modifier fails FModifierSchema.
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'noise', overrides: { depth: 99 } },
      state,
      'bad override',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a channel type with no modifier stack (Quat)', () => {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'qch',
      nodeType: 'KeyframeChannelQuat',
      params: { name: 'rot', target: 'box', paramPath: 'quaternion' },
    }).next;
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'qch', modifierType: 'noise' },
      s,
      'quat noise',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown channel', () => {
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ghost', modifierType: 'noise' },
      buildSceneWithTime(),
      'ghost',
    );
    expect(r.ok).toBe(false);
  });

  it('works on a Vec3 channel (per-component stack)', () => {
    const state = channelScene('KeyframeChannelVec3');
    const r = validatePlan(
      addChannelModifierMutator,
      { channelId: 'ch', modifierType: 'stepped' },
      state,
      'vec3 stepped',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyOps(state, r.ops as { type: string }[]);
    const mods = (next.nodes['ch'].params as { modifiers: Array<{ type: string }> }).modifiers;
    expect(mods.map((m) => m.type)).toEqual(['stepped']);
  });

  it('is deterministic (same spec → identical ops)', () => {
    const state = channelScene('KeyframeChannelNumber');
    const spec = { channelId: 'ch', modifierType: 'noise' as const, overrides: { strength: 2 } };
    const a = validatePlan(addChannelModifierMutator, spec, state, 'x');
    const b = validatePlan(addChannelModifierMutator, spec, state, 'x');
    expect(a.ok && b.ok && JSON.stringify(a.ops) === JSON.stringify(b.ops)).toBe(true);
  });
});

describe('setChannelExtend mutator (per-side extrapolation — #281 / V88 D1)', () => {
  function channelScene(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        keyframes: [{ time: 0, value: 5, easing: 'linear' }],
      },
    }).next;
    return s;
  }

  it('sets both sides via setParam(extendBefore)+(extendAfter)', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'ch', before: 'slope', after: 'hold' },
      channelScene(),
      'extend',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toEqual([
      { type: 'setParam', nodeId: 'ch', paramPath: 'extendBefore', value: 'slope' },
      { type: 'setParam', nodeId: 'ch', paramPath: 'extendAfter', value: 'hold' },
    ]);
  });

  it('emits only the provided side', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'ch', after: 'slope' },
      channelScene(),
      'after only',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toEqual([
      { type: 'setParam', nodeId: 'ch', paramPath: 'extendAfter', value: 'slope' },
    ]);
  });

  it('rejects a spec with neither side (gate 2)', () => {
    const r = validatePlan(setChannelExtendMutator, { channelId: 'ch' }, channelScene(), 'none');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown channel', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'ghost', before: 'hold' },
      buildSceneWithTime(),
      'ghost',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a channel type with no extend rule (Quat)', () => {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'qch',
      nodeType: 'KeyframeChannelQuat',
      params: { name: 'rot', target: 'box', paramPath: 'quaternion' },
    }).next;
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'qch', after: 'slope' },
      s,
      'quat extend',
    );
    expect(r.ok).toBe(false);
  });

  // #289 — per-axis targeting on a vec channel.
  function vec3ChannelScene(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'vch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: 'box',
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
    }).next;
    return s;
  }

  it('axis: writes a dense axisExtend array, target axis set, others null', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'vch', axis: 0, after: 'slope' },
      vec3ChannelScene(),
      'per-axis',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // before omitted → falls back to the channel-level 'hold'; other axes stay null.
    expect(r.ops).toEqual([
      {
        type: 'setParam',
        nodeId: 'vch',
        paramPath: 'axisExtend',
        value: [{ before: 'hold', after: 'slope' }, null, null],
      },
    ]);
  });

  it('axis: rejects a scalar Number channel (no axes)', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'ch', axis: 0, after: 'slope' },
      channelScene(),
      'axis on scalar',
    );
    expect(r.ok).toBe(false);
  });

  it('axis: rejects an out-of-range index', () => {
    const r = validatePlan(
      setChannelExtendMutator,
      { channelId: 'vch', axis: 3, after: 'slope' },
      vec3ChannelScene(),
      'axis oor',
    );
    expect(r.ok).toBe(false);
  });
});

describe('setKeyframeInterp mutator (per-keyframe interp/ease/handle — #281 / V88 D1)', () => {
  function channelScene(
    keys: Array<{ time: number; value: number; easing?: string; handleType?: string }>,
  ): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        keyframes: keys.map((k) => ({
          time: k.time,
          value: k.value,
          easing: k.easing ?? 'linear',
          ...(k.handleType ? { handleType: k.handleType } : {}),
        })),
      },
    }).next;
    return s;
  }

  it('sets easing on ALL keys, preserving time + value', () => {
    const state = channelScene([
      { time: 0, value: 0 },
      { time: 1, value: 10 },
    ]);
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'ch', scope: 'all', easing: 'back', ease: 'out' },
      state,
      'ease all',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const next = r.ops[0].value as Array<{
      time: number;
      value: number;
      easing: string;
      ease: string;
    }>;
    expect(next).toEqual([
      { time: 0, value: 0, easing: 'back', ease: 'out' },
      { time: 1, value: 10, easing: 'back', ease: 'out' },
    ]);
  });

  it('sets interp on only the key AT a given time (scope {time})', () => {
    const state = channelScene([
      { time: 0, value: 0 },
      { time: 1, value: 10 },
    ]);
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'ch', scope: { time: 1 }, easing: 'constant' },
      state,
      'step the second key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const next = r.ops[0].value as Array<{ time: number; easing: string }>;
    expect(next.map((k) => k.easing)).toEqual(['linear', 'constant']);
  });

  it('sets handleType without touching easing', () => {
    const state = channelScene([{ time: 0, value: 0, easing: 'cubic' }]);
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'ch', handleType: 'auto' },
      state,
      'handle',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const k = (r.ops[0].value as Array<{ easing: string; handleType: string }>)[0];
    expect(k.easing).toBe('cubic'); // untouched
    expect(k.handleType).toBe('auto');
  });

  it('rejects a spec with no interp field (defense-in-depth)', () => {
    const state = channelScene([{ time: 0, value: 0 }]);
    const r = validatePlan(setKeyframeInterpMutator, { channelId: 'ch' }, state, 'noop');
    expect(r.ok).toBe(false);
  });

  it('rejects scope {time} when no key is at that time', () => {
    const state = channelScene([{ time: 0, value: 0 }]);
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'ch', scope: { time: 5 }, easing: 'back' },
      state,
      'missing key',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an empty channel', () => {
    const state = channelScene([]);
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'ch', easing: 'back' },
      state,
      'empty',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a channel type without the broadened interp vocab (Quat)', () => {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'qch',
      nodeType: 'KeyframeChannelQuat',
      params: { name: 'rot', target: 'box', paramPath: 'quaternion' },
    }).next;
    const r = validatePlan(
      setKeyframeInterpMutator,
      { channelId: 'qch', easing: 'back' },
      s,
      'quat interp',
    );
    expect(r.ok).toBe(false);
  });

  it('is deterministic (same spec → identical ops)', () => {
    const state = channelScene([{ time: 0, value: 0 }]);
    const spec = { channelId: 'ch', easing: 'sine' as const, ease: 'inout' as const };
    const a = validatePlan(setKeyframeInterpMutator, spec, state, 'x');
    const b = validatePlan(setKeyframeInterpMutator, spec, state, 'x');
    expect(a.ok && b.ok && JSON.stringify(a.ops) === JSON.stringify(b.ops)).toBe(true);
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
        expect(op.paramPath).toBe('material.base.color');
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

// ---------------------------------------------------------------------------
// object↔data split (#365 Phase 5a Slice 1c) — the data-param mutators reach
// through an Object's `data` edge to the BoxData that owns material + size, so
// "make the cube red" / "double the cube" target the data node, not the pose.
// ---------------------------------------------------------------------------

/** An Object (pose) wired to a BoxData (geometry + material) and into a Scene. */
function buildSplitObjectScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'data',
    nodeType: 'BoxData',
    params: { size: [1, 1, 1], material: { name: 'default', base: { color: '#ff0000' } } },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'obj',
    nodeType: 'Object',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'data', socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'obj', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  return { ...s, outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } } };
}

describe('split-Object data-param mutators reach the BoxData (#365)', () => {
  it('setMaterialColor writes material.base.color on the DATA node, not the Object', () => {
    const state = buildSplitObjectScene();
    const result = validatePlan(
      setMaterialColorMutator,
      { targetSelectors: ['obj'], color: '#0000ff' },
      state,
      'paint',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
    const op = result.ops[0];
    if (op.type !== 'setParam') throw new Error('expected setParam');
    expect(op.nodeId).toBe('data');
    expect(op.paramPath).toBe('material.base.color');
    expect(op.value).toBe('#0000ff');
  });

  it('scale multiplies size on the DATA node, not the Object', () => {
    const state = buildSplitObjectScene();
    const result = validatePlan(scaleMutator, { targetSelectors: ['obj'], factor: 2 }, state, 's');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.ops.find((o) => o.type === 'setParam');
    if (op?.type !== 'setParam') throw new Error('expected setParam');
    expect(op.nodeId).toBe('data');
    expect(op.paramPath).toBe('size');
    expect(op.value).toEqual([2, 2, 2]);
  });

  it('randomize color + scale target the DATA node', () => {
    const state = buildSplitObjectScene();
    const result = validatePlan(
      randomizeMutator,
      {
        targetSelectors: ['obj'],
        properties: ['color', 'scale'],
        ranges: {
          color: { h: [0, 360], s: [0.5, 1], l: [0.4, 0.6] },
          scale: { factor: [1.5, 1.5] },
        },
        seed: 7,
      },
      state,
      'r',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const op of result.ops) {
      if (op.type === 'setParam') expect(op.nodeId).toBe('data');
    }
    const paths = result.ops.filter((o) => o.type === 'setParam').map((o) => o.paramPath);
    expect(paths).toContain('material.base.color');
    expect(paths).toContain('size');
  });
});

// ---------------------------------------------------------------------------
// randomize mutator — P7.2 / issue #26 path B
//
// Per-target randomization across {color, rotation, scale}. ONE call emits
// N × P ops in one atomic dispatch. Optional `seed` makes the entire
// sequence byte-identically reproducible via mulberry32.
//
// Tests cover D-01..D-10 (CONTEXT.md verbatim):
//   #1  emits N × P ops in spec order (target-outer × property-inner)
//   #2  seed determinism — twice-call returns byte-identical Op[]
//   #3  no seed — twice-call returns DIFFERENT Op[] (seed actually toggles)
//   #4  hue wrap: h:[350, 10] produces samples in [350,360) ∪ [0,10]
//   #5  bounds validation (zod / superRefine — D-08)
//   #6  per-property precondition reject — gate 4 names the (target, property) pair (D-10)
//   #7  atomic dispatch through agent path — proposePlanTool returns ok with N × P ops (D-07)
//   #8  D-05 hard scope: 'position' not in PropertyName enum
// ---------------------------------------------------------------------------

// Local helper: pure hex → HSL (re-parse the sampled hex back into HSL
// for the hue-wrap assertion. Standard RGB → HSL with no randomness.)
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`hexToHsl: bad hex ${hex}`);
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

// Local helper: scene with `box` (BoxMesh — material+rotation+size all
// compatible) and `light` (DirectionalLight — has color + rotation +
// scale vec3, but NO `size` and NO `radius`, so `canScale` returns
// false → mixed-compatibility scene exercises D-10 gate-4 reject).
function buildSceneWithLight(): DagState {
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
    nodeId: 'light',
    nodeType: 'DirectionalLight',
    params: {
      intensity: 1,
      position: [5, 5, 5],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#ffffff',
    },
  }).next;
  return s;
}

describe('randomize mutator', () => {
  // D-01..D-02 default-spec helper — full 3-property spec on box+sibling.
  function fullSpec(seed?: number) {
    return {
      targetSelectors: ['box', 'sibling'],
      properties: ['color', 'rotation', 'scale'] as const,
      ranges: {
        color: {
          h: [0, 360] as [number, number],
          s: [0.5, 1] as [number, number],
          l: [0.4, 0.6] as [number, number],
        },
        rotation: { axis: 'random' as const, degRange: [0, 360] as [number, number] },
        scale: { factor: [0.5, 1.5] as [number, number] },
      },
      ...(seed !== undefined ? { seed } : {}),
    };
  }

  // ---- #1 spec-order N × P op stream ----
  it('emits N × P ops in spec order (target-outer × property-inner)', () => {
    // box + sibling are both BoxMesh (all three properties compatible).
    // Deliberately NOT including `sphere` — SphereMesh lacks vec3
    // rotation, so under D-10 the call would gate-4-reject naming
    // (sphere, rotation), making a 9-op assertion unreachable.
    const state = buildScene();
    const result = validatePlan(randomizeMutator, fullSpec(42), state, 'r');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // N × P = 2 × 3 = 6 ops.
    expect(result.ops).toHaveLength(6);
    // Spec-order contract: outer = targetSelectors, inner = properties.
    // First 3 ops target `box` (color → rotation → scale paramPaths),
    // next 3 target `sibling`.
    const opPairs = result.ops.map((op) => {
      if (op.type !== 'setParam') throw new Error('unexpected non-setParam op');
      return { nodeId: op.nodeId, paramPath: op.paramPath };
    });
    expect(opPairs).toEqual([
      { nodeId: 'box', paramPath: 'material.base.color' },
      { nodeId: 'box', paramPath: 'rotation' },
      { nodeId: 'box', paramPath: 'size' },
      { nodeId: 'sibling', paramPath: 'material.base.color' },
      { nodeId: 'sibling', paramPath: 'rotation' },
      { nodeId: 'sibling', paramPath: 'size' },
    ]);
  });

  // ---- #2 seed determinism — byte-identical ----
  it('seed determinism — twice-call returns byte-identical Op[]', () => {
    const state = buildScene();
    const a = validatePlan(randomizeMutator, fullSpec(42), state, 'r');
    const b = validatePlan(randomizeMutator, fullSpec(42), state, 'r');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
  });

  // ---- #3 no seed — DIFFERENT (proves seed actually toggles) ----
  it('no seed — twice-call returns DIFFERENT Op[] (rules out vacuous determinism)', () => {
    const state = buildScene();
    const a = validatePlan(randomizeMutator, fullSpec(), state, 'r');
    const b = validatePlan(randomizeMutator, fullSpec(), state, 'r');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // With wide ranges (h:[0,360], degRange:[0,360], factor:[0.5,1.5])
    // across 6 ops, collision probability under double-Math.random is
    // negligibly small. If this ever flakes in CI, prefer "at least one
    // op differs" over the strict equality form.
    expect(JSON.stringify(a.ops)).not.toBe(JSON.stringify(b.ops));
  });

  // ---- #4 hue wrap ----
  it('hue wrap: h:[350, 10] produces samples in [350,360) ∪ [0,10]', () => {
    const state = buildScene();
    let lowBand = 0; // [0, 10]
    let highBand = 0; // [350, 360)
    let observedMin = 360;
    let observedMax = 0;
    for (let i = 0; i < 50; i++) {
      const spec = {
        targetSelectors: ['box'],
        properties: ['color'] as const,
        ranges: {
          color: {
            h: [350, 10] as [number, number],
            s: [1, 1] as [number, number],
            l: [0.5, 0.5] as [number, number],
          },
        },
        seed: 1000 + i,
      };
      const r = validatePlan(randomizeMutator, spec, state, 'wrap');
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.ops).toHaveLength(1);
      const op = r.ops[0];
      if (op.type !== 'setParam' || typeof op.value !== 'string') continue;
      const { h } = hexToHsl(op.value);
      // Round-trip from hex (8-bit per channel) introduces small
      // rounding; widen the assertion bands by ±2° to absorb it.
      if (h <= 12) lowBand++;
      else if (h >= 348) highBand++;
      observedMin = Math.min(observedMin, h);
      observedMax = Math.max(observedMax, h);
      expect(h <= 12 || h >= 348).toBe(true);
    }
    // Sanity: 50 samples should cover BOTH bands (wrap actually fires).
    expect(lowBand).toBeGreaterThan(0);
    expect(highBand).toBeGreaterThan(0);
    expect(lowBand + highBand).toBe(50);
    // Log for the executor's verify observation.
    void observedMin;
    void observedMax;
  });

  // ---- #5 bounds validation (D-08) ----
  it('bounds validation — zod / superRefine rejects bad specs', () => {
    const base = {
      targetSelectors: ['box'],
      ranges: {
        color: { h: [0, 360], s: [0, 1], l: [0, 1] },
        rotation: { axis: 'y', degRange: [0, 90] },
        scale: { factor: [0.5, 1.5] },
      },
    };
    // empty properties[]
    expect(randomizeMutator.spec.safeParse({ ...base, properties: [] }).success).toBe(false);
    // duplicate properties
    expect(
      randomizeMutator.spec.safeParse({ ...base, properties: ['color', 'color'] }).success,
    ).toBe(false);
    // properties=['color'] but ranges.color missing
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['color'],
        ranges: {},
      }).success,
    ).toBe(false);
    // ranges.color.s: min > max
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['color'],
        ranges: { color: { h: [0, 360], s: [0.8, 0.2], l: [0, 1] } },
      }).success,
    ).toBe(false);
    // factor [0, 1] — zero not positive
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['scale'],
        ranges: { scale: { factor: [0, 1] } },
      }).success,
    ).toBe(false);
    // factor [-1, 1] — negative
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['scale'],
        ranges: { scale: { factor: [-1, 1] } },
      }).success,
    ).toBe(false);
    // factor [2, 1] — min > max
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['scale'],
        ranges: { scale: { factor: [2, 1] } },
      }).success,
    ).toBe(false);
    // hue [350, 10] MUST parse success (wrap is intended; D-01)
    expect(
      randomizeMutator.spec.safeParse({
        targetSelectors: ['box'],
        properties: ['color'],
        ranges: { color: { h: [350, 10], s: [0, 1], l: [0, 1] } },
      }).success,
    ).toBe(true);
  });

  // ---- #6 D-10 per-property precondition reject ----
  it('per-property precondition rejects the WHOLE call at gate 4 naming the incompatible (target, property) pair', () => {
    // DirectionalLight has color + rotation but NO size and NO radius →
    // canScale returns false → 'scale' is the incompatible property
    // for the `light` target.
    const state = buildSceneWithLight();
    const spec = {
      targetSelectors: ['box', 'light'],
      properties: ['color', 'rotation', 'scale'] as const,
      ranges: {
        color: {
          h: [0, 360] as [number, number],
          s: [0.5, 1] as [number, number],
          l: [0.4, 0.6] as [number, number],
        },
        rotation: { axis: 'y' as const, degRange: [0, 90] as [number, number] },
        scale: { factor: [0.5, 1.5] as [number, number] },
      },
      seed: 42,
    };
    const result = validatePlan(randomizeMutator, spec, state, 'mixed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // D-10: gate 4, reason names the incompatible target AND the
    // property. Zero ops emitted (no silent partial mutation).
    expect(result.gate).toBe(4);
    expect(result.label).toBe('precondition');
    expect(result.reason.includes('light')).toBe(true);
    expect(result.reason.includes('scale')).toBe(true);
    // Anti-silent-skip property — the call did NOT emit 4 ops (color +
    // rotation for box AND light, plus scale for box only). No partial.
    // MutatorRejection carries no `ops` field; presence confirms reject.
  });

  // ---- #7 atomic dispatch through agent path (D-07) ----
  it('atomic dispatch through agent path — proposePlanTool returns ok with N × P ops', () => {
    // One propose+accept → ONE undo entry (the orchestrator forwards
    // `result.ops` to useDiffStore.propose with the closureSpec
    // reconstructed from `closureRoots`/`closureFollowedEdges`). D-07.
    registerAllMutators();
    const state = buildScene();
    const r = proposePlanTool.handler(
      {
        mutator: 'mutator.randomize',
        spec: fullSpec(42),
        intent: 'randomize the pair',
      },
      { dagState: state },
    );
    expect(r.ops).toHaveLength(6);
    const parsed = JSON.parse(r.text!) as {
      ok: boolean;
      closureRoots: string[];
      mutator: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mutator).toBe('mutator.randomize');
    expect(parsed.closureRoots).toEqual(['box', 'sibling']);
  });

  // ---- #8 D-05 hard scope: 'position' not in PropertyName ----
  it('D-05 hard scope: PropertyName enum rejects "position"', () => {
    // ScatterNode owns position-randomization; randomize.PropertyName
    // is strictly {color, rotation, scale}.
    const r = randomizeMutator.spec.safeParse({
      targetSelectors: ['box'],
      properties: ['position'],
      ranges: {},
    });
    expect(r.success).toBe(false);
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

  // ---------------------------------------------------------------------------
  // object↔data split (#365 Phase 5a) — duplicating a split Object deep-copies
  // its linked data node (Blender Shift+D). Cloning ONLY the Object leaves the
  // clone's `data` unwired → an empty render; the two must be independent.
  // ---------------------------------------------------------------------------
  it('deep-copies a split Object: the clone gets its OWN, independent BoxData', () => {
    const state = buildSplitObjectScene();
    const result = validatePlan(
      duplicateMutator,
      { targetSelectors: ['obj'], offset: [2, 0, 0] },
      state,
      'dup split',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two addNodes: the Object clone AND a fresh BoxData clone (not just the Object).
    const addNodes = result.ops.filter((o) => o.type === 'addNode');
    expect(addNodes).toHaveLength(2);
    const objClone = addNodes.find((o) => o.type === 'addNode' && o.nodeType === 'Object');
    const dataClone = addNodes.find((o) => o.type === 'addNode' && o.nodeType === 'BoxData');
    if (objClone?.type !== 'addNode' || dataClone?.type !== 'addNode') {
      throw new Error('expected an Object clone and a BoxData clone');
    }
    // The clone's data node is a FRESH id — not the source's 'data' node.
    expect(dataClone.nodeId).not.toBe('data');
    // Deep-copied params: same content, distinct object.
    expect(dataClone.params).toEqual(state.nodes['data'].params);

    // clone.data → the FRESH BoxData (the whole point — not a shared fan-out).
    const dataWire = result.ops.find(
      (o) => o.type === 'connect' && o.to.node === objClone.nodeId && o.to.socket === 'data',
    );
    if (dataWire?.type !== 'connect') throw new Error('expected a clone.data connect');
    expect(dataWire.from.node).toBe(dataClone.nodeId);

    // Independence, applied end-to-end: recolour the CLONE's data; the source stands.
    let s = state;
    for (const op of result.ops) s = applyOp(s, op).next;
    s = applyOp(s, {
      type: 'setParam',
      nodeId: dataClone.nodeId,
      paramPath: 'material.base.color',
      value: '#00ff00',
    }).next;
    const sourceData = s.nodes['data'].params as { material: { base: { color: string } } };
    const cloneData = s.nodes[dataClone.nodeId].params as {
      material: { base: { color: string } };
    };
    expect(cloneData.material.base.color).toBe('#00ff00');
    expect(sourceData.material.base.color).toBe('#ff0000'); // untouched — fully independent
  });

  // ---------------------------------------------------------------------------
  // Emission order — issue #19.
  //
  // The mutator emits `addNode(clone)` before every `connect` whose `from`
  // references that clone. The validator does NOT enforce this property:
  // `opTargetNodeId` on a connect returns `op.to.node` (the consumer), so a
  // connect referencing a missing `from.node` is invisible to gate 1
  // (node_existence) and gate 3 (closure_preservation). The actual safety
  // net lives one layer down: `applyConnect` (src/core/dag/ops.ts:165) calls
  // `getNode(state, op.from.node)` and throws OpError if the from-node
  // doesn't exist — but that only fires at dispatch time, after the plan has
  // been accepted as a valid Mutator output.
  //
  // So the mutator's emission order IS the contract. These tests pin it.
  // ---------------------------------------------------------------------------
  describe('emission order — #19 (addNode before connect-from-clone)', () => {
    it('emits addNode for the clone before any connect referencing the clone id', () => {
      const state = buildScene();
      const result = validatePlan(
        duplicateMutator,
        { targetSelectors: ['box'], offset: [2, 0, 0] },
        state,
        'dup',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const addNodeIdx = result.ops.findIndex((o) => o.type === 'addNode');
      const cloneId = (result.ops[addNodeIdx] as { type: 'addNode'; nodeId: string }).nodeId;
      expect(cloneId).toBe('box_copy1');

      // Every connect whose `from.node` is the clone must appear AFTER
      // the addNode. Asserting on each connect (not just the first) so a
      // multi-consumer fanout regression — where one connect slides
      // before the addNode — is caught.
      const cloneConnects = result.ops
        .map((op, i) => ({ op, i }))
        .filter(({ op }) => op.type === 'connect' && op.from.node === cloneId);

      expect(cloneConnects.length).toBeGreaterThan(0);
      for (const { i } of cloneConnects) {
        expect(i).toBeGreaterThan(addNodeIdx);
      }
    });

    it('multi-target duplicate: each clone gets its addNode before its connects', () => {
      // Two targets at once — the loop in duplicateMutator.build() emits
      // (addNode_A, connects_A…, addNode_B, connects_B…). A regression
      // that broke this per-target ordering (e.g. a pre-pass that
      // collected all addNodes after all connects) would fire here.
      const state = buildScene();
      const result = validatePlan(
        duplicateMutator,
        { targetSelectors: ['box', 'sphere'], offset: [2, 0, 0] },
        state,
        'dup two',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const addNodes = result.ops
        .map((op, i) => ({ op, i }))
        .filter(({ op }) => op.type === 'addNode');
      expect(addNodes).toHaveLength(2);

      for (const { op, i: addIdx } of addNodes) {
        const cloneId = (op as { type: 'addNode'; nodeId: string }).nodeId;
        const connects = result.ops
          .map((o, i) => ({ o, i }))
          .filter(({ o }) => o.type === 'connect' && o.from.node === cloneId);
        expect(connects.length).toBeGreaterThan(0);
        for (const { i: cIdx } of connects) {
          expect(cIdx).toBeGreaterThan(addIdx);
        }
      }
    });

    it('safety net: applying a reordered plan throws at applyConnect (validator does not catch it)', () => {
      // The validator accepts a reordered plan (see block comment above)
      // — the failure surfaces at the Op layer. This test pins that
      // safety net: if a future Mutator-author bug or refactor swaps
      // emission order, dispatch fails loudly rather than silently
      // producing a connect-to-nothing in the DAG.
      const state = buildScene();
      const result = validatePlan(
        duplicateMutator,
        { targetSelectors: ['box'], offset: [2, 0, 0] },
        state,
        'dup',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const addIdx = result.ops.findIndex((o) => o.type === 'addNode');
      const firstConnectIdx = result.ops.findIndex(
        (o) =>
          o.type === 'connect' &&
          o.from.node === (result.ops[addIdx] as { type: 'addNode'; nodeId: string }).nodeId,
      );
      expect(firstConnectIdx).toBeGreaterThan(-1);

      // Swap the addNode and the first clone-from connect.
      const reordered = [...result.ops];
      [reordered[addIdx], reordered[firstConnectIdx]] = [
        reordered[firstConnectIdx],
        reordered[addIdx],
      ];

      let next = state;
      expect(() => {
        for (const op of reordered) {
          next = applyOp(next, op).next;
        }
      }).toThrow(/box_copy1/);
    });
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

  // #424 — the agent path used to be a SECOND implementation of delete that swept
  // nothing, so asking the agent to delete a cube left its channel behind while
  // deleting the same cube in the outliner was clean. It now delegates to the one
  // shared builder. This asserts the sweep survives the five gates: the swept channel
  // is edge-less, so without the 'id-ref' closure kind gate 3 rejects the mutator's
  // OWN ops as out-of-scope.
  it('sweeps an edge-less channel with its target, and the plan still validates', () => {
    const state = buildScene();
    (state.nodes as Record<string, unknown>).chSweep = {
      id: 'chSweep',
      type: 'KeyframeChannelVec3',
      version: 1,
      params: { target: 'box', paramPath: 'position', keyframes: [] },
      inputs: {},
    };
    const result = validatePlan(deleteNodeMutator, { targetSelectors: ['box'] }, state, 'del');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const removed = result.ops
        .filter((o) => o.type === 'removeNode')
        .map((o) => (o as { nodeId: string }).nodeId);
      expect(removed).toContain('box');
      expect(removed).toContain('chSweep');
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
    expect(parsed.mutators).toHaveLength(26);
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

describe('mutator.timeline.addChannel (free-floating, V57)', () => {
  it('creates ONE free-floating KeyframeChannel — no layer, no connect', () => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addChannelMutator,
      {
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
    // Exactly ONE op: the channel addNode. No connect (free-floating — reached
    // by the resolver's target scan, never an `animation` edge).
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0];
    expect(op.type).toBe('addNode');
    if (op.type === 'addNode') {
      expect(op.nodeType).toBe('KeyframeChannelVec3');
      expect(op.nodeId).toBe('box_pos_channel');
      expect((op.params as { target: string }).target).toBe('box');
      expect((op.params as { paramPath: string }).paramPath).toBe('position');
    }
    expect(r.ops.filter((o) => o.type === 'connect')).toHaveLength(0);
  });

  it('derives a deterministic channelId matching dispatchDirectFirstKey when omitted', () => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addChannelMutator,
      { target: 'box', paramPath: 'material.base.color', valueType: 'color' },
      state,
      'derive id',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.ops[0];
    // `[^a-zA-Z0-9_-]` → `_`, exactly as dispatchDirectFirstKey's safePath.
    if (op.type === 'addNode') expect(op.nodeId).toBe('box_material_base_color_channel');
  });

  it.each([
    ['number', 'KeyframeChannelNumber'],
    ['vec3', 'KeyframeChannelVec3'],
    ['quat', 'KeyframeChannelQuat'],
    ['color', 'KeyframeChannelColor'],
  ])('valueType=%s → nodeType=%s', (valueType, nodeType) => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addChannelMutator,
      { target: 'box', paramPath: 'p', valueType },
      state,
      't',
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0].type === 'addNode') expect(r.ops[0].nodeType).toBe(nodeType);
  });

  it('rejects when target is not in the DAG (gate 4)', () => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addChannelMutator,
      { target: 'ghost', paramPath: 'position', valueType: 'vec3' },
      state,
      'no target',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });

  it('rejects a mismatched initialKeyframe value shape (gate 4)', () => {
    const state = buildSceneWithTime();
    const r = validatePlan(
      addChannelMutator,
      {
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

  it('rejects re-creating an existing channel (gate 4 — use keyframe instead)', () => {
    let state = buildSceneWithTime();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'box_position_channel',
      nodeType: 'KeyframeChannelVec3',
      params: { name: 'pos', target: 'box', paramPath: 'position', keyframes: [] },
    }).next;
    const r = validatePlan(
      addChannelMutator,
      { target: 'box', paramPath: 'position', valueType: 'vec3' },
      state,
      'collision',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(4);
  });
});

describe('mutator.timeline.keyframe', () => {
  function stateWithChannel() {
    let s = buildSceneWithTime();
    // v0.7 #199: a free-floating channel (no AnimationLayer wrapper) — the
    // keyframe Mutator targets it by channelId directly.
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

  // #281 — broadened interp vocabulary at key-creation.
  it('authors a Penner easing + ease direction at creation', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 1, value: [10, 0, 0], easing: 'back', ease: 'out' },
      state,
      'eased key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const k = (r.ops[0].value as Array<{ time: number; easing: string; ease?: string }>).find(
      (x) => x.time === 1,
    )!;
    expect(k.easing).toBe('back');
    expect(k.ease).toBe('out');
  });

  it('authors a handleType at creation', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 1, value: [10, 0, 0], easing: 'cubic', handleType: 'auto' },
      state,
      'handled key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const k = (r.ops[0].value as Array<{ time: number; handleType?: string }>).find(
      (x) => x.time === 1,
    )!;
    expect(k.handleType).toBe('auto');
  });

  it('byte-identical for a legacy call (no ease/handle keys added)', () => {
    const state = stateWithChannel();
    const r = validatePlan(
      keyframeMutator,
      { channelId: 'ch', time: 1, value: [10, 0, 0], easing: 'linear' },
      state,
      'legacy',
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.ops[0].type !== 'setParam') return;
    const k = (r.ops[0].value as Array<Record<string, unknown>>).find((x) => x.time === 1)!;
    // No `ease` / `handleType` keys when not supplied → identical to pre-#281.
    expect(Object.keys(k).sort()).toEqual(['easing', 'time', 'value']);
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
    const r = validatePlan(
      addPassMutator,
      { jobId: 'job', passKind: 'normal' },
      state,
      'add normal',
    );
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
    const wfOp = r.ops.find((o) => o.type === 'addNode' && o.nodeType === 'ComfyUIWorkflow');
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
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'val',
        target: 'box',
        paramPath: 'opacity',
        keyframes: keyframes.map((k) => ({
          time: k.time,
          value: k.value,
          easing: k.easing ?? 'linear',
        })),
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
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'ch', tolerance: 0.01 },
      state,
      'simplify',
    );
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
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'ch', tolerance: 0.01 },
      state,
      'peak',
    );
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
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'ch', tolerance: 1 },
      state,
      'flat',
    );
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
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'ch', tolerance: 0.01 },
      state,
      'vec3 line',
    );
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
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'ch_q', tolerance: 0.5 },
      s,
      'quat',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(0);
  });

  it('rejects when channelId is not a KeyframeChannel (gate 4)', () => {
    const state = numberChannelWith([{ time: 0, value: 0 }]);
    const r = validatePlan(
      simplifyChannelMutator,
      { channelId: 'box', tolerance: 0.1 },
      state,
      'wrong type',
    );
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
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: { name: 'val', target: 'box', paramPath: 'opacity', keyframes: [] },
    }).next;
    const r = validatePlan(removeKeyframesMutator, { channelId: 'ch', scope: 'all' }, s, 'noop');
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
// #283 Phase 4 — NLA agent mutators (createAction + addStrip)
// ---------------------------------------------------------------------------

describe('mutator.nla.createAction (author a target-less Action, V57)', () => {
  const CHANNELS = [
    {
      valueType: 'vec3' as const,
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' as const },
        { time: 2, value: [2, 1, 0], easing: 'linear' as const },
      ],
    },
  ];

  it('emits a single addNode(Action) with the channel bundle + deterministic id', () => {
    const state = buildSceneWithTime();
    const result = validatePlan(
      createActionMutator,
      { name: 'walk', actionId: 'nla_act', channels: CHANNELS },
      state,
      'author a walk Action',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(1);
      const op = result.ops[0];
      expect(op.type).toBe('addNode');
      if (op.type === 'addNode') {
        expect(op.nodeType).toBe('Action');
        expect(op.nodeId).toBe('nla_act');
        expect((op.params as { channels: unknown[] }).channels).toHaveLength(1);
      }
    }
  });

  it('auto-mints nla_action_1 when actionId is omitted', () => {
    const state = buildSceneWithTime();
    const result = validatePlan(
      createActionMutator,
      { name: 'walk', channels: CHANNELS },
      state,
      'author',
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.ops[0].type === 'addNode') {
      expect(result.ops[0].nodeId).toBe('nla_action_1');
    }
  });

  it('twice-call returns the same Op[] (deterministic)', () => {
    const state = buildSceneWithTime();
    const a = validatePlan(createActionMutator, { channels: CHANNELS }, state, 'a');
    const b = validatePlan(createActionMutator, { channels: CHANNELS }, state, 'a');
    expect(a).toEqual(b);
  });

  it('re-guards empty channels on the validatePlan-direct path (precondition)', () => {
    // The spec `.min(1)` fires only at safeParse; a validatePlan-direct caller passes
    // an already-parsed spec → the precondition re-guard must catch empty channels.
    const state = buildSceneWithTime();
    const result = validatePlan(createActionMutator, { channels: [] } as never, state, 'empty');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(4);
  });

  it('rejects a caller-supplied actionId that already exists', () => {
    let state = buildSceneWithTime();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'nla_act',
      nodeType: 'Action',
      params: { name: 'x', channels: [] },
    }).next;
    const result = validatePlan(
      createActionMutator,
      { actionId: 'nla_act', channels: CHANNELS },
      state,
      'dup',
    );
    expect(result.ok).toBe(false);
  });
});

describe('mutator.nla.addStrip (place an Action into a Track)', () => {
  /** A scene with `box` (target) + an Action `nla_act`. */
  function sceneWithAction(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_act',
      nodeType: 'Action',
      params: {
        name: 'walk',
        channels: [
          {
            valueType: 'vec3',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [2, 1, 0], easing: 'linear' },
            ],
          },
        ],
      },
    }).next;
    return s;
  }

  it('trackId omitted → [addNode:Strip, addNode:Track, setParam:strips=[stripId]] (auto-track)', () => {
    const state = sceneWithAction();
    const result = validatePlan(
      addStripMutator,
      { action: 'nla_act', target: 'box', stripId: 'nla_s1' },
      state,
      'place',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(3);
      expect(result.ops[0].type).toBe('addNode');
      expect(result.ops[1].type).toBe('addNode');
      const strip = result.ops[0];
      const track = result.ops[1];
      const setStrips = result.ops[2];
      if (strip.type === 'addNode') expect(strip.nodeType).toBe('Strip');
      if (track.type === 'addNode') {
        expect(track.nodeType).toBe('Track');
        expect(track.nodeId).toBe('nla_track_1');
      }
      if (setStrips.type === 'setParam') {
        expect(setStrips.nodeId).toBe('nla_track_1');
        expect(setStrips.paramPath).toBe('strips');
        expect(setStrips.value).toEqual(['nla_s1']);
      }
    }
  });

  it('existing trackId → [addNode:Strip, setParam:strips] appends, prior strips preserved', () => {
    let state = sceneWithAction();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'nla_trk',
      nodeType: 'Track',
      params: { name: 'Base', strips: ['existing_strip'], order: 0 },
    }).next;
    const result = validatePlan(
      addStripMutator,
      { action: 'nla_act', target: 'box', trackId: 'nla_trk', stripId: 'nla_s2' },
      state,
      'append',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
      const setStrips = result.ops[1];
      if (setStrips.type === 'setParam') {
        expect(setStrips.nodeId).toBe('nla_trk');
        expect(setStrips.value).toEqual(['existing_strip', 'nla_s2']);
      }
    }
  });

  it('rejects a missing action, a non-Action action, and a missing target', () => {
    const state = sceneWithAction();
    expect(validatePlan(addStripMutator, { action: 'nope', target: 'box' }, state, 'x').ok).toBe(
      false,
    );
    expect(validatePlan(addStripMutator, { action: 'box', target: 'box' }, state, 'x').ok).toBe(
      false,
    ); // box is a BoxMesh, not an Action
    expect(
      validatePlan(addStripMutator, { action: 'nla_act', target: 'nope' }, state, 'x').ok,
    ).toBe(false);
  });

  it('twice-call returns the same Op[] (deterministic)', () => {
    const state = sceneWithAction();
    const a = validatePlan(addStripMutator, { action: 'nla_act', target: 'box' }, state, 'p');
    const b = validatePlan(addStripMutator, { action: 'nla_act', target: 'box' }, state, 'p');
    expect(a).toEqual(b);
  });
});

describe('mutator.nla.setStripTiming / setStripBlend (edit a placed strip)', () => {
  /** A scene with `box`, an Action `nla_act`, and a Strip `nla_s` placing it. */
  function sceneWithStrip(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_act',
      nodeType: 'Action',
      params: { name: 'walk', channels: [] },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_s',
      nodeType: 'Strip',
      params: { name: 's', action: 'nla_act', target: 'box' },
    }).next;
    return s;
  }

  it('setStripTiming emits one setParam per provided field in deterministic order', () => {
    const state = sceneWithStrip();
    const result = validatePlan(
      setStripTimingMutator,
      { stripId: 'nla_s', start: 1, timeScale: 2 },
      state,
      'retime',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
      expect(result.ops.map((o) => (o.type === 'setParam' ? o.paramPath : o.type))).toEqual([
        'start',
        'timeScale',
      ]);
    }
  });

  it('setStripBlend emits one setParam per provided field (blendMode→influence→blendIn→blendOut)', () => {
    const state = sceneWithStrip();
    const result = validatePlan(
      setStripBlendMutator,
      { stripId: 'nla_s', blendIn: 0.5, influence: 0.8 },
      state,
      'blend',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops.map((o) => (o.type === 'setParam' ? o.paramPath : o.type))).toEqual([
        'influence',
        'blendIn',
      ]);
    }
  });

  it('re-guards an all-undefined spec on the validatePlan-direct path (precondition)', () => {
    const state = sceneWithStrip();
    const timing = validatePlan(setStripTimingMutator, { stripId: 'nla_s' } as never, state, 'x');
    expect(timing.ok).toBe(false);
    if (!timing.ok) expect(timing.gate).toBe(4);
    const blend = validatePlan(setStripBlendMutator, { stripId: 'nla_s' } as never, state, 'x');
    expect(blend.ok).toBe(false);
    if (!blend.ok) expect(blend.gate).toBe(4);
  });

  it('rejects a non-Strip target', () => {
    const state = sceneWithStrip();
    expect(validatePlan(setStripTimingMutator, { stripId: 'box', start: 1 }, state, 'x').ok).toBe(
      false,
    );
    expect(
      validatePlan(setStripBlendMutator, { stripId: 'nla_act', influence: 0.5 }, state, 'x').ok,
    ).toBe(false);
  });

  it('twice-call returns the same Op[] (deterministic)', () => {
    const state = sceneWithStrip();
    const a = validatePlan(setStripTimingMutator, { stripId: 'nla_s', repeat: 3 }, state, 'r');
    const b = validatePlan(setStripTimingMutator, { stripId: 'nla_s', repeat: 3 }, state, 'r');
    expect(a).toEqual(b);
  });
});

describe('mutator.nla.setTrackState (order / mute / solo)', () => {
  function sceneWithTrack(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_trk',
      nodeType: 'Track',
      params: { name: 'Base', strips: [], order: 0 },
    }).next;
    return s;
  }

  it('emits one setParam per provided field in deterministic order (order→mute→solo)', () => {
    const state = sceneWithTrack();
    const result = validatePlan(
      setTrackStateMutator,
      { trackId: 'nla_trk', order: 2, mute: true, solo: false },
      state,
      'track',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops.map((o) => (o.type === 'setParam' ? o.paramPath : o.type))).toEqual([
        'order',
        'mute',
        'solo',
      ]);
    }
  });

  it('re-guards an all-undefined spec on the validatePlan-direct path (precondition)', () => {
    const state = sceneWithTrack();
    const result = validatePlan(setTrackStateMutator, { trackId: 'nla_trk' } as never, state, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gate).toBe(4);
  });

  it('rejects a non-Track target', () => {
    const state = sceneWithTrack();
    expect(validatePlan(setTrackStateMutator, { trackId: 'box', mute: true }, state, 'x').ok).toBe(
      false,
    );
  });

  it('twice-call returns the same Op[] (deterministic)', () => {
    const state = sceneWithTrack();
    const a = validatePlan(setTrackStateMutator, { trackId: 'nla_trk', order: 1 }, state, 'o');
    const b = validatePlan(setTrackStateMutator, { trackId: 'nla_trk', order: 1 }, state, 'o');
    expect(a).toEqual(b);
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
  bakeGltfChannelMutator as _bakeGltfM,
  addModifierMutator as _addModifierM,
  addChannelModifierMutator as _addChannelModifierM,
  setChannelExtendMutator as _setChannelExtendM,
  setKeyframeInterpMutator as _setKeyframeInterpM,
  createActionMutator as _createActionM,
  addStripMutator as _addStripM,
  setStripTimingMutator as _setStripTimingM,
  setStripBlendMutator as _setStripBlendM,
  setTrackStateMutator as _setTrackStateM,
} from './index';
import type { MutatorDefinition, MutatorValidationResult } from './index';
import type { Op } from '../../core/dag/types';
import { gltfChildDagId } from '../../core/import/gltfImportChain';

describe('V14 deeper non-redundancy — Op-shape probe (issue #22)', () => {
  // A channel scene: collinear KeyframeChannelNumber so simplifyChannel
  // actually emits a setParam (a flat/no-op channel would emit zero ops
  // and the probe would compare empty signatures). The free-floating
  // channel `ch` (v0.7 #199 / V57 — no AnimationLayer) serves keyframe /
  // simplifyChannel / removeKeyframes.
  function buildSceneWithChannel(): DagState {
    let s = buildSceneWithTime();
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

  // P7.12 (#108) — a probe scene for bakeGltfChannel: GltfAsset → ClipSelect →
  // TransformClip(walk) carrying a 2-key TRS track for `bone_1`, plus the
  // GltfChild for `bone_1` (its dagId IS gltfChildDagId(assetRef, childName)).
  const BAKE_ASSET = 'asset-probe';
  function buildSceneForBake(): DagState {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'bake_clip',
      nodeType: 'TransformClip',
      params: {
        name: 'walk',
        duration: 1.5,
        keyframes: [
          {
            targetNodeId: 'bone_1',
            time: 0,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          {
            targetNodeId: 'bone_1',
            time: 1.5,
            position: [0, 2, 0],
            rotation: [0, 90, 0],
            scale: [1, 1, 1],
          },
        ],
      },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'bake_sel',
      nodeType: 'ClipSelect',
      params: { selectedClipName: 'walk' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'bake_clip', socket: 'out' },
      to: { node: 'bake_sel', socket: 'clips' },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'bake_asset',
      nodeType: 'GltfAsset',
      params: { assetRef: BAKE_ASSET },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'bake_sel', socket: 'out' },
      to: { node: 'bake_asset', socket: 'transformClip' },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(BAKE_ASSET, 'bone_1'),
      nodeType: 'GltfChild',
      params: {
        assetRef: BAKE_ASSET,
        childName: 'bone_1',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
    return s;
  }

  // #283 Phase 4 (NLA agent mutators) — a scene carrying the Action/Strip/Track
  // trio addStrip/createAction probe against: `box` (target, from buildSceneWithTime)
  // + an Action `nla_act` (one vec3 position channel) + a Strip + a Track `nla_trk`
  // that already holds the strip (so the addStrip probe can append to an EXISTING
  // track → the deterministic [addNode:Strip, setParam:strips] op-shape, no auto-Track).
  function buildSceneForNla(): DagState {
    let s = buildSceneWithTime();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_act',
      nodeType: 'Action',
      params: {
        name: 'walk',
        channels: [
          {
            valueType: 'vec3',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [2, 1, 0], easing: 'linear' },
            ],
          },
        ],
      },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_strip',
      nodeType: 'Strip',
      params: { name: 's', action: 'nla_act', target: 'box', start: 0 },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'nla_trk',
      nodeType: 'Track',
      params: { name: 'Base', strips: ['nla_strip'], order: 0 },
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
    'mutator.timeline.addChannel': {
      mutator: _addChannelM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: {
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
    // P7.12 (#108 / D1) — copy-on-write bake: 3 KeyframeChannelVec3 addNodes,
    // ZERO connects (R4 edge-less bridge). Distinct op-shape from addChannel
    // (which emits addNode + connect).
    'mutator.timeline.bakeGltfChannel': {
      mutator: _bakeGltfM as MutatorDefinition<unknown>,
      build: buildSceneForBake,
      spec: { assetRef: BAKE_ASSET, childName: 'bone_1' },
    },
    'mutator.geometry.addModifier': {
      mutator: _addModifierM as MutatorDefinition<unknown>,
      build: buildScene,
      spec: { target: 'box', modifierType: 'ArrayModifier', count: 3, offset: [2, 0, 0] },
    },
    // #281 — F-Modifier on the collinear `ch` channel. Emits setParam('modifiers');
    // a distinct paramPath from keyframe/simplify's setParam('keyframes').
    'mutator.timeline.addChannelModifier': {
      mutator: _addChannelModifierM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', modifierType: 'noise' },
    },
    // #281 — per-side extrapolation. Emits setParam('extendBefore')+('extendAfter'):
    // a distinct op-shape from every other channel mutator.
    'mutator.timeline.setChannelExtend': {
      mutator: _setChannelExtendM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', before: 'slope', after: 'slope' },
    },
    // #281 — per-keyframe interp. Emits setParam('keyframes') — same op-shape as
    // keyframe/simplify, distinguished by the contract discriminator (drops
    // animation-shape, lossy:['prior-interpolation']), the #22 resolution.
    'mutator.timeline.setKeyframeInterp': {
      mutator: _setKeyframeInterpM as MutatorDefinition<unknown>,
      build: buildSceneWithChannel,
      spec: { channelId: 'ch', scope: 'all', easing: 'back' },
    },
    // #283 Phase 4 — createAction emits [addNode:Action] (unique nodeType);
    // its all-8-inert contract discriminator is unique too.
    'mutator.nla.createAction': {
      mutator: _createActionM as MutatorDefinition<unknown>,
      build: buildSceneForNla,
      spec: {
        name: 'walk',
        actionId: 'probe_act',
        channels: [
          {
            valueType: 'vec3',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [2, 1, 0], easing: 'linear' },
            ],
          },
        ],
      },
    },
    // #283 Phase 4 — addStrip against an EXISTING track emits
    // [addNode:Strip, setParam:strips] — a distinct op-shape; requiredNodeTypes:['Action']
    // is the honest contract discriminator (clears the keyframe preserves-7 collision).
    'mutator.nla.addStrip': {
      mutator: _addStripM as MutatorDefinition<unknown>,
      build: buildSceneForNla,
      spec: { action: 'nla_act', target: 'box', trackId: 'nla_trk', stripId: 'probe_strip' },
    },
    // #283 Phase 4 inc 4B — setStripTiming emits [setParam:start, setParam:timeScale];
    // setStripBlend emits [setParam:blendMode, setParam:influence] — distinct op-shapes
    // (paramPath sets), separated from each other by their honest lossy kinds too.
    'mutator.nla.setStripTiming': {
      mutator: _setStripTimingM as MutatorDefinition<unknown>,
      build: buildSceneForNla,
      spec: { stripId: 'nla_strip', start: 1, timeScale: 2 },
    },
    'mutator.nla.setStripBlend': {
      mutator: _setStripBlendM as MutatorDefinition<unknown>,
      build: buildSceneForNla,
      spec: { stripId: 'nla_strip', blendMode: 'combine', influence: 0.5 },
    },
    // #283 Phase 4 inc 4C — setTrackState emits [setParam:order, setParam:mute,
    // setParam:solo] on nla_trk — a distinct op-shape; requiredNodeTypes:['Track'] is the
    // honest signature discriminator vs the set-Strip family.
    'mutator.nla.setTrackState': {
      mutator: _setTrackStateM as MutatorDefinition<unknown>,
      build: buildSceneForNla,
      spec: { trackId: 'nla_trk', order: 1, mute: true, solo: false },
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
          (result.ok ? '' : `gate ${result.gate} (${result.label}): ${result.reason}`),
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

// ---------------------------------------------------------------------------
// P7.11 Wave G (#100) — the headline D-01 director story through the AGENT
// MUTATOR surface: a director drops a glTF character, then issues
// `mutator.animation.retarget` to drive its `GltfSkeleton` rig with a
// foreign-vocabulary (Mixamo) source clip via a NON-IDENTITY bridge map.
//
// The verifier (VERIFICATION.md) found this reachable only at the
// `retargetClip()` function layer; the mutator rejected a `GltfSkeleton`
// target at the precondition AND, even past the gate, read `params.bones`
// the projection node does not have. This suite proves the gap is closed at
// the product surface: (a) preconditions accept a GltfSkeleton target, (b)
// the emitted clip's tracks bind to the TARGET (glTF-native) bone names —
// resolved by EVALUATING the GltfSkeleton, not by reading absent params, and
// (c) the closure gate (V13) accepts the plan even though evaluating the
// GltfSkeleton reads its upstream GltfAsset.
// ---------------------------------------------------------------------------
describe('mutator.animation.retarget — GltfSkeleton target (P7.11 Wave G / #100 / D-01)', () => {
  // The committed `skinned-bar` skin shape (Wave D): glTF-native joint keys
  // `Bone0`/`Bone1`, captured bind TRS in DEGREES (buildSkinMetadata convention)
  // — projectGltfSkeleton converts to radians, matching the Skeleton/BVH/FBX
  // BoneSpec contract. parentJointIndex is first-class (no runtime re-derive).
  const SKINNED_BAR_SKIN: GltfSkinMetadata = {
    jointKeys: ['Bone0', 'Bone1'],
    bindTRS: [
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ],
    parentJointIndex: [-1, 0],
    inverseBindMatrices: [],
  };

  // Mixamo-vocabulary source rig + clip. Source bone NAMES differ from the
  // glTF target keys, so an identity/empty map is a no-op — the bridge preset
  // is load-bearing (research risk #4 / FLAG 3).
  const MIXAMO_SOURCE_BONES: BoneSpec[] = [
    { name: 'mixamorig_Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'mixamorig_Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
  ];
  const MIXAMO_SOURCE_KFS = [
    { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
    { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
  ];

  // Build a DAG matching what a director would have after dropping a glTF
  // character (GltfAsset → GltfSkeleton target) and importing a Mixamo clip
  // (Skeleton source + AnimationClip), with the project TimeSource present.
  function buildSceneForGltfRetarget(): DagState {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    // The dropped glTF character: a GltfAsset carrying the captured skin.
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'gltf_asset',
      nodeType: 'GltfAsset',
      params: { assetRef: 'assets/skinned-bar.glb', skins: [SKINNED_BAR_SKIN] },
    }).next;
    // The PURE rig projection node — the director-reachable target. Its bones
    // are an evaluated output, NOT params (D-02).
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'gltf_skel',
      nodeType: 'GltfSkeleton',
      params: { skinIndex: 0 },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'gltf_asset', socket: 'out' },
      to: { node: 'gltf_skel', socket: 'asset' },
    }).next;
    // The foreign (Mixamo) source rig + clip.
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'src_skel',
      nodeType: 'Skeleton',
      params: { bones: MIXAMO_SOURCE_BONES },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'src_clip',
      nodeType: 'AnimationClip',
      params: { name: 'walk', duration: 1, keyframes: MIXAMO_SOURCE_KFS },
    }).next;
    return s;
  }

  function gltfRetargetSpec(map: Record<string, string>) {
    return {
      sourceClipId: 'src_clip',
      sourceSkeletonId: 'src_skel',
      targetSkeletonId: 'gltf_skel',
      customMap: map,
      outputClipId: 'walk_on_gltf',
    };
  }

  it('passes preconditions + emits a retargeted clip bound to the glTF rig through the agent surface', () => {
    const bridge = getBoneNameMapPreset('mixamoToGltfBarRig');
    expect(bridge).toBeDefined();
    // Load-bearing bridge: foreign source names map ONTO glTF-native targets.
    expect(bridge!.map['mixamorig_Hips']).toBe('Bone0');

    const state = buildSceneForGltfRetarget();
    const result = validatePlan(
      retargetMutator,
      gltfRetargetSpec(bridge!.map),
      state,
      'drop a Mixamo clip onto a glTF character',
    );

    // (a) The mutator accepted the GltfSkeleton target — no precondition or
    // closure-gate rejection. A silent rejection here is the gap reopening.
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`retarget rejected (gate ${result.gate}/${result.label}): ${result.reason}`);
    }

    // (b) It emitted a fresh AnimationClip wired to time + the glTF skeleton.
    const addClip = result.ops.find((o) => o.type === 'addNode' && o.nodeType === 'AnimationClip');
    expect(addClip).toBeDefined();
    if (addClip?.type !== 'addNode') throw new Error('no AnimationClip addNode');
    expect(addClip.nodeId).toBe('walk_on_gltf');
    const wiredToTarget = result.ops.some(
      (o) =>
        o.type === 'connect' &&
        o.from.node === 'gltf_skel' &&
        o.to.node === 'walk_on_gltf' &&
        o.to.socket === 'skeleton',
    );
    expect(wiredToTarget).toBe(true);

    // (c) The clip's tracks bind to the TARGET (glTF-native) bones. The
    // GltfSkeleton projects ['Bone0','Bone1']; every emitted keyframe's
    // `bone` index must address one of THOSE, proving the target rig was
    // resolved by EVALUATION (not by reading absent params.bones, which
    // would have produced an empty rig → zero/out-of-range tracks).
    const params = addClip.params as { keyframes?: { bone: number }[] };
    const kfs = params.keyframes ?? [];
    expect(kfs.length).toBeGreaterThan(0);
    const projectedTargetNames = ['Bone0', 'Bone1'];
    for (const kf of kfs) {
      expect(kf.bone).toBeGreaterThanOrEqual(0);
      expect(kf.bone).toBeLessThan(projectedTargetNames.length);
    }
    // The set of target bones actually driven includes a glTF-native key.
    const drivenNames = new Set(kfs.map((kf) => projectedTargetNames[kf.bone]));
    expect(drivenNames.has('Bone0')).toBe(true);
  });

  it('FALSIFICATION: an empty map yields an empty clip — the bridge is load-bearing, not a no-op', () => {
    const state = buildSceneForGltfRetarget();
    const result = validatePlan(
      retargetMutator,
      gltfRetargetSpec({}),
      state,
      'empty map — nothing should bind',
    );
    // The plan still validates (an empty clip is structurally valid), but the
    // mixamorig_* source matches NO glTF joint key, so NO tracks bind.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const addClip = result.ops.find((o) => o.type === 'addNode' && o.nodeType === 'AnimationClip');
    if (addClip?.type !== 'addNode') throw new Error('no AnimationClip addNode');
    const params = addClip.params as { keyframes?: { bone: number }[] };
    expect(params.keyframes ?? []).toHaveLength(0);
  });

  it('rejects a non-skeleton target with a Skeleton-or-GltfSkeleton reason (precondition gate)', () => {
    let state = buildSceneForGltfRetarget();
    // Point the target at the GltfAsset (a Mesh-output node), not the rig.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'src_skel2',
      nodeType: 'Skeleton',
      params: { bones: MIXAMO_SOURCE_BONES },
    }).next;
    const result = validatePlan(
      retargetMutator,
      {
        sourceClipId: 'src_clip',
        sourceSkeletonId: 'src_skel',
        targetSkeletonId: 'gltf_asset',
        customMap: { mixamorig_Hips: 'Bone0' },
        outputClipId: 'bad',
      },
      state,
      'bad target type',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('GltfSkeleton');
  });
});
