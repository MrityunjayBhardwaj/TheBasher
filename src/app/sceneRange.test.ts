// #1287 — the scene owns its End, and the playhead is not held inside it.
//
// Before: the playable range was a fixed 10 s in a UI store that nothing in 3D could change, and
// `setTime` clamped to it, so a 12.1 s walk sampled at 10.86 s, 11.7 s and 12.07 s put the Hips in
// the same spot all three times. Blender keeps End on the scene, loops playback there, and lets the
// playhead go past it (observed in 4.5: frame 500 with End at 250 is allowed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { buildExampleProject } from '../core/project/examples';
import { registerAllNodes } from '../nodes/registerAll';
import {
  buildSetSceneEndOps,
  DEFAULT_SCENE_FRAME_END,
  sceneEndSeconds,
  sceneFrameEnd,
} from './sceneRange';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function withEnd(state: DagState, seconds: number): DagState {
  for (const op of buildSetSceneEndOps(state, seconds)) state = applyOp(state, op).next;
  return state;
}

describe('#1287 — the scene End', () => {
  it('a project saved before End existed plays the 10 s it always did', async () => {
    // The example's file was written before End existed: its Scene has no `frameEnd`.
    const file = readFileSync(
      join(__dirname, '../core/project/exampleScenes/cameraPathAiWalk.basher.json'),
      'utf8',
    );
    expect(file).not.toContain('frameEnd');
    const state = (await buildExampleProject('example_camera_path_ai_walk')).state;
    expect(sceneFrameEnd(state)).toBe(DEFAULT_SCENE_FRAME_END);
    expect(sceneEndSeconds(state)).toBe(10);
    // And a new scene starts at the same 10 s.
    expect(sceneEndSeconds(buildDefaultDagState())).toBe(10);
  });

  it('End is set on the Scene node by an op the schema keeps, rounded to a frame', () => {
    const state = withEnd(buildDefaultDagState(), 12.1);
    const scene = state.outputs.scene!.node;
    // The op went through applyOp's schema: an undeclared param would have been dropped.
    expect((state.nodes[scene].params as { frameEnd?: number }).frameEnd).toBe(726);
    expect(sceneEndSeconds(state)).toBeCloseTo(12.1, 6);
  });

  it('a same-frame End is no edit, and End never drops below one frame', () => {
    const state = buildDefaultDagState();
    expect(buildSetSceneEndOps(state, 10)).toEqual([]);
    expect(buildSetSceneEndOps(state, 10.004)).toEqual([]);
    expect(sceneFrameEnd(withEnd(state, 0))).toBe(1);
    expect(buildSetSceneEndOps(state, Number.NaN)).toEqual([]);
  });
});

describe('#1287 — the playhead past End', () => {
  beforeEach(() => {
    useTimeStore.getState().pause();
    useTimeStore.getState().setDuration(10);
    useTimeStore.getState().setTime(0);
  });

  it('with End at 10 s and content to 12.1 s, the playhead reaches 11.7 s and stays there', () => {
    useTimeStore.getState().setRange(10, 12.1);
    useTimeStore.getState().setTime(11.7);
    expect(useTimeStore.getState().seconds).toBe(11.7);
    expect(useTimeStore.getState().frame).toBe(Math.round(11.7 * FRAMES_PER_SECOND));
    // It stops at the reach, not at End.
    useTimeStore.getState().setTime(99);
    expect(useTimeStore.getState().seconds).toBe(12.1);
  });

  it('moving End does not move a playhead it still reaches (Blender leaves it where it is)', () => {
    useTimeStore.getState().setRange(10, 12.1);
    useTimeStore.getState().setTime(11);
    useTimeStore.getState().setRange(8, 12.1);
    expect(useTimeStore.getState().seconds).toBe(11);
    // A reach that shrinks below it does pull it in.
    useTimeStore.getState().setRange(8, 9);
    expect(useTimeStore.getState().seconds).toBe(9);
  });

  it('playback loops at End, and from past End starts again at 0', () => {
    useTimeStore.getState().setRange(10, 12.1);
    useTimeStore.getState().setTime(9.99);
    useTimeStore.getState().play();
    useTimeStore.getState().tick(0.02);
    expect(useTimeStore.getState().seconds).toBeCloseTo(0.01, 6);

    useTimeStore.getState().setTime(11);
    useTimeStore.getState().tick(0.02);
    expect(useTimeStore.getState().seconds).toBe(0);
  });

  it('Video mode sizing the range lets the playhead reach exactly that far', () => {
    useTimeStore.getState().setRange(10, 12.1);
    useTimeStore.getState().setDuration(5);
    useTimeStore.getState().setTime(7);
    expect(useTimeStore.getState().seconds).toBe(5);
  });
});
