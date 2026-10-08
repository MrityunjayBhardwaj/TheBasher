// #1539 — skin weights by distance through the mesh's volume: what is inside, what a path may
// pass through, and what happens to a point or a bone the volume does not reach.
import { describe, expect, it } from 'vitest';
import { cylinderMesh } from '../test-utils/cylinderMesh';
import { captureByProximity, type CaptureBone, type CapturedWeights } from './captureWeights';
import {
  captureByVoxel,
  voxelize,
  VOXEL_INSIDE,
  VOXEL_OUTSIDE,
  VOXEL_SURFACE,
  type VoxelMesh,
  type VoxelVolume,
} from './captureVoxel';

/** A closed box with its faces' fronts outward, turned by `turn` about z. */
function box(lo: readonly number[], hi: readonly number[], turn = 0): VoxelMesh {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hi[0] : lo[0];
    const y = i & 2 ? hi[1] : lo[1];
    const z = i & 4 ? hi[2] : lo[2];
    points.push(x * c - y * s, x * s + y * c, z);
  }
  return { points: Float32Array.from(points), ...faces(BOX_FACES) };
}
/** x−, x+, y−, y+, z−, z+ — corner `i` has bit 0 for x, 1 for y, 2 for z. */
const BOX_FACES = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
];
function faces(list: readonly (readonly number[])[]) {
  return {
    faceSizes: Uint32Array.from(list.map((f) => f.length)),
    cornerPoints: Uint32Array.from(list.flat()),
  };
}
/** Several meshes as one, the way two parts of a character are one volume. */
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
/** The box [0,1]³ keeping only the faces listed (indices into `BOX_FACES`). */
function boxFaces(keep: readonly number[]): VoxelMesh {
  return { points: box([0, 0, 0], [1, 1, 1]).points, ...faces(keep.map((f) => BOX_FACES[f])) };
}

/** The state of the cube that holds `(x, y, z)`. */
function stateAt(v: VoxelVolume, x: number, y: number, z: number): number {
  const at = [x, y, z].map((p, a) => Math.floor((p - v.origin[a]) / v.size));
  if (at.some((i, a) => i < 0 || i >= v.dims[a]))
    throw new Error(`(${x}, ${y}, ${z}) is off the grid`);
  return v.state[at[0] + v.dims[0] * (at[1] + v.dims[1] * at[2])];
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

const TUBE = { radius: 0.25, height: 3, radial: 16, rings: 25 };
/** The tube's first point on the ring at height `y`. */
const ring = (y: number) => Math.round((y / TUBE.height) * (TUBE.rings - 1)) * TUBE.radial;
/** Three bones up the tube's axis; the last is a leaf, a quarter long. */
const CHAIN: CaptureBone[] = [
  { name: 'Bone', head: [0, 0, 0], tail: [0, 1, 0] },
  { name: 'Bone.001', head: [0, 1, 0], tail: [0, 2, 0] },
  { name: 'Bone.002', head: [0, 2, 0], tail: [0, 2.25, 0] },
];
const OPTS = { maxInfluences: 4, falloff: 0.2, resolution: 64 };

describe('#1539 — what is inside a mesh, holes or not', () => {
  it('an open-ended tube has an inside, the same one it has with its ends closed', () => {
    const open = cylinderMesh(TUBE);
    const bottom = Array.from({ length: TUBE.radial }, (_, s) => s);
    const top = bottom.map((s) => (TUBE.rings - 1) * TUBE.radial + s).reverse();
    const closed: VoxelMesh = {
      points: open.points,
      faceSizes: Uint32Array.from([...open.faceSizes, TUBE.radial, TUBE.radial]),
      cornerPoints: Uint32Array.from([...open.cornerPoints, ...bottom, ...top]),
    };
    const a = voxelize(open, 64)!;
    const b = voxelize(closed, 64)!;
    expect(a.inside).toBeGreaterThan(4000);
    // On the axis, from end to end, and nowhere beside the tube.
    for (const y of [0.1, 1.5, 2.9]) {
      expect(stateAt(a, 0, y, 0)).toBe(VOXEL_INSIDE);
      expect(stateAt(a, 0.33, y, 0)).toBe(VOXEL_OUTSIDE);
      expect(stateAt(a, 0, y, -0.33)).toBe(VOXEL_OUTSIDE);
    }
    // The caps turn the cubes they pass through into surface, and change nothing else: no cube
    // is inside one tube and outside the other.
    let differs = 0;
    for (let i = 0; i < a.state.length; i++) {
      if (a.state[i] === b.state[i]) continue;
      expect(b.state[i]).toBe(VOXEL_SURFACE);
      differs++;
    }
    expect(differs).toBe(b.surface - a.surface);
    expect(differs).toBeGreaterThan(0);
  });

  it('four walls of a box enclose, five do, three do not, and one sheet never does', () => {
    const middle = (keep: readonly number[]) =>
      stateAt(voxelize(boxFaces(keep), 16)!, 0.5, 0.5, 0.5);
    // A box open at both ends of y is a tube: four of the six lines out are stopped.
    expect(middle([0, 1, 4, 5])).toBe(VOXEL_INSIDE);
    // A cup: five.
    expect(middle([0, 1, 2, 4, 5])).toBe(VOXEL_INSIDE);
    expect(middle([0, 1, 2, 3, 4, 5])).toBe(VOXEL_INSIDE);
    // Three walls meeting at a corner stop three lines: not most of them.
    expect(middle([0, 2, 4])).toBe(VOXEL_OUTSIDE);
    expect(middle([0, 1])).toBe(VOXEL_OUTSIDE);
    expect(voxelize(boxFaces([0]), 16)!.inside).toBe(0);
  });

  it('a box turned inside out encloses the same cubes', () => {
    const out = box([0, 0, 0], [1, 0.6, 0.4]);
    const turned: VoxelMesh = {
      ...out,
      cornerPoints: Uint32Array.from(out.cornerPoints).reverse(),
    };
    expect(Array.from(voxelize(turned, 16)!.state)).toEqual(Array.from(voxelize(out, 16)!.state));
    expect(voxelize(out, 16)!.inside).toBeGreaterThan(0);
  });

  it('a line through the edge two triangles share crosses the surface once, not twice or never', () => {
    // A unit box on an 8-cube grid: every face lies on a cube boundary and every face's diagonal
    // runs exactly through cube centres. All six lines out of every enclosed cube are stopped, so
    // asking for all six finds the same inside as asking for one.
    const aligned = box([0, 0, 0], [1, 1, 1]);
    const all = voxelize(aligned, 8, 6)!;
    const any = voxelize(aligned, 8, 1)!;
    expect(all.inside).toBe(any.inside);
    // A face on a cube boundary belongs to the cube above it: the faces at 0 take the first cube
    // within the box and the faces at 1 the first cube beyond it, which leaves 7 enclosed a side.
    expect(all.inside).toBe(7 * 7 * 7);
    expect(all.surface).toBe(9 * 9 * 9 - 7 * 7 * 7);
    // And no cube of the grid's outermost layer is filled, though faces lie on cube boundaries.
    const [nx, ny, nz] = all.dims;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const edge = !x || !y || !z || x === nx - 1 || y === ny - 1 || z === nz - 1;
          if (edge) expect(all.state[x + nx * (y + ny * z)]).toBe(VOXEL_OUTSIDE);
        }
      }
    }
  });

  it('a mesh with no faces, or no size, has no volume', () => {
    const tube = cylinderMesh(TUBE);
    expect(voxelize({ ...tube, ...faces([]) }, 32)).toBeNull();
    expect(voxelize({ ...boxFaces([0]), points: new Float32Array(24) }, 32)).toBeNull();
    expect(captureByVoxel({ ...tube, ...faces([]) }, CHAIN, OPTS)).toBeNull();
  });
});

describe('#1539 — a point is bound to the bones nearest it through the volume', () => {
  it('an open tube is weighted: every point reached, every bone measured from', () => {
    const got = captureByVoxel(cylinderMesh(TUBE), CHAIN, OPTS)!;
    expect([got.unbound, got.unreached, got.outside]).toEqual([0, 0, []]);
    expect(got.vertexGroups).toEqual(['Bone', 'Bone.001', 'Bone.002']);
    for (let p = 0; p < TUBE.radial * TUBE.rings; p++) {
      expect(weightsOf(got, 3, p).reduce((a, b) => a + b)).toBeCloseTo(1, 5);
    }
    // Each stretch of the tube goes mostly to the bone inside it. At falloff 0.2 the rule is close
    // to the inverse square of distance: beside the middle of the middle bone that is 0.25 away
    // against √(0.25² + 0.5²) to each neighbour, 1 : 0.2 : 0.2.
    expect(weightsOf(got, 3, ring(1.5))[1]).toBeCloseTo(1 / 1.4, 1);
    expect(weightsOf(got, 3, ring(1.5))[0]).toBeCloseTo(0.2 / 1.4, 1);
    expect(weightsOf(got, 3, ring(0.5))[0]).toBeGreaterThan(0.75);
    expect(weightsOf(got, 3, ring(2.125))[2]).toBeGreaterThan(0.4);
    // Level with a joint, the two bones meeting there share the point about evenly.
    const [lower, upper] = weightsOf(got, 3, ring(1));
    expect(Math.abs(lower - upper)).toBeLessThan(0.1);
    // Past the last bone's tip, the tip is still the nearest bone.
    const end = weightsOf(got, 3, ring(3));
    expect(end[2]).toBeGreaterThan(end[1]);
    expect(end[1]).toBeGreaterThan(end[0]);
  });

  it('the weights go round a ring evenly, to within a twentieth: that much of the grid shows through', () => {
    // Distance along a path of cube-to-cube steps is not quite the straight line (a known edge of
    // the method — Maya's too, `…cut-cell.raw.txt:144-147`). On this tube, 10.7 cubes across:
    const got = captureByVoxel(cylinderMesh(TUBE), CHAIN, OPTS)!;
    for (const y of [0.5, 1.25, 1.75]) {
      const first = weightsOf(got, 3, ring(y));
      for (let side = 1; side < TUBE.radial; side++) {
        const here = weightsOf(got, 3, ring(y) + side);
        for (let b = 0; b < 3; b++) expect(Math.abs(here[b] - first[b])).toBeLessThan(0.05);
      }
    }
  });

  it('the size of the scene does not change the weights', () => {
    const tube = cylinderMesh(TUBE);
    // A power of two, so every scaled number is exact and the two grids cut the same cubes.
    const scale = 32;
    const big: VoxelMesh = { ...tube, points: tube.points.map((v) => v * scale) };
    const bigChain = CHAIN.map((b) => ({
      name: b.name,
      head: b.head.map((v) => v * scale) as [number, number, number],
      tail: b.tail.map((v) => v * scale) as [number, number, number],
    }));
    // A falloff with both of its terms in play, so a distance left undivided would show.
    const opts = { ...OPTS, falloff: 0.6 };
    const a = captureByVoxel(tube, CHAIN, opts)!;
    const b = captureByVoxel(big, bigChain, opts)!;
    expect(Array.from(b.lanes.joints)).toEqual(Array.from(a.lanes.joints));
    for (let i = 0; i < a.lanes.weights.length; i++) {
      expect(b.lanes.weights[i]).toBeCloseTo(a.lanes.weights[i], 4);
    }
  });

  it('a higher falloff holds each bone closer to itself', () => {
    const tube = cylinderMesh(TUBE);
    const at = ring(1.25);
    const smooth = weightsOf(captureByVoxel(tube, CHAIN, { ...OPTS, falloff: 0 })!, 3, at);
    const rigid = weightsOf(captureByVoxel(tube, CHAIN, { ...OPTS, falloff: 1 })!, 3, at);
    expect(rigid[1]).toBeGreaterThan(smooth[1] + 0.02);
    // With no squared term the falloff is the inverse square of distance, whatever the size.
    const lower = Math.hypot(0.25, 0.25);
    expect(smooth[0] / smooth[1]).toBeCloseTo((0.25 / lower) ** 2, 1);
  });

  it('keeps at most maxInfluences bones a point, nearest first, in whole sets of four', () => {
    const one = captureByVoxel(cylinderMesh(TUBE), CHAIN, { ...OPTS, maxInfluences: 1 })!;
    expect(one.lanes.width).toBe(4);
    expect(weightsOf(one, 3, ring(1.5))).toEqual([0, 1, 0]);
    const two = captureByVoxel(cylinderMesh(TUBE), CHAIN, { ...OPTS, maxInfluences: 2 })!;
    expect(weightsOf(two, 3, ring(0.25)).filter((w) => w > 0)).toHaveLength(2);
    expect(two.lanes.weights[ring(0.25) * 4]).toBeGreaterThan(
      two.lanes.weights[ring(0.25) * 4 + 1],
    );
  });
});

describe('#1539 — parts that lie close but join far away keep their own bones', () => {
  // Two bars hanging from a bridge, a tenth apart: an arm beside a torso. Bone L runs down the
  // left bar and bone R down the right one.
  const bars = join(
    box([0, 0, 0], [0.2, 1, 0.2]),
    box([0.3, 0, 0], [0.5, 1, 0.2]),
    box([0, 1, 0], [0.5, 1.2, 0.2]),
  );
  const L: CaptureBone = { name: 'L', head: [0.1, 0.1, 0.1], tail: [0.1, 0.9, 0.1] };
  const R: CaptureBone = { name: 'R', head: [0.4, 0.1, 0.1], tail: [0.4, 0.9, 0.1] };
  /** The foot of the left bar, on the side facing the right bar: corner x+ of box 0. */
  const INNER_FOOT = 1;

  it('straight-line distance gives the left bar a fifth of the right bar’s bone; the volume gives it a hundredth', () => {
    expect(Array.from(bars.points.subarray(INNER_FOOT * 3, INNER_FOOT * 3 + 3))).toEqual([
      expect.closeTo(0.2, 6),
      0,
      0,
    ]);
    const near = weightsOf(
      captureByProximity(bars.points, [L, R], { maxInfluences: 4, dropoff: 4 }),
      2,
      INNER_FOOT,
    );
    expect(near[1]).toBeGreaterThan(0.15);
    const through = captureByVoxel(bars, [L, R], OPTS)!;
    expect([through.unreached, through.outside]).toEqual([0, []]);
    // By the volume R is up one bar, across and down the other: over two away, against 0.17.
    expect(weightsOf(through, 2, INNER_FOOT)[1]).toBeLessThan(0.02);
    expect(weightsOf(through, 2, INNER_FOOT)[0]).toBeGreaterThan(0.98);
  });

  it('two parts with empty cubes between them stay apart, however the gap is slanted', () => {
    // Two slabs lying at 45° to the grid, two cubes apart, one bone in the lower. Cubes of the two
    // touch corner to corner across the gap; distance spreads only through shared faces, so the
    // upper slab is not reached, and says so.
    const gap = 2 / 32;
    const slabs = join(
      box([0, 0, 0], [1, 0.15, 0.3], Math.PI / 4),
      box([0, 0.15 + gap, 0], [1, 0.3 + gap, 0.3], Math.PI / 4),
    );
    const s = Math.SQRT1_2;
    const bone: CaptureBone = {
      name: 'A',
      head: [(0.1 - 0.075) * s, (0.1 + 0.075) * s, 0.15],
      tail: [(0.9 - 0.075) * s, (0.9 + 0.075) * s, 0.15],
    };
    const got = captureByVoxel(slabs, [bone], { ...OPTS, resolution: 32 })!;
    expect(got.unreached).toBe(8);
  });
});

describe('#1539 — a point or a bone the volume does not reach is named, never left at zero', () => {
  const tube = cylinderMesh(TUBE);

  it('a part no bone is in is bound by straight-line distance, and counted', () => {
    const withProp = join(tube, box([2, 0, -0.1], [2.2, 0.2, 0.1]));
    const got = captureByVoxel(withProp, CHAIN, OPTS)!;
    expect([got.unbound, got.unreached]).toEqual([0, 8]);
    const first = tube.points.length / 3;
    for (let p = first; p < first + 8; p++) {
      const w = weightsOf(got, 3, p);
      expect(w.reduce((a, b) => a + b)).toBeCloseTo(1, 5);
      // Level with the lowest bone, which is the nearest in a straight line.
      expect(w[0]).toBeGreaterThan(w[1]);
    }
    // The tube itself is weighted exactly as it is without the prop's cubes in the grid… the grid
    // is wider, so not bit for bit, but every point is still reached.
    expect(weightsOf(got, 3, ring(1.5))[1]).toBeGreaterThan(0.7);
  });

  it('a point on no face stands in no filled cube, and is counted the same way', () => {
    const loose: VoxelMesh = {
      ...tube,
      points: Float32Array.from([...tube.points, 0.6, 1.5, 0]),
    };
    const got = captureByVoxel(loose, CHAIN, OPTS)!;
    expect(got.unreached).toBe(1);
    // The same falloff, on straight-line distance over the mesh's longest side (3): 0.6 from the
    // middle bone and √(0.6² + 0.5²) from each neighbour. f(x) = 0.8x + 0.2x² gives 0.168 and
    // 0.2218, and the weights go as 1/f²: 1 : 0.574 : 0.574.
    expect(weightsOf(got, 3, tube.points.length / 3)[1]).toBeCloseTo(1 / (1 + 2 * 0.574), 3);
  });

  it('a bone outside the volume is named, and the rest are measured as before', () => {
    const far: CaptureBone = { name: 'Far', head: [1, 0, 0], tail: [1, 1, 0] };
    const got = captureByVoxel(tube, [...CHAIN, far], OPTS)!;
    expect(got.outside).toEqual(['Far']);
    expect(got.unreached).toBe(0);
    const alone = captureByVoxel(tube, CHAIN, OPTS)!;
    for (let p = 0; p < TUBE.radial * TUBE.rings; p++) {
      expect(weightsOf(got, 4, p).slice(0, 3)).toEqual(weightsOf(alone, 3, p));
    }
  });

  it('with every bone outside, every point falls back and every bone is named', () => {
    const away = CHAIN.map((b) => ({
      name: b.name,
      head: [b.head[0] + 5, b.head[1], b.head[2]] as [number, number, number],
      tail: [b.tail[0] + 5, b.tail[1], b.tail[2]] as [number, number, number],
    }));
    const got = captureByVoxel(tube, away, OPTS)!;
    expect(got.outside).toEqual(['Bone', 'Bone.001', 'Bone.002']);
    expect([got.unbound, got.unreached]).toEqual([0, TUBE.radial * TUBE.rings]);
  });

  it('one bone’s field is as long as the filled cubes, not as the grid', () => {
    const got = captureByVoxel(tube, CHAIN, OPTS)!;
    const volume = voxelize(tube, 64)!;
    expect(got.filled).toBe(volume.surface + volume.inside);
    expect(got.filled).toBeLessThan(volume.state.length / 2);
  });
});
