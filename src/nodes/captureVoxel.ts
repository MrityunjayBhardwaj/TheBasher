// #1539 — skin weights by voxel geodesic distance: each point is bound to the bones nearest it
// THROUGH THE BODY, so an arm lying against the torso does not take the torso's bones.
//
// ── THE METHOD ────────────────────────────────────────────────────────────────────────────────
//
// Maya's Geodesic Voxel Binding (Dionne & de Lasa, SCA 2013), in four steps:
//
// 1. VOXELIZE. The mesh's bounds are cut into cubes, `resolution` along the longest side. A cube a
//    triangle passes through is on the surface; a cube the surface encloses is inside. Together
//    they are the volume distance is measured through.
// 2. SEED. Each bone starts in the cubes its segment passes through, at each cube's straight-line
//    distance to the segment.
// 3. PROPAGATE. From a bone's seeds, the distance through filled cubes to every other filled cube,
//    one bone at a time. Distance spreads from cube to face-neighbouring cube as a front (the fast
//    marching method), not as the length of a path of cube-to-cube steps: a staircase of steps
//    overstates a slanted distance by up to 8%, which showed in the app as an uneven bend.
// 4. SAMPLE. Each point reads each bone's distance where it stands, keeps its `maxInfluences`
//    nearest bones, and turns distance into weight by the method's falloff:
//
//        w = ( 1 / ((1 − a)·d/D + a·(d/D)²) )²        a = falloff, D = the mesh's longest side
//
//    then the kept weights are scaled to add up to one
//    (`geodesic-voxel-binding/arxiv-2608.11272-geodesic-cut-cell.raw.txt:462-475`, restating the
//    2013 paper; Maya's Falloff, 0 smooth to 1 rigid, default 0.2: `bind-skin-options-2025.txt:151-155`).
//
// ── WHAT IS INSIDE, WHEN THE MESH HAS HOLES ───────────────────────────────────────────────────
//
// The 2013 paper is not held (paywalled), so how Maya decides this is not known. The one open
// implementation floods from outside the bounds and calls what the flood cannot reach "inside"
// (`poqpoq-voxel-skinner/src/Voxelizer.js:119-184`); a hole wider than one cube lets the flood in,
// the inside stays empty, and on an open-ended tube every point got no weight
// (`ref/probes/skin-weights-auto/README.txt:9`).
//
// Here a cube is inside when most straight lines out of it are stopped by the surface. Six lines
// leave each cube centre, one each way along each axis; a line counts the faces it crosses, +1
// through a front and −1 through a back, and is "stopped" when that count is not zero. A cube with
// at least `INSIDE_VOTES` stopped lines is inside. On a closed mesh all six agree. Through a hole,
// only the lines that leave by the hole are wrong, and the rest outvote them. It is the generalized
// winding number (Jacobson et al. 2013; the test the cut-cell paper uses, `…raw.txt:300-328`,
// `:940`) sampled in six directions instead of integrated over all of them.
//
// Like Maya's, it wants faces whose fronts point outward (`maya-docs/geodesic-voxel-binding-2015.txt:6`);
// a mesh turned wholly inside out works the same, since only "not zero" is asked.
//
// ── WHAT THE REFERENCE GETS WRONG, AND THIS DOES NOT ──────────────────────────────────────────
//
// - Memory. It keeps every bone's distance field at once, as 64-bit floats over the whole grid
//   (`GeodesicSolver.js:140`, `:38-46`): 1.2 GB for 72 bones at 128³. Here ONE 32-bit field is
//   live, over the filled cubes only; each point takes what it needs from it and the next bone
//   overwrites it. Everything a capture allocates is at most 24 bytes per grid cube plus 153 per
//   point (at four influences), whatever the number of bones: under 57 MB for the grid at 128,
//   and 6 MB in all for the 24,746-point, 72-bone character of `captureVoxel.character.test.ts`.
// - Scale. Its falloff uses the raw distance (`WeightExtractor.js:113-119`), so a mesh weights
//   differently at another size. Here distance is divided by the mesh's longest side.
// - Silent zeros. A point no bone reaches gets no weight and says nothing
//   (`WeightExtractor.js:105-108`); a bone in no filled cube gets an empty field, also silently
//   (`GeodesicSolver.js:103`). Here both are counted and named, and an unreached point is bound by
//   straight-line distance to its nearest bones under the same falloff, as the cut-cell paper does
//   (`…raw.txt:498-512`).
//
// ── WHAT IT CANNOT TELL APART ─────────────────────────────────────────────────────────────────
//
// Two parts closer together than about three cubes share cubes, or have cubes that touch, and
// are joined: measured on that character, a hand 6 cm from the thigh is kept apart at 128 (4.3
// cubes) and joined at 64 (2.2). Maya says the same of its own
// (`bind-skin-options-2025.txt:160-164`). Distance spreads only through shared faces, never corner
// to corner, so a layer of empty cubes between two parts keeps them apart however it is slanted.
//
// And the grid still shows a little: on a straight tube, where the right answer is known, weights
// are within 0.035 of it at 11 cubes across and within 0.02 at 21.
//
// Studied from poqpoq voxel-skinner (MIT, commit 56bb037f); no code is copied from it.
//
// REF: ref/GROUND_TRUTH_AUTO_SKIN_WEIGHTS.md §2A, §2A', §10; src/nodes/captureWeights.ts (the
//      proximity rule and the shape both return); issue #1539.

import { distanceToSegment, type CaptureBone, type CapturedWeights } from './captureWeights';
import { SKIN_SET_WIDTH } from './skinInfluences';

/** Of a cube's six lines out, how many the surface must stop for the cube to be inside. */
export const INSIDE_VOTES = 4;

/** In a search's `place`: this cube has its final distance. */
const SETTLED = -2;

/** Empty cubes kept on every side of the mesh's bounds. See `voxelize`. */
const PADDING = 2;

/** A cube's state in a {@link VoxelVolume}. */
export const VOXEL_OUTSIDE = 0;
export const VOXEL_SURFACE = 1;
export const VOXEL_INSIDE = 2;

/** A mesh as cubes: which are on its surface and which it encloses. */
export interface VoxelVolume {
  /** Cubes along x, y and z, the padding on every side included. */
  readonly dims: readonly [number, number, number];
  /** The side of one cube, in the mesh's units. */
  readonly size: number;
  /** The low corner of cube (0, 0, 0). */
  readonly origin: readonly [number, number, number];
  /** The mesh's longest side: what distance is divided by. */
  readonly extent: number;
  /** Per cube, x fastest: {@link VOXEL_OUTSIDE}, {@link VOXEL_SURFACE} or {@link VOXEL_INSIDE}. */
  readonly state: Uint8Array;
  readonly surface: number;
  readonly inside: number;
}

/** The faces of a mesh, as the stored mesh holds them. */
export interface VoxelMesh {
  readonly points: Float32Array;
  readonly faceSizes: Uint32Array;
  readonly cornerPoints: Uint32Array;
}

export interface VoxelCaptureOptions {
  /** The most bones one point is bound to. At least 1. */
  readonly maxInfluences: number;
  /** 0 smooth to 1 rigid — `a` in the falloff above. */
  readonly falloff: number;
  /** Cubes along the mesh's longest side. */
  readonly resolution: number;
}

export interface VoxelCapturedWeights extends CapturedWeights {
  /** Filled cubes (surface and inside): what one bone's distance field is as long as. */
  readonly filled: number;
  readonly dims: readonly [number, number, number];
}

/** Does the triangle (corners relative to a cube's centre, in cubes) touch the cube? */
function triangleTouchesCube(t: Float64Array): boolean {
  const H = 0.5;
  // The cube's own three axes.
  for (let a = 0; a < 3; a++) {
    const p0 = t[a];
    const p1 = t[3 + a];
    const p2 = t[6 + a];
    if (Math.min(p0, p1, p2) > H || Math.max(p0, p1, p2) < -H) return false;
  }
  const e = [
    t[3] - t[0],
    t[4] - t[1],
    t[5] - t[2],
    t[6] - t[3],
    t[7] - t[4],
    t[8] - t[5],
    t[0] - t[6],
    t[1] - t[7],
    t[2] - t[8],
  ];
  // The triangle's plane.
  const nx = e[1] * e[5] - e[2] * e[4];
  const ny = e[2] * e[3] - e[0] * e[5];
  const nz = e[0] * e[4] - e[1] * e[3];
  if (
    Math.abs(nx * t[0] + ny * t[1] + nz * t[2]) >
    H * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz))
  )
    return false;
  // Each cube axis crossed with each edge.
  for (let i = 0; i < 9; i += 3) {
    const ex = e[i];
    const ey = e[i + 1];
    const ez = e[i + 2];
    for (let a = 0; a < 3; a++) {
      const ax = a === 0 ? 0 : a === 1 ? ez : -ey;
      const ay = a === 0 ? -ez : a === 1 ? 0 : ex;
      const az = a === 0 ? ey : a === 1 ? -ex : 0;
      const p0 = ax * t[0] + ay * t[1] + az * t[2];
      const p1 = ax * t[3] + ay * t[4] + az * t[5];
      const p2 = ax * t[6] + ay * t[7] + az * t[8];
      const r = H * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
      if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
    }
  }
  return true;
}

/**
 * Which side of the line `a → b` the point `(pu, pv)` is on, with the line taken in ONE direction
 * whichever triangle asks, so the two triangles sharing an edge get the very same number.
 * Returns it signed for the triangle whose third corner is `c`: above zero is the triangle's side.
 * A point exactly on the line is given to the triangle on the line's left, so it is in exactly one
 * of the two.
 */
function insideEdge(
  au: number,
  av: number,
  bu: number,
  bv: number,
  cu: number,
  cv: number,
  pu: number,
  pv: number,
): boolean {
  if (au > bu || (au === bu && av > bv)) {
    const tu = au;
    const tv = av;
    au = bu;
    av = bv;
    bu = tu;
    bv = tv;
  }
  const side = (bu - au) * (cv - av) - (bv - av) * (cu - au);
  const at = (bu - au) * (pv - av) - (bv - av) * (pu - au);
  return at === 0 ? side > 0 : at > 0 === side > 0;
}

/**
 * `mesh` as cubes, `resolution` along its longest side, or `null` when it has no size or no faces.
 * `insideVotes` is {@link INSIDE_VOTES} everywhere but in the test that measures the choice.
 */
export function voxelize(
  mesh: VoxelMesh,
  resolution: number,
  insideVotes = INSIDE_VOTES,
): VoxelVolume | null {
  const { points, faceSizes, cornerPoints } = mesh;
  const count = points.length / 3;
  if (count === 0 || faceSizes.length === 0) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < count; p++) {
    for (let a = 0; a < 3; a++) {
      const v = points[p * 3 + a];
      if (!Number.isFinite(v)) return null;
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(extent > 0)) return null;
  const size = extent / Math.max(1, Math.floor(resolution));
  // Two cubes of padding on every side. A point on a cube boundary belongs to the cube above it,
  // so the mesh's own highest point (always on a boundary along its longest side) is in the first
  // padding cube, which is then on the surface. The second never is, and that empty outermost
  // layer is what lets a cube's neighbours be read without asking whether they are still in the
  // grid (and without a row's end wrapping round to the next row's start).
  const origin: [number, number, number] = [
    lo[0] - PADDING * size,
    lo[1] - PADDING * size,
    lo[2] - PADDING * size,
  ];
  const dims: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) dims[a] = Math.floor((hi[a] - lo[a]) / size) + 2 * PADDING + 1;
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const stride = [1, nx, nx * ny];

  // Every point in cubes, once: two triangles sharing a corner then share its exact numbers.
  const at = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    for (let a = 0; a < 3; a++) at[p * 3 + a] = (points[p * 3 + a] - origin[a]) / size;
  }

  const state = new Uint8Array(total);
  const votes = new Uint8Array(total);
  const crossings = new Int16Array(total);
  const tri = new Float64Array(9);
  const local = new Float64Array(9);
  let surface = 0;

  /** Step 1a: the cubes triangle `tri` passes through are on the surface. */
  const markSurface = (): void => {
    const from = [0, 0, 0];
    const to = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      from[a] = Math.max(1, Math.floor(Math.min(tri[a], tri[3 + a], tri[6 + a])));
      to[a] = Math.min(dims[a] - 2, Math.floor(Math.max(tri[a], tri[3 + a], tri[6 + a])));
    }
    const single = from[0] === to[0] && from[1] === to[1] && from[2] === to[2];
    for (let z = from[2]; z <= to[2]; z++) {
      for (let y = from[1]; y <= to[1]; y++) {
        for (let x = from[0]; x <= to[0]; x++) {
          const cube = x + nx * (y + ny * z);
          if (state[cube] === VOXEL_SURFACE) continue;
          if (!single) {
            for (let k = 0; k < 9; k += 3) {
              local[k] = tri[k] - (x + 0.5);
              local[k + 1] = tri[k + 1] - (y + 0.5);
              local[k + 2] = tri[k + 2] - (z + 0.5);
            }
            if (!triangleTouchesCube(local)) continue;
          }
          state[cube] = VOXEL_SURFACE;
          surface++;
        }
      }
    }
  };

  /**
   * Step 1b, one axis: where the lines along `axis` through the cube centres cross triangle `tri`,
   * and which way the face looks there. Written as +1 or −1 at the first centre past the crossing.
   */
  const markCrossings = (axis: number): void => {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const au = tri[u];
    const av = tri[v];
    const bu = tri[3 + u];
    const bv = tri[3 + v];
    const cu = tri[6 + u];
    const cv = tri[6 + v];
    // The face's normal along `axis`; zero when the line sees the triangle edge-on.
    const facing = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (facing === 0) return;
    // The other two parts of the normal, to find how far along the line the crossing is.
    const ba = tri[3 + axis] - tri[axis];
    const ca = tri[6 + axis] - tri[axis];
    const normalU = (bv - av) * ca - ba * (cv - av);
    const normalV = ba * (cu - au) - (bu - au) * ca;
    const sign = facing > 0 ? 1 : -1;
    const u0 = Math.max(0, Math.ceil(Math.min(au, bu, cu) - 0.5));
    const u1 = Math.min(dims[u] - 1, Math.floor(Math.max(au, bu, cu) - 0.5));
    const v0 = Math.max(0, Math.ceil(Math.min(av, bv, cv) - 0.5));
    const v1 = Math.min(dims[v] - 1, Math.floor(Math.max(av, bv, cv) - 0.5));
    for (let iv = v0; iv <= v1; iv++) {
      const pv = iv + 0.5;
      for (let iu = u0; iu <= u1; iu++) {
        const pu = iu + 0.5;
        if (
          !insideEdge(au, av, bu, bv, cu, cv, pu, pv) ||
          !insideEdge(bu, bv, cu, cv, au, av, pu, pv) ||
          !insideEdge(cu, cv, au, av, bu, bv, pu, pv)
        )
          continue;
        const depth = tri[axis] - (normalU * (pu - au) + normalV * (pv - av)) / facing;
        // The first cube whose centre lies past the crossing.
        const first = Math.min(dims[axis] - 1, Math.max(0, Math.floor(depth - 0.5) + 1));
        crossings[iu * stride[u] + iv * stride[v] + first * stride[axis]] += sign;
      }
    }
  };

  /** Every face as a fan of triangles from its first corner, handed to `visit` in `tri`. */
  const eachTriangle = (visit: () => void): void => {
    let corner = 0;
    for (let f = 0; f < faceSizes.length; f++) {
      const n = faceSizes[f];
      const a = cornerPoints[corner] * 3;
      for (let k = 1; k + 1 < n; k++) {
        const b = cornerPoints[corner + k] * 3;
        const c = cornerPoints[corner + k + 1] * 3;
        for (let i = 0; i < 3; i++) {
          tri[i] = at[a + i];
          tri[3 + i] = at[b + i];
          tri[6 + i] = at[c + i];
        }
        visit();
      }
      corner += n;
    }
  };

  eachTriangle(markSurface);
  for (let axis = 0; axis < 3; axis++) {
    crossings.fill(0);
    eachTriangle(() => markCrossings(axis));
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let iv = 0; iv < dims[v]; iv++) {
      for (let iu = 0; iu < dims[u]; iu++) {
        const column = iu * stride[u] + iv * stride[v];
        let all = 0;
        for (let k = 0; k < dims[axis]; k++) all += crossings[column + k * stride[axis]];
        // `behind` counts the faces a line going back from this centre crosses; the line going
        // forward crosses the rest.
        let behind = 0;
        for (let k = 0; k < dims[axis]; k++) {
          const cube = column + k * stride[axis];
          behind += crossings[cube];
          votes[cube] += (behind !== 0 ? 1 : 0) + (all - behind !== 0 ? 1 : 0);
        }
      }
    }
  }

  let inside = 0;
  // The outermost layer stays outside whatever the lines said: a line that ends there has left
  // the mesh.
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const cube = x + nx * (y + ny * z);
        if (state[cube] === VOXEL_OUTSIDE && votes[cube] >= insideVotes) {
          state[cube] = VOXEL_INSIDE;
          inside++;
        }
      }
    }
  }
  return { dims, size, origin, extent, state, surface, inside };
}

/** The method's falloff before squaring: `(1 − a)·x + a·x²`, `x` the distance over the extent. */
function falloffOf(distance: number, extent: number, a: number): number {
  const x = distance / extent;
  return (1 - a) * x + a * x * x;
}

/**
 * Bind every point of `mesh` to the bones nearest it through the mesh's volume, or `null` when the
 * mesh cannot be cut into cubes (no faces, or no size).
 */
export function captureByVoxel(
  mesh: VoxelMesh,
  bones: readonly CaptureBone[],
  options: VoxelCaptureOptions,
): VoxelCapturedWeights | null {
  const volume = voxelize(mesh, options.resolution);
  if (volume === null) return null;
  const { dims, size, origin, extent, state } = volume;
  const [nx, ny, nz] = dims;
  const points = mesh.points;
  const count = points.length / 3;

  // The filled cubes, numbered: a bone's field and its queue are as long as these, not as the grid.
  const filled = volume.surface + volume.inside;
  const numberOf = new Int32Array(nx * ny * nz).fill(-1);
  const cubeOf = new Int32Array(filled);
  let next = 0;
  for (let cube = 0; cube < state.length; cube++) {
    if (state[cube] === VOXEL_OUTSIDE) continue;
    numberOf[cube] = next;
    cubeOf[next++] = cube;
  }

  const kept = Math.max(1, Math.min(Math.floor(options.maxInfluences), bones.length));
  const width = Math.max(1, Math.ceil(kept / SKIN_SET_WIDTH)) * SKIN_SET_WIDTH;
  // Each point's `kept` nearest bones so far, nearest first, and how many it has.
  const nearBone = new Int32Array(count * kept);
  const nearDistance = new Float32Array(count * kept);
  const found = new Uint8Array(count);

  // Where each point reads a bone's distance: the filled cubes among the eight whose centres
  // surround it. Per read, the filled cube's number (-1 for none) and the way from its centre to
  // the point. A point on a face always has one (the cube it is in); a point on no face may have
  // none, and then nothing reaches it.
  const READS = 8;
  const readFrom = new Int32Array(count * READS).fill(-1);
  const readPlus = new Float32Array(count * READS);
  for (let p = 0; p < count; p++) {
    const gx = (points[p * 3] - origin[0]) / size - 0.5;
    const gy = (points[p * 3 + 1] - origin[1]) / size - 0.5;
    const gz = (points[p * 3 + 2] - origin[2]) / size - 0.5;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const iz = Math.floor(gz);
    const wx = gx - ix;
    const wy = gy - iy;
    const wz = gz - iz;
    for (let k = 0; k < READS; k++) {
      const dx = k & 1;
      const dy = (k >> 1) & 1;
      const dz = k >> 2;
      readFrom[p * READS + k] = numberOf[ix + dx + nx * (iy + dy + ny * (iz + dz))];
      readPlus[p * READS + k] = Math.hypot(wx - dx, wy - dy, wz - dz) * size;
    }
  }

  const field = new Float32Array(filled);
  // A binary heap of filled-cube numbers ordered by `field`, and where each one sits in it.
  const heap = new Int32Array(filled);
  const place = new Int32Array(filled);
  let heapSize = 0;
  const sink = (number: number, distance: number): void => {
    // Move `number` up from where it sits (or from the end, when it is new) to its place.
    let i = place[number];
    if (i < 0) i = heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const other = heap[parent];
      if (field[other] <= distance) break;
      heap[i] = other;
      place[other] = i;
      i = parent;
    }
    heap[i] = number;
    place[number] = i;
  };
  const pop = (): number => {
    const top = heap[0];
    place[top] = SETTLED;
    const last = heap[--heapSize];
    if (heapSize > 0) {
      const distance = field[last];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= heapSize) break;
        if (child + 1 < heapSize && field[heap[child + 1]] < field[heap[child]]) child++;
        if (field[heap[child]] >= distance) break;
        heap[i] = heap[child];
        place[heap[i]] = i;
        i = child;
      }
      heap[i] = last;
      place[last] = i;
    }
    return top;
  };

  const axisStep = [1, nx, nx * ny];
  /** The settled distance at `cube`, or Infinity when it is empty or not settled yet. */
  const settledAt = (cube: number): number => {
    const number = numberOf[cube];
    return number >= 0 && place[number] === SETTLED ? field[number] : Infinity;
  };
  /**
   * The distance at `cube` that its settled face neighbours imply, taking distance to grow at
   * one unit per unit travelled in whatever direction it arrives from (the fast marching method,
   * Sethian 1996). Along each axis the nearer of the two neighbours counts. With one axis it is a
   * step straight on; with two or three it is the front crossing the cube at a slant, which is
   * what makes a diagonal cost its true length rather than a staircase's.
   */
  const arrival = (cube: number): number => {
    let a = Math.min(settledAt(cube - 1), settledAt(cube + 1));
    let b = Math.min(settledAt(cube - nx), settledAt(cube + nx));
    let c = Math.min(settledAt(cube - axisStep[2]), settledAt(cube + axisStep[2]));
    // Nearest first.
    if (a > b) [a, b] = [b, a];
    if (b > c) [b, c] = [c, b];
    if (a > b) [a, b] = [b, a];
    let t = a + size;
    if (t <= b) return t;
    // (t − a)² + (t − b)² = size²
    t = (a + b + Math.sqrt(2 * size * size - (a - b) * (a - b))) / 2;
    if (t <= c) return t;
    // (t − a)² + (t − b)² + (t − c)² = size²
    const sum = a + b + c;
    const root = sum * sum - 3 * (a * a + b * b + c * c - size * size);
    return (sum + Math.sqrt(Math.max(0, root))) / 3;
  };

  const outside: string[] = [];
  bones.forEach((bone, b) => {
    field.fill(Infinity);
    place.fill(-1);
    heapSize = 0;

    // Step 2: seed the cubes the bone passes through and the ones beside them, each at its
    // centre's straight-line distance to the bone. (The ones beside it too, so that a bone lying
    // just outside the surface still starts somewhere.)
    const [hx, hy, hz] = bone.head;
    const length = Math.hypot(bone.tail[0] - hx, bone.tail[1] - hy, bone.tail[2] - hz);
    const steps = Math.max(1, Math.ceil(length / (size * 0.5)));
    let seeded = false;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const cx = Math.floor((hx + (bone.tail[0] - hx) * f - origin[0]) / size);
      const cy = Math.floor((hy + (bone.tail[1] - hy) * f - origin[1]) / size);
      const cz = Math.floor((hz + (bone.tail[2] - hz) * f - origin[2]) / size);
      if (cx < 1 || cy < 1 || cz < 1 || cx >= nx - 1 || cy >= ny - 1 || cz >= nz - 1) continue;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            const z = cz + dz;
            const number = numberOf[x + nx * (y + ny * z)];
            if (number < 0 || field[number] !== Infinity) continue;
            const d = distanceToSegment(
              origin[0] + (x + 0.5) * size,
              origin[1] + (y + 0.5) * size,
              origin[2] + (z + 0.5) * size,
              bone,
            );
            field[number] = d;
            sink(number, d);
            seeded = true;
          }
        }
      }
    }
    if (!seeded) {
      outside.push(bone.name);
      return;
    }

    // Step 3: distance from the seeds to every filled cube they can reach, nearest first. A cube
    // taken off the queue is settled; each of its six face neighbours not yet settled is then
    // given the distance its own settled neighbours imply (`arrival`).
    while (heapSize > 0) {
      const cube = cubeOf[pop()];
      for (let side = 0; side < 6; side++) {
        const beside = cube + (side & 1 ? -axisStep[side >> 1] : axisStep[side >> 1]);
        const other = numberOf[beside];
        if (other < 0 || place[other] === SETTLED) continue;
        const through = arrival(beside);
        if (through < field[other]) {
          field[other] = through;
          sink(other, through);
        }
      }
    }

    // Step 4a: each point reads the field at the cube centres around it, plus the way from the
    // centre to the point, and keeps the bone if it is among its nearest so far.
    for (let p = 0; p < count; p++) {
      let d = Infinity;
      for (let k = p * READS; k < p * READS + READS; k++) {
        const from = readFrom[k];
        if (from < 0) continue;
        const through = field[from] + readPlus[k];
        if (through < d) d = through;
      }
      if (d === Infinity) continue;
      const base = p * kept;
      const have = found[p];
      // Strictly nearer moves ahead, so equally near bones stay in bone order.
      let slot = have;
      while (slot > 0 && d < nearDistance[base + slot - 1]) slot--;
      if (slot >= kept) continue;
      for (let k = Math.min(have, kept - 1); k > slot; k--) {
        nearBone[base + k] = nearBone[base + k - 1];
        nearDistance[base + k] = nearDistance[base + k - 1];
      }
      nearBone[base + slot] = b;
      nearDistance[base + slot] = d;
      if (have < kept) found[p] = have + 1;
    }
  });

  // Step 4b: distance to weight.
  const joints = new Int32Array(count * width);
  const weights = new Float32Array(count * width);
  let unbound = 0;
  let unreached = 0;
  const fallBone = new Int32Array(kept);
  const fallDistance = new Float64Array(kept);
  for (let p = 0; p < count; p++) {
    const base = p * kept;
    let have = found[p];
    let boneAt: Int32Array | Float32Array = nearBone;
    let distanceAt: Float32Array | Float64Array = nearDistance;
    let from = base;
    if (have === 0) {
      // No bone reaches this point through the volume: its nearest bones in a straight line.
      const px = points[p * 3];
      const py = points[p * 3 + 1];
      const pz = points[p * 3 + 2];
      for (let b = 0; b < bones.length; b++) {
        const d = distanceToSegment(px, py, pz, bones[b]);
        if (!Number.isFinite(d)) continue;
        let slot = have;
        while (slot > 0 && d < fallDistance[slot - 1]) slot--;
        if (slot >= kept) continue;
        for (let k = Math.min(have, kept - 1); k > slot; k--) {
          fallBone[k] = fallBone[k - 1];
          fallDistance[k] = fallDistance[k - 1];
        }
        fallBone[slot] = b;
        fallDistance[slot] = d;
        if (have < kept) have++;
      }
      if (have === 0) {
        unbound++;
        continue;
      }
      unreached++;
      boneAt = fallBone;
      distanceAt = fallDistance;
      from = 0;
    }
    const nearest = falloffOf(distanceAt[from], extent, options.falloff);
    let total = 0;
    let used = 0;
    for (; used < have; used++) {
      const f = falloffOf(distanceAt[from + used], extent, options.falloff);
      // On a bone, only the bones the point lies on hold it.
      const ratio = nearest === 0 ? (f === 0 ? 1 : 0) : nearest / f;
      const raw = ratio * ratio;
      if (raw === 0) break;
      joints[p * width + used] = boneAt[from + used];
      weights[p * width + used] = raw;
      total += raw;
    }
    for (let lane = 0; lane < used; lane++) weights[p * width + lane] /= total;
  }

  return {
    lanes: { width, joints, weights },
    vertexGroups: bones.map((b) => b.name),
    unbound,
    unreached,
    outside,
    filled,
    dims,
  };
}
