// GLB parser unit tests — Wave D1 + #90.
//
// Round-trip + invariant breaks + accessor reading (FLOAT32 + the
// quantised integer types per #89, now multi-buffer indexed) + the
// #90 buffer-resolution surface (JSON-only `.gltf`, data-URI decode,
// external-buffer resolver, magic dispatch).
//
// REF: PLAN.md Wave D1; #89 (quantised accessors); #90 (buffers).

import { describe, expect, it } from 'vitest';
import {
  parseGlb,
  parseGltfJson,
  parseGltfContainer,
  resolveBuffers,
  readAccessor,
  type GltfJson,
} from './glb';

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Build an in-memory GLB with the given JSON + optional BIN bytes.
 *  JSON chunk is padded to 4-byte alignment with spaces; BIN with 0x00. */
function makeGlb(json: GltfJson, binBytes?: Uint8Array): ArrayBuffer {
  const encoder = new TextEncoder();
  let jsonBytes = encoder.encode(JSON.stringify(json));
  while (jsonBytes.length % 4 !== 0) {
    const padded = new Uint8Array(jsonBytes.length + 1);
    padded.set(jsonBytes);
    padded[jsonBytes.length] = 0x20; // space
    jsonBytes = padded;
  }
  let binPadded: Uint8Array | null = null;
  if (binBytes) {
    binPadded = binBytes;
    while (binPadded.length % 4 !== 0) {
      const padded = new Uint8Array(binPadded.length + 1);
      padded.set(binPadded);
      binPadded = padded;
    }
  }
  const totalLength = 12 + 8 + jsonBytes.length + (binPadded ? 8 + binPadded.length : 0);
  const buf = new ArrayBuffer(totalLength);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  let cursor = 12;
  view.setUint32(cursor, jsonBytes.length, true);
  view.setUint32(cursor + 4, CHUNK_JSON, true);
  new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
  cursor += 8 + jsonBytes.length;
  if (binPadded) {
    view.setUint32(cursor, binPadded.length, true);
    view.setUint32(cursor + 4, CHUNK_BIN, true);
    new Uint8Array(buf, cursor + 8, binPadded.length).set(binPadded);
  }
  return buf;
}

describe('parseGlb', () => {
  it('round-trips a minimal GLB (JSON + BIN recovered byte-identical)', () => {
    const json: GltfJson = { nodes: [{ name: 'cube' }] };
    const binBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    expect(parsed.json.nodes[0].name).toBe('cube');
    expect(Array.from(parsed.bin.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects magic mismatch', () => {
    const buf = new ArrayBuffer(12);
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => parseGlb(buf)).toThrow(/expected GLB magic/);
  });

  it('rejects non-2 version', () => {
    const buf = new ArrayBuffer(12);
    const v = new DataView(buf);
    v.setUint32(0, MAGIC, true);
    v.setUint32(4, 1, true);
    v.setUint32(8, 12, true);
    expect(() => parseGlb(buf)).toThrow(/expected GLB version 2/);
  });

  it('rejects declared-length mismatch', () => {
    const buf = new ArrayBuffer(12);
    const v = new DataView(buf);
    v.setUint32(0, MAGIC, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, 999, true);
    expect(() => parseGlb(buf)).toThrow(/declared length 999 does not match/);
  });
});

describe('readAccessor', () => {
  it('reads a FLOAT32 VEC3 accessor verbatim', () => {
    // 2 keyframes of position (VEC3 FLOAT32) = 24 bytes.
    const binBytes = new Uint8Array(24);
    const v = new DataView(binBytes.buffer);
    [0, 0, 0, 1, 2, 3].forEach((val, i) => v.setFloat32(i * 4, val, true));
    const json: GltfJson = {
      nodes: [],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 24 }],
      buffers: [{ byteLength: 24 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    const result = readAccessor(parsed.json, [parsed.bin], 0);
    expect(Array.from(result)).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it('reads a normalized SHORT (5122) accessor → [-1, 1] (#89)', () => {
    // Three SCALAR samples: 0 → 0, 32767 → 1, -32767 → -1.
    const binBytes = new Uint8Array(6);
    const v = new DataView(binBytes.buffer);
    v.setInt16(0, 0, true);
    v.setInt16(2, 32767, true);
    v.setInt16(4, -32767, true);
    const json: GltfJson = {
      nodes: [],
      accessors: [
        { bufferView: 0, componentType: 5122, count: 3, type: 'SCALAR', normalized: true },
      ],
      bufferViews: [{ buffer: 0, byteLength: 6 }],
      buffers: [{ byteLength: 6 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    const result = Array.from(readAccessor(parsed.json, [parsed.bin], 0));
    expect(result[0]).toBeCloseTo(0, 6);
    expect(result[1]).toBeCloseTo(1, 6);
    expect(result[2]).toBeCloseTo(-1, 6);
  });

  it('reads a normalized UNSIGNED_BYTE (5121) accessor → [0, 1] (#89)', () => {
    // 0 → 0, 255 → 1, 128 → ~0.502.
    const binBytes = new Uint8Array([0, 255, 128, 0]); // 4th byte = alignment pad
    const json: GltfJson = {
      nodes: [],
      accessors: [
        { bufferView: 0, componentType: 5121, count: 3, type: 'SCALAR', normalized: true },
      ],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      buffers: [{ byteLength: 4 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    const result = Array.from(readAccessor(parsed.json, [parsed.bin], 0));
    expect(result[0]).toBeCloseTo(0, 6);
    expect(result[1]).toBeCloseTo(1, 6);
    expect(result[2]).toBeCloseTo(128 / 255, 6);
  });

  it('reads a normalized BYTE (5120) accessor with the -1 floor (#89)', () => {
    // -128 is the reserved slot; dequantises to -1.0156 raw but floors to -1.
    const binBytes = new Uint8Array(4);
    const v = new DataView(binBytes.buffer);
    v.setInt8(0, -128);
    v.setInt8(1, 127);
    v.setInt8(2, 0);
    const json: GltfJson = {
      nodes: [],
      accessors: [
        { bufferView: 0, componentType: 5120, count: 3, type: 'SCALAR', normalized: true },
      ],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      buffers: [{ byteLength: 4 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    const result = Array.from(readAccessor(parsed.json, [parsed.bin], 0));
    expect(result[0]).toBe(-1); // floored, NOT -128/127 = -1.0078…
    expect(result[1]).toBeCloseTo(1, 6);
    expect(result[2]).toBeCloseTo(0, 6);
  });

  it('reads a NON-normalized USHORT (5123) accessor as raw integer values (#89)', () => {
    // Without `normalized`, integer types widen to float verbatim.
    const binBytes = new Uint8Array(4);
    const v = new DataView(binBytes.buffer);
    v.setUint16(0, 7, true);
    v.setUint16(2, 65535, true);
    const json: GltfJson = {
      nodes: [],
      accessors: [{ bufferView: 0, componentType: 5123, count: 2, type: 'SCALAR' }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      buffers: [{ byteLength: 4 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    expect(Array.from(readAccessor(parsed.json, [parsed.bin], 0))).toEqual([7, 65535]);
  });

  it('still reads a quantised accessor at a non-zero bufferView byteOffset (DataView alignment-safe)', () => {
    // SHORT samples start 2 bytes into the bin — a misaligned offset for
    // a 2-byte type only if read as a direct Int16Array view. DataView
    // tolerates it.
    const binBytes = new Uint8Array(8);
    const v = new DataView(binBytes.buffer);
    v.setInt16(2, 32767, true);
    v.setInt16(4, -32767, true);
    const json: GltfJson = {
      nodes: [],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 2,
          componentType: 5122,
          count: 2,
          type: 'SCALAR',
          normalized: true,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: 8 }],
      buffers: [{ byteLength: 8 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    const result = Array.from(readAccessor(parsed.json, [parsed.bin], 0));
    expect(result[0]).toBeCloseTo(1, 6);
    expect(result[1]).toBeCloseTo(-1, 6);
  });

  it('throws on UNSIGNED_INT (5125) — valid for indices, never animation I/O', () => {
    const binBytes = new Uint8Array(8);
    const json: GltfJson = {
      nodes: [],
      accessors: [{ bufferView: 0, componentType: 5125, count: 2, type: 'SCALAR' }],
      bufferViews: [{ buffer: 0, byteLength: 8 }],
      buffers: [{ byteLength: 8 }],
    };
    const buf = makeGlb(json, binBytes);
    const parsed = parseGlb(buf);
    expect(() => readAccessor(parsed.json, [parsed.bin], 0)).toThrow(
      /componentType 5125 is not supported for animation accessors/,
    );
  });

  it('reads an accessor backed by a non-zero buffer index (#90 multi-buffer)', () => {
    // bufferView.buffer = 1 → must read buffers[1], not buffers[0].
    const json: GltfJson = {
      nodes: [],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' }],
      bufferViews: [{ buffer: 1, byteLength: 8 }],
      buffers: [{ byteLength: 0 }, { byteLength: 8 }],
    };
    const buf0 = new Uint8Array(0);
    const buf1 = new Uint8Array(8);
    new DataView(buf1.buffer).setFloat32(0, 3, true);
    new DataView(buf1.buffer).setFloat32(4, 7, true);
    expect(Array.from(readAccessor(json, [buf0, buf1], 0))).toEqual([3, 7]);
  });

  it('throws when bufferView.buffer index is unresolved (#90)', () => {
    const json: GltfJson = {
      nodes: [],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR' }],
      bufferViews: [{ buffer: 2, byteLength: 4 }],
    };
    expect(() => readAccessor(json, [new Uint8Array(4)], 0)).toThrow(/not resolved/);
  });
});

describe('parseGlb (#90 — buffers[].uri no longer rejected)', () => {
  it('parses a GLB whose buffers[0] omits uri (embedded BIN) without throwing', () => {
    const json: GltfJson = {
      nodes: [{ name: 'cube' }],
      buffers: [{ byteLength: 4 }],
    };
    const buf = makeGlb(json, new Uint8Array([9, 8, 7, 6]));
    const parsed = parseGlb(buf);
    expect(Array.from(parsed.bin.slice(0, 4))).toEqual([9, 8, 7, 6]);
  });

  it('no longer throws when a buffer carries a uri (resolution deferred to resolveBuffers)', () => {
    const json: GltfJson = {
      nodes: [],
      buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAA' }],
    };
    const buf = makeGlb(json);
    expect(() => parseGlb(buf)).not.toThrow();
  });
});

describe('parseGltfJson + parseGltfContainer (#90)', () => {
  it('parses a JSON-only .gltf document into json + empty bin', () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }], buffers: [{ byteLength: 0 }] };
    const buf = new TextEncoder().encode(JSON.stringify(json)).buffer;
    const parsed = parseGltfJson(buf as ArrayBuffer);
    expect(parsed.json.nodes[0].name).toBe('Cube');
    expect(parsed.bin.byteLength).toBe(0);
  });

  it('rejects non-JSON input', () => {
    const buf = new TextEncoder().encode('not json {{{').buffer;
    expect(() => parseGltfJson(buf as ArrayBuffer)).toThrow(/not valid JSON/);
  });

  it('dispatches GLB magic → parseGlb, JSON → parseGltfJson', () => {
    const glb = makeGlb({ nodes: [{ name: 'g' }] }, new Uint8Array([1, 2, 3, 4]));
    expect(parseGltfContainer(glb).bin.byteLength).toBeGreaterThan(0);
    const gltf = new TextEncoder().encode(JSON.stringify({ nodes: [{ name: 'j' }] }))
      .buffer as ArrayBuffer;
    expect(parseGltfContainer(gltf).json.nodes[0].name).toBe('j');
  });
});

describe('resolveBuffers (#90)', () => {
  it('decodes an inline base64 data-URI buffer (no resolver needed)', async () => {
    // base64 "AQIDBA==" = bytes [1,2,3,4].
    const json: GltfJson = {
      nodes: [],
      buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AQIDBA==' }],
    };
    const [b0] = await resolveBuffers(json, new Uint8Array(0));
    expect(Array.from(b0)).toEqual([1, 2, 3, 4]);
  });

  it('returns the embedded BIN at index 0 when buffers[0] omits uri', async () => {
    const json: GltfJson = { nodes: [], buffers: [{ byteLength: 3 }] };
    const embedded = new Uint8Array([5, 6, 7]);
    const [b0] = await resolveBuffers(json, embedded);
    expect(Array.from(b0)).toEqual([5, 6, 7]);
  });

  it('fetches an external buffer via the injected resolver', async () => {
    const json: GltfJson = {
      nodes: [],
      buffers: [{ byteLength: 0 }, { byteLength: 2, uri: 'data.bin' }],
    };
    const fetched = new Uint8Array([42, 43]);
    const buffers = await resolveBuffers(json, new Uint8Array(0), async (uri) => {
      expect(uri).toBe('data.bin');
      return fetched;
    });
    expect(Array.from(buffers[1])).toEqual([42, 43]);
  });

  it('throws on an external buffer when no resolver is provided', async () => {
    const json: GltfJson = { nodes: [], buffers: [{ byteLength: 2, uri: 'data.bin' }] };
    await expect(resolveBuffers(json, new Uint8Array(0))).rejects.toThrow(
      /external but no resolveBuffer/,
    );
  });

  it('throws when a non-zero buffer omits its uri', async () => {
    const json: GltfJson = {
      nodes: [],
      buffers: [{ byteLength: 0 }, { byteLength: 4 }],
    };
    await expect(resolveBuffers(json, new Uint8Array(0))).rejects.toThrow(
      /only the first .* buffer may omit it/,
    );
  });
});
