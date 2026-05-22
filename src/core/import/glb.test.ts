// GLB parser unit tests — Wave D1.
//
// Round-trip + invariant breaks + accessor reading (FLOAT32 + the
// quantised integer types per #89) + the data-URI-buffer follow-up
// error message (#90).
//
// REF: PLAN.md Wave D1; #89 (quantised accessors).

import { describe, expect, it } from 'vitest';
import { parseGlb, readAccessor, type GltfJson } from './glb';

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
    const result = readAccessor(parsed.json, parsed.bin, 0);
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
    const result = Array.from(readAccessor(parsed.json, parsed.bin, 0));
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
    const result = Array.from(readAccessor(parsed.json, parsed.bin, 0));
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
    const result = Array.from(readAccessor(parsed.json, parsed.bin, 0));
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
    expect(Array.from(readAccessor(parsed.json, parsed.bin, 0))).toEqual([7, 65535]);
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
    const result = Array.from(readAccessor(parsed.json, parsed.bin, 0));
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
    expect(() => readAccessor(parsed.json, parsed.bin, 0)).toThrow(
      /componentType 5125 is not supported for animation accessors/,
    );
  });

  it('throws when buffers[0].uri is set (data-URI / external BIN follow-up)', () => {
    const json: GltfJson = {
      nodes: [],
      buffers: [{ byteLength: 0, uri: 'data:application/octet-stream;base64,AAAA' }],
    };
    const buf = makeGlb(json);
    expect(() => parseGlb(buf)).toThrow(/data-URI \/ external buffers are not supported/);
  });
});
