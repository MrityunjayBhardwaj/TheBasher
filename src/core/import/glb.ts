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
//   - Embedded BIN only. `buffers[].uri` (data-URI / external `.bin`)
//     throws — RESEARCH R2 / #90; the multi-file `.gltf` load-layer
//     case is #82.
//
// GLB layout (little-endian):
//   header: 12 bytes — magic 'glTF' (0x46546C67) | version 2 | length
//   chunk 1: u32 length | u32 type | bytes (length aligned to 4)
//   chunk 2: same shape
//
// REF: glTF 2.0 spec §4.4; PLAN.md Wave D1.

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GltfNode {
  name?: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  children?: number[];
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

export interface GltfJson {
  nodes: GltfNode[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  animations?: GltfAnimation[];
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

  // RESEARCH R2 — external buffers (data-URI or relative `.bin`) are not
  // supported by this importer in v0.7.5. A follow-up issue covers
  // multi-file `.gltf` resolution (#82-style scope).
  if (json.buffers) {
    for (let i = 0; i < json.buffers.length; i++) {
      if (json.buffers[i].uri !== undefined) {
        throw new Error(
          `parseGlb: buffers[${i}].uri is set — data-URI / external buffers are not supported in v0.7.5. ` +
            `Re-export as a single-file GLB. Tracking: glTF data-URI buffers follow-up.`,
        );
      }
    }
  }

  // Embedded BIN may be absent for JSON-only-with-no-animations files;
  // the import chain handles bin=null when no accessors are read.
  return { json, bin: bin ?? new Uint8Array(0) };
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
export function readAccessor(json: GltfJson, bin: Uint8Array, accessorIndex: number): Float32Array {
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
  const numComponents = NUM_COMPONENTS[accessor.type];
  if (!numComponents) {
    throw new Error(`readAccessor: unsupported accessor type ${accessor.type}`);
  }
  const count = accessor.count * numComponents;
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const totalBytes = count * compBytes;
  if (byteOffset + totalBytes > bin.byteLength) {
    throw new Error(
      `readAccessor: byteOffset+length ${byteOffset + totalBytes} overruns BIN chunk (${bin.byteLength} bytes)`,
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
