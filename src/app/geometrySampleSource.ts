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
// v1 scope: box/sphere/array/mirror terrain (the registry builds these sync). A `gltf`
// or `baked` terrain returns null from the registry → the sample falls back to the
// query controller's own position (the object tracks the Null in 3D, un-snapped) — a
// surfaced KNOWN LIMIT, not a silent no-op.
//
// REF: src/app/sampleTerrain.ts (the pure core); src/app/transformChannelSource.ts (the
//      pattern); src/app/resolveWorldTransform.ts + geometryRegistry.ts (world geometry).

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Node } from '../core/dag/types';
import { get as getGeometry } from './geometryRegistry';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { resolveWorldTransform } from './resolveWorldTransform';
import { sampleTerrainHeight, type TerrainSample } from './sampleTerrain';

type Vec3 = [number, number, number];

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** The single {node, socket} ref wired to a node's `socket`, or null. */
function singleInputRef(node: NodeLike, socket: string): { node: string } | null {
  const b = node.inputs?.[socket];
  if (!b) return null;
  const ref = (Array.isArray(b) ? b[0] : b) as { node?: unknown } | undefined;
  return ref && typeof ref.node === 'string' && ref.node ? { node: ref.node } : null;
}

export interface GeometrySampleRef {
  /** The terrain mesh node id. */
  geometry: string;
  /** The query controller node id (its world XZ), or null. */
  at: string | null;
}

/** The parsed refs carried by a SampleGeometry node's params — a valid terrain id plus
 *  the optional query controller. Null when the node is not a configured SampleGeometry. */
export function geometrySampleRefOf(node: NodeLike): GeometrySampleRef | null {
  if (node.type !== 'SampleGeometry') return null;
  const p = (node.params ?? {}) as {
    sourceGeometry?: { node?: unknown };
    at?: { node?: unknown };
  };
  const geometry = p.sourceGeometry?.node;
  if (typeof geometry !== 'string' || !geometry) return null;
  const at = typeof p.at?.node === 'string' && p.at.node ? p.at.node : null;
  return { geometry, at };
}

/** The SampleGeometry node wired to a driver's `inVec`, or null. Mirrors
 *  `statefulSourceOf`: the driver names its source through a real wired edge, so the
 *  cycle guard + subscription input-walk already see the driver→SampleGeometry hop. */
export function geometrySampleSourceOf(driverNode: NodeLike, state: DagState): Node | null {
  const srcId = singleInputRef(driverNode, 'inVec')?.node;
  if (!srcId) return null;
  const src = state.nodes[srcId];
  return src && src.type === 'SampleGeometry' ? (src as Node) : null;
}

/**
 * The world-space ground point under the query controller's XZ at `ctx`, plus the raw
 * sample (null when the ray misses the terrain footprint OR the terrain is a gltf/baked
 * mesh the registry can't build sync). On a miss the `point` falls back to the query
 * controller's own world position — the object tracks the Null un-snapped rather than
 * jumping to the origin. This is the ONE per-frame read the driver road calls.
 */
export function readTerrainSampleAt(
  state: DagState,
  ref: GeometrySampleRef,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): { point: Vec3; sample: TerrainSample | null } {
  const atPos: Vec3 = ref.at
    ? (resolveWorldTransform(state, ref.at, ctx, cache)?.position ?? [0, 0, 0])
    : [0, 0, 0];

  const mesh = resolveEvaluatedMesh(state, ref.geometry, ctx, cache);
  const buf = mesh ? getGeometry(mesh.geometry) : null;
  const posAttr = buf?.getAttribute('position');
  if (!posAttr) return { point: atPos, sample: null }; // gltf/baked/non-mesh → un-snapped

  const index = buf!.getIndex();
  const matrix = resolveWorldTransform(state, ref.geometry, ctx, cache)?.matrix ?? IDENTITY16;
  const sample = sampleTerrainHeight(
    posAttr.array as ArrayLike<number>,
    index ? (index.array as ArrayLike<number>) : null,
    matrix,
    atPos[0],
    atPos[2],
  );
  return { point: sample ? sample.point : atPos, sample };
}
