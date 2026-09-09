// PoseOverride — the pose lane's first consumer (#974, v3 of the armature epic).
//
// The rows here pin the four properties that are not obvious from reading it:
// pass-through is BY REFERENCE, the win signal is PRESENCE not value, the
// rewrite is copy-on-write, and `evaluate` samples nothing.
//
// REF: src/nodes/PoseOverride.ts; src/nodes/MaterialOverride.ts (the shape);
//      issues #974, #992, #900.

import { describe, expect, it } from 'vitest';
import { PoseOverrideNode, PoseOverrideParams } from './PoseOverride';
import type { BonePose, PosedSkeletonValue, SkeletonValue, Vec3 } from './types';

const BONES: SkeletonValue = {
  kind: 'Skeleton',
  bones: [
    { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'mixamorig_Hips', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'mixamorig_Spine', parent: 1, position: [0, 2, 0], rotation: [0, 0, 0] },
  ],
};

/** An upstream pose whose values MOVE with time, so a frozen result is visible. */
function upstream(): PosedSkeletonValue {
  return {
    kind: 'PosedSkeleton',
    skeleton: BONES,
    sample: (seconds: number): readonly BonePose[] =>
      BONES.bones.map((b, i) => ({
        bone: i,
        position: [b.position[0], b.position[1] + seconds, b.position[2]] as Vec3,
        rotation: [seconds * 10, 0, 0] as Vec3,
      })),
  };
}

const evalWith = (params: Record<string, unknown>, pose = upstream()): PosedSkeletonValue =>
  PoseOverrideNode.evaluate(
    PoseOverrideParams.parse(params),
    { pose } as never,
    undefined as never,
    undefined as never,
    // A node's `evaluate` is declared `O | Record<string, O>` for the multi-output
    // form (core/dag/types.ts:523); this one has a single socket, so the cast
    // names which arm applies rather than widening anything.
  ) as PosedSkeletonValue;

describe('PoseOverride', () => {
  it('passes the upstream pose through BY REFERENCE when nothing is authored', () => {
    const up = upstream();
    // Identity, not equality: an inert override must not perturb a downstream
    // identity check, which is the whole reason the lane is a function of time.
    expect(evalWith({ bone: 'mixamorig_Hips' }, up)).toBe(up);
    expect(evalWith({}, up)).toBe(up);
  });

  it('passes through when the named bone is not on this rig — an unbound name is authoring, not an error', () => {
    const up = upstream();
    expect(
      evalWith({ bone: 'nonesuch', position: [9, 9, 9], overridden: { position: true } }, up),
    ).toBe(up);
  });

  it('replaces only the authored component, leaving the other to the upstream', () => {
    const v = evalWith({
      bone: 'mixamorig_Hips',
      position: [7, 7, 7],
      rotation: [1, 2, 3],
      overridden: { position: true },
    });
    const at2 = v.sample(2);
    expect(at2[1].position).toEqual([7, 7, 7]);
    // rotation was NOT authored, so it still tracks time.
    expect(at2[1].rotation).toEqual([20, 0, 0]);
  });

  it('the win signal is PRESENCE, not value — authoring the upstream value still overrides', () => {
    // The bone at t=0 is already [0,1,0]. Authoring exactly that with the flag
    // set must still take the value from the override, or a director who drags a
    // bone back to where it started would silently lose the override and the
    // upstream motion would resurface underneath them.
    const authored = evalWith({
      bone: 'mixamorig_Hips',
      position: [0, 1, 0],
      overridden: { position: true },
    });
    // At t=5 the upstream would be [0,6,0]. The override pins it.
    expect(authored.sample(5)[1].position).toEqual([0, 1, 0]);

    // Same value, flag CLEAR — falls through to the upstream.
    const inert = evalWith({ bone: 'mixamorig_Hips', position: [0, 1, 0] });
    expect(inert.sample(5)[1].position).toEqual([0, 6, 0]);
  });

  // 🔴 THE ROW A FALSIFICATION PASS ADDED. Without it, replacing
  // `wantPosition ? position : at.position` with an unconditional `position`
  // stayed GREEN: every other row either authors position (so the flag is true
  // and the branch is invisible) or authors nothing (so the node early-returns
  // before the branch runs). Only a case that authors the OTHER component
  // reaches the position line with its flag false.
  it('a component whose flag is clear falls through even while its SIBLING is authored', () => {
    const v = evalWith({
      bone: 'mixamorig_Hips',
      position: [7, 7, 7],
      rotation: [1, 2, 3],
      overridden: { rotation: true },
    });
    const at2 = v.sample(2);
    expect(at2[1].rotation).toEqual([1, 2, 3]); // authored
    expect(at2[1].position).toEqual([0, 3, 0]); // upstream at t=2, NOT [7,7,7]
  });

  it('is copy-on-write — untouched bones keep the upstream objects they already had', () => {
    const up = upstream();
    const base = up.sample(1);
    const v = evalWith(
      { bone: 'mixamorig_Hips', position: [7, 7, 7], overridden: { position: true } },
      { ...up, sample: () => base },
    );
    const out = v.sample(1);
    expect(out).not.toBe(base);
    expect(out[0]).toBe(base[0]); // Root — same object
    expect(out[2]).toBe(base[2]); // Spine — same object
    expect(out[1]).not.toBe(base[1]); // the posed one is fresh
    expect(out[1].bone).toBe(1); // and keeps its index
  });

  it('samples NOTHING at evaluate time — the lane is lazy', () => {
    let sampled = 0;
    const counting: PosedSkeletonValue = {
      kind: 'PosedSkeleton',
      skeleton: BONES,
      sample: (s) => {
        sampled++;
        return upstream().sample(s);
      },
    };
    const v = evalWith(
      { bone: 'mixamorig_Hips', position: [7, 7, 7], overridden: { position: true } },
      counting,
    );
    expect(sampled).toBe(0); // evaluate() ran, nothing was sampled
    v.sample(0);
    expect(sampled).toBe(1); // one sample in, one sample out
  });

  it('declares no Time input — it inherits time from the value it wraps', () => {
    expect(Object.keys(PoseOverrideNode.inputs)).toEqual(['pose']);
  });
});
