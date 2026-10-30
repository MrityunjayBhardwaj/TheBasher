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
    // #1744 — the 3 s key is inside the shot: it moves with the scene time it shows (3 s of
    // scene, now on screen at 4 s), so the camera stays on the action it was keyed against.
    expect(keyTimes(s, 'cam_keys')).toEqual([1, 4, 9]);
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
    // And inside the shot: the box's 3 s key is on screen at 4 s, where the camera's moved to.
    expect(clock.filmAt(3)).toBeCloseTo(4, 2);
  });

  it('one Undo restores all of it', () => {
    const s0 = film();
    const store = useDagStore.getState();
    store.hydrate(s0);
    const before = useDagStore.getState().state;
    const edit = buildShotSpeedOps(before, 2, 5, 0.5)!;
    useDagStore.getState().dispatchAtomic(edit.ops, 'user', 'Shot 2 at 50%');
    expect(keyTimes(useDagStore.getState().state, 'cam_keys')).toEqual([1, 4, 9]);
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
    expect(keyTimes(s, 'cam_keys')).toEqual([1, 2.5, 4.5]);
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

  // #1744 — speeding up removes film time. A key inside the shot past its new end used to stay
  // put while the keys after the shot moved in past it, so the channel's keys came out of order.
  it('speeding up never puts a later key before an earlier one', () => {
    let s0 = film();
    s0 = run(s0, [
      {
        type: 'setParam',
        nodeId: 'cam_keys',
        paramPath: 'keyframes',
        value: [lin(1, [0, 0, 0]), lin(4.5, [1, 0, 0]), lin(6, [2, 0, 0])],
      },
    ]);
    const s = run(s0, buildShotSpeedOps(s0, 2, 5, 3)!.ops);
    const [k1, kA, kB] = keyTimes(s, 'cam_keys');
    expect(k1).toBe(1);
    expect(kA, 'the 4.5 s key stays inside the shot, now [2, 3)').toBeCloseTo(2 + 2.5 / 3, 3);
    expect(kB, 'the 6 s key moves in with the shot after').toBeCloseTo(4, 3);
    const values = (s.nodes.cam_keys.params as { keyframes: { value: number[] }[] }).keyframes.map(
      (k) => k.value[0],
    );
    expect(values, 'the keys play in the order they were keyed').toEqual([0, 1, 2]);
  });

  // #1744 — the last shot ends exactly at End. End only moved for a shot ending before it, so
  // the last shot's new length was reported and never played.
  it('the last shot at 50% moves End with it', () => {
    const s0 = film();
    const edit = buildShotSpeedOps(s0, 5, 10, 0.5)!;
    expect(edit.end).toBe(15);
    const s = run(s0, edit.ops);
    expect(frameEnd(s), 'End follows the shot').toBe(900);
    expect(keyTimes(s, cutChannelId(s))).toEqual([0, 2, 5]);
    expect(speedOver(s, 5, 15)).toBeCloseTo(0.5, 2);
  });

  it('the last shot at 200% pulls End in', () => {
    const s0 = film();
    const s = run(s0, buildShotSpeedOps(s0, 5, 10, 2)!.ops);
    expect(frameEnd(s)).toBe(450);
  });

  // #1744 — a shot after a speed ramp. The ramp's last key before the shot shapes the curve up to
  // the next key, which is now the shot's own; without a held key the shot before would ramp into
  // the new speed instead of playing as it did.
  it('the shot before a re-timed shot plays as it did when the speed was ramping into it', () => {
    let s0 = film();
    s0 = run(s0, [
      {
        type: 'addNode',
        nodeId: 'speed_ramp',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'timeSpeed',
          target: 'n_scene',
          paramPath: 'timeSpeed',
          keyframes: [
            { time: 0, value: 1, easing: 'linear' },
            { time: 10, value: 2, easing: 'linear' },
          ],
        },
      },
    ]);
    const before = speedOver(s0, 0, 2);
    const s = run(s0, buildShotSpeedOps(s0, 2, 5, 0.5)!.ops);
    expect(speedOver(s, 0, 2), 'the shot before is untouched').toBeCloseTo(before, 2);
    expect(speedOver(s, 2, 2 + 0.5), 'the shot plays at 50%').toBeCloseTo(0.5, 2);
  });

  // #1744 — the old curve has a key at the shot's old end, so it lands right on the new end. Its
  // easing is how the curve arrives at it, which is the shot's own span: a linear key there would
  // ramp the shot toward the resumed speed instead of holding the one it was given.
  it('a speed key at the end of the shot does not ramp the shot', () => {
    let s0 = film();
    s0 = run(s0, [
      {
        type: 'addNode',
        nodeId: 'speed_ramp',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'timeSpeed',
          target: 'n_scene',
          paramPath: 'timeSpeed',
          keyframes: [
            { time: 0, value: 1, easing: 'constant' },
            { time: 5, value: 1, easing: 'linear' },
            { time: 10, value: 2, easing: 'linear' },
          ],
        },
      },
    ]);
    const s = run(s0, buildShotSpeedOps(s0, 2, 5, 0.5)!.ops);
    expect(speedOver(s, 2, 8 - 1 / 60), 'the shot holds 50%').toBeCloseTo(0.5, 2);
    expect(speedOver(s, 8, 13), 'the ramp after resumes as it was').toBeCloseTo(
      speedOver(s0, 5, 10),
      2,
    );
  });

  // #1752 — a held shot (the speed is 0 across it) covers no scene time, so a length cannot be
  // derived from it: it used to collapse to nothing, its cut landing on the next one. It keeps its
  // length and plays at the speed it was given.
  const held = (keys: { time: number; value: number }[]) =>
    run(film(), [
      {
        type: 'addNode',
        nodeId: 'speed_held',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'timeSpeed',
          target: 'n_scene',
          paramPath: 'timeSpeed',
          keyframes: keys.map((k) => ({ ...k, easing: 'constant' })),
        },
      },
    ]);
  it('a held shot given a speed keeps its length and plays at that speed', () => {
    const s0 = held([
      { time: 0, value: 1 },
      { time: 2, value: 0 },
      { time: 5, value: 1 },
    ]);
    expect(speedOver(s0, 2, 5), 'the shot is held').toBeCloseTo(0, 2);
    const edit = buildShotSpeedOps(s0, 2, 5, 0.5)!;
    expect(edit.end).toBe(5);
    const s = run(s0, edit.ops);
    expect(keyTimes(s, cutChannelId(s))).toEqual(keyTimes(s0, cutChannelId(s0)));
    expect(speedOver(s, 2, 5 - 1 / 60), 'the shot plays at 50%').toBeCloseTo(0.5, 2);
  });

  // #1752 — keys inside a held stretch of a shot all show the same scene moment, so moving each
  // with the scene time it shows put them on one time, with different values. They stay in order,
  // each after the one before.
  it('keys inside a held stretch of a re-timed shot stay in order at distinct times', () => {
    let s0 = held([
      { time: 0, value: 1 },
      { time: 3, value: 0 },
      { time: 4.5, value: 1 },
    ]);
    s0 = run(s0, [
      {
        type: 'addNode',
        nodeId: 'held_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'cam2',
          paramPath: 'position',
          keyframes: [lin(2.5, [0, 0, 0]), lin(3.5, [1, 0, 0]), lin(4, [2, 0, 0])],
        },
      },
    ]);
    const s = run(s0, buildShotSpeedOps(s0, 2, 5, 1)!.ops);
    const times = keyTimes(s, 'held_keys');
    const values = (s.nodes.held_keys.params as { keyframes: { value: number[] }[] }).keyframes.map(
      (k) => k.value[0],
    );
    expect(values, 'in their old order').toEqual([0, 1, 2]);
    for (let i = 1; i < times.length; i++)
      expect(times[i], `key ${i} after key ${i - 1}`).toBeGreaterThan(times[i - 1]);
  });

  it('a speed that cannot hold a length is refused', () => {
    expect(buildShotSpeedOps(film(), 2, 5, 0)).toBeNull();
    expect(buildShotSpeedOps(film(), 2, 5, Number.NaN)).toBeNull();
  });
});
