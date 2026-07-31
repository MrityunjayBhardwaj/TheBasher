// #394 P5 / #519 — the ONE ownership query, for callers that hold no row.
//
// The inspector needs no query: its rows are generated from nodes and carry the node they
// came from, so a write is the identity function on provenance. The agent has no row — it
// names a scene object and a param path — so something has to say which layer of the chain
// that path resolves to. `resolveExposedTarget` is that something, and it answers off the
// SAME projection the rows come from rather than beside it.
//
// ── WHAT EACH GROUP OF CASES IS FOR ─────────────────────────────────────────────────
//
// 1. THE DEFECT (#519). Per param ROOT, the whole `material` root resolved to the layer at
//    the bottom of the lane, so a channel for a colour an operator forces landed on the
//    masked layer. Measured before the fix: the channel was created on the base data node,
//    the mutator reported success, and the composed material kept taking the field from the
//    operator. The topmost UNMASKED entry is the answer, and it comes back in the
//    operator's own flat vocabulary.
//
// 2. THE STRICT-EXTENSION CASES. Every shape that has no masking layer must answer exactly
//    what the shipped per-root reach answered — a transform param on the Object, a data
//    param on the base, a linked Material node's supersession. These are the ones that make
//    the change safe to land; if any of them moved, the fix would be a rewrite pretending
//    to be an extension.
//
// 3. THE FALLBACK, WHICH IS LOAD-BEARING AND NOT DEFENSIVE. A param a custom control renders
//    has NO projection row: nine keys are omitted for the camera lens control alone. Without
//    a fall-through to the per-root reach a camera channel would go back to targeting the
//    Object, where the render overlay never collects it — a regression that no material case
//    could have surfaced.
//
// 4. THE VOCABULARY COLLISION GUARD. `color` is not a rare param name. A split LIGHT owns
//    one, so bridging `material.base.color` onto any row spelled `color` would quietly turn
//    a mutator that correctly reports "this target has no material" into one that writes the
//    light. The bridge is scoped to material-lane operators, and this pins that scope.
//
// REF: src/app/exposeParams.ts (`resolveExposedTarget`, `pathOnRow`); PLAN-3 §4 P5;
//      issues #394, #519.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { SPLIT_KINDS, splitOps, type SplitKindName } from '../test-utils/splitKinds';
import { exposeParams, resolveExposedTarget } from './exposeParams';
import { MATERIAL_FIELD_IR_PATH } from './resolveMaterialFieldOwner';

const COLOR = MATERIAL_FIELD_IR_PATH.color;

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function applyOps(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

function split(kind: SplitKindName): DagState {
  return applyOps(
    emptyDagState(),
    splitOps(kind, { objectId: 'obj' }, { data: SPLIT_KINDS[kind].baseDataParams }) as Op[],
  );
}

/** Splice a data-lane operator on TOP of whatever currently feeds the Object, so calling
 *  this twice builds a real stack rather than throwing on a stale producer. */
function spliceOp(state: DagState, opId: string, nodeType: string, params: object): DagState {
  const below = (state.nodes['obj']?.inputs as { data?: { node: string } } | undefined)?.data?.node;
  if (!below) throw new Error('fixture: the Object has no data producer to splice above');
  return applyOps(state, [
    { type: 'addNode', nodeId: opId, nodeType, params },
    {
      type: 'disconnect',
      from: { node: below, socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: below, socket: 'out' },
      to: { node: opId, socket: 'target' },
    },
    { type: 'connect', from: { node: opId, socket: 'out' }, to: { node: 'obj', socket: 'data' } },
  ] as Op[]);
}

describe('#519 — the topmost UNMASKED entry owns the field', () => {
  it('resolves a forced colour to the operator, in the operator’s flat vocabulary', () => {
    const state = spliceOp(split('box'), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });

    // The vacuity guard: the two candidate nodes are genuinely different, and the answer is
    // the one ABOVE. Before the fix this returned the base with the IR path.
    expect(resolveExposedTarget(state, 'obj', COLOR)).toEqual({
      nodeId: 'ovr',
      paramPath: 'color',
    });
    expect(resolveExposedTarget(state, 'obj', COLOR)!.nodeId).not.toBe('obj_data');
  });

  it('splits ONE param root across two layers — which is what per-root could never do', () => {
    const state = spliceOp(split('box'), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });

    // Both requests live under the SAME `material` root, and they resolve to different
    // nodes: the operator supplies the colour, and it has no opinion about the material's
    // name, so that one still belongs to the layer underneath. A single answer for the root
    // — what `addChannel` asked for before this — has to get one of the two wrong.
    expect(resolveExposedTarget(state, 'obj', COLOR)!.nodeId).toBe('ovr');
    expect(resolveExposedTarget(state, 'obj', 'material.name')).toEqual({
      nodeId: 'obj_data',
      paramPath: 'material.name',
    });
  });

  it('takes the TOPMOST of two stacked operators', () => {
    let state = spliceOp(split('box'), 'lower', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });
    state = spliceOp(state, 'upper', 'MaterialOverrideOp', {
      color: '#ff00ff',
      overridden: { color: true },
    });
    expect(resolveExposedTarget(state, 'obj', COLOR)!.nodeId).toBe('upper');
  });

  it('a MUTED operator is byte-identically no operator', () => {
    const state = spliceOp(split('box'), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      muted: true,
    });
    expect(resolveExposedTarget(state, 'obj', COLOR)!.nodeId).toBe('obj_data');
  });
});

describe('the shapes with nothing masking — a STRICT EXTENSION of the shipped reach', () => {
  it('a transform param stays on the Object', () => {
    expect(resolveExposedTarget(split('box'), 'obj', 'position')).toEqual({
      nodeId: 'obj',
      paramPath: 'position',
    });
  });

  it('a data param resolves to the base, under the caller’s own path', () => {
    expect(resolveExposedTarget(split('box'), 'obj', 'size')).toEqual({
      nodeId: 'obj_data',
      paramPath: 'size',
    });
    expect(resolveExposedTarget(split('box'), 'obj', COLOR)).toEqual({
      nodeId: 'obj_data',
      paramPath: COLOR,
    });
  });

  it('steps past a GEOMETRY modifier, which is transparent to material by construction', () => {
    const state = spliceOp(split('box'), 'mod', 'ArrayModifier', { count: 2 });
    expect(resolveExposedTarget(state, 'obj', COLOR)!.nodeId).toBe('obj_data');
    expect(resolveExposedTarget(state, 'obj', 'size')!.nodeId).toBe('obj_data');
  });

  it('follows a linked Material node, because a socket supersedes the param it shares a name with', () => {
    const state = applyOps(split('box'), [
      { type: 'addNode', nodeId: 'mat', nodeType: 'Material', params: {} },
      {
        type: 'connect',
        from: { node: 'mat', socket: 'out' },
        to: { node: 'obj_data', socket: 'material' },
      },
    ] as Op[]);
    expect(resolveExposedTarget(state, 'obj', COLOR)).toEqual({
      nodeId: 'mat',
      paramPath: COLOR,
    });
  });

  it('answers null when nothing in the chain carries the param', () => {
    expect(resolveExposedTarget(split('box'), 'obj', 'nonesuch')).toBeNull();
    expect(resolveExposedTarget(split('box'), 'missing', 'position')).toBeNull();
  });
});

describe('the fall-through to the per-root reach — load-bearing, not defensive', () => {
  it('answers for a param a CUSTOM CONTROL renders, which has no projection row at all', () => {
    const state = split('camera');

    // First the premise, measured rather than assumed: `fov` really is absent from the
    // projection. It is one of nine keys the lens control owns, so the generic rows never
    // include it — which is exactly why a query built only on rows would answer null here.
    expect(exposeParams(state, 'obj').some((r) => r.paramPath === 'fov')).toBe(false);

    // …and the answer is still the data node, not the Object. A channel left on the Object
    // animates in the inspector read and never paints.
    expect(resolveExposedTarget(state, 'obj', 'fov')).toEqual({
      nodeId: 'obj_data',
      paramPath: 'fov',
    });
  });
});

describe('the vocabulary collision guard', () => {
  it('does NOT resolve a material field onto a split light’s own `color`', () => {
    const state = split('light');
    // The light owns a `color` param and it is NOT a material channel. Bridging on the name
    // alone would make this answer the LightData, turning "this target has no material" into
    // a silent write to the light's colour.
    expect(resolveExposedTarget(state, 'obj', COLOR)).toBeNull();
    // …while the light's own param resolves normally, so the guard is not just refusing
    // everything.
    expect(resolveExposedTarget(state, 'obj', 'color')).toEqual({
      nodeId: 'obj_data',
      paramPath: 'color',
    });
  });
});
