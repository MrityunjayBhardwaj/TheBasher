// #1456 — the times a consumer samples a wire at, so the poses it reads agree with the wire at every
// scene frame.
//
// A retarget and a bake both turn the wire into poses and join them with straight lines (slerp for a
// rotation). Two samples reproduce a segment between two keys only when the segment is itself a
// straight line in that space: linear, no handles, no modifiers, and in quaternion space. Before this
// the samples came from a key COUNT spread evenly over the range, measured on the real retarget:
// a key at 0.1 s of a 0 / 0.1 / 2 s curve was never sampled (85°), a step came out as a ramp (88°),
// and a cubic between sparse keys strayed 8.7°.
//
// The rule, from the references: Blender's bake visits every frame (`anim.py:314`,
// `range(frame_start, frame_end + 1, step)`), and Houdini retargets every frame of the source
// (KineFX "Retargeting"). Here the frame grid is filled only where it is needed:
//
//   - every key time, so no key is skipped;
//   - a constant segment gets the last frame before its closing key, so the hold holds at every
//     frame and the jump lands on the key's frame;
//   - any other segment two samples can't reproduce gets every scene frame inside it.
//
// A linear quaternion source (BVH, generated motion, Blender's per-frame glTF export) keeps just its
// keys, exactly the samples it had, so a dense clip does not double.
//
// REF: src/nodes/keyframeInterp.ts (`segmentQuat`, `segmentVec3`: the CLOSING key's easing shapes a
//      segment); src/nodes/PoseLayer.ts (`synchronizedSampler`, the euler read modes); issue #1456.

import { FRAMES_PER_SECOND } from '../core/sceneFrames';
import type { MotionPose } from './types';
import type { PoseLayerChannel, PoseLayerMember } from './PoseLayer';

/** Two times closer than this are one time. Well under a frame, well over float noise. */
const SAME_TIME = 1e-6;

/** What two neighbouring samples need between them to reproduce a segment. */
type Fill = 'none' | 'hold' | 'frames';

/** The scene frames strictly inside `(a, b)`. */
function framesInside(a: number, b: number, into: number[]): void {
  const first = Math.floor(a * FRAMES_PER_SECOND + SAME_TIME) + 1;
  for (let f = first; f / FRAMES_PER_SECOND < b - SAME_TIME; f++) into.push(f / FRAMES_PER_SECOND);
}

/** The last scene frame strictly before `b`, when it lies strictly after `a`. */
function frameBefore(a: number, b: number, into: number[]): void {
  const t = (Math.ceil(b * FRAMES_PER_SECOND - SAME_TIME) - 1) / FRAMES_PER_SECOND;
  if (t > a + SAME_TIME) into.push(t);
}

function fillSegment(fill: Fill, a: number, b: number, into: number[]): void {
  if (fill === 'hold') frameBefore(a, b, into);
  else if (fill === 'frames') framesInside(a, b, into);
}

/**
 * `times` sorted, made distinct, kept inside `[start, end]`, with both ends included — except a
 * motion keyed at one time, which is one pose and is sampled once, where it is keyed (#1249).
 */
function finish(start: number, end: number, times: number[]): number[] {
  const inside = times.filter((t) => t >= start && t <= end);
  const keyed = new Set(inside);
  if (keyed.size === 1) return [...keyed];
  const sorted = [start, end, ...inside].sort((x, y) => x - y);
  const out: number[] = [];
  for (const t of sorted) if (out.length === 0 || t - out[out.length - 1] > SAME_TIME) out.push(t);
  return out;
}

/**
 * A clip's sample times over `[start, end]`: every pose's time, and, for a stepped clip, the last
 * frame before each pose, so the hold reads at every frame. A linear clip's poses are quaternions
 * slerped between keys, which its own keys reproduce.
 */
export function clipSampleTimes(
  poses: readonly MotionPose[],
  start: number,
  end: number,
  interpolation: 'linear' | 'constant',
): number[] {
  const keys = [...new Set(poses.map((p) => p.time))].sort((x, y) => x - y);
  const times = [...keys];
  if (interpolation === 'constant') {
    for (let i = 1; i < keys.length; i++) frameBefore(keys[i - 1], keys[i], times);
  }
  return finish(start, end, times);
}

interface SegmentKey {
  readonly time: number;
  readonly value: number | readonly number[];
  readonly easing: string;
  readonly inHandle?: unknown;
  readonly outHandle?: unknown;
  readonly handleType?: unknown;
}

/** Two key values that are one value. */
function sameValue(a: SegmentKey['value'], b: SegmentKey['value']): boolean {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9);
}

/**
 * How the segment from `a` to `b` reads, as the samplers read it: by the CLOSING key's easing. A
 * segment whose two keys hold one value, with no handle to bow it and no modifier to bend it, is
 * flat whatever its easing — Blender writes a channel that doesn't move as a two-key step.
 */
function segmentFill(a: SegmentKey, b: SegmentKey, straight: boolean, bent: boolean): Fill {
  const handled =
    a.outHandle !== undefined ||
    b.inHandle !== undefined ||
    a.handleType !== undefined ||
    b.handleType !== undefined;
  // A modifier moves the curve inside any segment, a held one too.
  if (bent) return 'frames';
  if (!handled && sameValue(a.value, b.value)) return 'none';
  if (b.easing === 'constant') return 'hold';
  if (!straight || handled || b.easing !== 'linear') return 'frames';
  return 'none';
}

/** Whether a channel's modifier stack bends its curve away from the line between keys. */
function modified(channel: PoseLayerChannel): boolean {
  const own = (channel as { modifiers?: readonly unknown[] }).modifiers;
  const perAxis = (channel as { axisModifiers?: readonly (readonly unknown[] | null)[] })
    .axisModifiers;
  return (own?.length ?? 0) > 0 || (perAxis ?? []).some((m) => (m?.length ?? 0) > 0);
}

/**
 * An euler curve read axis by axis is a straight line between two keys only when one axis turns, by
 * less than half a turn: a fixed rotation times a turn about a fixed axis is a slerp. Two axes
 * turning together trace a curve no slerp follows (#1202).
 */
function oneAxisTurn(a: readonly number[], b: readonly number[]): boolean {
  let turning = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(b[i] - a[i]);
    if (d > SAME_TIME) {
      turning++;
      if (d >= 180) return false;
    }
  }
  return turning <= 1;
}

/**
 * A base layer's sample times over its keys' span: every key of every played channel but the
 * weight's, and the fills each segment needs (see the header). A rotation curve the member does not
 * read (an euler curve on a quaternion member, or the other way round) adds its keys and no fills.
 */
export function layerSampleTimes(
  channels: readonly PoseLayerChannel[],
  members: readonly PoseLayerMember[],
  start: number,
  end: number,
): number[] {
  const memberOf = new Map(members.map((m) => [m.bone, m]));
  const times: number[] = [];
  for (const channel of channels) {
    if (channel.component === 'weight' || channel.mute === true) continue;
    const keys = [...(channel.keyframes as readonly SegmentKey[])].sort((x, y) => x.time - y.time);
    for (const k of keys) times.push(k.time);
    const member = memberOf.get(channel.bone);
    const quaternionMember = member?.rotationMode === 'quaternion';
    if (channel.component === 'quaternion' && !quaternionMember) continue;
    if (channel.component === 'rotation' && (!member || quaternionMember)) continue;
    const bent = modified(channel);
    const synchronized = channel.component === 'rotation' && member?.eulerInterp === 'quaternion';
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1];
      const b = keys[i];
      if (synchronized) {
        // The keys become quaternions and are slerped by their easing; handles are not read.
        const plain = { outHandle: undefined, inHandle: undefined, handleType: undefined };
        const fill = segmentFill({ ...a, ...plain }, { ...b, ...plain }, true, bent);
        fillSegment(fill, a.time, b.time, times);
        continue;
      }
      const straight =
        channel.component !== 'rotation' ||
        oneAxisTurn(a.value as readonly number[], b.value as readonly number[]);
      fillSegment(segmentFill(a, b, straight, bent), a.time, b.time, times);
    }
  }
  return finish(start, end, times);
}
