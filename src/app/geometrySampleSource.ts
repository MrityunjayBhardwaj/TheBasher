// geometrySampleSource — the driver-resolution seam for the SampleGeometry road
// (#300 follow-up). The twin of transformChannelSource.ts, for GEOMETRY instead of a
// transform channel: given a ParamDriver whose `inVec` is wired to a SampleGeometry
// node, compute the ground point under the query controller's world XZ and hand it to
// the driver as a Vec3. Owns the parse + per-frame world read in ONE place so the
// direct driver road (paramDrivers.ts) and any future replay call the same seam.
//
// WHY here (not in the node's pure evaluate): the read needs the terrain's WORLD-space
// triangles — the geometry registry (`get`) AND the terrain's world matrix
// (`resolveWorldTransform`), both of which need `state`. That is the same reason the
// transform driver overlay and the stateful replay both live in the seam, not in the
// pure evaluator (evaluator.ts:167). Reading it here (the seam has `state`) keeps the
// node pure and render == read under scrub (H40) by construction — the value folds
// through the SAME `makeParamDriverVec3ChannelValue` a position keyframe rides.
//
// Terrain kinds: box/sphere/array/mirror build sync from the registry, and a baked mesh
// hits once its render primes the registry. A `gltf` terrain has no registry geometry (it
// lives only in the loaded three.js clone), so we read its world triangles from the SAME
// production-safe clone the renderer mounts (`getGltfClone`, like `resolveMeshUVs`) — see
// `gltfTerrainMeshes`. Only an UN-LOADED gltf / UN-primed baked mesh yields no geometry;
// then the sample falls back to the query controller's own position (the object tracks the
// Null in 3D, un-snapped) — a surfaced KNOWN LIMIT, not a silent no-op.
//
// REF: src/app/rayMesh.ts (the pure ray/nearest core); src/app/transformChannelSource.ts (the
//      pattern); src/app/resolveWorldTransform.ts + geometryRegistry.ts (world geometry).

import { Matrix4 } from 'three';
import type { Mesh, Object3D } from 'three';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Node } from '../core/dag/types';
import { get as getGeometry } from './geometryRegistry';
import { getGltfClone } from './asset/gltfCloneRegistry';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { resolveWorldTransform } from './resolveWorldTransform';
import { nearestPointOnMesh, raycastMesh, type RayHit, type RayOrientation } from './rayMesh';

type Vec3 = [number, number, number];

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** The single {node, socket} ref wired to a node's `socket`, or null. Carries the SOURCE
 *  socket so a consumer knows WHICH SampleGeometry output ('out' point / 'normal') it reads. */
function singleInputRef(node: NodeLike, socket: string): { node: string; socket: string } | null {
  const b = node.inputs?.[socket];
  if (!b) return null;
  const ref = (Array.isArray(b) ? b[0] : b) as { node?: unknown; socket?: unknown } | undefined;
  if (!ref || typeof ref.node !== 'string' || !ref.node) return null;
  return { node: ref.node, socket: typeof ref.socket === 'string' ? ref.socket : 'out' };
}

export interface GeometrySampleRef {
  /** The terrain mesh node id. */
  geometry: string;
  /** The query controller node id (its world position), or null. */
  at: string | null;
  /** Ray SOP Method: cast a ray ('project') or return the nearest surface point ('nearest'). */
  method: 'project' | 'nearest';
  /** The ray direction for 'project'. */
  direction: Vec3;
  /** Ray SOP Direction Type for 'project'. */
  orientation: RayOrientation;
  /** Ray SOP Intersect-Farthest-Surface for 'project'. */
  farthest: boolean;
}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');

/** The parsed config carried by a SampleGeometry node's params — a valid terrain id plus
 *  the query controller and the Ray-op mode (method/direction/orientation/farthest, with
 *  Ray-SOP defaults). Null when the node is not a configured SampleGeometry. */
export function geometrySampleRefOf(node: NodeLike): GeometrySampleRef | null {
  if (node.type !== 'SampleGeometry') return null;
  const p = (node.params ?? {}) as {
    sourceGeometry?: { node?: unknown };
    at?: { node?: unknown };
    method?: unknown;
    direction?: unknown;
    orientation?: unknown;
    farthest?: unknown;
  };
  const geometry = p.sourceGeometry?.node;
  if (typeof geometry !== 'string' || !geometry) return null;
  const at = typeof p.at?.node === 'string' && p.at.node ? p.at.node : null;
  return {
    geometry,
    at,
    method: p.method === 'nearest' ? 'nearest' : 'project',
    direction: isVec3(p.direction) ? p.direction : [0, -1, 0],
    orientation:
      p.orientation === 'reverse' || p.orientation === 'both' ? p.orientation : 'forward',
    farthest: p.farthest === true,
  };
}

/** The SampleGeometry node wired to a driver's `inVec` + the output socket the driver
 *  reads ('out' = ground point, 'normal' = surface normal), or null. Mirrors
 *  `statefulSourceOf`: the driver names its source through a real wired edge, so the
 *  cycle guard + subscription input-walk already see the driver→SampleGeometry hop. */
export function geometrySampleSourceOf(
  driverNode: NodeLike,
  state: DagState,
): { node: Node; socket: string } | null {
  // A vec target reads `out`/`normal` via `inVec`; a scalar target reads `distance` via `in`.
  const ref = singleInputRef(driverNode, 'inVec') ?? singleInputRef(driverNode, 'in');
  if (!ref) return null;
  const src = state.nodes[ref.node];
  return src && src.type === 'SampleGeometry' ? { node: src as Node, socket: ref.socket } : null;
}

/** One collision mesh in world space: local triangles + the world matrix to apply. */
interface TerrainMesh {
  positions: ArrayLike<number>;
  index: ArrayLike<number> | null;
  matrix: ArrayLike<number>;
}

/**
 * World-space collision meshes for a glTF terrain node, or [] when it is not a loaded,
 * mounted glTF (the async asset hasn't loaded yet, or the node isn't glTF at all). The
 * registry can't build a `gltf` geometry synchronously — the geometry lives only in the
 * loaded three.js clone — so we read it from the SAME production-safe clone the renderer
 * mounts (`getGltfClone`, as `resolveMeshUVs`/`resolveMeshTexture` already do), which makes
 * render == read by construction. Each mesh's transform is composed as
 * `nodeWorld · (cloneRoot⁻¹ · meshWorld)`: the parenthesised part is the mesh's pose
 * RELATIVE to the clone root, so wherever the clone happens to be mounted cancels out —
 * keeping the read render-independent (mirrors the procedural path's use of
 * `resolveWorldTransform` for the world matrix). Multi-mesh glTFs yield one entry per mesh.
 */
function gltfTerrainMeshes(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): TerrainMesh[] {
  const node = state.nodes[nodeId];
  const p = (node?.params ?? {}) as { assetRef?: unknown; childName?: unknown };
  if (typeof p.assetRef !== 'string' || !p.assetRef) return [];
  const clone = getGltfClone(p.assetRef);
  if (!clone) return [];
  const root: Object3D | null =
    typeof p.childName === 'string' && p.childName
      ? (clone.getObjectByName(p.childName) ?? null)
      : clone;
  if (!root) return [];

  const nodeWorld = new Matrix4().fromArray(
    (resolveWorldTransform(state, nodeId, ctx, cache)?.matrix ?? IDENTITY16) as number[],
  );
  const cloneRootInv = new Matrix4().copy(clone.matrixWorld).invert();
  const meshes: TerrainMesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    const posAttr = m.geometry.getAttribute('position');
    if (!posAttr) return;
    // mesh-relative-to-clone-root (mount cancels) → then under the DAG node's world.
    const relative = new Matrix4().multiplyMatrices(cloneRootInv, m.matrixWorld);
    const world = new Matrix4().multiplyMatrices(nodeWorld, relative);
    const index = m.geometry.getIndex();
    meshes.push({
      positions: posAttr.array as ArrayLike<number>,
      index: index ? (index.array as ArrayLike<number>) : null,
      matrix: world.elements,
    });
  });
  return meshes;
}

/**
 * The Ray-op hit for the query at `ctx` — the surface point/normal/distance the driver
 * reads. Dispatches the node's Method: 'project' casts a ray (`raycastMesh`) from the query
 * position along `direction` (with orientation + farthest); 'nearest' returns the closest
 * surface point (`nearestPointOnMesh`). Collects the terrain's world-space meshes — one from
 * the registry for a procedural/baked-primed mesh, or one per mesh from the loaded clone for
 * a glTF terrain — and samples each, keeping the best hit (min distance; max for
 * project+farthest). The `sample` is null when a projected ray misses OR the terrain has no
 * readable geometry (an un-loaded glTF / un-primed baked mesh); on a miss the `point` falls
 * back to the query's own world position (the object tracks the query un-snapped rather than
 * jumping to the origin). This is the ONE per-frame read the driver road calls.
 */
export function readTerrainSampleAt(
  state: DagState,
  ref: GeometrySampleRef,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): { point: Vec3; sample: RayHit | null } {
  const atPos: Vec3 = ref.at
    ? (resolveWorldTransform(state, ref.at, ctx, cache)?.position ?? [0, 0, 0])
    : [0, 0, 0];

  // Procedural / baked-primed terrain builds sync from the registry (one mesh); a glTF
  // terrain reads its meshes from the loaded clone (empty when not yet loaded → un-snapped).
  const mesh = resolveEvaluatedMesh(state, ref.geometry, ctx, cache);
  const buf = mesh ? getGeometry(mesh.geometry) : null;
  const posAttr = buf?.getAttribute('position');
  let meshes: TerrainMesh[];
  if (posAttr) {
    const index = buf!.getIndex();
    meshes = [
      {
        positions: posAttr.array as ArrayLike<number>,
        index: index ? (index.array as ArrayLike<number>) : null,
        matrix: resolveWorldTransform(state, ref.geometry, ctx, cache)?.matrix ?? IDENTITY16,
      },
    ];
  } else {
    meshes = gltfTerrainMeshes(state, ref.geometry, ctx, cache);
  }

  let sample: RayHit | null = null;
  for (const gm of meshes) {
    const hit =
      ref.method === 'nearest'
        ? nearestPointOnMesh(gm.positions, gm.index, gm.matrix, atPos)
        : raycastMesh(gm.positions, gm.index, gm.matrix, atPos, ref.direction, {
            orientation: ref.orientation,
            farthest: ref.farthest,
          });
    if (!hit) continue;
    // Best across meshes: farthest-surface keeps the max distance, everything else the min.
    if (
      !sample ||
      (ref.method === 'project' && ref.farthest
        ? hit.distance > sample.distance
        : hit.distance < sample.distance)
    )
      sample = hit;
  }
  return { point: sample ? sample.point : atPos, sample };
}
