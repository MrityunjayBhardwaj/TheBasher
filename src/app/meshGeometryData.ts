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
// ── #1117 — CORNER LAYERS ARE A NAMED LIST, AND THE BUILD DRAWS THEM BY ORDER ─────────────────
//
// A stored mesh keeps its UV sets and colours as named, typed corner layers (`MeshCornerLayer`),
// saved one base64 string per layer, exactly as the fixed fields they replace were. The build
// writes each layer to the buffer slot three reads: the `float2` layers to `uv`, `uv1`, `uv2`,
// `uv3` in list order, and the one `float4` layer to `color`. `meshDataProblem` refuses a mesh that
// would need a slot three does not have, so nothing is held that would silently never draw.
//
// REF: src/nodes/types.ts (`MeshGeometryData`, `MeshCornerLayer`), src/app/polygonLayout.ts (the
//      check, the split layout and `fanToTriangles`); issues #1049, #1054, #1117, #628.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import type {
  GeometryRef,
  MeshCornerLayer,
  MeshCornerLayerType,
  MeshGeometryData,
} from '../nodes/types';
import { hashString } from '../core/dag/hash';
import {
  cornerLayerWidth,
  fanToTriangles,
  MAX_COLOUR_LAYERS,
  MAX_UV_LAYERS,
  meshSplitLayout,
  type PolygonRim,
} from './polygonLayout';

/** One corner layer as saved: its name, its type, and its values as one base64 string. */
export interface PackedCornerLayer {
  readonly name: string;
  readonly type: MeshCornerLayerType;
  readonly data: string;
}

/** The persisted form: one base64 string per array and per layer, `null` for absent normals. */
export interface PackedMeshData {
  readonly points: string;
  readonly faceSizes: string;
  readonly cornerPoints: string;
  readonly cornerLayers: readonly PackedCornerLayer[];
  readonly cornerNormals: string | null;
}

function isPackedCornerLayer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.type === 'string' && typeof v.data === 'string';
}

/** Is this value a packed mesh? Recognised by SHAPE, so nothing that reads it asks who holds it. */
export function isPackedMeshData(value: unknown): value is PackedMeshData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.points === 'string' &&
    typeof v.faceSizes === 'string' &&
    typeof v.cornerPoints === 'string' &&
    Array.isArray(v.cornerLayers) &&
    v.cornerLayers.every(isPackedCornerLayer) &&
    (v.cornerNormals === null || typeof v.cornerNormals === 'string')
  );
}

/** The byte length a base64 string decodes to, without decoding it. */
function decodedBytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/**
 * A packed mesh's element counts and layer names, read off the string lengths alone.
 *
 * For surfaces that describe a mesh to a reader who cannot use its bytes — an agent above all,
 * where megabytes of base64 would cost the context window and say nothing.
 */
export function packedMeshSummary(packed: PackedMeshData): {
  readonly points: number;
  readonly faces: number;
  readonly corners: number;
  readonly layers: readonly { readonly name: string; readonly type: MeshCornerLayerType }[];
  readonly normals: boolean;
} {
  return {
    points: decodedBytes(packed.points) / 12,
    faces: decodedBytes(packed.faceSizes) / 4,
    corners: decodedBytes(packed.cornerPoints) / 4,
    layers: packed.cornerLayers.map(({ name, type }) => ({ name, type })),
    normals: packed.cornerNormals !== null,
  };
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
    cornerLayers: data.cornerLayers.map((layer) => ({
      name: layer.name,
      type: layer.type,
      data: toBase64(layer.data),
    })),
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
    cornerLayers: packed.cornerLayers.map((layer) => ({
      name: layer.name,
      type: layer.type,
      data: new Float32Array(fromBase64(layer.data)),
    })),
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
 * arrays, so it never disagrees with what the project saves. Each layer contributes its name and
 * type as well as its values: a renamed or retyped layer draws to a different slot, so it must not
 * share a built geometry with the old one.
 */
export function meshGeometryRef(packed: PackedMeshData): GeometryRef {
  const content = [
    packed.points,
    packed.faceSizes,
    packed.cornerPoints,
    packed.cornerLayers.length === 0
      ? '-'
      : packed.cornerLayers.map((l) => JSON.stringify([l.name, l.type, l.data])).join(','),
    packed.cornerNormals ?? '-',
  ].join('|');
  return {
    key: `mesh|${hashString(content)}`,
    descriptor: { kind: 'mesh', data: unpackMeshData(packed) },
  };
}

/**
 * The three.js buffer attribute each corner layer is drawn to, in list order (#1117): the `float2`
 * layers count up `uv`, `uv1`, `uv2`, `uv3`, and the `float4` layer is `color`.
 */
export function cornerLayerBufferNames(
  layers: readonly Pick<MeshCornerLayer, 'type'>[],
): readonly string[] {
  let uvs = 0;
  return layers.map((layer) => {
    switch (layer.type) {
      case 'float4':
        return 'color';
      case 'float2': {
        const name = uvs === 0 ? 'uv' : `uv${uvs}`;
        uvs++;
        return name;
      }
      default: {
        const unreachable: never = layer.type;
        throw new Error(`cornerLayerBufferNames: undeclared layer type ${String(unreachable)}`);
      }
    }
  });
}

/**
 * Every buffer slot a stored mesh's corner layers can be drawn to: the names
 * {@link cornerLayerBufferNames} gives the largest mesh the data check admits.
 *
 * For a reader that has to know which buffer attributes ARE corner layers without a mesh in hand —
 * a builder deciding what it cannot carry, above all. Derived rather than spelled, so it cannot
 * name a slot the build never writes, or miss one it does.
 */
export const CORNER_LAYER_SLOTS: readonly string[] = cornerLayerBufferNames([
  ...Array.from({ length: MAX_UV_LAYERS }, () => ({ type: 'float2' as const })),
  ...Array.from({ length: MAX_COLOUR_LAYERS }, () => ({ type: 'float4' as const })),
]);

export interface MeshGeometryBuild {
  readonly geometry: BufferGeometry;
  /** Each face's rim in the BUILT buffer's split numbering — `polygonLayoutOf`'s rims. */
  readonly splitRims: readonly PolygonRim[];
}

/**
 * Build the render buffer from the split layout: one vertex per distinct (point, layers, normal).
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
  const { points, cornerPoints, cornerLayers, cornerNormals } = data;
  const vertices = layout.vertexCorner.length;
  const positions = new Float32Array(vertices * 3);
  const layers = cornerLayers.map((layer) => {
    // `meshSplitLayout` has already refused a type with no width, so this is never null here.
    const width = cornerLayerWidth(layer.type)!;
    return { source: layer.data, width, out: new Float32Array(vertices * width) };
  });
  const normals = cornerNormals === null ? null : new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const corner = layout.vertexCorner[v];
    const point = cornerPoints[corner];
    positions.set(points.subarray(point * 3, point * 3 + 3), v * 3);
    for (const { source, width, out } of layers) {
      out.set(source.subarray(corner * width, corner * width + width), v * width);
    }
    if (normals !== null && cornerNormals !== null) {
      normals.set(cornerNormals.subarray(corner * 3, corner * 3 + 3), v * 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const names = cornerLayerBufferNames(cornerLayers);
  layers.forEach(({ width, out }, i) => {
    geometry.setAttribute(names[i], new Float32BufferAttribute(out, width));
  });
  geometry.setIndex(fanToTriangles(layout.splitRims));
  if (normals !== null) geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  return { geometry, splitRims: layout.splitRims };
}
