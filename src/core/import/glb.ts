// GLB binary container parser — Phase 7.5 Wave D (issue #81).
//
// Inline, dependency-free reader for the glTF 2.0 GLB layout (spec
// §4.4). Pulls out the JSON chunk + the binary chunk so the import
// chain can walk `json.animations` + read accessors. NO mesh-data
// touched — Draco/KTX2 stay drei-lazy at render time (B12).
//
// Scope discipline (per CONTEXT.md + RESEARCH.md):
//   - FLOAT32-only animation accessors (componentType 5126). Quantised
//     (5120/5121/5122/5123) throw with a clear follow-up message.
//   - Embedded BIN only. `buffers[].uri` (data-URI / external `.bin`)
//     throws — RESEARCH R2; the multi-file `.gltf` case is filed as a
//     follow-up before this phase merges.
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

/**
 * Read a FLOAT32 accessor as a Float32Array view over the bin chunk.
 *
 * v0.7.5 ONLY handles componentType 5126 (FLOAT). Quantised animation
 * accessors (KHR_mesh_quantization) throw with a clear follow-up
 * message. This matches the CONTEXT D-04 scope discipline — the
 * follow-up issue is filed before this phase merges.
 */
export function readAccessor(json: GltfJson, bin: Uint8Array, accessorIndex: number): Float32Array {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`readAccessor: accessor[${accessorIndex}] missing`);
  if (accessor.componentType !== 5126) {
    throw new Error(
      `readAccessor: componentType ${accessor.componentType} (non-FLOAT32) is not supported ` +
        `in v0.7.5. Re-export with sampler outputs as FLOAT. ` +
        `Tracking: glTF quantised animation accessors follow-up.`,
    );
  }
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`readAccessor: bufferView[${accessor.bufferView}] missing`);
  const numComponents = NUM_COMPONENTS[accessor.type];
  if (!numComponents) {
    throw new Error(`readAccessor: unsupported accessor type ${accessor.type}`);
  }
  const compBytes = COMPONENT_BYTES[accessor.componentType];
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const totalBytes = accessor.count * numComponents * compBytes;
  if (byteOffset + totalBytes > bin.byteLength) {
    throw new Error(
      `readAccessor: byteOffset+length ${byteOffset + totalBytes} overruns BIN chunk (${bin.byteLength} bytes)`,
    );
  }
  // Float32Array alignment: glTF 2.0 spec §3.6.2.4 requires accessor
  // offsets be a multiple of componentType size. For FLOAT32 that's 4
  // bytes — well-formed exports always satisfy it. If a misaligned
  // export ever surfaces, swap to a DataView read.
  const startInBin = bin.byteOffset + byteOffset;
  return new Float32Array(bin.buffer, startInBin, accessor.count * numComponents);
}
