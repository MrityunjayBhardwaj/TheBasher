// #1318 — Render ▸ Animation resolves the scene once per export, not once per frame.
//
// The export's per-frame `capture()` resolves the active camera at that frame. On the "Camera Path +
// AI Walk" example the camera's Track-To aims at the walker's Hips, so each resolve reaches the
// character's pose chain and its whole-clip `RetargetClip` — meant to run once per graph change.
// Without a cache that ran 3× per exported frame (measured: 5 frames 5,979 ms against 467 ms with
// one cache). The graph cannot change during an export, so one cache serves every frame: pure
// nodes are keyed without time and time-dependent ones with it (`evaluator.ts` cache key), so the
// shared cache is correct by construction, not by assumption. The parity test below checks that.
//
// What runs for real: the export function, the frame loop (`renderAnimation`) and its `capture()`
// closure, over the example's own graph. What is stubbed: pixels (no GPU here), the frame sink and
// the download.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { poses: { position: number[] }[] } = { poses: [] };

vi.mock('../render/renderToImage', () => ({
  clampRenderSize: (_gl: unknown, width: number, height: number) => ({ width, height }),
  createRenderScratch: () => ({ dispose: () => {} }),
  renderSceneToImageCanvas: (opts: { pose: { position: number[] } }) => {
    captured.poses.push(opts.pose);
    return Promise.resolve({} as HTMLCanvasElement);
  },
}));
vi.mock('../render/renderAnimation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/renderAnimation')>();
  return {
    ...actual,
    createPngSequenceSink: () => ({
      format: 'png-sequence' as const,
      addFrame: () => Promise.resolve(),
      finish: (frameCount: number) =>
        Promise.resolve({ blob: new Blob(), ext: 'zip', format: 'png-sequence', frameCount }),
      abort: () => {},
    }),
  };
});
vi.mock('./downloadBlob', () => ({ downloadBlob: () => {} }));

import { registerAllNodes } from '../nodes/registerAll';
import { __retargetRunsForTests } from '../nodes/RetargetClip';
import { buildExampleProject } from '../core/project/examples';
import { useDagStore } from '../core/dag/store';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useThreeRef } from './character/threeRef';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';
import { resolveActiveCameraPoseAt } from './activeCamera';
import { renderAnimationToFile } from './renderAnimationAction';

registerAllNodes();

/** The example as a director opens it: it is stored native (#1424), so the load door changes nothing. */
async function exampleState() {
  const project = await buildExampleProject('example_camera_path_ai_walk');
  return project.state;
}

const FRAMES = 6;

describe('#1318 — Render ▸ Animation resolves the scene once per export', () => {
  beforeEach(() => {
    captured.poses = [];
    useThreeRef.setState({ gl: {} as never, scene: {} as never });
    // A short timeline, so the export is a handful of frames: inclusive of 0 and the last.
    useTimeStore.getState().setDuration((FRAMES - 1) / FRAMES_PER_SECOND);
    useTimeStore.getState().setTime(0);
  });
  afterEach(() => {
    useThreeRef.setState({ gl: null, scene: null } as never);
  });

  it('retargets the walk once for the whole export, not three times per frame', async () => {
    useDagStore.setState({ state: await exampleState() } as never);
    const before = __retargetRunsForTests();

    const result = await renderAnimationToFile('png-sequence');

    expect(result).toEqual({ ok: true, format: 'png-sequence', frameCount: FRAMES });
    expect(captured.poses).toHaveLength(FRAMES);
    expect(__retargetRunsForTests() - before).toBe(1);
  }, 60_000);

  it('frames exactly the shot an uncached resolve gives at each frame', async () => {
    const state = await exampleState();
    useDagStore.setState({ state } as never);

    await renderAnimationToFile('png-sequence');

    expect(captured.poses).toHaveLength(FRAMES);
    captured.poses.forEach((pose, f) => {
      const alone = resolveActiveCameraPoseAt(state, f / FRAMES_PER_SECOND, createEvaluatorCache());
      expect(pose).toEqual(alone);
    });
    // And the shot moves: a cache that froze time would hand every frame the first pose.
    expect(captured.poses[FRAMES - 1].position).not.toEqual(captured.poses[0].position);
  }, 120_000);
});
