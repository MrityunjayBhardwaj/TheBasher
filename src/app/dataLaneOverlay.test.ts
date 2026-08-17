// #522 — which nodes feed a scene child's overlay, and what their paths mean there.
//
// Two independent properties, and the second needs a counter rather than an assertion about
// values:
//
//  1. WHAT the lane contributes. Every node from the base up, not just the one the Object's
//     `data` input names — that single hop is the defect, and it bites on an ordinary
//     geometry modifier with no material operator anywhere.
//
//  2. HOW OFTEN the ownership question is asked. Deciding what a later layer supplies
//     EVALUATES, and this runs per scene child. So it is asked ONCE per lane and only when
//     the lane holds something that can mask — ZERO times for the plain modifier lane the
//     defect was measured on. A test over the returned sources would pass just as happily
//     against a version that evaluated for every object in the scene.
//
// VACUITY GUARD: the base and the operator are distinct ids, and the fixtures put a forcing
// operator over a base that authors a different value, so a walk that stopped at either end
// cannot pass by coincidence.
//
// REF: src/app/dataLaneOverlay.ts; src/viewport/SceneFromDAG.tsx (the four hooks and the
//      membership gate that consume it); issues #522, #519, #516.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { SPLIT_KINDS, splitOps } from '../test-utils/splitKinds';

/** Counts real calls without replacing the implementation — the answers must stay true.
 *
 *  Self-validating: one case below expects exactly 1 and another exactly 0, so a spy that
 *  never intercepted (the usual way a module mock silently does nothing) fails one instead
 *  of passing both. */
const calls = { owners: 0 };
vi.mock('./resolveMaterialFieldOwner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolveMaterialFieldOwner')>();
  return {
    ...actual,
    resolveMaterialFieldOwners: (...args: Parameters<typeof actual.resolveMaterialFieldOwners>) => {
      calls.owners += 1;
      return actual.resolveMaterialFieldOwners(...args);
    },
  };
});

const { dataLaneNodeIds, dataLaneOverlaySources, overlayPathOn } =
  await import('./dataLaneOverlay');
const { MATERIAL_FIELD_IR_PATH } = await import('./resolveMaterialFieldOwner');

const COLOR_IR = MATERIAL_FIELD_IR_PATH.color;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  calls.owners = 0;
});

function applyOps(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

function splitCube(): DagState {
  return applyOps(
    emptyDagState(),
    splitOps('box', { objectId: 'obj' }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
  );
}

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
    { type: 'connect', from: { node: below, socket: 'out' }, to: { node: opId, socket: 'target' } },
    { type: 'connect', from: { node: opId, socket: 'out' }, to: { node: 'obj', socket: 'data' } },
  ] as Op[]);
}

describe('#522 — the overlay reaches the whole lane', () => {
  it('a bare split object contributes its data node, exactly as one hop did', () => {
    expect(dataLaneNodeIds(splitCube(), 'obj')).toEqual(['obj_data']);
  });

  it('a lane with a geometry modifier contributes the BASE too — the measured defect', () => {
    const state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    // Base FIRST, and the base is present at all: with one hop this list was ['mod'], so a
    // correctly-targeted channel on `obj_data` was never collected and never painted.
    expect(dataLaneNodeIds(state, 'obj')).toEqual(['obj_data', 'mod']);
  });

  it('a node with NO data lane contributes nothing, so its overlay is untouched', () => {
    // #476 — this case used to build a fused `SphereMesh`. The retirement did not empty the
    // class it stands for, so it retargets rather than being deleted: AmbientLight is the one
    // scene kind that deliberately never split (ambient is a World datablock), so it is a
    // live node with no `data` input and therefore the sharpest member of "no lane at all".
    const state = applyOps(emptyDagState(), [
      { type: 'addNode', nodeId: 'ambient', nodeType: 'AmbientLight', params: {} },
    ] as Op[]);
    // Guard-the-guard: an absent id returns [] just as happily, so the empty answer only
    // means anything once the subject is known to be there.
    expect(state.nodes['ambient']).toBeDefined();
    expect(dataLaneNodeIds(state, 'ambient')).toEqual([]);
    expect(dataLaneOverlaySources(state, 'ambient')).toEqual([]);
  });
});

describe('#522 — what a lane node’s path MEANS on the composed value', () => {
  it('translates a forcing operator’s flat field into the IR the value carries', () => {
    const state = spliceOp(splitCube(), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });
    const op = dataLaneOverlaySources(state, 'obj').find((s) => s.nodeId === 'ovr')!;
    // Without this the entry is rebased as `data.color`, which no renderer reads — measured,
    // and it is why a channel placed on the operator did not paint either.
    expect(overlayPathOn(op, 'color')).toBe(COLOR_IR);
  });

  it('drops a masked layer’s entry, so a fallback cannot beat the layer above it', () => {
    const state = spliceOp(splitCube(), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });
    const base = dataLaneOverlaySources(state, 'obj').find((s) => s.nodeId === 'obj_data')!;
    expect(overlayPathOn(base, COLOR_IR)).toBeNull();
    // …and only that field. The base still owns everything the operator does not supply.
    expect(overlayPathOn(base, 'size')).toBe('size');
  });

  it('MUTING the operator hands the field back — the same walk, no special case', () => {
    const state = spliceOp(splitCube(), 'ovr', 'MaterialOverrideOp', {
      color: '#00ff88',
      muted: true,
    });
    const base = dataLaneOverlaySources(state, 'obj').find((s) => s.nodeId === 'obj_data')!;
    expect(overlayPathOn(base, COLOR_IR)).toBe(COLOR_IR);
  });

  it('a plain modifier lane translates and masks NOTHING', () => {
    const state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    for (const src of dataLaneOverlaySources(state, 'obj')) {
      expect(src.translate).toBeUndefined();
      expect(src.masked).toBeUndefined();
      expect(overlayPathOn(src, COLOR_IR)).toBe(COLOR_IR);
    }
  });
});

describe('#522 — how OFTEN the ownership question is asked', () => {
  it('asks ZERO times for a lane that cannot mask — which is every default object', () => {
    const state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    dataLaneOverlaySources(state, 'obj');
    // This runs per scene child on every render, and the walk EVALUATES. A version that
    // asked unconditionally would return identical sources and cost the whole scene.
    expect(calls.owners).toBe(0);
  });

  it('asks exactly ONCE for a lane that can, however many nodes it holds', () => {
    let state = spliceOp(splitCube(), 'lower', 'MaterialOverrideOp', {
      color: '#00ff88',
      overridden: { color: true },
    });
    state = spliceOp(state, 'mod', 'ArrayModifier', { count: 2 });
    state = spliceOp(state, 'upper', 'MaterialOverrideOp', {
      color: '#ff00ff',
      overridden: { color: true },
    });
    const sources = dataLaneOverlaySources(state, 'obj');
    expect(sources).toHaveLength(4);
    expect(calls.owners).toBe(1);
  });
});
