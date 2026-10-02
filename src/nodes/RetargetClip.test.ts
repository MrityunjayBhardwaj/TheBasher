// RetargetClip — the retarget as an operator (#901).
//
// The rows here are about the two properties the node exists for: it reproduces
// the retarget math exactly, and it is a function of the GRAPH rather than of the
// frame. Everything else about it is inherited from `retargetClip()`, which has
// its own suite.

import { describe, expect, it } from 'vitest';
import { RetargetClipNode, RetargetClipParams } from './RetargetClip';
import { posedSkeletonFromClip } from './AnimationClip';
import { posesFromKeyframes } from '../core/import/keyframePoses';
import { PoseLayerNode, PoseLayerParams } from './PoseLayer';
import { restPoseOf } from './Skeleton';
import { retargetClip } from '../core/import/retarget';
import type {
  AnimationClipValue,
  AnimationKeyframe,
  BoneNameMapValue,
  BoneSpec,
  PosedSkeletonValue,
} from './types';
import { clipValueFromKeys } from '../test-utils/clipValue';

/**
 * Fresh operands per call — subject and expectation must never share an object.
 * A fixture that hands both sides the same array cannot be falsified: perturbing
 * "the source" moves the expectation with it and the comparison passes forever.
 */
function sourceBones(): BoneSpec[] {
  return [
    { name: 'mixamorig_Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'mixamorig_Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
  ];
}
function targetBones(): BoneSpec[] {
  return [
    { name: 'hips', parent: -1, position: [0, 1.2, 0], rotation: [0, 0, 0] },
    { name: 'spine', parent: 0, position: [0, 0.5, 0], rotation: [0, 0, 0] },
  ];
}
function sourceKeys(): AnimationKeyframe[] {
  return [
    { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
    { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
  ];
}
function nameMap(): Record<string, string> {
  return { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' };
}

function sourceClipValue(over: Partial<AnimationClipValue> = {}): AnimationClipValue {
  return clipValueFromKeys({
    kind: 'AnimationClip',
    name: 'walk',
    duration: 1,
    loop: 'hold',
    keyframes: sourceKeys(),
    skeleton: { kind: 'Skeleton', bones: sourceBones() },
    ...over,
  });
}
/** #1225 — the node reads the pose wire: the clip's pose, which carries the clip's range. */
function sourcePose(over: Partial<AnimationClipValue> = {}): PosedSkeletonValue {
  return posedSkeletonFromClip(sourceClipValue(over));
}
function boneMapValue(): BoneNameMapValue {
  return { kind: 'BoneNameMap', name: 'test bridge', map: nameMap() };
}

// The node emits TWO views of one retarget (#992/#974), so a test that wants the
// clip names the socket rather than taking the whole record. `evaluatePosed` is
// its twin; both go through the same call so they can never be given different
// operands by accident.
const evaluateBoth = (
  inputs: Record<string, unknown>,
  params = RetargetClipParams.parse({}),
): { out: AnimationClipValue; posed: PosedSkeletonValue } =>
  RetargetClipNode.evaluate(params, inputs as never, undefined as never) as {
    out: AnimationClipValue;
    posed: PosedSkeletonValue;
  };

const evaluate = (
  inputs: Record<string, unknown>,
  params = RetargetClipParams.parse({}),
): AnimationClipValue => evaluateBoth(inputs, params).out;

describe('RetargetClip — the operator', () => {
  it('reproduces retargetClip() exactly, from independently allocated operands', () => {
    // Both sides get their OWN objects, so a shared reference cannot make them
    // agree. The subject reads its operands off `inputs`; the expectation builds
    // its own from the same generators.
    const value = evaluate({
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    });
    const expected = retargetClip({
      sourceBones: sourceBones(),
      // #919 — the domain comes off the SAME generator the subject's operand does,
      // so the two sides agree by construction rather than by a literal restated
      // here. The fixture is deliberately `loop: 'hold'`, which is what makes the
      // `value.loop` row below a measurement instead of a coincidence.
      sourceClip: {
        name: 'walk',
        duration: 1,
        loop: sourceClipValue().loop,
        poses: posesFromKeyframes(sourceKeys(), sourceBones()),
      },
      targetBones: targetBones(),
      nameMap: nameMap(),
    });
    // #1225 — the value carries the retarget's timed poses on the target's bone names.
    expect(value.poses).toEqual(expected.clipParams.poses);
    expect(value.duration).toBe(expected.clipParams.duration);
    expect(value.name).toBe(expected.clipParams.name);
    expect(value.loop).toBe(expected.clipParams.loop);
    expect(value.poses.length).toBeGreaterThan(0);
  });

  it('is TIME-FREE and pure — the lever that keeps ~12ms off the frame path', () => {
    // `cost` is inert (`def.cost` has no readers anywhere), so this is the whole
    // of the cost decision, and it is structural: the evaluator only appends
    // `|t:frame.seconds` to the cache key for an IMPURE node, and only a `time`
    // input could make this one a function of the frame.
    expect(RetargetClipNode.pure).toBe(true);
    expect(Object.keys(RetargetClipNode.inputs ?? {})).toEqual(['source', 'boneMap', 'skeleton']);
    expect('time' in (RetargetClipNode.inputs ?? {})).toBe(false);
  });

  it('the CLIP carries no `pose` field — sampling lives on the separate `posed` output', () => {
    // This used to read `expect(value.pose).toBeUndefined()`, guarding a field
    // that was OPTIONAL: RetargetClip omitted it while AnimationClip answered
    // one. #920 made both producers time-free and removed the field, so the
    // claim climbed from a value nobody happens to set to one the TYPE forbids.
    //
    // It stays as a RUNTIME row rather than becoming a type-level assertion,
    // and the reason is measurable: `npm run typecheck` cannot see `*.test.*`,
    // so a `@ts-expect-error` here would be a gate CI never runs. `in` is
    // checked when the suite executes, which CI does.
    //
    // #992/#974 did NOT weaken this. The node now also emits a posed rig, but on
    // its own `posed` SOCKET — the clip value itself still carries no pose, so a
    // reader of `out` cannot mistake a description of motion for a sample of it.
    // The row below pins the two as views of one computation.
    const value = evaluate({
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    });
    expect('pose' in value).toBe(false);
    // …while still answering everything a clip IS asked for.
    expect(value.kind).toBe('AnimationClip');
    expect(value.poses.length).toBeGreaterThan(0);
  });

  it('`posed` is the SAME motion as `out`, sampled — the two cannot disagree', () => {
    // The point of emitting both from one evaluate. If `posed` were built from
    // anything but the clip `out` carries, the pose lane and the clip lane would
    // be two answers to where a bone is at t, which is the exact defect the
    // shared sampler factory exists to prevent.
    const { out, posed } = evaluateBoth({
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    });
    expect(posed.kind).toBe('PosedSkeleton');
    // Same rig object, not merely an equal one.
    expect(posed.skeleton).toBe(out.skeleton);
    // One pose per target bone, index-aligned.
    const at0 = posed.sample(0);
    expect(at0).toHaveLength(out.skeleton.bones.length);
    expect(at0.map((p) => p.name)).toEqual(out.skeleton.bones.map((b) => b.name));
    // Independently sampling the clip through the shared factory agrees.
    const viaClip = posedSkeletonFromClip(out).sample(0.5);
    expect(posed.sample(0.5)).toEqual(viaClip);
  });

  it('carries the TARGET rig, because the emitted indices are the target’s', () => {
    const value = evaluate({
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    });
    expect(value.skeleton.bones.map((b) => b.name)).toEqual(['hips', 'spine']);
    // #1225 — every bone a pose names is one of the target's.
    const names = new Set(value.skeleton.bones.map((b) => b.name));
    for (const pose of value.poses) {
      for (const name of Object.keys(pose.bones)) expect(names.has(name), name).toBe(true);
    }
    expect(value.poses.length).toBeGreaterThan(0);
  });

  it('answers EMPTY for a half-wired graph — never the source’s own keys', () => {
    // The dangerous failure is not "no motion"; it is the source's 78-bone
    // indices arriving on a 23-bone rig and looking like a retarget bug. Each
    // missing input is asserted separately so one guard cannot cover another.
    const full = {
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    };
    for (const missing of ['source', 'boneMap', 'skeleton'] as const) {
      const inputs: Record<string, unknown> = { ...full };
      delete inputs[missing];
      const value = evaluate(inputs);
      expect(value.poses, `${missing} unwired`).toEqual([]);
    }
    // A rig with no bones is the same case wearing a wired edge.
    expect(evaluate({ ...full, skeleton: { kind: 'Skeleton', bones: [] } }).poses).toEqual([]);
    // The control: with everything wired it is NOT empty, so the rows above are
    // measuring the guards and not a subject that never produces anything.
    expect(evaluate(full).poses.length).toBeGreaterThan(0);
  });

  it('takes the output name from its param, and derives one when it is blank', () => {
    const inputs = {
      source: sourcePose(),
      boneMap: boneMapValue(),
      skeleton: { kind: 'Skeleton', bones: targetBones() },
    };
    expect(evaluate(inputs).name).toBe('walk_retargeted');
    expect(evaluate(inputs, RetargetClipParams.parse({ name: 'Robot motion' })).name).toBe(
      'Robot motion',
    );
  });
});

describe('RetargetClip reads the pose wire (#1225)', () => {
  const target = () => ({ kind: 'Skeleton' as const, bones: targetBones() });
  const DEG = 180 / Math.PI;

  /** The fixture's motion as keys on a base layer over the source rig's rest pose: the shape a
   *  character's own motion takes (#1211). Degrees, XYZ members; the keys turn about Y alone. */
  function baseLayerWire(shift = 0): PosedSkeletonValue {
    const rest = restPoseOf({ kind: 'Skeleton', bones: sourceBones() });
    const byBone = new Map<number, AnimationKeyframe[]>();
    for (const k of sourceKeys()) byBone.set(k.bone, [...(byBone.get(k.bone) ?? []), k]);
    const names = sourceBones().map((b) => b.name);
    const channels = [...byBone].flatMap(([bone, keys]) => [
      {
        bone: names[bone],
        component: 'position',
        keyframes: keys.map((k) => ({ time: k.time + shift, value: k.position, easing: 'linear' })),
      },
      {
        bone: names[bone],
        component: 'rotation',
        keyframes: keys.map((k) => ({
          time: k.time + shift,
          value: k.rotation.map((r) => r * DEG),
          easing: 'linear',
        })),
      },
    ]);
    return PoseLayerNode.evaluate(
      PoseLayerParams.parse({
        name: 'walk',
        members: names.map((bone) => ({ bone, rotationMode: 'XYZ' })),
        channels,
      }),
      { pose: rest },
      undefined as never,
    ) as PosedSkeletonValue;
  }

  it('the same motion as a clip and as a base layer retargets the same', () => {
    const viaClip = evaluate({ source: sourcePose(), boneMap: boneMapValue(), skeleton: target() });
    const viaLayer = evaluate({
      source: baseLayerWire(),
      boneMap: boneMapValue(),
      skeleton: target(),
    });
    expect(viaLayer.poses).toHaveLength(viaClip.poses.length);
    viaLayer.poses.forEach((pose, i) => {
      const c = viaClip.poses[i];
      expect(pose.time).toBe(c.time);
      expect(Object.keys(pose.bones)).toEqual(Object.keys(c.bones));
      for (const [name, bone] of Object.entries(pose.bones)) {
        for (let a = 0; a < 3; a++)
          expect(bone.position![a]).toBeCloseTo(c.bones[name].position![a], 6);
        for (let a = 0; a < 4; a++) {
          expect(bone.quaternion![a]).toBeCloseTo(c.bones[name].quaternion![a], 6);
        }
      }
    });
    expect(viaLayer.name).toBe('walk_retargeted');
    expect(viaLayer.poses.length).toBeGreaterThan(0);
  });

  it('a range that starts after 0 is sampled over its span and placed back where it plays', () => {
    const shifted = evaluate({
      source: baseLayerWire(0.5),
      boneMap: boneMapValue(),
      skeleton: target(),
    });
    const unshifted = evaluate({
      source: baseLayerWire(),
      boneMap: boneMapValue(),
      skeleton: target(),
    });
    expect(shifted.poses.map((p) => p.time)).toEqual(unshifted.poses.map((p) => p.time + 0.5));
    expect(shifted.duration).toBeCloseTo(1.5, 9);
    shifted.poses.forEach((pose, i) => {
      for (const [name, bone] of Object.entries(pose.bones)) {
        bone.quaternion!.forEach((q, a) =>
          expect(q).toBeCloseTo(unshifted.poses[i].bones[name].quaternion![a], 9),
        );
      }
    });
    expect(shifted.poses.length).toBeGreaterThan(0);
  });

  it('`sampleRate` overrides the rate the wire carries', () => {
    const inputs = { source: sourcePose(), boneMap: boneMapValue(), skeleton: target() };
    const times = (v: AnimationClipValue) => v.poses.length;
    // The clip's own rate: 2 keys over 1 s, so 2 samples.
    expect(times(evaluate(inputs))).toBe(2);
    expect(times(evaluate(inputs, RetargetClipParams.parse({ sampleRate: 10 })))).toBe(10);
  });

  it('a wire with no range (a skeleton at rest) has no motion to retarget', () => {
    const rest = restPoseOf({ kind: 'Skeleton', bones: sourceBones() });
    expect(rest.clip).toBeUndefined();
    expect(evaluate({ source: rest, boneMap: boneMapValue(), skeleton: target() }).poses).toEqual(
      [],
    );
  });

  it('carries the source name and end behaviour across, from the wire', () => {
    const value = evaluate({
      source: sourcePose({ name: 'jog', loop: 'cycle-offset' }),
      boneMap: boneMapValue(),
      skeleton: target(),
    });
    expect(value.name).toBe('jog_retargeted');
    expect(value.loop).toBe('cycle-offset');
  });
});
