// curveSampleSource — the ARC-LENGTH PROOF (#321).
//
// The claim the whole camera rig rests on: sampling a curve at evenly-spaced `u` yields
// evenly-spaced points IN WORLD SPACE — constant speed. Phase 4's Follow-Path maps a
// keyframeable evalTime onto `u`, so if this is false, a linear evalTime lurches and no
// amount of F-curve easing can fix it (you cannot author an ease on top of a base motion
// that isn't constant-speed).
//
// Each test that asserts constant speed is paired with a FALSIFIER — the same curve
// sampled by raw spline parameter `t` — which must FAIL the same assertion. Without the
// falsifier the test would still pass if someone "simplified" the seam back to getPoint(t)
// on an evenly-spaced curve, and the regression would ship silently.

import { describe, expect, it, beforeAll } from 'vitest';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp } from '../core/dag/ops';
import { registerAllNodes } from '../nodes/registerAll';
import { sampleCurve } from '../nodes/curveMath';
import type { Vec3 } from '../nodes/types';
import { withIds } from '../test-utils/curvePoints';
import { curveSamplerFor, readCurveSampleAt } from './curveSampleSource';

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** Deliberately LOPSIDED spacing: a long first span, then two tight ones. This is the
 *  shape that exposes raw-`t` sampling — each span gets an equal share of `t` however long
 *  it is, so the object bolts through the long span and crawls through the short ones. */
const LOPSIDED: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [11, 0, 0],
  [12, 0, 0],
];

/** Add a curve AND wire it into the scene, as the real add road does (addPrimitives).
 *  The wiring is not incidental: the seam reads the curve's pose through the shared
 *  `resolveWorldTransform`, which walks the SCENE TREE — a floating, unparented node has
 *  no world transform at all. (That is the correct behaviour, and the reason this seam
 *  does not just read `params.position`: a curve may be nested under a Group, and only
 *  the tree walk knows that.) */
function addCurve(state: DagState, id: string, params: Record<string, unknown>): DagState {
  let s = applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'Curve',
    params: { points: withIds(LOPSIDED), closed: false, resolution: 32, ...params },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  }).next;
  return s;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The gaps between consecutive samples at evenly-spaced u. */
function gapsAt(sampleAt: (u: number) => Vec3, steps: number): number[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= steps; i++) pts.push(sampleAt(i / steps));
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) gaps.push(dist(pts[i - 1], pts[i]));
  return gaps;
}

/** max/min gap. 1 = perfectly constant speed; a big number = lurching. */
const spread = (gaps: number[]) => Math.max(...gaps) / Math.min(...gaps);

beforeAll(() => {
  registerAllNodes();
});

describe('curveSampleSource — arc-length parameterization', () => {
  it('samples a lopsided curve at CONSTANT SPEED in u (the claim Follow-Path rests on)', () => {
    const state = addCurve(buildDefaultDagState(), 'c1', {});
    const sampler = curveSamplerFor(state, 'c1', CTX)!;
    expect(sampler).toBeTruthy();

    const gaps = gapsAt((u) => sampler.pointAt(u), 16);
    // Every step of equal `u` covers equal DISTANCE. (Not exactly 1.0: the table
    // integrates a polyline, so a finite resolution leaves a little slack.)
    expect(spread(gaps)).toBeLessThan(1.05);
  });

  it('FALSIFIER: the same curve by raw spline `t` LURCHES — so the test above has teeth', () => {
    // Sample the SAME baked polyline by index fraction (which is what getPoint(t) does:
    // equal `t` per span, regardless of span length) instead of by arc length.
    const samples = sampleCurve(LOPSIDED, false, 32);
    const byRawT = (u: number): Vec3 => samples[Math.round(u * (samples.length - 1))];

    const gaps = gapsAt(byRawT, 16);
    // The long span is ~10 units and the short ones ~1 each, all given equal `t` — so the
    // speed varies by nearly an order of magnitude. If this ever drops near 1.0, the
    // fixture stopped being lopsided and the test above stopped proving anything.
    expect(spread(gaps)).toBeGreaterThan(3);
  });

  it('measures arc length in WORLD space — a non-uniform scale does not break constant speed', () => {
    // x is stretched 5x and z is squashed: local arc length is now disproportionate to
    // world arc length, so a table built in LOCAL space would lurch. The seam builds it
    // in world, so it doesn't.
    const state = addCurve(buildDefaultDagState(), 'c1', {
      points: withIds([
        [0, 0, 0],
        [4, 0, 0],
        [4, 0, 4],
        [0, 0, 4],
      ]),
      scale: [5, 1, 0.2],
    });
    const sampler = curveSamplerFor(state, 'c1', CTX)!;

    const gaps = gapsAt((u) => sampler.pointAt(u), 16);
    expect(spread(gaps)).toBeLessThan(1.1);

    // And the reported length is the WORLD length, not the local one: the two straight
    // legs are 4×5 = 20 and 4×0.2 = 0.8 world units (plus spline rounding at the corner).
    expect(sampler.length).toBeGreaterThan(18);
  });

  it('inherits a PARENT Group’s transform — arc length stays constant-speed under it', () => {
    // The case the seam exists for, and the one a local-space table could never survive:
    // the curve itself is untransformed, but its PARENT stretches x by 6. Local arc length
    // is unchanged; world arc length is not. Nothing in the curve's own params says so —
    // only the scene-tree walk knows, which is exactly why this read cannot live in the
    // node's pure `evaluate`.
    let state = applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'g1',
      nodeType: 'Group',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [6, 1, 1] },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'c1',
      nodeType: 'Curve',
      params: {
        points: withIds([
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 1],
          [0, 0, 1],
        ]),
        resolution: 32,
      },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'c1', socket: 'out' },
      to: { node: 'g1', socket: 'children' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'g1', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    }).next;

    const sampler = curveSamplerFor(state, 'c1', CTX)!;
    expect(sampler).toBeTruthy();

    // The parent's 6x stretch reached the sample: the world path is far longer than the
    // ~3-unit local one. (A local-space table would report ~3 and place a follower wrong.)
    expect(sampler.length).toBeGreaterThan(10);

    // And it is still constant-speed in u despite the inherited non-uniform scale.
    expect(spread(gapsAt((u) => sampler.pointAt(u), 16))).toBeLessThan(1.15);
  });

  it('the world transform moves the sampled point (the curve is posed like any object)', () => {
    const base = addCurve(buildDefaultDagState(), 'c1', {});
    const moved = addCurve(buildDefaultDagState(), 'c1', { position: [0, 7, 0] });

    const a = readCurveSampleAt(base, 'c1', 0.5, CTX)!;
    const b = readCurveSampleAt(moved, 'c1', 0.5, CTX)!;
    expect(b.point[1] - a.point[1]).toBeCloseTo(7, 5);
    expect(b.point[0]).toBeCloseTo(a.point[0], 5);
  });

  it('u = 0 and u = 1 land on the first and last control points of an open curve', () => {
    const state = addCurve(buildDefaultDagState(), 'c1', {});
    const sampler = curveSamplerFor(state, 'c1', CTX)!;
    expect(sampler.pointAt(0)[0]).toBeCloseTo(0, 5);
    expect(sampler.pointAt(1)[0]).toBeCloseTo(12, 5);
  });

  it('an OPEN curve CLAMPS out-of-range u; a CLOSED one WRAPS', () => {
    const open = addCurve(buildDefaultDagState(), 'c1', {});
    const openSampler = curveSamplerFor(open, 'c1', CTX)!;
    // Past the end it stops at the end rather than teleporting home.
    expect(openSampler.pointAt(1.4)).toEqual(openSampler.pointAt(1));
    expect(openSampler.pointAt(-0.3)).toEqual(openSampler.pointAt(0));

    const closed = addCurve(buildDefaultDagState(), 'c2', { closed: true });
    const closedSampler = curveSamplerFor(closed, 'c2', CTX)!;
    expect(closedSampler.closed).toBe(true);
    // A lap and a quarter == a quarter (a Follow-Path over a loop keeps going round).
    const a = closedSampler.pointAt(0.25);
    const b = closedSampler.pointAt(1.25);
    expect(b[0]).toBeCloseTo(a[0], 4);
    expect(b[2]).toBeCloseTo(a[2], 4);
  });

  it('the tangent points along the direction of travel', () => {
    const state = addCurve(buildDefaultDagState(), 'c1', {
      points: withIds([
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ]),
    });
    const { tangent } = readCurveSampleAt(state, 'c1', 0.5, CTX)!;
    expect(tangent[0]).toBeCloseTo(1, 3); // travelling +X
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 5); // unit
  });

  it('a degenerate (zero-length) curve yields a finite point and tangent, never NaN', () => {
    const state = addCurve(buildDefaultDagState(), 'c1', {
      points: withIds([
        [2, 2, 2],
        [2, 2, 2],
      ]),
    });
    const s = readCurveSampleAt(state, 'c1', 0.5, CTX)!;
    expect(s.length).toBe(0);
    expect(s.point.every(Number.isFinite)).toBe(true);
    expect(s.tangent.every(Number.isFinite)).toBe(true);
  });

  it('a non-Curve node samples to null (the seam refuses, it does not guess)', () => {
    const state = applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'Null',
      params: { position: [0, 0, 0] },
    }).next;
    expect(curveSamplerFor(state, 'n1', CTX)).toBeNull();
    expect(readCurveSampleAt(state, 'missing', 0.5, CTX)).toBeNull();
  });
});
