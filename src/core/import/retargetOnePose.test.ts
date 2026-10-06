// #1249 — a one-pose motion retargets to one pose, timed where the source times it.
//
// Three's `SkeletonUtils.retargetClip` samples as many frames as the longest track has keys and
// stamps frame `i` at `i · duration / (frames − 1)` (SkeletonUtils.js:203, 213-214, 252). A one-pose
// source is one frame at `0 · ∞ = NaN`, and at duration 0 it is no frames at all. Measured before
// the fix on `kimodo-served-f0.bvh`: 78 of 78 keys at NaN; at duration 0, 0 keys.
//
// The oracle for the VALUES is independent of the fix: the same pose written as two identical
// frames, which three samples the ordinary way. The one-pose result must equal that result's
// first frame, so a fix that got the times right by producing some other pose would still red.
//
// What it changes for a user, measured: nothing observed yet. Through the RetargetClip node the pose
// plays and bakes correctly with NaN times, because the pose wire reads the clip's duration, not its
// key times, and no production road writes a retarget's keys into params (the AnimationClip schema
// rejects a NaN time). The fix is to the value every reader of the retarget sees, before one does.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBvh } from './bvh';
import { retargetClip, type RetargetArgs } from './retarget';
import type { MotionPose } from '../../nodes/types';
import { evaluate } from '../dag/evaluator';
import { registerAllNodes } from '../../nodes/registerAll';

const fixture = parseBvh(
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/kimodo-served-f0.bvh'), 'utf8'),
  'f0',
  0.01,
);
const bones = fixture.skeletonParams.bones;
const identity = Object.fromEntries(bones.map((b) => [b.name, b.name]));

function run(poses: readonly MotionPose[], duration: number) {
  return retargetClip({
    sourceBones: bones,
    targetBones: bones,
    nameMap: identity,
    sourceClip: { ...fixture.clipParams, duration, poses },
  } as RetargetArgs).clipParams;
}

const at = (time: number) => fixture.clipParams.poses.map((p) => ({ ...p, time }));

/** The same pose as two identical frames: three's ordinary path, whose first frame is the answer. */
function twoFrameOracle(): readonly MotionPose[] {
  const out = run([...at(0), ...at(1)], 1);
  return out.poses.filter((p) => p.time === 0);
}

function close(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
}

/** Every bone of `got` whose rotation or position is off `want`'s, plus any either one lacks. */
function bonesOff(got: MotionPose, want: MotionPose): string[] {
  const names = new Set([...Object.keys(got.bones), ...Object.keys(want.bones)]);
  return [...names].filter((n) => {
    const g = got.bones[n];
    const w = want.bones[n];
    return !g || !w || !close(g.quaternion, w.quaternion) || !close(g.position, w.position);
  });
}

describe('a one-pose motion retargets to one pose (#1249)', () => {
  beforeAll(() => registerAllNodes());

  it('the fixture has one pose: every source key at one time', () => {
    expect(fixture.clipParams.poses.map((p) => p.time)).toEqual([0]);
  });

  it('keys it at the time the source keys it, with the pose three samples for it', () => {
    const oracle = twoFrameOracle();
    expect(oracle.length).toBe(1);
    expect(Object.keys(oracle[0].bones).length).toBeGreaterThan(0);
    const out = run(fixture.clipParams.poses, fixture.clipParams.duration);
    expect(out.poses.map((p) => p.time)).toEqual([0]);
    expect(bonesOff(out.poses[0], oracle[0])).toEqual([]);
    expect(out.duration).toBe(fixture.clipParams.duration);
  });

  it('a pose keyed away from zero keeps its time', () => {
    const out = run(at(0.5), 1);
    expect(out.poses.map((p) => p.time)).toEqual([0.5]);
  });

  it('a pose with a duration of 0 is kept, not dropped, and keeps its duration', () => {
    const out = run(at(0), 0);
    expect(out.poses.map((p) => p.time)).toEqual([0]);
    expect(bonesOff(out.poses[0], twoFrameOracle()[0])).toEqual([]);
    expect(out.duration).toBe(0);
  });

  it('the RetargetClip node carries the pose at a real time, and plays it', () => {
    // The product road: a one-frame clip's pose wire into a RetargetClip. Its evaluated clip is what
    // every reader of the retarget sees. Before the fix its one pose sat at NaN; the posed view below
    // played the right pose even then (it samples the clip's duration, not the key times), so the
    // time assertion is the one that reds, and the pose assertion guards playback.
    const map = Object.fromEntries(bones.map((b) => [b.name, b.name]));
    const node = (id: string, type: string, params: unknown, inputs: object = {}) => ({
      id,
      type,
      version: 1,
      params,
      inputs,
    });
    const state = {
      nodes: {
        sskel: node('sskel', 'Skeleton', { bones }),
        clip: node('clip', 'AnimationClip', fixture.clipParams, {
          skeleton: { node: 'sskel', socket: 'out' },
        }),
        tskel: node('tskel', 'Skeleton', { bones }),
        map: node('map', 'BoneNameMap', { name: 'identity', map }),
        rt: node(
          'rt',
          'RetargetClip',
          { name: '', active: false },
          {
            source: { node: 'clip', socket: 'pose' },
            boneMap: { node: 'map', socket: 'out' },
            skeleton: { node: 'tskel', socket: 'out' },
          },
        ),
      },
      outputs: {},
    };
    type Posed = { sample: (s: number) => readonly { quaternion: readonly number[] }[] };
    const value = evaluate(state as never, 'rt').value as {
      out: { poses: readonly { time: number }[] };
      posed: Posed;
    };
    expect(value.out.poses.map((p) => p.time)).toEqual([0]);

    const oracle = run([...at(0), ...at(1)], 1);
    const oracleState = {
      nodes: {
        skel: node('skel', 'Skeleton', { bones }),
        clip: node('clip', 'AnimationClip', oracle, { skeleton: { node: 'skel', socket: 'out' } }),
      },
      outputs: {},
    };
    const want = (evaluate(oracleState as never, 'clip').value as { pose: Posed }).pose.sample(0);
    for (const t of [0, 0.5, 3]) {
      const got = value.posed.sample(t);
      const off = got.filter((p, k) => !close(p.quaternion, want[k].quaternion)).length;
      expect(off, `bones off the pose at t=${t}`).toBe(0);
    }
  });

  it('a motion of more than one pose is untouched: its times are three’s own', () => {
    const walk = parseBvh(
      readFileSync(resolve(process.cwd(), 'public/fixtures/anim/walk.bvh'), 'utf8'),
      'walk',
    );
    const map = Object.fromEntries(walk.skeletonParams.bones.map((b) => [b.name, b.name]));
    const out = retargetClip({
      sourceBones: walk.skeletonParams.bones,
      targetBones: walk.skeletonParams.bones,
      nameMap: map,
      sourceClip: walk.clipParams,
    } as RetargetArgs).clipParams;
    expect(out.poses.map((p) => p.time)).toEqual(
      walk.clipParams.poses.map((p) => Math.fround(p.time)),
    );
    expect(out.duration).toBeCloseTo(walk.clipParams.duration, 6);
  });
});
