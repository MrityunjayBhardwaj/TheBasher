import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import { MemoryStorage } from '../core/storage';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { probeWebCodecsEncoder, runVideoStitch, stubVideoEncoder } from './runVideoStitch';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildStitchState(opts: { frameEnd?: number; outputPath?: string } = {}) {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 60, position: [0, 0, 5], lookAt: [0, 0, 0] },
  }).next;
  s = makeSplitCube(s, { objectId: 'box', size: [1, 1, 1], position: [0, 0, 0] }).state;
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
  s = applyOp(s, { type: 'addNode', nodeId: 'beauty', nodeType: 'BeautyPass', params: {} }).next;
  for (const wire of [
    { from: 'scene', to: ['beauty', 'scene'] },
    { from: 'cam', to: ['beauty', 'camera'] },
    { from: 'time', to: ['beauty', 'time'] },
  ] as const) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: wire.from, socket: 'out' },
      to: { node: wire.to[0], socket: wire.to[1] },
    }).next;
  }
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'p',
    nodeType: 'Prompt',
    params: { text: 'a cube', negative: '', tags: [] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cw',
    nodeType: 'ComfyUIWorkflow',
    params: {
      presetId: 'stylizedRealism',
      frameStart: 0,
      frameEnd: opts.frameEnd ?? 4,
      lastGoodFrame: -1,
      outputPath: 'renders/job1/stylized_stylizedRealism',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'p', socket: 'out' },
    to: { node: 'cw', socket: 'prompt' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'beauty', socket: 'out' },
    to: { node: 'cw', socket: 'pass-input' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'cw', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'stitch',
    nodeType: 'VideoStitch',
    params: {
      codec: 'h264',
      fps: 30,
      outputPath: opts.outputPath ?? 'renders/job1/final.mp4',
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cw', socket: 'out' },
    to: { node: 'stitch', socket: 'pass-input' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'stitch', socket: 'time' },
  }).next;
  return s;
}

async function seedStylizedFrames(storage: MemoryStorage, n: number) {
  for (let f = 0; f <= n; f++) {
    const padded = f.toString().padStart(4, '0');
    await storage.write(
      `renders/job1/stylized_stylizedRealism_${padded}.png`,
      new TextEncoder().encode(`frame${f}`),
    );
  }
}

describe('runVideoStitch (Wave D2 — execute side)', () => {
  it('reads stylized frames from D-04 paths, encodes, writes video to outputPath', async () => {
    const storage = new MemoryStorage();
    await seedStylizedFrames(storage, 4);
    const state = buildStitchState();
    const report = await runVideoStitch('stitch', state, {
      storage,
      encoder: stubVideoEncoder,
    });
    expect(report.framesEncoded).toBe(5);
    expect(report.outputPath).toBe('renders/job1/final.mp4');
    expect(report.bytesWritten).toBeGreaterThan(0);
    expect(await storage.exists('renders/job1/final.mp4')).toBe(true);
    const bytes = await storage.read('renders/job1/final.mp4');
    const text = new TextDecoder().decode(bytes);
    expect(text).toMatch(/^STUBVIDEO\/h264\/30\/5/);
    expect(text).toMatch(/ENDVID$/);
  });

  it('twice-call deterministic — same DAG + same stub produces identical output bytes', async () => {
    const storage1 = new MemoryStorage();
    await seedStylizedFrames(storage1, 2);
    const storage2 = new MemoryStorage();
    await seedStylizedFrames(storage2, 2);
    const state = buildStitchState({ frameEnd: 2 });
    await runVideoStitch('stitch', state, { storage: storage1, encoder: stubVideoEncoder });
    await runVideoStitch('stitch', state, { storage: storage2, encoder: stubVideoEncoder });
    const a = await storage1.read('renders/job1/final.mp4');
    const b = await storage2.read('renders/job1/final.mp4');
    expect(a).toEqual(b);
  });

  it('throws when a stylized frame is missing on disk', async () => {
    const storage = new MemoryStorage();
    await seedStylizedFrames(storage, 1); // only 0..1 seeded; need 0..4
    const state = buildStitchState({ frameEnd: 4 });
    await expect(
      runVideoStitch('stitch', state, { storage, encoder: stubVideoEncoder }),
    ).rejects.toThrow(/stylized frame missing at/);
  });

  it('throws when an upstream is not a ComfyUIWorkflow (v0.5 stylizes-only)', async () => {
    let s = buildStitchState();
    // Wire BeautyPass directly into stitch.pass-input — not allowed.
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'beauty', socket: 'out' },
      to: { node: 'stitch', socket: 'pass-input' },
    }).next;
    const storage = new MemoryStorage();
    await seedStylizedFrames(storage, 4);
    await expect(
      runVideoStitch('stitch', s, { storage, encoder: stubVideoEncoder }),
    ).rejects.toThrow(/wire a ComfyUIWorkflow/);
  });

  it('throws when stitchNodeId is unknown', async () => {
    const state = buildStitchState();
    await expect(
      runVideoStitch('nope', state, {
        storage: new MemoryStorage(),
        encoder: stubVideoEncoder,
      }),
    ).rejects.toThrow(/unknown stitchNodeId/);
  });

  it('throws when target is not a VideoStitch', async () => {
    const state = buildStitchState();
    await expect(
      runVideoStitch('cw', state, {
        storage: new MemoryStorage(),
        encoder: stubVideoEncoder,
      }),
    ).rejects.toThrow(/is not a VideoStitch/);
  });

  it('throws when outputPath is empty (Mutator must set it)', async () => {
    const state = buildStitchState({ outputPath: '' });
    await expect(
      runVideoStitch('stitch', state, {
        storage: new MemoryStorage(),
        encoder: stubVideoEncoder,
      }),
    ).rejects.toThrow(/empty outputPath/);
  });

  it('throws when stitch has no upstream frames', async () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'stitch',
      nodeType: 'VideoStitch',
      params: { codec: 'h264', fps: 30, outputPath: 'renders/x/v.mp4' },
    }).next;
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: 'stitch', socket: 'time' },
    }).next;
    await expect(
      runVideoStitch('stitch', s, {
        storage: new MemoryStorage(),
        encoder: stubVideoEncoder,
      }),
    ).rejects.toThrow(/no upstream frames/);
  });

  it('probeWebCodecsEncoder returns null in non-browser / unit-test environments', () => {
    expect(probeWebCodecsEncoder()).toBeNull();
  });
});

describe('V8 — file-rooted dispatch rule for runVideoStitch.ts', () => {
  it('runVideoStitch.ts does not import dag store or op machinery', () => {
    const file = readFileSync(path.resolve(__dirname, 'runVideoStitch.ts'), 'utf-8');
    const FORBIDDEN_IMPORTS =
      /from\s+['"][^'"]*(dagStore|useDagStore|dispatchAtomic|core\/dag\/ops)['"]/;
    expect(file).not.toMatch(FORBIDDEN_IMPORTS);
  });
});
