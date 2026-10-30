// #1688 — which clock a node runs on is the graph's answer: a camera or a cut is on the playhead,
// a node set to `film` is, and everything inherits the clock of what it hangs from.
//
// Every case runs in a scene slowed to a quarter: at speed 1 the two clocks are equal and a wrong
// answer is invisible. The playhead is at 4 s, so scene time is 1 s, and every keyed position
// below runs x = t (0 at 0 s, 8 at 8 s): x reads back the clock the thing was sampled on.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveWorldTransform } from './resolveWorldTransform';
import { sceneClockOf } from './sceneClock';
import { clockedCtx, clockOf } from './subjectClock';
import { useTimeStore } from './stores/timeStore';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

afterEach(() => {
  useTimeStore.getState().setTimeMap(null);
  useTimeStore.getState().setTime(0);
});

const FILM = 4;
const SCENE = 1;

function apply(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** x runs with time on `target`'s position: x = t. */
function keyedX(target: string): Op {
  return {
    type: 'addNode',
    nodeId: `ch_${target}`,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target,
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 8, value: [8, 0, 0], easing: 'linear' },
      ],
    },
  };
}

/** The default scene at quarter speed, with a Group `n_rig` in the scene holding a camera
 *  `n_cam2` (active), the rig keyed. `clock` is the rig's setting. */
function rigScene(clock?: 'film'): DagState {
  let state = buildDefaultDagState();
  const scene = state.outputs.scene!.node;
  state = apply(state, [
    { type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0.25 },
    {
      type: 'addNode',
      nodeId: 'n_rig',
      nodeType: 'Group',
      params: clock ? { clock } : {},
    },
    {
      type: 'connect',
      from: { node: 'n_rig', socket: 'out' },
      to: { node: scene, socket: 'children' },
    },
    keyedX('n_rig'),
  ]);
  state = makeSplitCamera(state, {
    objectId: 'n_cam2',
    position: [0, 0, 0],
    lens: { lookAt: [0, 0, -1] },
  }).state;
  return apply(state, [
    {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_rig', socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: scene, socket: 'camera' },
      replace: true,
    },
  ]);
}

/** The default scene at quarter speed with its camera keyed, and a cube `n_kid` hanging from it. */
function cameraChildScene(): DagState {
  let state = buildDefaultDagState();
  const scene = state.outputs.scene!.node;
  state = apply(state, [
    { type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0.25 },
    keyedX('n_camera'),
  ]);
  state = makeSplitCube(state, { objectId: 'n_kid' }).state;
  return apply(state, [
    {
      type: 'connect',
      from: { node: 'n_camera', socket: 'out' },
      to: { node: scene, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: 'n_kid', socket: 'out' },
      to: { node: 'n_camera', socket: 'children' },
    },
  ]);
}

describe('clockOf (#1688)', () => {
  it('the fixture is slowed: the playhead at 4 s is scene time 1 s', () => {
    expect(sceneClockOf(rigScene()).sceneAt(FILM)).toBe(SCENE);
  });

  it('a camera and its lens half are on the playhead; the Scene is, only for its speed', () => {
    const state = rigScene();
    expect(clockOf(state, 'n_cam2')).toBe('film');
    const lens = (state.nodes.n_cam2.inputs.data as { node: string }).node;
    expect(clockOf(state, lens)).toBe('film');
    const scene = state.outputs.scene!.node;
    expect(clockOf(state, scene, 'timeSpeed')).toBe('film');
    expect(clockOf(state, scene, 'frameEnd')).toBe('scene');
  });

  it('a rig is on scene time until it is set to film', () => {
    expect(clockOf(rigScene(), 'n_rig')).toBe('scene');
    expect(clockOf(rigScene('film'), 'n_rig')).toBe('film');
  });

  it('a child inherits the clock of what it hangs from', () => {
    expect(clockOf(cameraChildScene(), 'n_kid')).toBe('film');
    expect(clockOf(buildDefaultDagState(), 'n_box')).toBe('scene');
  });
});

describe('posing on the clock a thing runs on (#1688)', () => {
  it('a camera on a film rig moves with the rig at the playhead', () => {
    const pose = resolveCameraPoseAt(rigScene('film'), 'n_cam2', FILM);
    expect(pose.position[0]).toBeCloseTo(FILM);
  });

  it('a camera on a rig left on scene time hangs from it at scene time', () => {
    const pose = resolveCameraPoseAt(rigScene(), 'n_cam2', FILM);
    expect(pose.position[0]).toBeCloseTo(SCENE);
  });

  it('a camera read as a parent or a target is where it is drawn (#1643)', () => {
    const state = cameraChildScene();
    const drawn = resolveCameraPoseAt(state, 'n_camera', FILM).position[0];
    expect(drawn).toBeCloseTo(FILM);
    const ctx = clockedCtx(SCENE, FILM);
    expect(resolveWorldTransform(state, 'n_camera', ctx)?.position[0]).toBeCloseTo(drawn);
    expect(resolveWorldTransform(state, 'n_kid', ctx)?.position[0]).toBeCloseTo(drawn);
  });

  it('without the film time, the playhead is worked back through the scene clock', () => {
    const state = cameraChildScene();
    const sceneOnly = { time: { frame: SCENE * 60, seconds: SCENE, normalized: 0 } };
    expect(resolveWorldTransform(state, 'n_kid', sceneOnly)?.position[0]).toBeCloseTo(FILM);
  });

  it('the inspector reads a film rig at the playhead', () => {
    const xf = resolveEvaluatedTransform(rigScene('film'), 'n_rig', clockedCtx(SCENE, FILM));
    expect(xf?.position?.[0]).toBeCloseTo(FILM);
  });

  it('a context on the playhead still reads a scene-time thing at scene time', () => {
    // A film-time node's Track-To or Follow-Path hands its own (playhead) context to the
    // resolver for its target; the target keeps its own clock.
    const filmSide = clockedCtx(SCENE, FILM, 'film');
    expect(filmSide.time.seconds).toBe(FILM);
    expect(resolveWorldTransform(rigScene(), 'n_rig', filmSide)?.position[0]).toBeCloseTo(SCENE);
    expect(resolveEvaluatedTransform(rigScene(), 'n_rig', filmSide)?.position?.[0]).toBeCloseTo(
      SCENE,
    );
  });
});

describe('a moment held at speed 0 (#1688)', () => {
  /** The film rig, with the scene frozen: scene time is 0 at every playhead. */
  function frozen(): DagState {
    const state = rigScene('film');
    const scene = state.outputs.scene!.node;
    return apply(state, [{ type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0 }]);
  }

  it('the rig keeps moving at the live playhead while the scene is held', () => {
    const state = frozen();
    useTimeStore.getState().setTimeMap(sceneClockOf(state));
    useTimeStore.getState().setTime(FILM);
    expect(useTimeStore.getState().seconds).toBe(0);
    const sceneOnly = { time: { frame: 0, seconds: 0, normalized: 0 } };
    expect(resolveEvaluatedTransform(state, 'n_rig', sceneOnly)?.position?.[0]).toBeCloseTo(FILM);
    expect(resolveCameraPoseAt(state, 'n_cam2', FILM).position[0]).toBeCloseTo(FILM);
  });
});
