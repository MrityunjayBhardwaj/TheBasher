// #730 — an authored curve read as a control input to motion generation.
//
// Two claims carry this file, and both are about the SEAM rather than the maths:
// the waypoints are WORLD (a curve under a transform must not report its local
// points), and the curve is chosen by SELECTION (a camera rail sitting in the
// scene must not silently start steering characters).

import { describe, it, expect, beforeAll } from 'vitest';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCurve } from '../../test-utils/splitCurve';
import {
  MOTION_PATH_WAYPOINTS,
  motionPathFromSelection,
  waypointsFromCurve,
} from './motionPathFromCurve';

// `makeSplitCurve` builds genuine Object/CurveData nodes through the real registry,
// so it has to be seeded before any fixture is constructed.
beforeAll(() => registerAllNodes());

// EVERY fixture here is wired into the scene, and that is load-bearing rather than
// tidiness: `resolveWorldTransform` resolves a node's world by walking the SCENE's
// child list, so a curve that is not a scene child resolves to identity and reports
// its LOCAL points as world — silently, and looking entirely correct. A curve a
// director drew is always a scene child; a fixture that forgets to be one measures
// the fallback instead of the road.
const IN_SCENE = { node: 'n_scene', socket: 'children' } as const;

/** A straight ground line from [-2,0,0] to [2,0,0], so world XZ is easy to read. */
function straightCurve(position: [number, number, number] = [0, 0, 0]) {
  return makeSplitCurve(buildDefaultDagState(), {
    objectId: 'n_curve',
    position,
    connectTo: IN_SCENE,
    points: [
      [-2, 0, 0],
      [-1, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
  });
}

describe('sampling a curve into waypoints', () => {
  it('returns the configured number of ground positions', () => {
    const { state, objectId } = straightCurve();
    const wp = waypointsFromCurve(state, objectId);
    expect(wp).not.toBeNull();
    expect(wp).toHaveLength(MOTION_PATH_WAYPOINTS);
  });

  it('spans the whole curve — endpoints included, not just the interior', () => {
    const { state, objectId } = straightCurve();
    const wp = waypointsFromCurve(state, objectId)!;
    expect(wp[0].x).toBeCloseTo(-2, 5);
    expect(wp[wp.length - 1].x).toBeCloseTo(2, 5);
  });

  it('reports WORLD positions, not the curve’s local points', () => {
    // The defect this guards: `points` are local to the owning Object's
    // transform, so reading them directly gives a path of the right shape in the
    // wrong place. Move the Object 10m and every waypoint must move with it.
    const local = waypointsFromCurve(straightCurve([0, 0, 0]).state, 'n_curve')!;
    const moved = waypointsFromCurve(straightCurve([10, 0, 5]).state, 'n_curve')!;
    expect(moved[0].x).toBeCloseTo(local[0].x + 10, 5);
    expect(moved[0].z).toBeCloseTo(local[0].z + 5, 5);
  });

  it('drops height — the server takes ground positions and rejects a 3-wide point', () => {
    const { state, objectId } = makeSplitCurve(buildDefaultDagState(), {
      objectId: 'n_curve',
      connectTo: IN_SCENE,
      points: [
        [0, 3, 0],
        [1, 7, 1],
        [2, 2, 2],
      ],
    });
    const wp = waypointsFromCurve(state, objectId)!;
    // Exactly two keys, and they are x and z. A y that leaked through would be
    // sliced by the server as (x, y) and constrain HEIGHT instead of depth.
    expect(Object.keys(wp[0]).sort()).toEqual(['x', 'z']);
  });

  it('samples evenly in ARC LENGTH, so the request implies constant speed', () => {
    // The server spreads waypoints evenly over frames. Even-in-parameter sampling
    // would pair uneven distances with even times — a character that speeds up
    // through the straight sections, silently.
    const { state, objectId } = straightCurve();
    const wp = waypointsFromCurve(state, objectId, 5)!;
    const gaps = wp.slice(1).map((p, i) => p.x - wp[i].x);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 4);
  });

  it('returns null for a node that is not a curve at all', () => {
    const { state } = straightCurve();
    expect(waypointsFromCurve(state, 'n_curve_data_missing')).toBeNull();
  });

  it('returns null for a degenerate curve rather than a path that stands still', () => {
    // Every control point stacked: a zero-length path. Passing it on would ask
    // the generator to walk somewhere while giving it one repeated point.
    const { state, objectId } = makeSplitCurve(buildDefaultDagState(), {
      objectId: 'n_curve',
      connectTo: IN_SCENE,
      points: [
        [1, 0, 1],
        [1, 0, 1],
        [1, 0, 1],
      ],
    });
    expect(waypointsFromCurve(state, objectId)).toBeNull();
  });
});

describe('choosing the path by selection', () => {
  it('uses the selected curve', () => {
    const { state, objectId } = straightCurve();
    expect(motionPathFromSelection(state, objectId)).not.toBeNull();
  });

  it('does NOT use a curve merely because one is in the scene', () => {
    // The rule this holds: a curve here is already a camera rail, and drawing a
    // camera move must never start steering generated characters. Nothing
    // selected means no path was asked for.
    const { state } = straightCurve();
    expect(motionPathFromSelection(state, null)).toBeNull();
  });

  it('ignores a selection that is not a curve', () => {
    const { state } = straightCurve();
    expect(motionPathFromSelection(state, 'n_not_a_curve')).toBeNull();
  });
});
