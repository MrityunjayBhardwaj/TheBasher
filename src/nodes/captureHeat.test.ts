// #1356 — skin weights by heat spreading over the surface: which bone heats a place, what the heat
// settles to, and what happens to a piece or a bone the heat does not reach.
import { describe, expect, it } from 'vitest';
import { cylinderMesh } from '../test-utils/cylinderMesh';
import { hairpinLength, hairpinMesh } from '../test-utils/hairpinMesh';
import { captureByHeat, heatLoad } from './captureHeat';
import { captureByVoxel, type VoxelMesh } from './captureVoxel';
import { captureByProximity, type CaptureBone, type CapturedWeights } from './captureWeights';

function faces(list: readonly (readonly number[])[]) {
  return {
    faceSizes: Uint32Array.from(list.map((f) => f.length)),
    cornerPoints: Uint32Array.from(list.flat()),
  };
}
/** A closed box with its faces' fronts outward. Corner `i` has bit 0 for x, 1 for y, 2 for z. */
function box(lo: readonly number[], hi: readonly number[]): VoxelMesh {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    points.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  }
  return {
    points: Float32Array.from(points),
    ...faces([
      [0, 4, 6, 2],
      [1, 3, 7, 5],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 2, 3, 1],
      [4, 5, 7, 6],
    ]),
  };
}
/** Several meshes as one. */
function join(...parts: VoxelMesh[]): VoxelMesh {
  const points: number[] = [];
  const sizes: number[] = [];
  const corners: number[] = [];
  let base = 0;
  for (const part of parts) {
    points.push(...part.points);
    sizes.push(...part.faceSizes);
    for (const c of part.cornerPoints) corners.push(c + base);
    base += part.points.length / 3;
  }
  return {
    points: Float32Array.from(points),
    faceSizes: Uint32Array.from(sizes),
    cornerPoints: Uint32Array.from(corners),
  };
}
/** `mesh` with every point moved by `by`. */
function moved(mesh: VoxelMesh, by: readonly [number, number, number]): VoxelMesh {
  return { ...mesh, points: mesh.points.map((v, i) => v + by[i % 3]) };
}
/** `mesh` turned inside out: every face the other way round, cut into the same triangles. */
function insideOut(mesh: VoxelMesh): VoxelMesh {
  const corners = Array.from(mesh.cornerPoints);
  let at = 0;
  for (const n of mesh.faceSizes) {
    const rest = corners.slice(at + 1, at + n).reverse();
    corners.splice(at + 1, n - 1, ...rest);
    at += n;
  }
  return { ...mesh, cornerPoints: Uint32Array.from(corners) };
}

/** Point `p`'s weight per bone index. */
function weightsOf(got: CapturedWeights, bones: number, p: number): number[] {
  const out = Array.from({ length: bones }, () => 0);
  const { joints, weights, width } = got.lanes;
  for (let lane = 0; lane < width; lane++) {
    const w = weights[p * width + lane];
    if (w > 0) out[joints[p * width + lane]] += w;
  }
  return out;
}
/** The most any point's weight on any bone differs between two captures of as many points. */
function apart(a: CapturedWeights, b: CapturedWeights, bones: number, points: number): number {
  let most = 0;
  for (let p = 0; p < points; p++) {
    const wa = weightsOf(a, bones, p);
    const wb = weightsOf(b, bones, p);
    for (let i = 0; i < bones; i++) most = Math.max(most, Math.abs(wa[i] - wb[i]));
  }
  return most;
}

const TUBE = { radius: 0.25, height: 3, radial: 16, rings: 25 };
const POINTS = TUBE.radial * TUBE.rings;
/** The tube's first point on the ring at height `y`. */
const ring = (y: number) => Math.round((y / TUBE.height) * (TUBE.rings - 1)) * TUBE.radial;
/** Three bones up the tube's axis; the last is a leaf, a quarter long. */
const CHAIN: CaptureBone[] = [
  { name: 'Bone', head: [0, 0, 0], tail: [0, 1, 0] },
  { name: 'Bone.001', head: [0, 1, 0], tail: [0, 2, 0] },
  { name: 'Bone.002', head: [0, 2, 0], tail: [0, 2.25, 0] },
];
/** Two bones of equal length meeting at the middle of the tube. */
const HALVES: CaptureBone[] = [
  { name: 'Lower', head: [0, 0, 0], tail: [0, 1.5, 0] },
  { name: 'Upper', head: [0, 1.5, 0], tail: [0, 3, 0] },
];
const OPTS = { maxInfluences: 4 };

describe('#1356 — heat settles over the surface into weights', () => {
  const tube = cylinderMesh(TUBE);

  it('an open tube is weighted whole: every place heated, every bone heating, nothing left over', () => {
    const got = captureByHeat(tube, CHAIN, OPTS)!;
    expect(got.vertexGroups).toEqual(['Bone', 'Bone.001', 'Bone.002']);
    expect({
      unbound: got.unbound,
      unreached: got.unreached,
      outside: got.outside,
      sites: got.sites,
      pieces: got.pieces,
      heated: got.heated,
      unsettled: got.unsettled,
    }).toEqual({
      unbound: 0,
      unreached: 0,
      outside: [],
      sites: POINTS,
      pieces: 1,
      heated: POINTS,
      unsettled: 0,
    });
    for (let p = 0; p < POINTS; p++) {
      expect(weightsOf(got, 3, p).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5);
    }
    // Beside the middle of a bone it is that bone's; the hold falls away along the tube.
    expect(weightsOf(got, 3, ring(0.5))[0]).toBeGreaterThan(0.9);
    expect(weightsOf(got, 3, ring(1.5))[1]).toBeGreaterThan(0.8);
    const up = [0.5, 0.75, 1, 1.25, 1.5].map((y) => weightsOf(got, 3, ring(y))[0]);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeLessThan(up[i - 1]);
  });

  it('at the joint of two equal bones the ring is shared half and half: both are as near, and both heat it', () => {
    const got = captureByHeat(tube, HALVES, OPTS)!;
    for (let side = 0; side < TUBE.radial; side++) {
      const [lower, upper] = weightsOf(got, 2, ring(1.5) + side);
      expect(lower).toBeCloseTo(0.5, 4);
      expect(upper).toBeCloseTo(0.5, 4);
    }
    // And the two halves mirror each other.
    expect(weightsOf(got, 2, ring(1))[0]).toBeCloseTo(weightsOf(got, 2, ring(2))[1], 4);
  });

  it('and still is with the whole scene turned, when the two distances no longer round alike', () => {
    // A turn about a skew axis, of the tube and of the bones together.
    const [ax, ay, az] = [0.36, 0.48, 0.8];
    const [c, s] = [Math.cos(0.7), Math.sin(0.7)];
    const turn = (x: number, y: number, z: number): [number, number, number] => {
      const dot = ax * x + ay * y + az * z;
      return [
        x * c + (ay * z - az * y) * s + ax * dot * (1 - c),
        y * c + (az * x - ax * z) * s + ay * dot * (1 - c),
        z * c + (ax * y - ay * x) * s + az * dot * (1 - c),
      ];
    };
    const points = new Float32Array(tube.points.length);
    for (let p = 0; p < POINTS; p++) {
      points.set(turn(tube.points[p * 3], tube.points[p * 3 + 1], tube.points[p * 3 + 2]), p * 3);
    }
    const bones = HALVES.map((b) => ({
      name: b.name,
      head: turn(...(b.head as [number, number, number])),
      tail: turn(...(b.tail as [number, number, number])),
    }));
    const got = captureByHeat({ ...tube, points }, bones, OPTS)!;
    for (let side = 0; side < TUBE.radial; side++) {
      expect(weightsOf(got, 2, ring(1.5) + side)[0]).toBeCloseTo(0.5, 3);
    }
  });

  it('the weights go round a ring evenly: nothing of a grid shows', () => {
    const got = captureByHeat(tube, CHAIN, OPTS)!;
    for (const y of [0.5, 1, 1.125, 2, 2.75]) {
      const round = Array.from(
        { length: TUBE.radial },
        (_, side) => weightsOf(got, 3, ring(y) + side)[1],
      );
      expect(Math.max(...round) - Math.min(...round)).toBeLessThan(1e-4);
    }
  });

  it('the size of the scene does not change the weights', () => {
    const got = captureByHeat(tube, CHAIN, OPTS)!;
    for (const scale of [100, 0.01]) {
      const scaled = captureByHeat(
        { ...tube, points: tube.points.map((v) => v * scale) },
        CHAIN.map((b) => ({
          name: b.name,
          head: b.head.map((v) => v * scale) as [number, number, number],
          tail: b.tail.map((v) => v * scale) as [number, number, number],
        })),
        OPTS,
      )!;
      expect(apart(got, scaled, 3, POINTS)).toBeLessThan(1e-4);
    }
  });

  it('keeps at most maxInfluences bones a point, strongest first, in whole sets of four', () => {
    const one = captureByHeat(tube, CHAIN, { maxInfluences: 1 })!;
    expect(one.lanes.width).toBe(4);
    for (let p = 0; p < POINTS; p++) {
      expect(Array.from(one.lanes.weights.subarray(p * 4, p * 4 + 4))).toEqual([1, 0, 0, 0]);
    }
    const two = captureByHeat(tube, CHAIN, { maxInfluences: 2 })!;
    const mid = ring(1.125);
    expect(two.lanes.weights[mid * 4]).toBeGreaterThan(two.lanes.weights[mid * 4 + 1]);
    expect(two.lanes.weights[mid * 4 + 1]).toBeGreaterThan(0);
    expect(two.lanes.weights[mid * 4 + 2]).toBe(0);
    expect(two.lanes.weights[mid * 4] + two.lanes.weights[mid * 4 + 1]).toBeCloseTo(1, 6);
    // Five bones up the tube, five kept: two sets of four.
    const five: CaptureBone[] = [0, 1, 2, 3, 4].map((i) => ({
      name: `b${i}`,
      head: [0, i * 0.6, 0],
      tail: [0, (i + 1) * 0.6, 0],
    }));
    const wide = captureByHeat(tube, five, { maxInfluences: 5 })!;
    expect(wide.lanes.width).toBe(8);
    expect(weightsOf(wide, 5, ring(1.5)).filter((w) => w > 0)).toHaveLength(5);
  });

  it('a bone whose heat does not reach a place is not among its bones: the lane is left empty', () => {
    // A tube two hundred rings long with five bones up it: the first bone's heat is gone, to the
    // last digit, long before the far end.
    const LONG = { radius: 0.25, height: 25, radial: 8, rings: 201 };
    const long = cylinderMesh(LONG);
    const five: CaptureBone[] = [0, 1, 2, 3, 4].map((i) => ({
      name: `b${i}`,
      head: [0, i * 5, 0],
      tail: [0, (i + 1) * 5, 0],
    }));
    const got = captureByHeat(long, five, { maxInfluences: 5 })!;
    expect([got.unreached, got.outside, got.unsettled]).toEqual([0, [], 0]);
    const { joints, weights, width } = got.lanes;
    expect(width).toBe(8);
    const end = (LONG.rings - 1) * LONG.radial;
    const lanes = Array.from({ length: width }, (_, k) => [
      joints[end * width + k],
      weights[end * width + k],
    ]);
    expect(lanes[0][0]).toBe(4);
    expect(weightsOf(got, 5, end)[0]).toBe(0);
    const used = lanes.filter(([, w]) => w > 0).length;
    expect(used).toBeLessThan(5);
    for (const [joint, weight] of lanes.slice(used)) expect([joint, weight]).toEqual([0, 0]);
    expect(Array.from(weights).every((w) => w >= 0 && Number.isFinite(w))).toBe(true);
  });

  it('the same mesh and bones give the very same numbers twice', () => {
    const a = captureByHeat(tube, CHAIN, OPTS)!;
    const b = captureByHeat(tube, CHAIN, OPTS)!;
    expect(Array.from(a.lanes.weights)).toEqual(Array.from(b.lanes.weights));
    expect(Array.from(a.lanes.joints)).toEqual(Array.from(b.lanes.joints));
  });
});

describe('#1356 — parts that touch side by side keep their own bones', () => {
  // A tube bent back on itself like a hairpin: up one leg, over, and down the other, the two legs
  // two thousandths apart. A finger beside a finger, joined at the knuckles.
  const HALF = 0.101;
  const LEG = 1;
  const SHAPE = { radius: 0.1, half: HALF, leg: LEG, radial: 16, rings: 47 };
  const LENGTH = hairpinLength(SHAPE);
  const hairpin = hairpinMesh(SHAPE);
  const UP: CaptureBone = { name: 'Up', head: [-HALF, 0, 0], tail: [-HALF, LEG, 0] };
  const DOWN: CaptureBone = { name: 'Down', head: [HALF, LEG, 0], tail: [HALF, 0, 0] };
  /** Half way up the first leg, on the side facing the other leg. */
  const INNER = Math.round((0.5 / LENGTH) * (SHAPE.rings - 1)) * SHAPE.radial;

  it('the fixture is what it says: the legs two thousandths apart where the point stands', () => {
    const [x, y, z] = hairpin.points.subarray(INNER * 3, INNER * 3 + 3);
    expect(x).toBeCloseTo(-0.001, 5);
    expect(y).toBeCloseTo(0.5, 1);
    expect(z).toBe(0);
  });

  it('straight-line distance and the voxel grid give it nearly half of the other leg’s bone; heat gives it under a hundredth', () => {
    const near = weightsOf(
      captureByProximity(hairpin.points, [UP, DOWN], { maxInfluences: 4, dropoff: 4 }),
      2,
      INNER,
    );
    expect(near[1]).toBeGreaterThan(0.45);
    const through = captureByVoxel(hairpin, [UP, DOWN], {
      maxInfluences: 4,
      falloff: 0.2,
      resolution: 128,
    })!;
    expect(weightsOf(through, 2, INNER)[1]).toBeGreaterThan(0.4);
    const along = captureByHeat(hairpin, [UP, DOWN], OPTS)!;
    // Every place has its own leg's bone in sight: the other leg's wall, two thousandths BEHIND
    // the places that face it, is not in the way of a line that sets off the other way.
    expect([along.unreached, along.outside, along.pieces, along.heated]).toEqual([
      0,
      [],
      1,
      SHAPE.radial * SHAPE.rings,
    ]);
    expect(weightsOf(along, 2, INNER)[1]).toBeLessThan(0.01);
    expect(weightsOf(along, 2, INNER)[0]).toBeGreaterThan(0.99);
    // Over the top, where the two legs really do join, they share.
    const top = Math.round((SHAPE.rings - 1) / 2) * SHAPE.radial;
    expect(weightsOf(along, 2, top)[0]).toBeCloseTo(0.5, 2);
  });
});

describe('#1356 — a bone heats a place only when it is in sight from inside', () => {
  const SHAPE = { radius: 0.25, height: 4, radial: 16, rings: 33 };
  const tube = cylinderMesh(SHAPE);
  const count = SHAPE.radial * SHAPE.rings;
  const INSIDE: CaptureBone = { name: 'Inside', head: [0, 3.5, 0], tail: [0, 4, 0] };
  // In the open air a twentieth outside the wall: nearer to the foot of the tube than `Inside`,
  // by a long way, on every side of it.
  const BESIDE: CaptureBone = { name: 'Beside', head: [0.3, 0.4, 0], tail: [0.3, 0.6, 0] };

  it('a bone lying outside the wall heats neither the wall facing it nor the wall behind that', () => {
    const got = captureByHeat(tube, [INSIDE, BESIDE], OPTS)!;
    // The wall facing it would have to be heated from in front; the far wall, through the near one.
    expect(got.outside).toEqual(['Beside']);
    expect(got.unreached).toBe(0);
    // The places nearer to it than to `Inside` get no heat of their own, and take what spreads
    // down the tube from the ones that do.
    expect(got.heated).toBe(SHAPE.radial * 16);
    for (let p = 0; p < count; p++) expect(weightsOf(got, 2, p)).toEqual([1, 0]);
  });

  it('the same bone moved onto the axis is in sight of the places round it, and holds them', () => {
    const got = captureByHeat(
      tube,
      [INSIDE, { name: 'Beside', head: [0, 0.4, 0], tail: [0, 0.6, 0] }],
      OPTS,
    )!;
    expect(got.outside).toEqual([]);
    const foot = Math.round((0.5 / SHAPE.height) * (SHAPE.rings - 1)) * SHAPE.radial;
    expect(weightsOf(got, 2, foot)[1]).toBeGreaterThan(0.95);
  });

  it('only its own piece is in a place’s way: a sleeve round the tube sees the bone through it', () => {
    // The same tube again at twice the radius, round the first: two pieces, one bone inside both.
    const sleeve = cylinderMesh({ ...SHAPE, radius: 0.5 });
    const both = captureByHeat(join(tube, sleeve), [INSIDE], OPTS)!;
    expect([both.pieces, both.heated, both.unreached, both.outside]).toEqual([2, count * 2, 0, []]);
  });

  it('a bone ending exactly on a point holds it, and nothing comes out not a number', () => {
    const chainTube = cylinderMesh(TUBE);
    const spoke: CaptureBone = { name: 'Spoke', head: [0.25, 1.5, 0], tail: [0, 1.5, 0] };
    expect(Array.from(chainTube.points.subarray(ring(1.5) * 3, ring(1.5) * 3 + 3))).toEqual([
      0.25, 1.5, 0,
    ]);
    const got = captureByHeat(chainTube, [...CHAIN, spoke], OPTS)!;
    expect(Array.from(got.lanes.weights).every(Number.isFinite)).toBe(true);
    expect([got.unreached, got.unsettled, got.outside]).toEqual([0, 0, []]);
    expect(weightsOf(got, 4, ring(1.5))[3]).toBeGreaterThan(0.99);
    // And the rest of the tube is still its chain's.
    expect(weightsOf(got, 4, ring(0.5))[0]).toBeGreaterThan(0.9);
  });
});

describe('#1356 — a piece or a bone the heat does not reach is named, never left at zero', () => {
  const tube = cylinderMesh(TUBE);

  it('a closed part with no bone in it takes the bone behind it, a point on no face its nearest, and both are counted', () => {
    // An eye: a closed box beside the tube. And one point on no face at all, with a bone starting
    // exactly on it that is nearest to nothing else.
    const eye = box([2, 0.3, 0.2], [2.5, 0.8, 0.7]);
    const mesh = join(tube, eye);
    const loose: VoxelMesh = {
      ...mesh,
      points: Float32Array.from([...mesh.points, 5, 5, 5]),
    };
    const far: CaptureBone = { name: 'Far', head: [5, 5, 5], tail: [5, 5.2, 5] };
    const got = captureByHeat(loose, [...CHAIN, far], OPTS)!;
    expect(got.pieces).toBe(3);
    expect(got.unreached).toBe(9);
    expect(got.unbound).toBe(0);
    // `Far` is the nearest bone of the loose point alone. A point on no face stands for no surface,
    // so `Far` heats nothing and nothing is solved for it; it holds that one point by nearness.
    expect([got.outside, got.heated, got.unsettled]).toEqual([[], POINTS, 0]);
    expect(got.steps).toBe(captureByHeat(mesh, CHAIN, OPTS)!.steps);
    // The eye's far side has the tube's first bone behind it, through the eye; the near side
    // faces that bone and is heated by none, and takes what spreads round from the far side.
    for (let p = POINTS; p < POINTS + 8; p++) expect(weightsOf(got, 4, p)).toEqual([1, 0, 0, 0]);
    expect(weightsOf(got, 4, POINTS + 8)).toEqual([0, 0, 0, 1]);
    // And the tube is weighted as it is without them.
    expect(apart(got, captureByHeat(tube, [...CHAIN, far], OPTS)!, 4, POINTS)).toBeLessThan(1e-5);
  });

  it('a shell with the bones in its hollow, not in its wall, is weighted like the skin it stands for', () => {
    // The tube given thickness: an outer wall, an inner wall a fifth nearer the axis facing it,
    // and a ring of faces joining them at each end. Closed, and the bones are in the hole.
    const inner = cylinderMesh({ ...TUBE, radius: 0.2 });
    const top = (TUBE.rings - 1) * TUBE.radial;
    const rims: number[][] = [];
    for (let side = 0; side < TUBE.radial; side++) {
      const next = (side + 1) % TUBE.radial;
      rims.push([side, next, POINTS + next, POINTS + side]);
      rims.push([top + next, top + side, POINTS + top + side, POINTS + top + next]);
    }
    const walls = join(tube, insideOut(inner));
    const band: VoxelMesh = {
      points: walls.points,
      faceSizes: Uint32Array.from([...walls.faceSizes, ...rims.map((f) => f.length)]),
      cornerPoints: Uint32Array.from([...walls.cornerPoints, ...rims.flat()]),
    };
    const got = captureByHeat(band, CHAIN, OPTS)!;
    // No place has a bone in sight: from the outer wall the inner one is in the way, and the
    // inner wall faces the bones. Every outer place is heated through the inner wall.
    expect([got.pieces, got.heated, got.unreached, got.unbound, got.outside]).toEqual([
      1,
      0,
      POINTS * 2,
      0,
      [],
    ]);
    for (let p = 0; p < POINTS * 2; p++) {
      expect(weightsOf(got, 3, p).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
    }
    // The outer wall is each bone's beside that bone, to within a twelfth of what the plain
    // tube is. The inner wall faces the bones, is heated by none, and takes what spreads in over
    // the two rims.
    const plain = captureByHeat(tube, CHAIN, OPTS)!;
    for (const y of [0.5, 1, 1.5, 2.125, 2.75]) {
      for (let i = 0; i < 3; i++) {
        expect(
          Math.abs(weightsOf(got, 3, ring(y))[i] - weightsOf(plain, 3, ring(y))[i]),
        ).toBeLessThan(0.08);
      }
    }
    expect(weightsOf(got, 3, POINTS + ring(1.5))[1]).toBeLessThan(0.1);
  });

  it('a closed part between two bones that both face it goes point by point to the nearer, and is counted', () => {
    const closed = box([0, 0, 0], [1, 1, 1]);
    const left: CaptureBone = { name: 'L', head: [-1, 0.5, 0.5], tail: [-0.5, 0.5, 0.5] };
    const right: CaptureBone = { name: 'R', head: [1.5, 0.5, 0.5], tail: [2, 0.5, 0.5] };
    const got = captureByHeat(closed, [left, right], OPTS)!;
    expect([got.unreached, got.unbound, got.heated, got.outside]).toEqual([8, 0, 0, []]);
    // Corner p has bit 0 set on the right-hand side.
    for (let p = 0; p < 8; p++) expect(weightsOf(got, 2, p)).toEqual(p & 1 ? [0, 1] : [1, 0]);
  });

  it('a bone that is nowhere is passed over, and with no bone anywhere every point is unbound', () => {
    const nowhere: CaptureBone = { name: 'Nowhere', head: [NaN, 0, 0], tail: [0, 1, 0] };
    const some = captureByHeat(tube, [nowhere, ...CHAIN], OPTS)!;
    expect([some.unbound, some.unreached, some.outside]).toEqual([0, 0, ['Nowhere']]);
    const chain = captureByHeat(tube, CHAIN, OPTS)!;
    for (let p = 0; p < POINTS; p++) {
      expect(weightsOf(some, 4, p)).toEqual([0, ...weightsOf(chain, 3, p)]);
    }
    expect(weightsOf(some, 4, ring(0.5))[1]).toBeGreaterThan(0.9);
    const none = captureByHeat(tube, [nowhere], OPTS)!;
    expect([none.unbound, none.unreached, none.outside]).toEqual([POINTS, 0, ['Nowhere']]);
    expect(Array.from(none.lanes.weights).every((w) => w === 0)).toBe(true);
  });

  it('a mesh with no faces, no size, no whole triangle, or a point that is not a number has no surface', () => {
    expect(
      captureByHeat(
        { ...tube, faceSizes: new Uint32Array(0), cornerPoints: new Uint32Array(0) },
        CHAIN,
        OPTS,
      ),
    ).toBeNull();
    expect(
      captureByHeat({ ...tube, points: new Float32Array(tube.points.length) }, CHAIN, OPTS),
    ).toBeNull();
    expect(
      captureByHeat(
        { ...tube, points: tube.points.map((v, i) => (i === 4 ? NaN : v)) },
        CHAIN,
        OPTS,
      ),
    ).toBeNull();
    // Every face has two corners at one point.
    expect(
      captureByHeat(
        {
          points: tube.points,
          ...faces([
            [0, 0, 1],
            [2, 3, 3],
          ]),
        },
        CHAIN,
        OPTS,
      ),
    ).toBeNull();
  });
});

describe('#1356 — the surface as it is stored, not as it ought to be', () => {
  const tube = cylinderMesh(TUBE);

  it('a closed piece made inside out captures as it would the right way out, whatever the piece beside it', () => {
    // A tube a quarter longer at each end than the chain, with both ends closed.
    const TALL = { ...TUBE, height: 3.5, rings: 29 };
    const N = TALL.radial * TALL.rings;
    const open = moved(cylinderMesh(TALL), [0, -0.25, 0]);
    const bottom = Array.from({ length: TALL.radial }, (_, side) => side);
    const top = bottom.map((side) => (TALL.rings - 1) * TALL.radial + side).reverse();
    const closed: VoxelMesh = {
      points: open.points,
      faceSizes: Uint32Array.from([...open.faceSizes, TALL.radial, TALL.radial]),
      cornerPoints: Uint32Array.from([...open.cornerPoints, ...bottom, ...top]),
    };
    const got = captureByHeat(closed, CHAIN, OPTS)!;
    const turned = captureByHeat(insideOut(closed), CHAIN, OPTS)!;
    expect([got.unreached, got.heated, turned.unreached, turned.heated]).toEqual([0, N, 0, N]);
    expect(apart(got, turned, 3, N)).toBeLessThan(1e-6);

    // Two of them two apart, each with its own chain; only the second is inside out.
    const second = CHAIN.map((b) => ({
      name: `${b.name}.R`,
      head: [b.head[0] + 2, b.head[1], b.head[2]] as [number, number, number],
      tail: [b.tail[0] + 2, b.tail[1], b.tail[2]] as [number, number, number],
    }));
    const both = captureByHeat(
      join(closed, moved(closed, [2, 0, 0])),
      [...CHAIN, ...second],
      OPTS,
    )!;
    const mixed = captureByHeat(
      join(closed, insideOut(moved(closed, [2, 0, 0]))),
      [...CHAIN, ...second],
      OPTS,
    )!;
    expect([both.pieces, both.unreached, mixed.unreached]).toEqual([2, 0, 0]);
    expect(apart(both, mixed, 6, N * 2)).toBeLessThan(1e-6);
    // Each tube is its own bones' alone.
    const mid = 10 * TALL.radial;
    expect(weightsOf(both, 6, mid).slice(3)).toEqual([0, 0, 0]);
    expect(weightsOf(both, 6, N + mid).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('an open piece stored inside out has no bone behind any face: each point goes whole to its nearest bone, and is counted', () => {
    const turned = captureByHeat(insideOut(tube), CHAIN, OPTS)!;
    expect([turned.heated, turned.unreached, turned.unbound, turned.outside]).toEqual([
      0,
      POINTS,
      0,
      [],
    ]);
    expect(weightsOf(turned, 3, ring(0.5))).toEqual([1, 0, 0]);
    expect(weightsOf(turned, 3, ring(1.5))).toEqual([0, 1, 0]);
  });

  it('points standing at one position are one place: a tube cut round and left touching still conducts', () => {
    // Every face above the middle ring uses its own copy of that ring's points, with each zero
    // coordinate of a copy written as minus zero.
    const cut = ring(1.5);
    const copy = (p: number) => (p >= cut && p < cut + TUBE.radial ? POINTS + (p - cut) : p);
    const corners = Array.from(tube.cornerPoints);
    let minusZeros = 0;
    for (let f = 0; f < tube.faceSizes.length; f++) {
      const face = corners.slice(f * 4, f * 4 + 4);
      if (face.some((p) => p >= cut + TUBE.radial)) {
        corners.splice(f * 4, 4, ...face.map(copy));
      }
    }
    const extra: number[] = [];
    for (let k = 0; k < TUBE.radial * 3; k++) {
      const v = tube.points[cut * 3 + k];
      if (v === 0) minusZeros++;
      extra.push(v === 0 ? -0 : v);
    }
    expect(minusZeros).toBeGreaterThan(0);
    const split: VoxelMesh = {
      points: Float32Array.from([...tube.points, ...extra]),
      faceSizes: tube.faceSizes,
      cornerPoints: Uint32Array.from(corners),
    };
    expect(Object.is(split.points[(POINTS + 0) * 3 + 2], -0)).toBe(true);
    const got = captureByHeat(split, CHAIN, OPTS)!;
    expect([got.pieces, got.sites, got.unreached]).toEqual([1, POINTS, 0]);
    expect(apart(got, captureByHeat(tube, CHAIN, OPTS)!, 3, POINTS)).toBeLessThan(1e-6);
    for (let side = 0; side < TUBE.radial; side++) {
      expect(weightsOf(got, 3, POINTS + side)).toEqual(weightsOf(got, 3, cut + side));
    }
  });

  it('a point hung on the tube by a triangle with no area takes its neighbours’ weights', () => {
    // Half way up one upright edge, joined to the edge's two ends by a triangle that is a line.
    const a = ring(1) + 3;
    const b = a + TUBE.radial;
    const mid = [0, 1, 2].map((k) => (tube.points[a * 3 + k] + tube.points[b * 3 + k]) / 2);
    // It is the mesh's FIRST face, so it is the first triangle round both of the edge's ends.
    const hung: VoxelMesh = {
      points: Float32Array.from([...tube.points, ...mid]),
      faceSizes: Uint32Array.from([3, ...tube.faceSizes]),
      cornerPoints: Uint32Array.from([a, POINTS, b, ...tube.cornerPoints]),
    };
    const got = captureByHeat(hung, CHAIN, OPTS)!;
    // The two ends are heated as every other place of the tube is: a triangle with no area is no
    // face to set off over.
    expect([got.pieces, got.unreached, got.unbound, got.heated]).toEqual([1, 0, 0, POINTS]);
    expect(Array.from(got.lanes.weights).every(Number.isFinite)).toBe(true);
    const [wa, wb, wm] = [a, b, POINTS].map((p) => weightsOf(got, 3, p));
    for (let i = 0; i < 3; i++) expect(wm[i]).toBeCloseTo((wa[i] + wb[i]) / 2, 4);
    expect(apart(got, captureByHeat(tube, CHAIN, OPTS)!, 3, POINTS)).toBeLessThan(1e-4);
  });

  it('a face doubled back on itself is no part of the fan a line sets off over', () => {
    // One bone at the foot of the tube, so every line to it sets off downwards. And one wall
    // triangle ABOVE a place stored a second time the other way round, first in the mesh: seen
    // along the place's normal it is upside down, and would claim the lines that set off away
    // from it.
    const low: CaptureBone = { name: 'Low', head: [0, 0, 0], tail: [0, 0.5, 0] };
    const at = ring(2);
    const doubled: VoxelMesh = {
      points: tube.points,
      faceSizes: Uint32Array.from([3, ...tube.faceSizes]),
      cornerPoints: Uint32Array.from([
        at,
        at + TUBE.radial + 1,
        at + TUBE.radial,
        ...tube.cornerPoints,
      ]),
    };
    // The triangle it doubles is the first of the quad above `at`.
    expect(
      Array.from(
        tube.cornerPoints.subarray(
          (at / TUBE.radial) * TUBE.radial * 4,
          (at / TUBE.radial) * TUBE.radial * 4 + 3,
        ),
      ),
    ).toEqual([at, at + TUBE.radial, at + TUBE.radial + 1]);
    const got = captureByHeat(doubled, [low], OPTS)!;
    expect([got.pieces, got.heated, got.unreached]).toEqual([1, POINTS, 0]);
  });

  it('across an edge between two blunt triangles a bone’s hold stays above nothing', () => {
    // A flat kite: A and B ten apart, C and D half a unit either side of the middle of AB. The
    // angles at C and D are near a half turn, so by the cotangent formula AB conducts backwards.
    // It lies five below the origin, facing up: taken from the origin its faces look inward, which
    // must not turn a piece with a rim inside out.
    const kite: VoxelMesh = {
      points: Float32Array.from([0, 0, -5, 10, 0, -5, 5, 0.5, -5, 5, -0.5, -5]),
      ...faces([
        [0, 1, 2],
        [0, 3, 1],
      ]),
    };
    // Under the kite (its faces look up): one bone under A, one under B, one under C and D.
    const bones: CaptureBone[] = [
      { name: 'a', head: [0, 0, -6], tail: [-1, 0, -6] },
      { name: 'b', head: [10, 0, -6], tail: [11, 0, -6] },
      { name: 'c', head: [5, -0.5, -5.2], tail: [5, 0.5, -5.2] },
    ];
    const got = captureByHeat(kite, bones, OPTS)!;
    expect([got.heated, got.unreached, got.outside]).toEqual([4, 0, []]);
    for (let p = 0; p < 4; p++) {
      const w = weightsOf(got, 3, p);
      expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
      for (const v of w) expect(v).toBeGreaterThan(0);
    }
  });
});

describe('#1356 — how much work a capture by heat may be', () => {
  const tube = cylinderMesh(TUBE);

  it('is every bone across the largest piece, to the power one and a half', () => {
    expect(heatLoad(tube, 3)).toEqual({ largest: POINTS, work: 3 * POINTS ** 1.5 });
    expect(heatLoad(tube, 6)!.work).toBe(6 * POINTS ** 1.5);
    // A smaller piece either side of it changes nothing: the largest decides.
    const small = cylinderMesh({ ...TUBE, rings: 5 });
    expect(heatLoad(join(moved(small, [2, 0, 0]), tube, moved(small, [4, 0, 0])), 3)).toEqual({
      largest: POINTS,
      work: 3 * POINTS ** 1.5,
    });
    expect(
      heatLoad({ ...tube, faceSizes: new Uint32Array(0), cornerPoints: new Uint32Array(0) }, 3),
    ).toBeNull();
  });
});
