// stubEncoder — deterministic, GL-free PassEncoder for tests + the Wave B
// shipping seam.
//
// Produces a tiny well-formed PNG whose pixel data encodes the pass's
// sourceHash so two runs of the same RenderJob over the same DagState
// produce byte-identical bytes (V2 twice-eval friendly). The agent can
// describe a frame by sourceHash and the storage layer can dedupe on
// content; both are the actual P4 invariants the Wave A locked decisions
// pinned. Real WebGL rendering is its own swap-in via PassEncoder — Wave
// B intentionally ships the seam, not the pixels.
//
// Spec choice: 1x1 IDAT (uncompressed via deflate stored block) with a
// 24-bit RGB pixel derived from the sourceHash's first 6 hex chars. This
// keeps the encoder dependency-free while writing valid PNG bytes that
// any image viewer can open.
//
// REF: project_p4_prompt locked decisions ("main thread sync first ...
// real GL renderer is one strategy swap away").

import type { PassEncoder } from '../runRenderJob';

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export const stubEncoder: PassEncoder = async ({ pass }) => {
  const [r, g, b] = pixelFromHash(pass.sourceHash);
  return encode1x1Png(r, g, b);
};

function pixelFromHash(hash: string): [number, number, number] {
  // sourceHash is FNV-1a, 8 hex chars. Take pairs as r/g/b — last 2 chars
  // discarded but already entropy-mixed by hashValue().
  const r = parseInt(hash.slice(0, 2), 16) || 0;
  const g = parseInt(hash.slice(2, 4), 16) || 0;
  const b = parseInt(hash.slice(4, 6), 16) || 0;
  return [r, g, b];
}

function encode1x1Png(r: number, g: number, b: number): Uint8Array {
  // Layout: signature + IHDR + IDAT (raw deflate stored block) + IEND.
  const ihdr = buildIhdr(1, 1);
  const idat = buildIdat(r, g, b);
  const iend = buildChunk('IEND', new Uint8Array(0));
  const total = PNG_SIGNATURE.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(PNG_SIGNATURE, off);
  off += PNG_SIGNATURE.length;
  out.set(ihdr, off);
  off += ihdr.length;
  out.set(idat, off);
  off += idat.length;
  out.set(iend, off);
  return out;
}

function buildIhdr(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 2; // color type (truecolor RGB)
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return buildChunk('IHDR', data);
}

function buildIdat(r: number, g: number, b: number): Uint8Array {
  // Raw image data: 1 row of (filter byte + R + G + B).
  const raw = Uint8Array.of(0, r, g, b);
  // zlib wrapper around a single uncompressed deflate block.
  // Header: 0x78 0x01 (no preset dict, fastest).
  const header = Uint8Array.of(0x78, 0x01);
  // Deflate stored block: BFINAL=1, BTYPE=00. Then LEN/NLEN little-endian.
  const blockHeader = Uint8Array.of(
    0x01,
    raw.length & 0xff,
    (raw.length >>> 8) & 0xff,
    ~raw.length & 0xff,
    (~raw.length >>> 8) & 0xff,
  );
  const adler = adler32(raw);
  const adlerBytes = Uint8Array.of(
    (adler >>> 24) & 0xff,
    (adler >>> 16) & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff,
  );
  const compressed = concat([header, blockHeader, raw, adlerBytes]);
  return buildChunk('IDAT', compressed);
}

function buildChunk(tag: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(8 + len + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = tag.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + len));
  view.setUint32(8 + len, crc);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
