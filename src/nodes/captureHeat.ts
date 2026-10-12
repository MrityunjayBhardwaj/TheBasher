// #1356 — skin weights by heat spreading over the surface: each point is bound to the bones whose
// heat reaches it ALONG THE SKIN, so a finger lying against its neighbour keeps its own bones.
//
// ── WHY A THIRD MEASURE ───────────────────────────────────────────────────────────────────────
//
// The voxel method (`captureVoxel.ts`) joins parts closer together than about three cubes. On the
// character of `captureHeat.character.test.ts` the fingers stand half a millimetre apart, a
// twentieth of a cube at 128: three in four finger points took another finger's bones (6,029 of
// 7,965 at 128; 5,438 at 256), worse than straight-line distance does (2,426). Along the surface
// two fingers are as far apart as the way down one, across the knuckles and up the other; by this
// method none of those points does.
//
// ── WHAT IT COSTS ─────────────────────────────────────────────────────────────────────────────
//
// On that character (24,746 points, 67 bones; Node on this machine, 2026-10-12) about 0.15 s and
// 11.8 MB. It is that quick there because that character is 95 small pieces: the time grows with
// the size of a PIECE to the power one and a half, for each bone that heats it (`heatLoad`, which
// gives the measurements). One skin of 38,400 points with 20 bones took 3.9 s; of 199,680, 54 s.
// A caller that must not stand frozen asks `heatLoad` first (`CaptureModifier` does). What would
// lift this is a solve whose steps do not grow with the piece — a multilevel one; not built
// (#1591).
//
// ── THE METHOD ────────────────────────────────────────────────────────────────────────────────
//
// Baran & Popović, "Automatic Rigging and Animation of 3D Characters" (SIGGRAPH 2007), §4
// (`baran-popovic-pinocchio/baran-popovic-2007.txt:388-429`). The skin is a sheet that conducts
// heat. For one bone at a time, the places that bone heats are pulled towards 1 and the places
// another bone heats towards 0, each as strongly as its bone is near; where the heat settles is
// that bone's weight. In the paper's terms, for bone i:
//
//        −Δ wᵢ + H wᵢ = H pᵢ
//
// Δ is the surface's Laplacian by the cotangent formula, pᵢ is 1 at the places bone i heats, and H
// is c/d² at a place whose bone is at distance d and in sight, 0 at a place that sees none; c = 1,
// the paper's choice. Summed over the bones the weights come to exactly 1 at every place a bone's
// heat reaches (`:427-429`), so nothing has to be shared out afterwards beyond dropping all but
// the `maxInfluences` strongest.
//
// Each row is multiplied through by the patch of surface its place stands for (a third of every
// triangle it is a corner of). That makes the system symmetric, and makes every number in it a
// ratio of lengths: the weights do not change with the size of the scene.
//
// ── WHICH BONE HEATS A PLACE ──────────────────────────────────────────────────────────────────
//
// The nearest one it can see from inside: the straight line from the place to the bone must set
// off into the body (under the faces that meet at the place, not out over them) and cross no other
// face of the place's own piece on the way. That is the paper's "contained in the character
// volume" (`:409-414`), asked of the surface alone, with no volume built.
//
// As in the paper, a place whose nearest bone is out of sight gets no heat of its own, and takes
// what spreads to it from the places round it; bones as near as the nearest share a place.
//
// Two things here are not the paper's, each measured on the character of
// `captureHeat.character.test.ts` with its arms turned 75° down (2026-10-12):
//
// - "Sets off into the body" is asked of the faces round the place, not left to the crossing test.
//   A thumb's tip bone that pokes out through the thumb is in plain sight of the thigh beside it,
//   with no face between: without this, 231 hip and leg points took that bone. Blender and the
//   paper's code have a test of this kind on the place's averaged normal
//   (`meshlaplacian.cc:471-486`, `attachment.cpp:35-43`); on a coarse mesh an averaged normal
//   passes lines that leave over a neighbouring face, so the faces are asked one by one.
// - Only the place's OWN piece blocks. A character is often several shells one inside another;
//   with every shell blocking, 1,092 points sat on pieces that saw no bone, against 958.
//
// ── PIECES ────────────────────────────────────────────────────────────────────────────────────
//
// Heat cannot pass between two pieces of surface no edge joins, so each piece is its own problem
// and a bone is solved only over the pieces it heats. Points standing at exactly the same position
// are one place: a seam split for its two bindings still conducts.
//
// A closed piece made inside out (a mirrored part) is read the other way round, by the sign of the
// volume it encloses. A piece with a rim encloses none, and is taken to face the way it is stored.
//
// ── WHAT IS LEFT, AND SAID ────────────────────────────────────────────────────────────────────
//
// - A piece none of whose places has a bone in sight is a shell with its bones in the hollow and
//   not in its wall: on that character the pelvis (a closed band, 534 points) and the two toe caps
//   (212 each). A place of it is heated by its nearest bone when that bone lies BEHIND it, through
//   the shell's own far wall, and its points are counted in `unreached`: they are not bound by the
//   measure the rest are. The shell's inner wall FACES its bones, is heated by none, and takes
//   what spreads in over the rims; a wall cannot tell a bone in its hollow from one beside it.
//   (Heating the inner wall from the bones the outer wall found was tried: with a hand a
//   centimetre and a half from that pelvis it gave 378 hip and leg points the hand's bones,
//   against 26 without.)
// - A piece still unheated after that (a closed part lying between bones that all face it; an open
//   piece stored inside out; a point on no face) goes point by point to its nearest bone, whole,
//   and is counted in `unreached` too. Blender leaves such points at zero and says nothing
//   (`meshlaplacian.cc:533-535`).
// - A bone that ends up holding no point at all is named in `outside`.
// - The balance is found by conjugate gradients, never by factoring the matrix (Blender factors:
//   `linear_solver.cc:278-301`), so there is no solve that can fail outright; a solve that had not
//   settled within its allowance would be counted in `unsettled`. None has been seen.
//
// ── WHAT IT CANNOT TELL APART ─────────────────────────────────────────────────────────────────
//
// Parts joined by a face are one sheet, however thin the bridge. And it is a surface method: a
// character made of many separate shells (clothes over a body) is weighted shell by shell, each
// by the bones behind its own faces, where the voxel method treats them as one solid.
//
// Implemented from the paper. Blender's bone heat (GPL) and Pinocchio (LGPL) were read for what
// they do, as was meshonline's Surface Heat Diffuse Skinning (MIT), whose seeding by rays from the
// bone was not followed; no code is copied from any of them.
//
// REF: ref/GROUND_TRUTH_AUTO_SKIN_WEIGHTS.md §2B, §2C, §2C', §10; src/nodes/captureWeights.ts (the
//      shape every method returns); src/nodes/captureVoxel.ts; issue #1356.

import { distanceToSegment, type CaptureBone, type CapturedWeights } from './captureWeights';
import type { VoxelMesh } from './captureVoxel';
import { SKIN_SET_WIDTH } from './skinInfluences';

/** Bones this much farther than the nearest, as a share of its distance, are as near as it is. */
const TIE = 1e-4;

/**
 * The least an edge conducts. The cotangent of an edge whose two opposite angles add up to more
 * than a half turn is negative, and a negative conductance lets a weight leave the range 0 to 1;
 * and the edges of a triangle with no area conduct nothing, which would leave a place hung on one
 * joined to nothing.
 */
const MIN_CONDUCTANCE = 1e-4;

/**
 * How far outside a triangle, as a share of its size, a line may pass and still cross it. A line
 * through the very edge two triangles share must cross one of them; computed exactly it can miss
 * both by a rounding.
 */
const ON_EDGE = 1e-9;

/** A solve stops when what is left over is this share of what it started from. */
const TOLERANCE = 1e-6;

export interface HeatCaptureOptions {
  /** The most bones one point is bound to. At least 1. */
  readonly maxInfluences: number;
}

export interface HeatCapturedWeights extends CapturedWeights {
  /** Places on the surface: points standing at the very same position are one place. */
  readonly sites: number;
  /** Pieces of the surface no edge joins. */
  readonly pieces: number;
  /** Places with a bone in sight from inside, which that bone heats directly. */
  readonly heated: number;
  /** Steps taken over all the solves, and the solves that ran out of steps before settling. */
  readonly steps: number;
  readonly unsettled: number;
}

/** A mesh as a sheet that conducts heat: its places, the triangles between them, and its pieces. */
interface Surface {
  readonly count: number;
  readonly lo: readonly number[];
  readonly hi: readonly number[];
  readonly extent: number;
  /** Per point, its place. */
  readonly siteOf: Int32Array;
  readonly sites: number;
  /** Per place, where it stands. */
  readonly at: Float64Array;
  /** Per triangle, its three places. */
  readonly corners: Int32Array;
  readonly triangles: number;
  /** The triangles round each place: place s is a corner of `fan[fanStart[s] .. fanStart[s + 1])`. */
  readonly fanStart: Int32Array;
  readonly fan: Int32Array;
  /** Per place: the surface it stands for, and the sum of its triangles' normals by their areas. */
  readonly area: Float64Array;
  readonly normal: Float64Array;
  /** A row per place: its neighbours, and how well the edge to each conducts. */
  readonly rowStart: Int32Array;
  readonly column: Int32Array;
  readonly conductance: Float64Array;
  /** Per place, its piece; and the places piece by piece: piece k is `order[pieceStart[k] ..)`. */
  readonly pieceOf: Int32Array;
  readonly order: Int32Array;
  readonly pieceStart: readonly number[];
  readonly pieces: number;
  /** Per piece: +1 as stored, −1 for a closed piece made inside out. */
  readonly facing: Int8Array;
}

/** `mesh` as a {@link Surface}, or `null` when it has no face with three corners apart. */
function surfaceOf(mesh: VoxelMesh): Surface | null {
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

  // ── Places: points at the very same position are one. ──────────────────────────────────────
  const siteOf = new Int32Array(count);
  let sites = 0;
  {
    const exact = new Float32Array(points.length);
    // Adding zero turns −0 into 0, so the two spellings of zero are one position.
    for (let i = 0; i < points.length; i++) exact[i] = points[i] + 0;
    const bits = new Int32Array(exact.buffer);
    let size = 1;
    while (size < count * 2) size *= 2;
    const table = new Int32Array(size).fill(-1);
    for (let p = 0; p < count; p++) {
      const x = bits[p * 3];
      const y = bits[p * 3 + 1];
      const z = bits[p * 3 + 2];
      let slot =
        (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
      for (;;) {
        const first = table[slot];
        if (first < 0) {
          table[slot] = p;
          siteOf[p] = sites++;
          break;
        }
        if (bits[first * 3] === x && bits[first * 3 + 1] === y && bits[first * 3 + 2] === z) {
          siteOf[p] = siteOf[first];
          break;
        }
        slot = (slot + 1) & (size - 1);
      }
    }
  }
  const at = new Float64Array(sites * 3);
  for (let p = 0; p < count; p++) {
    const s = siteOf[p] * 3;
    at[s] = points[p * 3];
    at[s + 1] = points[p * 3 + 1];
    at[s + 2] = points[p * 3 + 2];
  }

  // ── Triangles between places: every face as a fan from its first corner. ───────────────────
  let fans = 0;
  for (let f = 0; f < faceSizes.length; f++) fans += Math.max(0, faceSizes[f] - 2);
  const corners = new Int32Array(fans * 3);
  let triangles = 0;
  {
    let corner = 0;
    for (let f = 0; f < faceSizes.length; f++) {
      const n = faceSizes[f];
      const a = siteOf[cornerPoints[corner]];
      for (let k = 1; k + 1 < n; k++) {
        const b = siteOf[cornerPoints[corner + k]];
        const c = siteOf[cornerPoints[corner + k + 1]];
        // A triangle with two corners at one place has no inside and joins nothing new.
        if (a === b || b === c || c === a) continue;
        corners[triangles * 3] = a;
        corners[triangles * 3 + 1] = b;
        corners[triangles * 3 + 2] = c;
        triangles++;
      }
      corner += n;
    }
  }
  if (triangles === 0) return null;
  // The triangles round each place: place s is a corner of `fan[fanStart[s] .. fanStart[s + 1])`.
  const fanStart = new Int32Array(sites + 1);
  for (let t = 0; t < triangles * 3; t++) fanStart[corners[t] + 1]++;
  for (let s = 0; s < sites; s++) fanStart[s + 1] += fanStart[s];
  const fan = new Int32Array(triangles * 3);
  {
    const fill = fanStart.slice(0, sites);
    for (let t = 0; t < triangles * 3; t++) fan[fill[corners[t]]++] = (t / 3) | 0;
  }

  // ── How well each edge conducts, and how much surface each place stands for. ───────────────
  // A row per place: its neighbours and the conductance of the edge to each. Built with every
  // triangle adding its three edges to both ends, then each row's repeats added together.
  const area = new Float64Array(sites);
  const normal = new Float64Array(sites * 3);
  const rowStart = new Int32Array(sites + 1);
  for (let t = 0; t < triangles * 3; t++) rowStart[corners[t] + 1] += 2;
  for (let s = 0; s < sites; s++) rowStart[s + 1] += rowStart[s];
  const fill = rowStart.slice(0, sites);
  let column = new Int32Array(triangles * 6);
  let conductance = new Float64Array(triangles * 6);
  for (let t = 0; t < triangles; t++) {
    const i = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
    const x = [at[i[0] * 3], at[i[1] * 3], at[i[2] * 3]];
    const y = [at[i[0] * 3 + 1], at[i[1] * 3 + 1], at[i[2] * 3 + 1]];
    const z = [at[i[0] * 3 + 2], at[i[1] * 3 + 2], at[i[2] * 3 + 2]];
    const ux = x[1] - x[0];
    const uy = y[1] - y[0];
    const uz = z[1] - z[0];
    const vx = x[2] - x[0];
    const vy = y[2] - y[0];
    const vz = z[2] - z[0];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const twice = Math.hypot(cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      normal[i[k] * 3] += cx;
      normal[i[k] * 3 + 1] += cy;
      normal[i[k] * 3 + 2] += cz;
    }
    for (let k = 0; k < 3; k++) {
      area[i[k]] += twice / 6;
      // The edge opposite corner k conducts by half the cotangent of the angle at k.
      const a = (k + 1) % 3;
      const b = (k + 2) % 3;
      const dot =
        (x[a] - x[k]) * (x[b] - x[k]) +
        (y[a] - y[k]) * (y[b] - y[k]) +
        (z[a] - z[k]) * (z[b] - z[k]);
      const half = twice > 0 ? (0.5 * dot) / twice : 0;
      column[fill[i[a]]] = i[b];
      conductance[fill[i[a]]++] = half;
      column[fill[i[b]]] = i[a];
      conductance[fill[i[b]]++] = half;
    }
  }
  // A place on an edge only one triangle uses: its piece has a rim, and is not closed.
  const onRim = new Uint8Array(sites);
  {
    // Each row sorted by neighbour, repeats added, and the whole packed down.
    let write = 0;
    let read = 0;
    for (let s = 0; s < sites; s++) {
      const end = rowStart[s + 1];
      for (let k = read + 1; k < end; k++) {
        const c = column[k];
        const w = conductance[k];
        let j = k;
        for (; j > read && column[j - 1] > c; j--) {
          column[j] = column[j - 1];
          conductance[j] = conductance[j - 1];
        }
        column[j] = c;
        conductance[j] = w;
      }
      rowStart[s] = write;
      for (let k = read; k < end; ) {
        const c = column[k];
        const from = k;
        let w = 0;
        for (; k < end && column[k] === c; k++) w += conductance[k];
        if (k - from === 1) onRim[s] = 1;
        column[write] = c;
        conductance[write++] = Math.max(w, MIN_CONDUCTANCE);
      }
      read = end;
    }
    rowStart[sites] = write;
    column = column.slice(0, write);
    conductance = conductance.slice(0, write);
  }

  // ── Pieces: the places an unbroken run of edges joins. ─────────────────────────────────────
  // Heat never passes from one piece to another, so each is its own problem. `order` lists the
  // places piece by piece; piece k is `order[pieceStart[k] .. pieceStart[k + 1])`.
  const pieceOf = new Int32Array(sites).fill(-1);
  const order = new Int32Array(sites);
  const pieceStart: number[] = [];
  {
    let tail = 0;
    for (let s = 0; s < sites; s++) {
      if (pieceOf[s] >= 0) continue;
      let head = tail;
      pieceOf[s] = pieceStart.length;
      pieceStart.push(tail);
      order[tail++] = s;
      while (head < tail) {
        const i = order[head++];
        for (let k = rowStart[i]; k < rowStart[i + 1]; k++) {
          const j = column[k];
          if (pieceOf[j] >= 0) continue;
          pieceOf[j] = pieceOf[s];
          order[tail++] = j;
        }
      }
    }
    pieceStart.push(tail);
  }
  const pieces = pieceStart.length - 1;

  // Which way each piece's faces look. A CLOSED piece encloses a volume, and its sign says it: a
  // piece made inside out (a mirrored part) is read the other way round. A piece with a rim has no
  // volume to ask, and is taken as it is stored.
  const facing = new Int8Array(pieces).fill(1);
  {
    const volume = new Float64Array(pieces);
    const rimmed = new Uint8Array(pieces);
    for (let s = 0; s < sites; s++) {
      const k = pieceOf[s];
      if (onRim[s]) rimmed[k] = 1;
      // A place's normal is the sum over its triangles of twice each one's area along its normal,
      // so over a closed piece this adds up to eighteen times the volume inside, signed.
      volume[k] +=
        at[s * 3] * normal[s * 3] +
        at[s * 3 + 1] * normal[s * 3 + 1] +
        at[s * 3 + 2] * normal[s * 3 + 2];
    }
    for (let k = 0; k < pieces; k++) if (!rimmed[k] && volume[k] < 0) facing[k] = -1;
  }

  return {
    count,
    lo,
    hi,
    extent,
    siteOf,
    sites,
    at,
    corners,
    triangles,
    fanStart,
    fan,
    area,
    normal,
    rowStart,
    column,
    conductance,
    pieceOf,
    order,
    pieceStart,
    pieces,
    facing,
  };
}

/**
 * How much work binding `mesh` to `bones` bones by heat may be, and the size of the piece that
 * decides it; `null` when the mesh has no surface.
 *
 * A bone's heat is found over a whole piece by a search that takes about two steps for every
 * place across the piece, each step visiting every place: the places of the piece to the power one
 * and a half. Measured on tubes of one piece with 20 bones (Node on this machine, 2026-10-12):
 * 3,200 points 0.11 s; 12,800, 0.68 s; 38,400, 3.9 s; 102,400, 20 s; 199,680, 54 s — 24 billionths
 * of a second for each unit of this number. The count here takes every bone to heat the largest
 * piece, which is the most it can be.
 */
export function heatLoad(
  mesh: VoxelMesh,
  bones: number,
): { readonly work: number; readonly largest: number } | null {
  const surface = surfaceOf(mesh);
  if (surface === null) return null;
  let largest = 0;
  for (let k = 0; k < surface.pieces; k++) {
    largest = Math.max(largest, surface.pieceStart[k + 1] - surface.pieceStart[k]);
  }
  return { work: bones * Math.pow(largest, 1.5), largest };
}

/**
 * The most {@link heatLoad} a capture is let run at: about ten seconds here. Past it the app would
 * stand frozen, since a capture runs where its node is evaluated.
 */
export const HEAT_WORK_LIMIT = 4e8;

/**
 * Bind every point of `mesh` to the bones whose heat reaches it over the surface, or `null` when
 * the mesh has no face with three corners apart.
 */
export function captureByHeat(
  mesh: VoxelMesh,
  bones: readonly CaptureBone[],
  options: HeatCaptureOptions,
): HeatCapturedWeights | null {
  const surface = surfaceOf(mesh);
  if (surface === null) return null;
  const {
    count,
    lo,
    hi,
    extent,
    siteOf,
    sites,
    at,
    corners,
    triangles,
    fanStart,
    fan,
    area,
    normal,
    rowStart,
    column,
    conductance,
    pieceOf,
    order,
    pieceStart,
    pieces,
    facing,
  } = surface;

  // ── Triangles by the cell they pass through, to find what a line of sight crosses. ─────────
  const cells = Math.min(128, Math.max(4, Math.ceil(Math.sqrt(triangles))));
  const cell = extent / cells;
  const dims = [0, 0, 0];
  for (let a = 0; a < 3; a++) dims[a] = Math.floor((hi[a] - lo[a]) / cell) + 1;
  const [nx, ny, nz] = dims;
  const cellStart = new Int32Array(nx * ny * nz + 1);
  const range = new Int32Array(6);
  const rangeOf = (t: number): void => {
    for (let a = 0; a < 3; a++) {
      const p = at[corners[t * 3] * 3 + a];
      const q = at[corners[t * 3 + 1] * 3 + a];
      const r = at[corners[t * 3 + 2] * 3 + a];
      range[a] = Math.floor((Math.min(p, q, r) - lo[a]) / cell);
      range[3 + a] = Math.floor((Math.max(p, q, r) - lo[a]) / cell);
    }
  };
  for (let t = 0; t < triangles; t++) {
    rangeOf(t);
    for (let z = range[2]; z <= range[5]; z++)
      for (let y = range[1]; y <= range[4]; y++)
        for (let x = range[0]; x <= range[3]; x++) cellStart[x + nx * (y + ny * z) + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) cellStart[c + 1] += cellStart[c];
  const cellFill = cellStart.slice(0, nx * ny * nz);
  const cellTriangles = new Int32Array(cellStart[nx * ny * nz]);
  for (let t = 0; t < triangles; t++) {
    rangeOf(t);
    for (let z = range[2]; z <= range[5]; z++)
      for (let y = range[1]; y <= range[4]; y++)
        for (let x = range[0]; x <= range[3]; x++)
          cellTriangles[cellFill[x + nx * (y + ny * z)]++] = t;
  }

  /** Does the straight line from place `from` to `(ex, ey, ez)` cross its own piece on the way? */
  const crossesOwnPiece = (from: number, ex: number, ey: number, ez: number): boolean => {
    const piece = pieceOf[from];
    const sx = at[from * 3];
    const sy = at[from * 3 + 1];
    const sz = at[from * 3 + 2];
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const start = [(sx - lo[0]) / cell, (sy - lo[1]) / cell, (sz - lo[2]) / cell];
    const step = [dx / cell, dy / cell, dz / cell];
    const cellAt = [0, 0, 0];
    const next = [Infinity, Infinity, Infinity];
    const every = [Infinity, Infinity, Infinity];
    const way = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      cellAt[a] = Math.floor(start[a]);
      if (step[a] > 0) {
        way[a] = 1;
        every[a] = 1 / step[a];
        next[a] = (cellAt[a] + 1 - start[a]) / step[a];
      } else if (step[a] < 0) {
        way[a] = -1;
        every[a] = -1 / step[a];
        next[a] = (cellAt[a] - start[a]) / step[a];
      }
    }
    for (;;) {
      const c = cellAt[0] + nx * (cellAt[1] + ny * cellAt[2]);
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const t = cellTriangles[k] * 3;
        const a = corners[t];
        const b = corners[t + 1];
        const cc = corners[t + 2];
        // The triangles the place is a corner of are where the line starts, not what it crosses;
        // another piece's are another sheet.
        if (a === from || b === from || cc === from || pieceOf[a] !== piece) continue;
        const ax = at[a * 3];
        const ay = at[a * 3 + 1];
        const az = at[a * 3 + 2];
        const e1x = at[b * 3] - ax;
        const e1y = at[b * 3 + 1] - ay;
        const e1z = at[b * 3 + 2] - az;
        const e2x = at[cc * 3] - ax;
        const e2y = at[cc * 3 + 1] - ay;
        const e2z = at[cc * 3 + 2] - az;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0) continue;
        const tx = sx - ax;
        const ty = sy - ay;
        const tz = sz - az;
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < -ON_EDGE || u > 1 + ON_EDGE) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) / det;
        if (v < -ON_EDGE || u + v > 1 + ON_EDGE) continue;
        const along = (e2x * qx + e2y * qy + e2z * qz) / det;
        // Ahead of the place, and short of the bone.
        if (along > 0 && along < 1) return true;
      }
      const a = next[0] <= next[1] ? (next[0] <= next[2] ? 0 : 2) : next[1] <= next[2] ? 1 : 2;
      if (next[a] >= 1) return false;
      cellAt[a] += way[a];
      if (cellAt[a] < 0 || cellAt[a] >= dims[a]) return false;
      next[a] += every[a];
    }
  };

  // ── Which bone heats each place, and how strongly. ─────────────────────────────────────────
  const nearestBone = new Int32Array(sites).fill(-1);
  const heat = new Float64Array(sites);
  // One entry per (place, bone that heats it): a place with several equally near bones has several.
  const heatedPlace: number[] = [];
  const heatedBone: number[] = [];
  const heatedBy: number[] = [];
  const distances = new Float64Array(bones.length);
  const floor = extent * 1e-6;
  /**
   * Give place `s` its heat, when its nearest bone is in sight of it from inside. With
   * `throughOwnWall`, when that bone lies behind it, whatever of the place's own piece is between.
   */
  const heatPlace = (s: number, throughOwnWall: boolean): boolean => {
    const px = at[s * 3];
    const py = at[s * 3 + 1];
    const pz = at[s * 3 + 2];
    let nearest = Infinity;
    for (let b = 0; b < bones.length; b++) {
      const d = distanceToSegment(px, py, pz, bones[b]);
      distances[b] = d;
      if (d < nearest) {
        nearest = d;
        nearestBone[s] = b;
      }
    }
    // A place that stands for no surface (it is on no face with any area) has no heat to take.
    if (area[s] === 0) return false;
    const nx0 = normal[s * 3];
    const ny0 = normal[s * 3 + 1];
    const nz0 = normal[s * 3 + 2];
    const front = facing[pieceOf[s]];
    /** Is bone `b` in sight of this place from inside? */
    const sees = (b: number): boolean => {
      // A place on the bone itself has no line to check.
      if (distances[b] <= floor) return true;
      const bone = bones[b];
      const ax = bone.tail[0] - bone.head[0];
      const ay = bone.tail[1] - bone.head[1];
      const az = bone.tail[2] - bone.head[2];
      const length2 = ax * ax + ay * ay + az * az;
      const along =
        length2 > 0
          ? Math.min(
              1,
              Math.max(
                0,
                (ax * (px - bone.head[0]) + ay * (py - bone.head[1]) + az * (pz - bone.head[2])) /
                  length2,
              ),
            )
          : 0;
      const ex = bone.head[0] + ax * along;
      const ey = bone.head[1] + ay * along;
      const ez = bone.head[2] + az * along;
      const dx = ex - px;
      const dy = ey - py;
      const dz = ez - pz;
      // The line must set off INTO the body. Seen along the place's own normal, the triangles
      // round it are the sectors of a fan; the line sets off over exactly one of them, and into
      // the body when it goes under that triangle's face. (On a rim the fan is not all the way
      // round, and a line over the gap is judged by the place's normal.)
      let under = (dx * nx0 + dy * ny0 + dz * nz0) * front < 0;
      for (let k = fanStart[s]; k < fanStart[s + 1]; k++) {
        const t = fan[k] * 3;
        // The triangle's other two corners, in its own order round from this place.
        const turn = corners[t] === s ? 0 : corners[t + 1] === s ? 1 : 2;
        const i = corners[t + ((turn + 1) % 3)] * 3;
        const j = corners[t + ((turn + 2) % 3)] * 3;
        const ux = at[i] - px;
        const uy = at[i + 1] - py;
        const uz = at[i + 2] - pz;
        const vx = at[j] - px;
        const vy = at[j + 1] - py;
        const vz = at[j + 2] - pz;
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        // A triangle folded back under the place's normal is no sector of the fan.
        if (!(fx * nx0 + fy * ny0 + fz * nz0 > 0)) continue;
        const pastU =
          (uy * dz - uz * dy) * nx0 + (uz * dx - ux * dz) * ny0 + (ux * dy - uy * dx) * nz0;
        const beforeV =
          (dy * vz - dz * vy) * nx0 + (dz * vx - dx * vz) * ny0 + (dx * vy - dy * vx) * nz0;
        if (pastU < 0 || beforeV < 0) continue;
        under = (dx * fx + dy * fy + dz * fz) * front < 0;
        break;
      }
      return under && (throughOwnWall || !crossesOwnPiece(s, ex, ey, ez));
    };
    // Bones as near as the nearest (to one part in ten thousand) share the place between them.
    const d = Math.max(nearest, floor);
    const each = area[s] / (d * d);
    let seen = 0;
    for (let b = 0; b < bones.length; b++) {
      if (!(distances[b] <= nearest * (1 + TIE)) || !sees(b)) continue;
      heatedPlace.push(s);
      heatedBone.push(b);
      heatedBy.push(each);
      heat[s] += each;
      seen++;
    }
    return seen > 0;
  };
  let heated = 0;
  const heatedIn = new Int32Array(pieces);
  for (let s = 0; s < sites; s++) {
    if (!heatPlace(s, false)) continue;
    heated++;
    heatedIn[pieceOf[s]]++;
  }
  // A piece none of whose places has a bone in sight is a shell with its bones in the hollow, not
  // in its wall (a pelvis made as a thick band, the cap of a toe, an eye). A place of it is heated
  // by its nearest bone when that bone lies behind it, through the shell's own far wall; and its
  // points are counted: they are not bound by the measure the rest are.
  const blind = new Uint8Array(pieces);
  for (let k = 0; k < pieces; k++) {
    if (heatedIn[k] > 0) continue;
    blind[k] = 1;
    for (let i = pieceStart[k]; i < pieceStart[k + 1]; i++) heatPlace(order[i], true);
  }

  // ── The balance of heat, one bone at a time. ───────────────────────────────────────────────
  const diagonal = new Float64Array(sites);
  for (let s = 0; s < sites; s++) {
    let sum = heat[s];
    for (let k = rowStart[s]; k < rowStart[s + 1]; k++) sum += conductance[k];
    diagonal[s] = sum;
  }
  const kept = Math.max(1, Math.min(Math.floor(options.maxInfluences), bones.length));
  const width = Math.max(1, Math.ceil(kept / SKIN_SET_WIDTH)) * SKIN_SET_WIDTH;
  // Each place's `kept` hottest bones so far, hottest first, and how many it has.
  const keptBone = new Int32Array(sites * kept);
  const keptHeat = new Float32Array(sites * kept);
  const found = new Uint8Array(sites);

  const entriesOf: number[][] = bones.map(() => []);
  for (let e = 0; e < heatedPlace.length; e++) entriesOf[heatedBone[e]].push(e);

  const x = new Float64Array(sites);
  const r = new Float64Array(sites);
  const z = new Float64Array(sites);
  const p = new Float64Array(sites);
  const q = new Float64Array(sites);
  const active = new Int32Array(sites);
  const inPlay = new Uint8Array(pieces);
  let steps = 0;
  let unsettled = 0;
  bones.forEach((_, b) => {
    const entries = entriesOf[b];
    if (entries.length === 0) return;
    // Only the pieces this bone heats: everywhere else its heat is exactly nothing.
    inPlay.fill(0);
    for (const e of entries) inPlay[pieceOf[heatedPlace[e]]] = 1;
    let n = 0;
    for (let k = 0; k < pieces; k++) {
      if (!inPlay[k]) continue;
      for (let i = pieceStart[k]; i < pieceStart[k + 1]; i++) active[n++] = order[i];
    }
    for (let i = 0; i < n; i++) {
      x[active[i]] = 0;
      r[active[i]] = 0;
    }
    for (const e of entries) r[heatedPlace[e]] += heatedBy[e];
    let rz = 0;
    let target = 0;
    for (let i = 0; i < n; i++) {
      const s = active[i];
      target += r[s] * r[s];
      z[s] = r[s] / diagonal[s];
      p[s] = z[s];
      rz += r[s] * z[s];
    }
    target *= TOLERANCE * TOLERANCE;
    // Conjugate gradients, each place scaled by its own diagonal.
    const limit = Math.max(100, 4 * n);
    let settled = false;
    for (let step = 0; step < limit; step++) {
      steps++;
      let pq = 0;
      for (let i = 0; i < n; i++) {
        const s = active[i];
        let sum = diagonal[s] * p[s];
        for (let k = rowStart[s]; k < rowStart[s + 1]; k++) sum -= conductance[k] * p[column[k]];
        q[s] = sum;
        pq += p[s] * sum;
      }
      const alpha = rz / pq;
      let left = 0;
      for (let i = 0; i < n; i++) {
        const s = active[i];
        x[s] += alpha * p[s];
        r[s] -= alpha * q[s];
        left += r[s] * r[s];
      }
      if (left <= target) {
        settled = true;
        break;
      }
      let rzNext = 0;
      for (let i = 0; i < n; i++) {
        const s = active[i];
        z[s] = r[s] / diagonal[s];
        rzNext += r[s] * z[s];
      }
      const beta = rzNext / rz;
      rz = rzNext;
      for (let i = 0; i < n; i++) p[active[i]] = z[active[i]] + beta * p[active[i]];
    }
    if (!settled) unsettled++;

    for (let i = 0; i < n; i++) {
      const s = active[i];
      const w = x[s];
      if (!(w > 0)) continue;
      const base = s * kept;
      const have = found[s];
      // Strictly hotter moves ahead, so equally hot bones stay in bone order.
      let slot = have;
      while (slot > 0 && w > keptHeat[base + slot - 1]) slot--;
      if (slot >= kept) continue;
      for (let k = Math.min(have, kept - 1); k > slot; k--) {
        keptBone[base + k] = keptBone[base + k - 1];
        keptHeat[base + k] = keptHeat[base + k - 1];
      }
      keptBone[base + slot] = b;
      keptHeat[base + slot] = w;
      if (have < kept) found[s] = have + 1;
    }
  });

  // ── Heat to weight. ────────────────────────────────────────────────────────────────────────
  const joints = new Int32Array(count * width);
  const weights = new Float32Array(count * width);
  let unbound = 0;
  let unreached = 0;
  const holds = new Uint8Array(bones.length);
  for (let point = 0; point < count; point++) {
    const s = siteOf[point];
    const have = found[s];
    if (have === 0) {
      // No heat reaches this place at all: its nearest bone in a straight line.
      if (nearestBone[s] < 0) {
        unbound++;
        continue;
      }
      unreached++;
      joints[point * width] = nearestBone[s];
      weights[point * width] = 1;
      holds[nearestBone[s]] = 1;
      continue;
    }
    if (blind[pieceOf[s]]) unreached++;
    let total = 0;
    for (let k = 0; k < have; k++) total += keptHeat[s * kept + k];
    for (let k = 0; k < have; k++) {
      joints[point * width + k] = keptBone[s * kept + k];
      weights[point * width + k] = keptHeat[s * kept + k] / total;
      holds[keptBone[s * kept + k]] = 1;
    }
  }
  const outside = bones.filter((_, b) => !holds[b]).map((bone) => bone.name);

  return {
    lanes: { width, joints, weights },
    vertexGroups: bones.map((b) => b.name),
    unbound,
    unreached,
    outside,
    sites,
    pieces,
    heated,
    steps,
    unsettled,
  };
}
