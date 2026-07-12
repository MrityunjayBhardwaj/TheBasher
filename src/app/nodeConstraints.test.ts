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
import {
  trackToForTarget,
  constraintTargetSet,
  resolveConstraintRotation,
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
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: TARGET_ID,
        nodeType: 'BoxMesh',
        params: { position: [10, 0, 0], size: [1, 1, 1] },
      },
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
