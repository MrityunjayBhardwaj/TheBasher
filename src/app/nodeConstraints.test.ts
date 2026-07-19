// nodeConstraints — the scene-layer Track-To resolution (epic #201, slice #204).
// Asserts resolveConstraintRotation consumes resolveWorldTransform (#202) for the
// object + target world positions and derives the aim; point AND node-ref targets;
// node-ref tracking a MOVING (animated) target; mute + cycle safety.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1; vyapti V58/V56/V37.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import {
  trackToForTarget,
  constraintTargetSet,
  constraintStackForTarget,
  resolveConstraintRotation,
  resolveTrackToTarget,
} from './nodeConstraints';
import { resolveTrackTo } from './resolveTrackTo';

type Vec3 = [number, number, number];

const BOX_ID = 'n_box';
const TT_ID = 'n_tt';
const TARGET_ID = 'n_target_box';

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/** -Z world direction of an object posed with this Euler (deg, XYZ). */
function minusZ(euler: Vec3): THREE.Vector3 {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(euler[0]),
    THREE.MathUtils.degToRad(euler[1]),
    THREE.MathUtils.degToRad(euler[2]),
    'XYZ',
  );
  return new THREE.Vector3(0, 0, -1).applyEuler(e);
}

/** Default project + a Track-To on n_box. `aimNode` empty → point target. */
function buildPointTrackTo(boxPos: Vec3, aimPoint: Vec3): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'position',
    value: boxPos,
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: TT_ID,
    nodeType: 'TrackTo',
    params: { name: 'tt', target: BOX_ID, aimNode: '', aimPoint, up: [0, 1, 0], mute: false },
  }).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('nodeConstraints — enumeration', () => {
  it('trackToForTarget finds an active constraint and skips muted/other targets', () => {
    let state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    expect(trackToForTarget(state.nodes, BOX_ID)?.aimPoint).toEqual([1, 0, 0]);
    expect(trackToForTarget(state.nodes, 'n_camera')).toBeNull();
    // Mute → inert.
    state = applyOp(state, {
      type: 'setParam',
      nodeId: TT_ID,
      paramPath: 'mute',
      value: true,
    }).next;
    expect(trackToForTarget(state.nodes, BOX_ID)).toBeNull();
  });

  it('constraintTargetSet collects constrained node ids (excludes muted)', () => {
    const state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    expect(constraintTargetSet(state.nodes).has(BOX_ID)).toBe(true);
    expect(constraintTargetSet(state.nodes).size).toBe(1);
  });

  // #311 T1 — a PRE-STACK project (authored with no `order`, exactly as
  // buildPointTrackTo does) must deserialize to order 0, so it is a single-member
  // stack in node-table order == the old first-wins scan. No migration needed: the
  // zod `.default(0)` fills it at addNode. This is the serialize byte-identity pin.
  it('an order-less TrackTo (pre-stack project) defaults to order 0', () => {
    const state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    expect((state.nodes[TT_ID].params as { order?: unknown }).order).toBe(0);
  });
});

// #311 T2 — the ordered stack. The byte-identity claim under test: with every
// constraint at order 0 (every pre-stack project), the stable sort is a no-op over
// node-table order, so `[0]` is the node the old first-wins scan returned.
describe('nodeConstraints — the ordered constraint stack (#311)', () => {
  /** Add a 2nd/3rd Track-To on BOX_ID with an explicit order. */
  function addTrackTo(state: DagState, id: string, aimPoint: Vec3, order: number): DagState {
    return applyOp(state, {
      type: 'addNode',
      nodeId: id,
      nodeType: 'TrackTo',
      params: {
        name: id,
        target: BOX_ID,
        aimNode: '',
        aimPoint,
        up: [0, 1, 0],
        mute: false,
        order,
      },
    } as Op).next;
  }

  it('stacks every active constraint on the target, sorted bottom → top by order', () => {
    let state = buildPointTrackTo([0, 0, 0], [1, 0, 0]); // TT_ID, order 0
    state = addTrackTo(state, 'n_tt_b', [0, 0, 1], -5); // sorts BELOW the default
    state = addTrackTo(state, 'n_tt_c', [0, 1, 0], 10); // sorts ABOVE it

    const stack = constraintStackForTarget(state.nodes, BOX_ID);
    expect(stack.map((m) => m.nodeId)).toEqual(['n_tt_b', TT_ID, 'n_tt_c']);
    expect(stack.map((m) => m.order)).toEqual([-5, 0, 10]);
  });

  it('[0] equals the old first-wins scan when every order is 0 (the identity pin)', () => {
    let state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    state = addTrackTo(state, 'n_tt_b', [0, 0, 1], 0); // SAME order → stable → table order
    const stack = constraintStackForTarget(state.nodes, BOX_ID);
    expect(stack).toHaveLength(2);
    // Stable sort keeps the first-declared node first — exactly first-wins.
    expect(stack[0].nodeId).toBe(TT_ID);
    expect(trackToForTarget(state.nodes, BOX_ID)?.nodeId).toBe(TT_ID);
  });

  it('excludes muted members and other targets; an unbound TrackTo is inert', () => {
    let state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    state = addTrackTo(state, 'n_tt_muted', [0, 0, 1], 1);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_tt_muted',
      paramPath: 'mute',
      value: true,
    }).next;
    expect(constraintStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([TT_ID]);
    expect(constraintStackForTarget(state.nodes, 'n_camera')).toEqual([]);

    // An unbound constraint (target '') must not leak into the target set.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt_unbound',
      nodeType: 'TrackTo',
      params: { name: 'unbound' },
    } as Op).next;
    expect(constraintTargetSet(state.nodes).has('')).toBe(false);
    expect(constraintTargetSet(state.nodes).size).toBe(1);
  });

  it('members carry the normalized aim shape (never raw node params)', () => {
    const state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    const [m] = constraintStackForTarget(state.nodes, BOX_ID);
    expect(m.aimPoint).toEqual([1, 0, 0]);
    expect(m.aimNode).toBe('');
    expect(m.up).toEqual([0, 1, 0]);
    expect(m.target).toBe(BOX_ID);
  });

  // #311 T3 — the fold. A SINGLE member must resolve exactly as the pre-stack
  // first-wins path did (identity); TWO members must now COMPOSE (the capability
  // first-wins made impossible — the 2nd constraint used to be silently ignored).
  it('a single-member stack resolves identically to the pure aim resolver (identity)', () => {
    const state = buildPointTrackTo([0, 0, 0], [5, 0, 0]);
    expect(resolveConstraintRotation(state, BOX_ID, ctxAt(0))).toEqual(
      resolveTrackTo([0, 0, 0], [5, 0, 0]),
    );
  });

  it('two members compose — the higher-order member wins the rotation band', () => {
    let state = buildPointTrackTo([0, 0, 0], [5, 0, 0]); // order 0 → aims at +X
    state = addTrackTo(state, 'n_tt_top', [0, 0, -5], 10); // order 10 → aims at -Z

    // Pre-#311 this 2nd constraint was silently DROPPED (first-wins) and the box kept
    // aiming at +X. Now the top of the stack owns the band.
    const rot = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!;
    expect(minusZ(rot).z).toBeCloseTo(-1, 5);
    expect(rot).toEqual(resolveTrackTo([0, 0, 0], [0, 0, -5]));

    // The camera aim point follows the SAME winner (one band, one winner).
    expect(resolveTrackToTarget(state, BOX_ID, ctxAt(0))).toEqual([0, 0, -5]);
  });

  it('a degenerate top member contributes nothing — the member below still aims', () => {
    let state = buildPointTrackTo([0, 0, 0], [5, 0, 0]);
    // Aim point == the object's own world position → zero distance → undefined aim.
    state = addTrackTo(state, 'n_tt_degen', [0, 0, 0], 10);
    expect(resolveConstraintRotation(state, BOX_ID, ctxAt(0))).toEqual(
      resolveTrackTo([0, 0, 0], [5, 0, 0]),
    );
  });
});

describe('resolveConstraintRotation — point target', () => {
  it('derives the aim from the object world position → point (consumes #202)', () => {
    const state = buildPointTrackTo([0, 0, 0], [5, 0, 0]);
    const rot = resolveConstraintRotation(state, BOX_ID, ctxAt(0));
    expect(rot).not.toBeNull();
    // -Z points toward +X.
    expect(minusZ(rot!).x).toBeCloseTo(1, 5);
    // Identical to the pure resolver fed the same world positions.
    expect(rot).toEqual(resolveTrackTo([0, 0, 0], [5, 0, 0]));
  });

  it('the object world position matters: an offset box aims differently', () => {
    const state = buildPointTrackTo([0, 0, 5], [0, 0, 0]);
    const rot = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!;
    // Box at +Z aiming at origin → -Z points toward -Z.
    expect(minusZ(rot).z).toBeCloseTo(-1, 5);
  });

  it('returns null for an unconstrained node', () => {
    const state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    expect(resolveConstraintRotation(state, 'n_camera', ctxAt(0))).toBeNull();
  });

  it('returns null when muted', () => {
    let state = buildPointTrackTo([0, 0, 0], [1, 0, 0]);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: TT_ID,
      paramPath: 'mute',
      value: true,
    }).next;
    expect(resolveConstraintRotation(state, BOX_ID, ctxAt(0))).toBeNull();
  });
});

describe('resolveConstraintRotation — node-ref target', () => {
  /** Default project + a SECOND box (the aim target) + a Track-To on n_box aimed
   *  at it. Optionally animate the target's position so the aim must follow. */
  function buildNodeRefTrackTo(opts: { animateTarget?: boolean }): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [0, 0, 0],
    }).next;
    state = makeSplitCube(state, {
      objectId: TARGET_ID,
      position: [10, 0, 0],
      size: [1, 1, 1],
    }).state;
    const ops: Op[] = [
      {
        type: 'connect',
        from: { node: TARGET_ID, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'addNode',
        nodeId: TT_ID,
        nodeType: 'TrackTo',
        params: {
          name: 'tt',
          target: BOX_ID,
          aimNode: TARGET_ID,
          aimPoint: [0, 0, 0],
          up: [0, 1, 0],
          mute: false,
        },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;
    if (opts.animateTarget) {
      state = applyOp(state, {
        type: 'addNode',
        nodeId: 'n_target_ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'targetpos',
          target: TARGET_ID,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [10, 0, 0], easing: 'linear' },
            { time: 1, value: [0, 0, 10], easing: 'linear' },
          ],
        },
      }).next;
    }
    return state;
  }

  it('aims at the target node world position (reads target via #202)', () => {
    const state = buildNodeRefTrackTo({});
    const rot = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!;
    // n_box at origin, target box at +X → -Z toward +X.
    expect(minusZ(rot).x).toBeCloseTo(1, 5);
  });

  it('follows a MOVING target: distinct aims at distinct times', () => {
    const state = buildNodeRefTrackTo({ animateTarget: true });
    const at0 = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!; // target at +X
    const at1 = resolveConstraintRotation(state, BOX_ID, ctxAt(1))!; // target at +Z
    expect(minusZ(at0).x).toBeCloseTo(1, 4);
    expect(minusZ(at1).z).toBeCloseTo(1, 4);
    expect(at0).not.toEqual(at1);
  });

  it('cycle safety: A→B and B→A both resolve off the other’s un-aimed world (no loop)', () => {
    let state = buildNodeRefTrackTo({});
    // Add the reverse constraint: target box tracks n_box.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt_rev',
      nodeType: 'TrackTo',
      params: {
        name: 'ttrev',
        target: TARGET_ID,
        aimNode: BOX_ID,
        aimPoint: [0, 0, 0],
        up: [0, 1, 0],
        mute: false,
      },
    }).next;
    // Both terminate (resolveWorldTransform is constraint-free → no re-entry).
    const a = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!;
    const b = resolveConstraintRotation(state, TARGET_ID, ctxAt(0))!;
    expect(minusZ(a).x).toBeCloseTo(1, 5); // box at origin aims +X at target
    expect(minusZ(b).x).toBeCloseTo(-1, 5); // target at +X aims -X back at box
  });
});
