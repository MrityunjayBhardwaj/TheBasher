// Render ▸ Image resolves the scene through one cache, not three.
//
// A still reads the graph three times: the render output's settings, the active camera's pose at
// the playhead, and the depth of field (which re-resolves the pose when focus-on-target is set).
// On the "Camera Path + AI Walk" example the camera's Track-To aims at the walker's Hips, so each
// pose resolve reaches the character's pose chain and its whole-clip `RetargetClip`, which is
// meant to run once per graph change. Each walk with its own (or no) cache paid it again. The
// graph cannot change while one still renders, so one cache serves all three walks: pure nodes are
// keyed without time and time-dependent ones with it (`evaluator.ts` cache key). The parity test
// below checks the shared cache frames the same shot as a resolve on its own.
//
// What runs for real: `renderActiveProjectBlob` over the example's own graph. What is stubbed:
// pixels (no GPU here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { pose: unknown; dof: unknown }[] = [];

vi.mock('../render/renderToImage', () => ({
  renderSceneToPngBlob: (opts: { pose: unknown; dof: unknown }) => {
    captured.push({ pose: opts.pose, dof: opts.dof });
    return Promise.resolve(new Blob());
  },
}));

import { registerAllNodes } from '../nodes/registerAll';
import { __retargetRunsForTests } from '../nodes/RetargetClip';
import { buildExampleProject } from '../core/project/examples';
import { useDagStore } from '../core/dag/store';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useThreeRef } from './character/threeRef';
import { useTimeStore } from './stores/timeStore';
import { resolveActiveCameraPoseAt, selectActiveCameraNode } from './activeCamera';
import { cameraDataOf } from './cameraNode';
import { renderActiveProjectBlob } from './renderImageAction';

registerAllNodes();

/** The example as a director opens it: it is stored native (#1424), so the load door changes nothing. */
async function exampleState() {
  const project = await buildExampleProject('example_camera_path_ai_walk');
  return project.state;
}

const SECONDS = 2;

describe('Render ▸ Image resolves the scene once per still', () => {
  beforeEach(() => {
    captured.length = 0;
    useThreeRef.setState({ gl: {} as never, scene: {} as never });
    useTimeStore.getState().setTime(SECONDS);
  });
  afterEach(() => {
    useThreeRef.setState({ gl: null, scene: null } as never);
  });

  it('retargets the walk once for a still, not once per walk', async () => {
    useDagStore.setState({ state: await exampleState() } as never);
    const before = __retargetRunsForTests();

    const out = await renderActiveProjectBlob();

    expect(out).not.toBeNull();
    expect(captured).toHaveLength(1);
    expect(__retargetRunsForTests() - before).toBe(1);
  }, 60_000);

  it('shares the cache with depth of field when it focuses on the target', async () => {
    // The example's camera does not focus on its target, so its depth-of-field walk never
    // reaches the pose. Turned on, it re-resolves the pose — through the same cache.
    const state = await exampleState();
    const camera = selectActiveCameraNode(state);
    const lens = camera ? cameraDataOf(state, camera.id) : null;
    expect(lens).not.toBeNull();
    Object.assign(lens!.params as Record<string, unknown>, {
      dofEnabled: true,
      focusOnTarget: true,
    });
    useDagStore.setState({ state } as never);
    const before = __retargetRunsForTests();

    await renderActiveProjectBlob();

    expect(captured).toHaveLength(1);
    expect(captured[0].dof).not.toBeNull();
    expect(__retargetRunsForTests() - before).toBe(1);
  }, 60_000);

  it('frames exactly the shot an uncached resolve gives at the playhead', async () => {
    const state = await exampleState();
    useDagStore.setState({ state } as never);

    await renderActiveProjectBlob();

    expect(captured).toHaveLength(1);
    const seconds = useTimeStore.getState().seconds;
    expect(seconds).toBe(SECONDS);
    expect(captured[0].pose).toEqual(
      resolveActiveCameraPoseAt(state, seconds, createEvaluatorCache()),
    );
    // The settings are read at time 0 through the same cache; the shot at the playhead differs
    // from the shot at 0, so a cache that leaked time 0 into the pose would fail the line above.
    expect(captured[0].pose).not.toEqual(
      resolveActiveCameraPoseAt(state, 0, createEvaluatorCache()),
    );
  }, 60_000);
});
