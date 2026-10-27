// #1700 — a shot's speed, and the insert-time it makes: read back through the cuts' keys, the
// channels' keys and the scene clock (what plays), never through which camera is on screen.
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildCutOps } from './shotOps';
import { buildInsertTimeOps, buildShotSpeedOps, speedOver } from './shotSpeed';
import { sceneClockOf } from './sceneClock';
import { clockOf } from './subjectClock';

beforeAll(() => registerAllNodes());

const run = (s: DagState, ops: readonly Op[] | null | undefined): DagState => {
  expect(ops, 'the edit was refused').toBeTruthy();
  for (const op of ops!) s = applyOp(s, op).next;
  return s;
};
const lin = (time: number, value: number[]) => ({ time, value, easing: 'linear' });
const channel = (id: string, target: string): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'KeyframeChannelVec3',
  params: {
    name: 'position',
    target,
    paramPath: 'position',
    keyframes: [lin(1, [0, 0, 0]), lin(3, [1, 0, 0]), lin(6, [2, 0, 0])],
  },
});

/** Three shots — [0,2) default camera, [2,5) cam2, [5,10) cam3 — a keyed camera (cam2, film
 *  time) and a keyed box (scene time), both keyed at 1, 3 and 6 s. */
function film(): DagState {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  s = run(s, buildCutOps(s, 2, 'cam2'));
  s = run(s, buildCutOps(s, 5, 'cam3'));
  s = run(s, [channel('cam_keys', 'cam2'), channel('box_keys', 'n_box')]);
  return s;
}

const keyTimes = (s: DagState, id: string) =>
  ((s.nodes[id].params as { keyframes: { time: number }[] }).keyframes ?? []).map((k) => k.time);
const cutChannelId = (s: DagState) =>
  Object.values(s.nodes).find(
    (n) =>
      n.type === 'KeyframeChannelText' &&
      (n.params as { paramPath?: unknown }).paramPath === 'active',
  )!.id;
const frameEnd = (s: DagState) => (s.nodes.n_scene.params as { frameEnd: number }).frameEnd;

describe('#1700 — the fixture is on the clocks it claims', () => {
  it('the cuts and the camera are on film time, the box on scene time', () => {
    const s = film();
    expect(
      clockOf(
        s,
        cutChannelId(s) && (s.nodes[cutChannelId(s)].params as { target: string }).target,
        'active',
      ),
    ).toBe('film');
    expect(clockOf(s, 'cam2', 'position')).toBe('film');
    expect(clockOf(s, 'n_box', 'position')).toBe('scene');
    expect(keyTimes(s, cutChannelId(s))).toEqual([0, 2, 5]);
  });
});

describe('#1700 — insert time moves everything on film time, and only that', () => {
  it('moves the later cuts AND the later film-time keys by the same amount', () => {
    const s0 = film();
    const s = run(s0, buildInsertTimeOps(s0, 5, 3));
    // Both halves of the done-when, in one test: a version that moves only one reds here.
    expect(keyTimes(s, cutChannelId(s)), 'cuts').toEqual([0, 2, 8]);
    expect(keyTimes(s, 'cam_keys'), 'film-time keys').toEqual([1, 3, 9]);
    expect(keyTimes(s, 'box_keys'), 'scene-time keys stay').toEqual([1, 3, 6]);
    expect(frameEnd(s), 'the film is 3 s longer').toBe(600 + 180);
  });

  it('a key keeps every field but its time', () => {
    let s = film();
    s = run(s, [
      {
        type: 'setParam',
        nodeId: 'cam_keys',
        paramPath: 'keyframes',
        value: [{ ...lin(6, [2, 0, 0]), easing: 'cubic' }],
      },
    ]);
    s = run(s, buildInsertTimeOps(s, 5, 1));
    expect((s.nodes.cam_keys.params as { keyframes: unknown[] }).keyframes).toEqual([
      { ...lin(7, [2, 0, 0]), easing: 'cubic' },
    ]);
  });

  it('nothing to move is no ops', () => {
    expect(buildInsertTimeOps(film(), 5, 0)).toEqual([]);
  });
});

// The clock sums the speed on a 1/240 s grid (`sceneClock.ts`), so a speed measured across a
// step is good to about a millisecond: speeds are compared to 2 places, times to frames.
describe('#1700 — slowing a shot lengthens it', () => {
  it('Shot 2 at 50% runs twice as long; the later cut, the camera keys and End follow', () => {
    const s0 = film();
    const edit = buildShotSpeedOps(s0, 2, 5, 0.5)!;
    expect(edit.end, 'snapped to a frame').toBe(8);
    const s = run(s0, edit.ops);

    expect(keyTimes(s, cutChannelId(s))).toEqual([0, 2, 8]);
    expect(keyTimes(s, 'cam_keys')).toEqual([1, 3, 9]);
    expect(keyTimes(s, 'box_keys')).toEqual([1, 3, 6]);
    expect(frameEnd(s)).toBe(780);

    expect(speedOver(s, 0, 2), 'the shot before is untouched').toBeCloseTo(1, 2);
    expect(speedOver(s, 2, 8), 'the shot plays at 50%').toBeCloseTo(0.5, 2);
    expect(speedOver(s, 8, 13), 'the shot after resumes real time').toBeCloseTo(1, 2);

    // The camera moves with the action: the box's 6 s key (scene time) is first on screen at
    // 9 s on the playhead, where the camera's 6 s key moved to.
    const clock = sceneClockOf(s);
    expect(clock.sceneAt(8)).toBeCloseTo(5, 2);
    expect(clock.filmAt(6)).toBeCloseTo(9, 3);
  });

  it('one Undo restores all of it', () => {
    const s0 = film();
    const store = useDagStore.getState();
    store.hydrate(s0);
    const before = useDagStore.getState().state;
    const edit = buildShotSpeedOps(before, 2, 5, 0.5)!;
    useDagStore.getState().dispatchAtomic(edit.ops, 'user', 'Shot 2 at 50%');
    expect(keyTimes(useDagStore.getState().state, 'cam_keys')).toEqual([1, 3, 9]);
    useDagStore.getState().undo();
    const after = useDagStore.getState().state;
    expect(after.nodes).toEqual(before.nodes);
    expect(after.outputs).toEqual(before.outputs);
  });

  it('keep length: the shot covers twice the scene, and nothing after it moves', () => {
    const s0 = film();
    const edit = buildShotSpeedOps(s0, 2, 5, 2, { keepLength: true })!;
    expect(edit.end).toBe(5);
    const s = run(s0, edit.ops);
    expect(keyTimes(s, cutChannelId(s))).toEqual([0, 2, 5]);
    expect(keyTimes(s, 'cam_keys')).toEqual([1, 3, 6]);
    expect(frameEnd(s)).toBe(600);
    expect(speedOver(s, 2, 5)).toBeCloseTo(2, 2);
    expect(speedOver(s, 5, 10)).toBeCloseTo(1, 2);
  });

  it('speeding a shot up shortens it and pulls the later cut and keys in', () => {
    const s0 = film();
    const s = run(s0, buildShotSpeedOps(s0, 2, 5, 2)!.ops);
    expect(keyTimes(s, cutChannelId(s))).toEqual([0, 2, 3.5]);
    expect(keyTimes(s, 'cam_keys')).toEqual([1, 3, 4.5]);
    expect(frameEnd(s)).toBe(510);
    expect(speedOver(s, 2, 3.5)).toBeCloseTo(2, 2);
    expect(speedOver(s, 3.5, 8.5)).toBeCloseTo(1, 2);
  });

  it('re-timing a shot already slowed replaces its speed rather than stacking on it', () => {
    const s0 = film();
    const s1 = run(s0, buildShotSpeedOps(s0, 2, 5, 0.5)!.ops);
    const s2 = run(s1, buildShotSpeedOps(s1, 2, 8, 1)!.ops);
    expect(keyTimes(s2, cutChannelId(s2))).toEqual([0, 2, 5]);
    expect(keyTimes(s2, 'cam_keys')).toEqual([1, 3, 6]);
    expect(frameEnd(s2)).toBe(600);
    expect(speedOver(s2, 0, 10)).toBeCloseTo(1, 2);
  });

  it('a speed that cannot hold a length is refused', () => {
    expect(buildShotSpeedOps(film(), 2, 5, 0)).toBeNull();
    expect(buildShotSpeedOps(film(), 2, 5, Number.NaN)).toBeNull();
  });
});
