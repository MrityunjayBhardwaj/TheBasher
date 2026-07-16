// FollowPath — the POSITION band of the constraint stack (#339).
//
// Three of these tests exist because reading the code before writing it turned up three
// things a "register it and write a sibling fold" build would have shipped broken, each
// silent:
//
//   1. BAND SEPARATION — the shared enumeration used to hand back a Track-To-shaped value.
//      A Follow-Path coerced into that view comes out as `aimNode: ''` → `aimPoint:
//      [0,0,0]`, and the rotation fold aims the object at the WORLD ORIGIN.
//   2. THE AIM ORIGIN — the bands are orthogonal in what they WRITE, but an aim is derived
//      FROM a position, so rotation READS what position writes. Aim from the authored
//      position and "fly the path while locked on the hero" is wrong by exactly the
//      distance the path moved the camera.
//   3. `evalTime` IS RESOLVED, NOT RAW — read it off the param and keyframes on it are
//      ignored, which would quietly falsify the entire reason the seam is arc-length
//      parameterized.
//
// Each is pinned below. None of them throws; all three would pass a naive test suite.
//
// REF: issue #339; src/app/nodeConstraints.ts; src/app/curveSampleSource.ts (the seam +
//      its own arc-length proof, which this file does not duplicate).

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  constraintStackForTarget,
  followPathStackForTarget,
  relationalPoseStackForTarget,
  constraintTargetSet,
  nextConstraintOrder,
  resolveConstraintPosition,
  resolveConstraintRotation,
} from './nodeConstraints';
import { resolveCameraPoseAt } from './activeCamera';

type Vec3 = [number, number, number];

const BOX_ID = 'n_box';
const CURVE_ID = 'n_curve';
const FP_ID = 'n_fp';

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** Deliberately LOPSIDED spacing — the shape that separates arc-length from raw `t`: one
 *  long span then two tight ones. Collinear, so the expected point is plain arithmetic. */
const LOPSIDED: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [11, 0, 0],
  [12, 0, 0],
];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** -Z world direction of an object posed with this Euler (deg, XYZ) — where it looks. */
function minusZ(euler: Vec3): THREE.Vector3 {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(euler[0]),
    THREE.MathUtils.degToRad(euler[1]),
    THREE.MathUtils.degToRad(euler[2]),
    'XYZ',
  );
  return new THREE.Vector3(0, 0, -1).applyEuler(e);
}

/** A curve WIRED INTO THE SCENE — the seam resolves its pose through the shared scene-tree
 *  walk, so a floating node has no world transform (curveSampleSource.test.ts's note). */
function addCurve(state: DagState, id = CURVE_ID, params: Record<string, unknown> = {}): DagState {
  let s = applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'Curve',
    params: { points: LOPSIDED, closed: false, resolution: 32, ...params },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  }).next;
  return s;
}

function addFollowPath(
  state: DagState,
  params: Record<string, unknown> = {},
  id = FP_ID,
): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'FollowPath',
    params: { name: 'fp', target: BOX_ID, curve: CURVE_ID, evalTime: 0, offset: 0, ...params },
  }).next;
}

/** Default project + a scene-wired curve + a Follow-Path binding n_box to it. */
function buildFollowing(params: Record<string, unknown> = {}): DagState {
  return addFollowPath(addCurve(buildDefaultDagState()), params);
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('FollowPath — band separation (the enumeration is shared, the coercion is not)', () => {
  it('a Follow-Path is in the pose stack and the follow band, but NOT the aim band', () => {
    const state = buildFollowing();
    expect(relationalPoseStackForTarget(state.nodes, BOX_ID).map((m) => m.type)).toEqual([
      'FollowPath',
    ]);
    expect(followPathStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([FP_ID]);
    // THE PIN: the aim band must not see it. If it did, the coercion would fabricate
    // `aimPoint: [0,0,0]` and the object would be aimed at the world origin.
    expect(constraintStackForTarget(state.nodes, BOX_ID)).toEqual([]);
  });

  it('a Follow-Path alone derives NO rotation (the aim-at-origin trap)', () => {
    const state = buildFollowing({ evalTime: 0.5 });
    // The object moves...
    expect(resolveConstraintPosition(state, BOX_ID, ctxAt(0))).not.toBeNull();
    // ...and is not silently rotated to face [0,0,0] while doing it.
    expect(resolveConstraintRotation(state, BOX_ID, ctxAt(0))).toBeNull();
  });

  it('both bands enumerate from ONE scan: a mixed stack keeps every member, in order', () => {
    let state = buildFollowing({ order: 0 });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt',
      nodeType: 'TrackTo',
      params: { target: BOX_ID, aimNode: '', aimPoint: [1, 0, 0], up: [0, 1, 0], order: 1 },
    }).next;
    // The whole stack (what the panel renders) — both bands, bottom → top.
    expect(relationalPoseStackForTarget(state.nodes, BOX_ID).map((m) => m.type)).toEqual([
      'FollowPath',
      'TrackTo',
    ]);
    // Each band's view — same membership rule, its own members.
    expect(followPathStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([FP_ID]);
    expect(constraintStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId)).toEqual(['n_tt']);
  });

  it('constraintTargetSet includes a Follow-Path-only target (it must mount a follower)', () => {
    const state = buildFollowing();
    expect(constraintTargetSet(state.nodes).has(BOX_ID)).toBe(true);
  });

  it('nextConstraintOrder counts BOTH bands — a new member never ties with the other band', () => {
    let state = buildFollowing({ order: 0 });
    // A Track-To added next must land ABOVE the Follow-Path, not tie with it at 0.
    expect(nextConstraintOrder(state.nodes, BOX_ID)).toBe(1);
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt',
      nodeType: 'TrackTo',
      params: { target: BOX_ID, order: nextConstraintOrder(state.nodes, BOX_ID) },
    }).next;
    expect(nextConstraintOrder(state.nodes, BOX_ID)).toBe(2);
  });
});

describe('FollowPath — the position fold', () => {
  it('places the object ON the path: u=0 → start, u=1 → end', () => {
    expect(resolveConstraintPosition(buildFollowing({ evalTime: 0 }), BOX_ID, ctxAt(0))).toEqual([
      0, 0, 0,
    ]);
    const end = resolveConstraintPosition(buildFollowing({ evalTime: 1 }), BOX_ID, ctxAt(0))!;
    expect(dist(end, [12, 0, 0])).toBeLessThan(1e-6);
  });

  it('maps evalTime by ARC LENGTH, not by spline t (the whole point of the seam)', () => {
    const mid = resolveConstraintPosition(buildFollowing({ evalTime: 0.5 }), BOX_ID, ctxAt(0))!;
    // Half the LENGTH of a 12-unit path is x≈6. Raw `t` would put the halfway point in the
    // last third of the control points (x≈10.5) — the lurch this seam exists to remove.
    expect(mid[0]).toBeGreaterThan(5.5);
    expect(mid[0]).toBeLessThan(6.5);
  });

  it('an open path CLAMPS past its ends; a closed one WRAPS', () => {
    const openPast = resolveConstraintPosition(
      buildFollowing({ evalTime: 1.25 }),
      BOX_ID,
      ctxAt(0),
    )!;
    expect(dist(openPast, [12, 0, 0])).toBeLessThan(1e-6);
    // Closed: u=1.25 is the same point as u=0.25.
    const closed = addFollowPath(addCurve(buildDefaultDagState(), CURVE_ID, { closed: true }), {
      evalTime: 1.25,
    });
    const closedQuarter = addFollowPath(
      addCurve(buildDefaultDagState(), CURVE_ID, { closed: true }),
      { evalTime: 0.25 },
    );
    const a = resolveConstraintPosition(closed, BOX_ID, ctxAt(0))!;
    const b = resolveConstraintPosition(closedQuarter, BOX_ID, ctxAt(0))!;
    expect(dist(a, b)).toBeLessThan(1e-6);
  });

  it('`offset` shifts along the path (one animation, a convoy of objects)', () => {
    const at0 = resolveConstraintPosition(buildFollowing({ evalTime: 0.5 }), BOX_ID, ctxAt(0))!;
    const shifted = resolveConstraintPosition(
      buildFollowing({ evalTime: 0.25, offset: 0.25 }),
      BOX_ID,
      ctxAt(0),
    )!;
    expect(dist(at0, shifted)).toBeLessThan(1e-6);
  });

  it('a MUTED member contributes nothing', () => {
    const state = buildFollowing({ evalTime: 0.5, mute: true });
    expect(resolveConstraintPosition(state, BOX_ID, ctxAt(0))).toBeNull();
  });

  it('a DEGENERATE member (no curve / unresolvable curve) contributes nothing, never throws', () => {
    expect(resolveConstraintPosition(buildFollowing({ curve: '' }), BOX_ID, ctxAt(0))).toBeNull();
    expect(
      resolveConstraintPosition(buildFollowing({ curve: 'n_nope' }), BOX_ID, ctxAt(0)),
    ).toBeNull();
    // A `curve` pointing at something that isn't a Curve — the seam returns null, the fold
    // treats it as degenerate rather than crashing the whole transform read.
    expect(
      resolveConstraintPosition(buildFollowing({ curve: BOX_ID }), BOX_ID, ctxAt(0)),
    ).toBeNull();
  });

  it('an unconstrained node resolves to null (identity — position unchanged)', () => {
    const state = addCurve(buildDefaultDagState());
    expect(resolveConstraintPosition(state, BOX_ID, ctxAt(0))).toBeNull();
  });

  it('LAST-WRITER-WINS: the top member owns the position', () => {
    let state = buildFollowing({ evalTime: 0, order: 0 });
    state = addFollowPath(state, { evalTime: 1, order: 1 }, 'n_fp2');
    const p = resolveConstraintPosition(state, BOX_ID, ctxAt(0))!;
    expect(dist(p, [12, 0, 0])).toBeLessThan(1e-6); // the order:1 member, not order:0
    // ...and a degenerate TOP member falls through to the one below, like a muted one.
    let fallthrough = buildFollowing({ evalTime: 0, order: 0 });
    fallthrough = addFollowPath(fallthrough, { curve: '', order: 1 }, 'n_fp2');
    expect(resolveConstraintPosition(fallthrough, BOX_ID, ctxAt(0))).toEqual([0, 0, 0]);
  });
});

describe('FollowPath — evalTime is RESOLVED, not read raw', () => {
  it('a keyframed evalTime animates the object along the path', () => {
    let state = buildFollowing({ evalTime: 0 });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_evalTime',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'evalTime',
        target: FP_ID,
        paramPath: 'evalTime',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    // THE PIN: read raw, every one of these would be the start point and the F-curve
    // editor would be decorative. The whole "eased path-speed for free" claim is this.
    const start = resolveConstraintPosition(state, BOX_ID, ctxAt(0))!;
    const mid = resolveConstraintPosition(state, BOX_ID, ctxAt(0.5))!;
    const end = resolveConstraintPosition(state, BOX_ID, ctxAt(1))!;
    expect(dist(start, [0, 0, 0])).toBeLessThan(1e-6);
    expect(dist(end, [12, 0, 0])).toBeLessThan(1e-6);
    expect(mid[0]).toBeGreaterThan(5.5);
    expect(mid[0]).toBeLessThan(6.5);
  });

  it('a LINEAR evalTime ramp yields CONSTANT SPEED (the ease is the director’s, not the curve’s)', () => {
    let state = buildFollowing({ evalTime: 0 });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_evalTime',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'evalTime',
        target: FP_ID,
        paramPath: 'evalTime',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    const pts: Vec3[] = [];
    for (let i = 0; i <= 10; i++)
      pts.push(resolveConstraintPosition(state, BOX_ID, ctxAt(i / 10))!);
    const gaps: number[] = [];
    for (let i = 1; i < pts.length; i++) gaps.push(dist(pts[i - 1], pts[i]));
    // Constant speed end to end over a deliberately lopsided curve. Sampled by raw `t` the
    // spread would be several-fold (see curveSampleSource.test.ts's falsifier).
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.05);
  });
});

describe('FollowPath — the CAMERA road (the headline, and its own resolver)', () => {
  // A camera is posed by `resolveCameraPoseAt`, NOT by the mesh road — it is never a
  // scene-child, so it never meets ConstrainedR or resolveEvaluatedTransform. Fold the
  // position band only on the mesh road and a Follow-Path works on a cube and silently
  // does NOTHING on a camera: the one object the whole rig is for.
  it('a camera flies the path — its pose resolver folds the position band too', () => {
    const state = addFollowPath(addCurve(buildDefaultDagState()), {
      target: 'n_camera',
      evalTime: 1,
    });
    const pose = resolveCameraPoseAt(state, 'n_camera', 0)!;
    expect(dist(pose.position as Vec3, [12, 0, 0])).toBeLessThan(1e-6);
  });

  it('"fly the path while locked on the hero" — position from the path, aim at the subject', () => {
    // THE SENTENCE THE WHOLE CAMERA RIG EXISTS FOR, as one assertion.
    let state = addFollowPath(addCurve(buildDefaultDagState()), {
      target: 'n_camera',
      evalTime: 1,
      order: 0,
    });
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [12, 0, 8],
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt',
      nodeType: 'TrackTo',
      params: { target: 'n_camera', aimNode: BOX_ID, up: [0, 1, 0], order: 1 },
    }).next;

    const pose = resolveCameraPoseAt(state, 'n_camera', 0)!;
    // On the path...
    expect(dist(pose.position as Vec3, [12, 0, 0])).toBeLessThan(1e-6);
    // ...and locked on the hero. A camera aims by a lookAt POINT, so the two bands need no
    // ordering: move the camera and the aim follows.
    expect(dist(pose.lookAt as Vec3, [12, 0, 8])).toBeLessThan(1e-6);
  });

  it('a keyframed evalTime moves the CAMERA along the path over time', () => {
    let state = addFollowPath(addCurve(buildDefaultDagState()), {
      target: 'n_camera',
      evalTime: 0,
    });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_evalTime',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'evalTime',
        target: FP_ID,
        paramPath: 'evalTime',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    expect(
      dist(resolveCameraPoseAt(state, 'n_camera', 0)!.position as Vec3, [0, 0, 0]),
    ).toBeLessThan(1e-6);
    expect(
      dist(resolveCameraPoseAt(state, 'n_camera', 1)!.position as Vec3, [12, 0, 0]),
    ).toBeLessThan(1e-6);
  });

  it('an unfollowed camera keeps its authored pose (byte-identical)', () => {
    const state = addCurve(buildDefaultDagState());
    const pose = resolveCameraPoseAt(state, 'n_camera', 0)!;
    expect(pose.position).toEqual([3, 2, 3]);
  });
});

describe('FollowPath — the aim origin (rotation reads what position writes)', () => {
  it('a tracked follower aims from where the PATH put it, not from where it was authored', () => {
    // The box follows to the path's end [12,0,0] and tracks a target at [12,0,12].
    // From the FOLLOWED position the aim is straight +Z. From the AUTHORED position
    // (the default [0,0,0]-ish) it would be a diagonal — wrong by the whole path.
    let state = buildFollowing({ evalTime: 1, order: 0 });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_aim',
      nodeType: 'Null',
      params: { position: [12, 0, 12] },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_aim', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt',
      nodeType: 'TrackTo',
      params: { target: BOX_ID, aimNode: 'n_aim', up: [0, 1, 0], order: 1 },
    }).next;

    const rot = resolveConstraintRotation(state, BOX_ID, ctxAt(0))!;
    const look = minusZ(rot);
    expect(look.x).toBeCloseTo(0, 5);
    expect(look.z).toBeCloseTo(1, 5);
  });

  it('aiming AT a path-follower tracks where the path put IT (the mirror case)', () => {
    // n_box sits at the origin and tracks n_hero, which follows the path to [12,0,0].
    let state = applyOp(buildDefaultDagState(), {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [0, 0, 0],
    }).next;
    state = addCurve(state);
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_hero',
      nodeType: 'Null',
      params: { position: [0, 0, 5] },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_hero', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    }).next;
    state = addFollowPath(state, { target: 'n_hero', evalTime: 1 }, 'n_fp_hero');
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt',
      nodeType: 'TrackTo',
      params: { target: BOX_ID, aimNode: 'n_hero', up: [0, 1, 0] },
    }).next;

    // The hero is really at [12,0,0] → the box looks +X. Aiming at its authored [0,0,5]
    // would look +Z instead: the aim would trail the subject by the whole path.
    const look = minusZ(resolveConstraintRotation(state, BOX_ID, ctxAt(0))!);
    expect(look.x).toBeCloseTo(1, 5);
    expect(look.z).toBeCloseTo(0, 5);
  });
});
