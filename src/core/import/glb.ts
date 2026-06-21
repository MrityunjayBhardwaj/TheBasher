// GLB binary container parser — Phase 7.5 Wave D (issue #81).
//
// Inline, dependency-free reader for the glTF 2.0 GLB layout (spec
// §4.4). Pulls out the JSON chunk + the binary chunk so the import
// chain can walk `json.animations` + read accessors. NO mesh-data
// touched — Draco/KTX2 stay drei-lazy at render time (B12).
//
// Scope discipline (per CONTEXT.md + RESEARCH.md):
//   - Animation accessors: FLOAT32 (5126) + the four quantised integer
//     types (5120/5121/5122/5123, KHR_mesh_quantization) with spec
//     dequantisation when `normalized` is set (#89). UNSIGNED_INT (5125)
//     and unknown types throw.
//   - Multiple buffers (#90). `parseGlb` recovers the embedded BIN as
//     buffer 0; `resolveBuffers` then materialises the full
//     `buffers[]` array — embedded (no uri), inline data-URI (decoded
//     here, sync), or external relative `.bin` (fetched via an injected
//     async resolver, OPFS in production). `parseGltfJson` handles the
//     JSON-only `.gltf` container (no GLB magic / chunks). `readAccessor`
//     indexes `buffers[bufferView.buffer]`. NOTE: this is the IMPORTER's
//     own byte-level buffer resolution — a different path from #82's
//     renderer-side sentinel-URL sibling loader (`opfsGltfResolver`).
//
// GLB layout (little-endian):
//   header: 12 bytes — magic 'glTF' (0x46546C67) | version 2 | length
//   chunk 1: u32 length | u32 type | bytes (length aligned to 4)
//   chunk 2: same shape
//
// REF: glTF 2.0 spec §4.4; PLAN.md Wave D1.

import type { GltfJsonMaterial } from './gltfJsonMaterialToOpenpbr';

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GltfNode {
  name?: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  /**
   * P7.11 (#100) — a node's local transform as a single 4×4 column-major
   * matrix (16 floats). Per glTF 2.0 §3.6 this is MUTUALLY EXCLUSIVE with
   * translation/rotation/scale on the same node — a node uses EITHER the
   * decomposed T/R/S fields OR `matrix`, never both. Blender's exporter
   * commonly emits `matrix` for JOINT nodes, so `defaultTRS`
   * (gltfImportChain) must decompose it; ignoring it captures bind pose as
   * identity and silently breaks deform fidelity on matrix-form rigs.
   */
  matrix?: number[];
  children?: number[];
  /**
   * #178 (S2) — index into the glTF top-level `meshes` array. Present when this
   * node instantiates a mesh; absent for pure transform/bone nodes.
   * `captureChildMaterials` reads it to pull the node's per-primitive materials.
   */
  mesh?: number;
}

export interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
  /**
   * When true, integer component values are dequantised to [0,1]
   * (unsigned) or [-1,1] (signed) per glTF 2.0 §3.6.2.1.2. Common on
   * KHR_mesh_quantization sampler outputs. Absent / false → raw values.
   */
  normalized?: boolean;
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
}

export interface GltfAnimationSampler {
  input: number;
  output: number;
  interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GltfAnimationChannel {
  sampler: number;
  target: { node: number; path: 'translation' | 'rotation' | 'scale' };
}

export interface GltfAnimation {
  name?: string;
  channels: GltfAnimationChannel[];
  samplers: GltfAnimationSampler[];
}

/**
 * P7.11 (#100) — a glTF skin: the joint list + (optional) inverse-bind
 * matrices that bind a SkinnedMesh's vertices to a bone hierarchy
 * (glTF 2.0 §3.7.3.1).
 */
export interface GltfSkin {
  /** glTF NODE indices, in joint-list order. The IBM accessor is indexed
   *  by POSITION in this array, NOT by node index. */
  joints: number[];
  /** Accessor INDEX (MAT4/FLOAT) of the per-joint inverse-bind matrices,
   *  parallel to `joints` in joint-list order. Optional — absent means the
   *  loader reconstructs identity inverses. NOTE: this is the accessor
   *  index (a number), not the matrix data; read it via `readAccessor`. */
  inverseBindMatrices?: number;
  /** Advisory common-root node index (skin.skeleton). Optional; structural
   *  roots are also derivable from the node hierarchy. */
  skeleton?: number;
  name?: string;
}

export interface GltfJson {
  nodes: GltfNode[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  animations?: GltfAnimation[];
  /** P7.11 (#100) — skin definitions; absent for non-skinned files. */
  skins?: GltfSkin[];
  /**
   * #178 (S2) — top-level meshes; each primitive's `material` indexes
   * `materials`. `captureChildMaterials` reads this to map a node's mesh →
   * its per-primitive material definitions.
   */
  meshes?: { primitives?: { material?: number }[] }[];
  /** #178 (S2) — material definitions, compiled to OpenPBR IR on import. */
  materials?: GltfJsonMaterial[];
}

export interface ParsedGlb {
  json: GltfJson;
  bin: Uint8Array;
}

export function parseGlb(buffer: ArrayBuffer): ParsedGlb {
  if (buffer.byteLength < 12) {
    throw new Error(`parseGlb: buffer too small (${buffer.byteLength} bytes)`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `parseGlb: expected GLB magic 0x46546C67 ('glTF'), got 0x${magic.toString(16)}`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`parseGlb: expected GLB version 2, got ${version}`);
  }
  const totalLength = view.getUint32(8, true);
  if (totalLength !== buffer.byteLength) {
    throw new Error(
      `parseGlb: declared length ${totalLength} does not match buffer length ${buffer.byteLength}`,
    );
  }

  let cursor = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  const decoder = new TextDecoder('utf-8');
  while (cursor < totalLength) {
    if (cursor + 8 > totalLength) {
      throw new Error('parseGlb: truncated chunk header');
    }
    const chunkLength = view.getUint32(cursor, true);
    const chunkType = view.getUint32(cursor + 4, true);
    const chunkStart = cursor + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > totalLength) {
      throw new Error(
        `parseGlb: chunk overruns buffer (start=${chunkStart}, len=${chunkLength}, total=${totalLength})`,
      );
    }
    if (chunkType === CHUNK_JSON) {
      const bytes = new Uint8Array(buffer, chunkStart, chunkLength);
      json = JSON.parse(decoder.decode(bytes)) as GltfJson;
    } else if (chunkType === CHUNK_BIN) {
      bin = new Uint8Array(buffer, chunkStart, chunkLength);
    }
    // Unknown chunk types are ignored per glTF 2.0 §4.4 (forward-compat).
    cursor = chunkEnd;
  }

  if (!json) throw new Error('parseGlb: missing JSON chunk');

  // #90 — `buffers[].uri` (data-URI / external `.bin`) is no longer
  // rejected here. The embedded BIN is returned as buffer 0; any
  // uri-bearing buffer is materialised later by `resolveBuffers`.
  // Embedded BIN may be absent for JSON-only-with-no-animations files;
  // the import chain handles bin=empty when no accessors are read.
  return { json, bin: bin ?? new Uint8Array(0) };
}

/** Pad `bytes` up to the next 4-byte boundary with `fill` (glTF 2.0 §4.4.2
 *  requires each chunk's data to be 4-byte aligned). Returns the input verbatim
 *  when already aligned (no copy). */
function padChunkTo4(bytes: Uint8Array, fill: number): Uint8Array {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.byteLength + (4 - remainder));
  padded.set(bytes);
  padded.fill(fill, bytes.byteLength);
  return padded;
}

/**
 * Serialise a parsed GLB (`{ json, bin }`) back into GLB binary bytes — the
 * inverse of `parseGlb`. Used by the spec/gloss `.glb` ingest conversion (#216):
 * the `.glb`'s materials are converted in the JSON document, then the container
 * is repacked so BOTH OPFS readers (the render GLTFLoader and the capture
 * `buildGltfImportOps`) see normal metal-rough (render == capture, V37/H40).
 *
 * Layout per glTF 2.0 §4.4: 12-byte header (magic | version 2 | total length),
 * the JSON chunk (UTF-8, padded with 0x20 SPACE to a 4-byte boundary), then —
 * when `bin` is non-empty — the BIN chunk (padded with 0x00). An empty `bin`
 * emits a JSON-only GLB (no BIN chunk), valid per §4.4.3. `json` is typed
 * `unknown` because the converter operates on a looser document shape than
 * `GltfJson`; only `JSON.stringify` is needed here.
 */
export function repackGlb(parsed: { json: unknown; bin: Uint8Array }): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(parsed.json));
  const jsonChunk = padChunkTo4(jsonBytes, 0x20);
  const hasBin = parsed.bin.byteLength > 0;
  const binChunk = hasBin ? padChunkTo4(parsed.bin, 0x00) : null;

  const totalLength =
    12 + 8 + jsonChunk.byteLength + (binChunk ? 8 + binChunk.byteLength : 0);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  let cursor = 12;
  view.setUint32(cursor, jsonChunk.byteLength, true);
  view.setUint32(cursor + 4, CHUNK_JSON, true);
  out.set(jsonChunk, cursor + 8);
  cursor += 8 + jsonChunk.byteLength;

  if (binChunk) {
    view.setUint32(cursor, binChunk.byteLength, true);
    view.setUint32(cursor + 4, CHUNK_BIN, true);
    out.set(binChunk, cursor + 8);
  }
  return out;
}

/**
 * Parse a JSON-only `.gltf` container (#90) — plain UTF-8 JSON, no GLB
 * magic / chunks / embedded BIN. Buffers are always external or inline
 * data-URIs, materialised by `resolveBuffers`. Returns an empty `bin`
 * (buffer 0 has no embedded chunk in this container).
 */
export function parseGltfJson(buffer: ArrayBuffer): ParsedGlb {
  const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
  let json: GltfJson;
  try {
    json = JSON.parse(text) as GltfJson;
  } catch (e) {
    throw new Error(`parseGltfJson: not valid JSON (${(e as Error).message})`);
  }
  if (json === null || typeof json !== 'object') {
    throw new Error('parseGltfJson: parsed value is not a glTF document object');
  }
  return { json, bin: new Uint8Array(0) };
}

/**
 * Container dispatcher (#90): a `.glb` starts with the GLB magic
 * (0x46546C67) → `parseGlb`; anything else is treated as JSON-only
 * `.gltf` → `parseGltfJson`. Lets one importer entry point accept both
 * containers without a separate format flag (single-path; CONTEXT D-02).
 */
export function parseGltfContainer(buffer: ArrayBuffer): ParsedGlb {
  if (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC) {
    return parseGlb(buffer);
  }
  return parseGltfJson(buffer);
}

/** Decode a `data:` URI's payload into raw bytes (base64 or percent-encoded). */
function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('resolveBuffers: malformed data URI (no comma)');
  const meta = uri.slice('data:'.length, comma);
  const payload = uri.slice(comma + 1);
  const raw = /;base64/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Materialise `json.buffers[]` into a concrete byte array per buffer
 * index — the shape `readAccessor` indexes via `bufferView.buffer` (#90).
 *
 *   - No `uri`  → the GLB-embedded BIN (`embeddedBin`). Valid only at
 *     index 0 per glTF 2.0 §4.4.3; a later no-uri buffer is malformed.
 *   - `data:` URI → decoded inline (sync, no IO).
 *   - external relative URI (`foo.bin`) → fetched via the injected
 *     `resolveBuffer` callback (OPFS in production). An external URI with
 *     no resolver throws loudly rather than silently dropping geometry.
 *
 * Async because external resolution is IO-bound; the embedded / data-URI
 * branches never await, so single-file GLB import stays effectively sync.
 */
export async function resolveBuffers(
  json: GltfJson,
  embeddedBin: Uint8Array,
  resolveBuffer?: (uri: string) => Promise<Uint8Array>,
): Promise<Uint8Array[]> {
  const buffers = json.buffers ?? [];
  if (buffers.length === 0) {
    // No declared buffers: expose the embedded BIN at index 0 so a stray
    // bufferView (none expected) still resolves; empty otherwise.
    return embeddedBin.byteLength > 0 ? [embeddedBin] : [];
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const uri = buffers[i].uri;
    if (uri === undefined) {
      if (i !== 0) {
        throw new Error(
          `resolveBuffers: buffers[${i}] has no uri — only the first (GLB-embedded) buffer may omit it.`,
        );
      }
      out.push(embeddedBin);
    } else if (uri.startsWith('data:')) {
      out.push(decodeDataUri(uri));
    } else {
      if (!resolveBuffer) {
        throw new Error(
          `resolveBuffers: buffers[${i}].uri="${uri}" is external but no resolveBuffer callback was provided.`,
        );
      }
      out.push(await resolveBuffer(uri));
    }
  }
  return out;
}

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const NUM_COMPONENTS: Record<GltfAccessor['type'], number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

// Dequantisation divisors per glTF 2.0 §3.6.2.1.2 (accessor data types).
// Applied only when `accessor.normalized === true`. Signed types floor at
// -1 (the `-MAX` slot is reserved/unused so c/MAX can dip just below -1).
const NORMALIZE_DIVISOR: Record<number, number> = {
  5120: 127, // BYTE → [-1, 1]
  5121: 255, // UNSIGNED_BYTE → [0, 1]
  5122: 32767, // SHORT → [-1, 1]
  5123: 65535, // UNSIGNED_SHORT → [0, 1]
};

const SIGNED_COMPONENT = new Set([5120, 5122]);

/**
 * Read an accessor's data into a Float32Array (one copy, dequantised).
 *
 * Supports FLOAT (5126) and the four integer component types
 * (5120 BYTE / 5121 UBYTE / 5122 SHORT / 5123 USHORT) — the latter are
 * common on KHR_mesh_quantization size-optimised exports (#89). When
 * `accessor.normalized` is set, integer values are dequantised per the
 * spec (signed → [-1,1] with a -1 floor; unsigned → [0,1]); otherwise
 * the raw integer value is widened to float.
 *
 * Reads through a DataView (little-endian, glTF's required byte order)
 * so arbitrary bin byteOffsets are safe regardless of component-size
 * alignment — and returns a fresh array (callers only read by index;
 * no aliasing dependency, verified at #89).
 */
export function readAccessor(
  json: GltfJson,
  buffers: Uint8Array[],
  accessorIndex: number,
): Float32Array {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`readAccessor: accessor[${accessorIndex}] missing`);
  const compBytes = COMPONENT_BYTES[accessor.componentType];
  if (!compBytes || accessor.componentType === 5125) {
    // 5125 (UNSIGNED_INT) is valid only for mesh indices, never for
    // animation sampler I/O — reject it (and any unknown type) loudly.
    throw new Error(
      `readAccessor: componentType ${accessor.componentType} is not supported for ` +
        `animation accessors (expected FLOAT / BYTE / UBYTE / SHORT / USHORT).`,
    );
  }
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`readAccessor: bufferView[${accessor.bufferView}] missing`);
  // #90 — multi-buffer: select the backing buffer by `bufferView.buffer`.
  const bin = buffers[bufferView.buffer];
  if (!bin) {
    throw new Error(
      `readAccessor: bufferView[${accessor.bufferView}].buffer=${bufferView.buffer} not resolved ` +
        `(${buffers.length} buffer(s) available)`,
    );
  }
  const numComponents = NUM_COMPONENTS[accessor.type];
  if (!numComponents) {
    throw new Error(`readAccessor: unsupported accessor type ${accessor.type}`);
  }
  const count = accessor.count * numComponents;
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const totalBytes = count * compBytes;
  if (byteOffset + totalBytes > bin.byteLength) {
    throw new Error(
      `readAccessor: byteOffset+length ${byteOffset + totalBytes} overruns buffer ${bufferView.buffer} (${bin.byteLength} bytes)`,
    );
  }
  const dv = new DataView(bin.buffer, bin.byteOffset + byteOffset, totalBytes);
  const out = new Float32Array(count);
  const normalized = accessor.normalized === true;
  const divisor = NORMALIZE_DIVISOR[accessor.componentType];
  const signed = SIGNED_COMPONENT.has(accessor.componentType);
  for (let i = 0; i < count; i++) {
    const off = i * compBytes;
    let raw: number;
    switch (accessor.componentType) {
      case 5126:
        out[i] = dv.getFloat32(off, true);
        continue;
      case 5120:
        raw = dv.getInt8(off);
        break;
      case 5121:
        raw = dv.getUint8(off);
        break;
      case 5122:
        raw = dv.getInt16(off, true);
        break;
      default: // 5123
        raw = dv.getUint16(off, true);
        break;
    }
    out[i] = normalized ? (signed ? Math.max(raw / divisor, -1) : raw / divisor) : raw;
  }
  return out;
}
