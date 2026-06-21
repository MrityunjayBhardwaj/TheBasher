// repackGlb — the GLB writer (inverse of parseGlb), added for the spec/gloss
// `.glb` ingest conversion (#216). The load-bearing invariant: parseGlb ∘
// repackGlb is identity on (json, bin), and the output is a spec-valid GLB
// (correct magic / version / total length / 4-byte chunk alignment).

import { describe, it, expect } from 'vitest';
import { parseGlb, repackGlb, type GltfJson } from './glb';

/** Build a minimal valid GLB from a json object + optional bin, the slow/honest
 *  way (hand-assembled bytes) so the test doesn't lean on repackGlb to test
 *  repackGlb. Mirrors the glTF 2.0 §4.4 layout. */
function handPackGlb(json: unknown, bin: Uint8Array | null): ArrayBuffer {
  const enc = new TextEncoder();
  const jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLen = jsonBytes.byteLength + jsonPad;
  const binPad = bin ? (4 - (bin.byteLength % 4)) % 4 : 0;
  const binLen = bin ? bin.byteLength + binPad : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let c = 12;
  dv.setUint32(c, jsonLen, true);
  dv.setUint32(c + 4, 0x4e4f534a, true);
  out.set(jsonBytes, c + 8);
  out.fill(0x20, c + 8 + jsonBytes.byteLength, c + 8 + jsonLen); // space pad
  c += 8 + jsonLen;
  if (bin) {
    dv.setUint32(c, binLen, true);
    dv.setUint32(c + 4, 0x004e4942, true);
    out.set(bin, c + 8);
  }
  return out.buffer;
}

const SAMPLE_JSON = {
  asset: { version: '2.0' },
  materials: [{ name: 'Mat', pbrMetallicRoughness: { metallicFactor: 0.5 } }],
  buffers: [{ byteLength: 6 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
};

describe('repackGlb', () => {
  it('round-trips json + bin through parseGlb (identity)', () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const original = parseGlb(handPackGlb(SAMPLE_JSON, bin));

    const repacked = repackGlb(original);
    const reparsed = parseGlb(
      repacked.buffer.slice(repacked.byteOffset, repacked.byteOffset + repacked.byteLength),
    );

    expect(reparsed.json).toEqual(original.json);
    // bin survives byte-for-byte (the padded tail is dropped — chunkLength is
    // the un-padded length only when the source was aligned; here 6 → padded to
    // 8, so parseGlb reads back the 8-byte chunk. Assert the first 6 match.)
    expect(Array.from(reparsed.bin.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('produces a spec-valid header (magic / version 2 / self-consistent length)', () => {
    const out = repackGlb({ json: SAMPLE_JSON, bin: new Uint8Array([9, 9]) });
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(out.byteLength);
  });

  it('4-byte aligns the JSON chunk (pads odd-length JSON with spaces)', () => {
    // A json whose serialisation is not a multiple of 4 forces padding.
    const out = repackGlb({ json: { a: 1 }, bin: new Uint8Array(0) });
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const jsonChunkLen = dv.getUint32(12, true);
    expect(jsonChunkLen % 4).toBe(0);
    expect(out.byteLength % 4).toBe(0);
  });

  it('emits a JSON-only GLB (no BIN chunk) when bin is empty', () => {
    const out = repackGlb({ json: SAMPLE_JSON, bin: new Uint8Array(0) });
    const reparsed = parseGlb(
      out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    );
    expect(reparsed.bin.byteLength).toBe(0);
    // total length == header + one chunk only.
    const enc = new TextEncoder();
    const jb = enc.encode(JSON.stringify(SAMPLE_JSON));
    const padded = jb.byteLength + ((4 - (jb.byteLength % 4)) % 4);
    expect(out.byteLength).toBe(12 + 8 + padded);
  });

  it('preserves unknown top-level fields not declared on GltfJson', () => {
    const json = { ...SAMPLE_JSON, scene: 0, scenes: [{ nodes: [0] }], extras: { k: 'v' } };
    const out = repackGlb({ json, bin: new Uint8Array(0) });
    const reparsed = parseGlb(
      out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    ) as { json: GltfJson & Record<string, unknown> };
    expect(reparsed.json.scene).toBe(0);
    expect(reparsed.json.extras).toEqual({ k: 'v' });
  });
});
