// runRenderJob — Wave B execution-layer unit tests.
//
// Verifies:
//  - frame walking: every (frame, pass) pair → one PNG write to storage
//  - paths follow the pad-4 convention `${prefix}/${kind}_${frame}.png`
//  - bytes are valid PNG (magic header)
//  - byte-determinism: same DagState rendered twice → identical bytes
//  - sourceHash flips on time → bytes flip frame-to-frame
//  - V8: src/render/* never imports the dispatcher (textual guard)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { stubEncoder } from './encoders/stubEncoder';
import { runRenderJob } from './runRenderJob';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildJobState(opts: {
  frameStart?: number;
  frameEnd?: number;
  fps?: number;
  outputPath?: string;
  passes?: Array<'BeautyPass' | 'IDPass'>;
}) {
  const passes = opts.passes ?? ['BeautyPass'];
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: {
      jobId: 'jobA',
      frameStart: opts.frameStart ?? 0,
      frameEnd: opts.frameEnd ?? 1,
      fps: opts.fps ?? 30,
      outputPath: opts.outputPath ?? 'renders/jobA',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job', socket: 'time' },
  }).next;
  for (let i = 0; i < passes.length; i++) {
    const passId = `pass_${i}_${passes[i]}`;
    s = applyOp(s, { type: 'addNode', nodeId: passId, nodeType: passes[i], params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: passId, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: passId, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: passId, socket: 'time' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: passId, socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    }).next;
  }
  return s;
}

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

describe('P4 — runRenderJob (Wave B)', () => {
  it('writes one PNG per (frame, pass) using the pad-4 path convention', async () => {
    const storage = new MemoryStorage();
    const state = buildJobState({ frameStart: 0, frameEnd: 2, passes: ['BeautyPass', 'IDPass'] });
    const report = await runRenderJob('job', state, { storage, encoder: stubEncoder });
    expect(report.framesWritten).toBe(3); // frames 0, 1, 2
    expect(report.passKinds).toEqual(['beauty', 'id']);
    expect(report.outputs).toHaveLength(6); // 3 frames * 2 passes
    expect(report.outputs).toContain('renders/jobA/beauty_0000.png');
    expect(report.outputs).toContain('renders/jobA/beauty_0001.png');
    expect(report.outputs).toContain('renders/jobA/id_0002.png');
    for (const p of report.outputs) {
      const bytes = await storage.read(p);
      expect(isPng(bytes)).toBe(true);
    }
  });

  it('determinism: same DagState rendered twice → identical bytes per frame', async () => {
    const state = buildJobState({ frameStart: 0, frameEnd: 1 });
    const sA = new MemoryStorage();
    const sB = new MemoryStorage();
    await runRenderJob('job', state, { storage: sA, encoder: stubEncoder });
    await runRenderJob('job', state, { storage: sB, encoder: stubEncoder });
    const a = await sA.read('renders/jobA/beauty_0000.png');
    const b = await sB.read('renders/jobA/beauty_0000.png');
    expect(a).toEqual(b);
  });

  it('frames produce different pixels (sourceHash flips on time)', async () => {
    const storage = new MemoryStorage();
    const state = buildJobState({ frameStart: 0, frameEnd: 1 });
    await runRenderJob('job', state, { storage, encoder: stubEncoder });
    const f0 = await storage.read('renders/jobA/beauty_0000.png');
    const f1 = await storage.read('renders/jobA/beauty_0001.png');
    // Same length, different content (the stubEncoder embeds sourceHash
    // into the IDAT pixel — change in t flips the pixel).
    expect(f0.length).toBe(f1.length);
    expect(Buffer.from(f0).equals(Buffer.from(f1))).toBe(false);
  });

  it('throws on missing RenderJob node', async () => {
    const state = buildJobState({});
    await expect(
      runRenderJob('nope', state, { storage: new MemoryStorage(), encoder: stubEncoder }),
    ).rejects.toThrow(/unknown jobNodeId/);
  });

  it('throws when jobNodeId points to a non-RenderJob node', async () => {
    const state = buildJobState({});
    await expect(
      runRenderJob('box', state, { storage: new MemoryStorage(), encoder: stubEncoder }),
    ).rejects.toThrow(/not a RenderJob/);
  });

  it('handles a job with no connected passes (writes zero bytes, returns clean report)', async () => {
    const storage = new MemoryStorage();
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'job',
      nodeType: 'RenderJob',
      params: { jobId: 'empty', frameStart: 0, frameEnd: 4, fps: 30 },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'job', socket: 'time' },
    }).next;
    const report = await runRenderJob('job', s, { storage, encoder: stubEncoder });
    expect(report.outputs).toEqual([]);
    expect(report.passKinds).toEqual([]);
    expect(report.framesWritten).toBe(0);
  });
});

describe('V8 — file-rooted dispatch rule (src/render/* must not emit Ops)', () => {
  // V8 forbids dispatching from src/render/. The execution layer reads
  // DagState and writes via StorageCapability; if it ever IMPORTS the op
  // store these tests fail and force a rewrite. Match imports only —
  // prose comments documenting the rule are allowed.
  const FORBIDDEN_IMPORTS =
    /from\s+['"][^'"]*(dagStore|useDagStore|dispatchAtomic|core\/dag\/ops)['"]/;

  it('runRenderJob.ts does not import the DAG dispatcher or store mutators', () => {
    const file = readFileSync(path.resolve(__dirname, 'runRenderJob.ts'), 'utf-8');
    expect(file).not.toMatch(FORBIDDEN_IMPORTS);
  });

  it('stubEncoder.ts does not import dag store or op machinery', () => {
    const file = readFileSync(path.resolve(__dirname, 'encoders/stubEncoder.ts'), 'utf-8');
    expect(file).not.toMatch(FORBIDDEN_IMPORTS);
  });

  it('dryRun.ts does not import dag store or op machinery (P5 Wave A5)', () => {
    const file = readFileSync(path.resolve(__dirname, 'dryRun.ts'), 'utf-8');
    expect(file).not.toMatch(FORBIDDEN_IMPORTS);
  });
});
