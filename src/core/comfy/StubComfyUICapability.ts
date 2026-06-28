// StubComfyUICapability — deterministic, dependency-free
// ComfyUICapability for tests and offline development.
//
// Shape parity with `stubEncoder` (src/render/encoders/stubEncoder.ts):
// hashes (workflowJson + inputs) into a 6-hex digest, then encodes a 1×1
// PNG whose pixel encodes the digest. Two submits with identical inputs
// return byte-identical bytes — V2 twice-eval friendly. Two submits with
// different prompts produce different bytes — Wave B/C tests can prove
// sourceHash isolation.
//
// D-06 (locked): the dryRun probe writes its result to the canonical
// stylized-output path. Subsequent execute-time submits hit the same
// (workflowJson, inputs) hash → same bytes → cache parity with the
// already-written probe result.
//
// REF: vyapti V6, project_p4 stub-encoder pattern.

import type {
  ComfyBatchResult,
  ComfyInputs,
  ComfySubmitResult,
  ComfyUICapability,
  ComfyWorkflowJson,
} from './ComfyUICapability';
import type { ComfyProgressEvent } from './comfyProgress';
import type { ComfyApiJson } from './comfyGraph';
import { scanBasherExports } from './basherExports';

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export interface StubComfyOptions {
  /**
   * Optional fixed delay per submit — Wave A's dryRun test extrapolates
   * `frames * stubFrameTime`, so a deterministic delay keeps the math
   * predictable. Defaults to 0 (no artificial wait).
   */
  readonly perSubmitDelayMs?: number;
  /**
   * If provided, the next call(s) to `submit` reject with this error
   * instead of producing bytes. Test-only — used to exercise the
   * mid-failure branch in `runComfyUIWorkflow`. Each submit consumes one
   * entry from the array.
   */
  readonly errorQueue?: Error[];
}

export class StubComfyUICapability implements ComfyUICapability {
  readonly id = 'stub';
  readonly kind = 'stub' as const;

  private nextJobId = 1;
  private cancelled = new Set<string>();
  private readonly errorQueue: Error[];
  private readonly perSubmitDelayMs: number;

  constructor(opts: StubComfyOptions = {}) {
    this.errorQueue = [...(opts.errorQueue ?? [])];
    this.perSubmitDelayMs = opts.perSubmitDelayMs ?? 0;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async submit(workflowJson: ComfyWorkflowJson, inputs: ComfyInputs): Promise<ComfySubmitResult> {
    if (this.errorQueue.length > 0) {
      const err = this.errorQueue.shift()!;
      throw err;
    }
    if (this.perSubmitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.perSubmitDelayMs));
    }
    const jobId = `stub_${this.nextJobId++}`;
    const hash = digest(workflowJson, inputs);
    const [r, g, b] = pixelFromHash(hash);
    const frame = encode1x1Png(r, g, b);
    return { jobId, frame };
  }

  async submitBatch(
    workflowJson: ComfyWorkflowJson,
    inputs: ComfyInputs,
    onEvent?: (event: ComfyProgressEvent) => void,
  ): Promise<ComfyBatchResult> {
    if (this.errorQueue.length > 0) {
      const err = this.errorQueue.shift()!;
      throw err;
    }
    if (this.perSubmitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.perSubmitDelayMs));
    }
    const jobId = `stub_${this.nextJobId++}`;
    // N frames, deterministic per (graphHash, batchIndex) — the batched test seam
    // (design §8). N is intrinsic to the compiled workflow (its batch dimension),
    // mirroring the real server where N output images fall out of execution.
    const n = inferBatchCount(workflowJson);
    const base = digest(workflowJson, inputs);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      // per-frame digest = base hash mixed with the batch index → a distinct,
      // deterministic colour per (graphHash, batchIndex).
      const h = mixString(mixString(0x811c9dc5, base), String(i)) >>> 0;
      const [r, g, b] = pixelFromHash(h.toString(16).padStart(8, '0'));
      frames.push(encode1x1Png(r, g, b));
    }
    // Emit synthetic progress so the live-progress UI is exercisable WITHOUT a server
    // (mirrors the real /ws stream: an executing node, a step ramp, and a preview
    // frame). Deterministic — the test seam for the progress surface.
    if (onEvent) {
      onEvent({ kind: 'executing', node: '3' });
      onEvent({ kind: 'progress', value: 0, max: n, node: '3' });
      if (frames.length > 0) onEvent({ kind: 'preview', mime: 'image/png', bytes: frames[0] });
      onEvent({ kind: 'progress', value: n, max: n, node: '3' });
    }
    // Group frames by declared basher_export node id so the export-collection path is
    // exercisable WITHOUT a server (the real impl groups by the producing output node;
    // the stub has no execution graph, so it routes the full frame set to each declared
    // export). Absent → callers fall back to the flat `frames`.
    const exports = scanBasherExports((workflowJson as ComfyApiJson) ?? {});
    const framesByNode = exports.length
      ? Object.fromEntries(exports.map((e) => [e.nodeId, frames]))
      : undefined;
    return { jobId, frames, framesByNode };
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
  }

  /** Test helper — has cancel(jobId) been called? */
  wasCancelled(jobId: string): boolean {
    return this.cancelled.has(jobId);
  }
}

/** Infer the batch length N from a compiled batched workflow the way the real
 *  server does — from the batch dimension baked into the graph. Prefers a
 *  `BasherSchedule` node's `frame_count`, else an `EmptyLatentImage.batch_size`,
 *  else 1. The stub treats the JSON shallowly (it is `unknown`), scanning node
 *  values for those two known keys. */
function inferBatchCount(workflowJson: ComfyWorkflowJson): number {
  if (!workflowJson || typeof workflowJson !== 'object') return 1;
  let n = 1;
  for (const node of Object.values(workflowJson as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue;
    const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    const fc = inputs.frame_count;
    if (typeof fc === 'number' && Number.isFinite(fc) && fc > n) n = Math.floor(fc);
    const bs = inputs.batch_size;
    if (typeof bs === 'number' && Number.isFinite(bs) && bs > n) n = Math.floor(bs);
  }
  return Math.max(1, n);
}

// --------------------------------------------------------------------------
// Deterministic hashing of (workflowJson, inputs).
//
// Workflow JSON is serialized with stable key ordering. Image inputs
// participate by content-hash (FNV-1a over the bytes), not by name only —
// otherwise two different beauty frames with the same name slot would
// produce the same stylized bytes (cache hit on the wrong content).
// --------------------------------------------------------------------------

function digest(workflowJson: ComfyWorkflowJson, inputs: ComfyInputs): string {
  let h = 0x811c9dc5;
  h = mixString(h, stableStringify(workflowJson));
  for (const key of Object.keys(inputs.images).sort()) {
    h = mixString(h, key);
    h = mixBytes(h, inputs.images[key]);
  }
  for (const key of Object.keys(inputs.scalars).sort()) {
    h = mixString(h, key);
    h = mixString(h, String(inputs.scalars[key]));
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function mixString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

function mixBytes(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

function pixelFromHash(hash: string): [number, number, number] {
  const r = parseInt(hash.slice(0, 2), 16) || 0;
  const g = parseInt(hash.slice(2, 4), 16) || 0;
  const b = parseInt(hash.slice(4, 6), 16) || 0;
  return [r, g, b];
}

// --------------------------------------------------------------------------
// 1×1 PNG encoder — copied verbatim from stubEncoder.ts so the stub stays
// dependency-free. If a third file ever needs this, lift to a shared util.
// --------------------------------------------------------------------------

function encode1x1Png(r: number, g: number, b: number): Uint8Array {
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
  data[8] = 8;
  data[9] = 2;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return buildChunk('IHDR', data);
}

function buildIdat(r: number, g: number, b: number): Uint8Array {
  const raw = Uint8Array.of(0, r, g, b);
  const header = Uint8Array.of(0x78, 0x01);
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
