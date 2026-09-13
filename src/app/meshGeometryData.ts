// #1049 — a stored polygon mesh: how it is persisted, keyed and built into a render buffer.
//
// ── WHY THIS IS NOT WHERE THE LAYOUT LIVES ────────────────────────────────────────────────
//
// A stored mesh has one invariant every operation leans on: its corner arrays agree with its
// face sizes and cite points that exist. That check, and the layout derived from it, live in
// `polygonLayout.ts` (`meshDataProblem`, `meshSplitLayout`, `meshWeldedRims`), because the layout
// questions are asked from inside the count's leaf modules, which may import types and nothing
// else. This module holds the halves that need `three` and the hasher: the packed form the
// project saves, the content key, and the buffer. The build reads the SAME split layout the
// questions do, so a rim `polygonLayoutOf` states is by construction a rim of the drawn buffer.
//
// ── WHY PACKED, AND NOT JSON NUMBERS ──────────────────────────────────────────────────────
//
// Measured on a 65,024-triangle mesh (195,072 split vertices, the worst case): JSON number arrays
// are 10.19 MB and cost 76 ms to hash and 86 ms to schema-parse; base64 typed arrays are 6.59 MB,
// 11.6 ms to hash, 0.3 ms to parse, 3.6 ms to decode positions. For scale, Blender's `.blend` grows
// 7.46 MB for the same mesh. Hashing and parsing happen once per params object (the evaluator
// memoises the params hash by identity), but load parses every node, so the difference is paid by
// every project open.
//
// Byte order is the platform's. Every engine this app runs in is little-endian, and a big-endian
// reader would need a swap here and nowhere else.
//
// REF: src/nodes/types.ts (`MeshGeometryData`), src/app/polygonLayout.ts (the check, the split
//      layout and `fanToTriangles`); issues #1049, #1054, #628.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { GeometryRef, MeshGeometryData } from '../nodes/types';
import { hashString } from '../core/dag/hash';
import { fanToTriangles, meshSplitLayout, type PolygonRim } from './polygonLayout';

/** The persisted form: one base64 string per array, `null` for an absent corner attribute. */
export interface PackedMeshData {
  readonly points: string;
  readonly faceSizes: string;
  readonly cornerPoints: string;
  readonly cornerUVs: string | null;
  readonly cornerNormals: string | null;
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  // Chunked: spreading a multi-megabyte array into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function packMeshData(data: MeshGeometryData): PackedMeshData {
  return {
    points: toBase64(data.points),
    faceSizes: toBase64(data.faceSizes),
    cornerPoints: toBase64(data.cornerPoints),
    cornerUVs: data.cornerUVs === null ? null : toBase64(data.cornerUVs),
    cornerNormals: data.cornerNormals === null ? null : toBase64(data.cornerNormals),
  };
}

/**
 * Decoded once per packed object. The packed object is a node's params value, which the DAG
 * replaces rather than mutates on any edit, so its identity is a sound cache key and the decoded
 * arrays are shared by every evaluation of that node until it changes.
 */
const unpacked = new WeakMap<PackedMeshData, MeshGeometryData>();

export function unpackMeshData(packed: PackedMeshData): MeshGeometryData {
  const hit = unpacked.get(packed);
  if (hit !== undefined) return hit;
  const data: MeshGeometryData = {
    points: new Float32Array(fromBase64(packed.points)),
    faceSizes: new Uint32Array(fromBase64(packed.faceSizes)),
    cornerPoints: new Uint32Array(fromBase64(packed.cornerPoints)),
    cornerUVs: packed.cornerUVs === null ? null : new Float32Array(fromBase64(packed.cornerUVs)),
    cornerNormals:
      packed.cornerNormals === null ? null : new Float32Array(fromBase64(packed.cornerNormals)),
  };
  unpacked.set(packed, data);
  return data;
}

/**
 * The geometry handle for stored mesh data, keyed by CONTENT.
 *
 * Two nodes holding identical meshes share one built geometry, and any change to any array is a
 * different key. The key is taken over the packed strings, which are a lossless spelling of the
 * arrays, so it never disagrees with what the project saves.
 */
export function meshGeometryRef(packed: PackedMeshData): GeometryRef {
  const content = [
    packed.points,
    packed.faceSizes,
    packed.cornerPoints,
    packed.cornerUVs ?? '-',
    packed.cornerNormals ?? '-',
  ].join('|');
  return {
    key: `mesh|${hashString(content)}`,
    descriptor: { kind: 'mesh', data: unpackMeshData(packed) },
  };
}

export interface MeshGeometryBuild {
  readonly geometry: BufferGeometry;
  /** Each face's rim in the BUILT buffer's split numbering — `polygonLayoutOf`'s rims. */
  readonly splitRims: readonly PolygonRim[];
}

/**
 * Build the render buffer from the split layout: one vertex per distinct (point, uv, normal).
 *
 * Every attribute of a vertex is read from the corner that minted it, and a duplicate is written
 * at the position of the point it copies, so welding the built buffer by position returns the
 * stored points again (unless two stored points coincide, which the corner-based weld keeps
 * apart). Normals the mesh does not store are derived from the built buffer, smooth across each
 * split vertex, which is what three's loaders do for a primitive without them.
 *
 * Returns a FRESH geometry on every call: the registry owns caching and disposal by key.
 */
export function buildMeshGeometry(data: MeshGeometryData): MeshGeometryBuild {
  const layout = meshSplitLayout(data);
  const { points, cornerPoints, cornerUVs, cornerNormals } = data;
  const vertices = layout.vertexCorner.length;
  const positions = new Float32Array(vertices * 3);
  const uvs = cornerUVs === null ? null : new Float32Array(vertices * 2);
  const normals = cornerNormals === null ? null : new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const corner = layout.vertexCorner[v];
    const point = cornerPoints[corner];
    positions.set(points.subarray(point * 3, point * 3 + 3), v * 3);
    if (uvs !== null && cornerUVs !== null) {
      uvs.set(cornerUVs.subarray(corner * 2, corner * 2 + 2), v * 2);
    }
    if (normals !== null && cornerNormals !== null) {
      normals.set(cornerNormals.subarray(corner * 3, corner * 3 + 3), v * 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  if (uvs !== null) geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(fanToTriangles(layout.splitRims));
  if (normals !== null) geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  return { geometry, splitRims: layout.splitRims };
}
