// capabilityConformance — the properties EVERY motion-generation backend must
// satisfy, written once and run against each implementation.
//
// It exists because the stub was a false witness, and nothing could see it.
//
// The stub emits metres with the world translation on its ROOT. A real Kimodo
// clip emits CENTIMETRES with the world translation on `Hips` and a root that is
// identically zero for every frame. Every test in the tier passed against the
// stub, and none of them said anything true about the backend the tier exists to
// stand in for — because each test asserted against the one implementation it had
// in front of it, so "what a backend must do" was never written down anywhere.
//
// The same thing had already happened one layer down. `soma-generated.bvh` was
// synthesised from the exporter's own source with real care — the `Root` wrapper,
// the missing End Site blocks and the ZYX channel order were all read out of it
// correctly. The two properties the source did not state were filled in with the
// plausible default, and both were wrong: metres instead of centimetres, and a
// stationary root instead of a translating pelvis. A fixture is right about
// everything its source states and wrong about everything it does not, and it is
// also the only witness, so nothing disagrees with it.
//
// What a conformance suite adds over more tests is that the properties are stated
// INDEPENDENTLY of any implementation, so a new backend either satisfies them or
// is named. Adding an arm is one call.
//
// REF: src/core/motiongen/MotionGenerationCapability.ts; src/core/import/bvhProfile.ts;
//      issues #790 (the contract), #792 (the offset double-count this deliberately
//      does not assert away).

import { describe, expect, it } from 'vitest';
import { parseBvh } from '../import/bvh';
import { readBvhProfile } from '../import/bvhProfile';
import { MAX_MOTION_FPS, assertValidMotionRequest } from './MotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
} from './MotionGenerationCapability';
import type { BoneSpec } from '../../nodes/types';

export interface ConformanceOptions {
  /** A request the backend is expected to satisfy. */
  readonly request: MotionGenerationRequest;
  /**
   * A model id the licence manifest refuses. Every implementation must refuse it
   * BEFORE doing any work, so the check belongs to the contract rather than to
   * any one implementation.
   */
  readonly blockedModel: string;
  /**
   * Whether two identical requests must produce byte-identical BVH. True for the
   * stub; false for a sampler, whose non-determinism is a property rather than a
   * defect. Declared rather than probed, because probing cannot distinguish "not
   * deterministic" from "deterministic and we got lucky twice".
   */
  readonly deterministic: boolean;
}

/**
 * Plausible standing scale for a generated humanoid clip, in metres, once the
 * declared `unitScale` has been applied.
 *
 * A range and not a value, because it is asserting a CATEGORY rather than a
 * measurement: every backend this capability names emits a human skeleton, and no
 * human is 0.4 m or 4 m tall. What it actually catches is the failure it was
 * written for — a units mistake is a factor of 100, so it misses these bounds by
 * two orders of magnitude and cannot squeak through a loose range. Deliberately
 * generous so it never adjudicates anybody's proportions.
 */
const MIN_HUMAN_EXTENT_M = 0.5;
const MAX_HUMAN_EXTENT_M = 3;

/**
 * The furthest any joint sits from the skeleton root in its bind pose, in metres.
 *
 * Distance from the root rather than height, because a rest pose is not
 * necessarily laid out along +Y — the real SOMA skeleton's limbs run along +X, so
 * a height measurement over it reads near zero and would pass any bounds check
 * for the wrong reason.
 */
export function bindExtentMetres(bones: readonly BoneSpec[]): number {
  const world = bones.map(() => [0, 0, 0] as [number, number, number]);
  bones.forEach((bone, i) => {
    const parent = bone.parent >= 0 ? world[bone.parent] : [0, 0, 0];
    world[i] = [
      parent[0] + bone.position[0],
      parent[1] + bone.position[1],
      parent[2] + bone.position[2],
    ];
  });
  return world.reduce((max, p) => Math.max(max, Math.hypot(p[0], p[1], p[2])), 0);
}

/**
 * Declare the shared conformance block for one capability.
 *
 * Call it from a `.test.ts` file per implementation. The factory is invoked per
 * test rather than once, so an implementation carrying per-instance state (the
 * stub's job counter) cannot leak between assertions.
 */
export function describeMotionCapabilityConformance(
  name: string,
  makeCapability: () => MotionGenerationCapability,
  options: ConformanceOptions,
): void {
  const { request, blockedModel, deterministic } = options;

  describe(`motion capability conformance — ${name}`, () => {
    it('returns a job id, echoes the checkpoint, and DECLARES its unit scale', async () => {
      const result = await makeCapability().generate(request);
      expect(result.jobId.length).toBeGreaterThan(0);
      expect(result.model).toBe(request.model);
      expect(result.bvh.length).toBeGreaterThan(0);
      // The one property the clip cannot state about itself, so the one the
      // result has to. Not defaulted anywhere: a scale nobody stated and a scale
      // of 1 are different facts, and only one of them is ever true by accident.
      expect(Number.isFinite(result.unitScale)).toBe(true);
      expect(result.unitScale).toBeGreaterThan(0);
    });

    it('returns BVH the import road accepts — the same function a dropped file takes', async () => {
      const result = await makeCapability().generate(request);
      const parsed = parseBvh(result.bvh, 'conformance', result.unitScale);
      expect(parsed.skeletonParams.bones.length).toBeGreaterThan(0);
      expect(parsed.clipParams.keyframes.length).toBeGreaterThan(0);
    });

    it('STATES its own sampling rate in the clip, and the clip agrees with itself', async () => {
      const result = await makeCapability().generate(request);
      const profile = readBvhProfile(result.bvh);

      expect(profile.frames).toBeGreaterThanOrEqual(2);
      expect(profile.fps).toBeGreaterThan(0);
      expect(profile.fps).toBeLessThanOrEqual(MAX_MOTION_FPS);
      expect(profile.duration).toBeGreaterThan(0);

      // The rate is not something the caller asked for and not something the
      // result labelled — it is read off the clip, and the clip's own duration
      // has to follow from it. This is what replaced the `fps` request field: a
      // derived value cannot disagree with the artifact it was derived from.
      const parsed = parseBvh(result.bvh, 'conformance', result.unitScale);
      expect(parsed.clipParams.duration).toBeCloseTo(profile.duration, 5);
    });

    it('names the joint carrying world translation, and it is a joint of this skeleton', async () => {
      const result = await makeCapability().generate(request);
      const profile = readBvhProfile(result.bvh);

      // Non-null: a generator asked for motion that returns a clip translating
      // nowhere has answered a different question. Which joint it is does NOT
      // have to be the root — the real backend puts it on `Hips` and leaves the
      // root identically zero — so the property is that it is NAMED and REAL,
      // never that it sits in a particular place.
      expect(profile.rootMotionJoint).not.toBeNull();
      expect(profile.joints).toContain(profile.rootMotionJoint);

      const parsed = parseBvh(result.bvh, 'conformance', result.unitScale);
      expect(parsed.skeletonParams.bones.map((b) => b.name)).toContain(profile.rootMotionJoint);
    });

    it('declares a unit scale that is TRUE — applied, the rig is human-sized', async () => {
      const result = await makeCapability().generate(request);
      const bones = parseBvh(result.bvh, 'conformance', result.unitScale).skeletonParams.bones;

      const extent = bindExtentMetres(bones);
      expect(extent).toBeGreaterThan(MIN_HUMAN_EXTENT_M);
      expect(extent).toBeLessThan(MAX_HUMAN_EXTENT_M);
    });

    it('the declared scale is CHECKABLE — the same rig at a 100x wrong scale fails it', async () => {
      // The gate's failing arm, constructed rather than assumed. Without this the
      // check above passes for every backend forever and proves nothing: a claim
      // whose falsification is never built is a claim nobody has tested.
      const result = await makeCapability().generate(request);
      const wrong = parseBvh(result.bvh, 'conformance', result.unitScale * 100).skeletonParams
        .bones;
      expect(bindExtentMetres(wrong)).toBeGreaterThan(MAX_HUMAN_EXTENT_M);
    });

    it('scaling touches LENGTHS only — rotations are unit-free and pass through', async () => {
      const result = await makeCapability().generate(request);
      const raw = parseBvh(result.bvh, 'conformance', 1);
      const scaled = parseBvh(result.bvh, 'conformance', 0.01);

      // NON-VACUITY FIRST, and it is not ceremony: a BVH bind pose carries
      // IDENTITY rotations, so `0 * 0.01 === 0` and comparing bind rotations
      // holds just as well when the scale IS wrongly applied to them. The first
      // version of this test asserted exactly that and passed while rotations
      // were being scaled. The keyframes are where the rotations are non-zero,
      // so that is where the property has to be checked — and the check is only
      // worth anything once something confirms there is a rotation to check.
      const movingKeys = raw.clipParams.keyframes.filter((kf) => kf.rotation.some((v) => v !== 0));
      expect(movingKeys.length).toBeGreaterThan(0);

      raw.skeletonParams.bones.forEach((bone, i) => {
        const other = scaled.skeletonParams.bones[i];
        bone.position.forEach((v, axis) => expect(other.position[axis]).toBeCloseTo(v * 0.01, 9));
      });
      raw.clipParams.keyframes.forEach((kf, i) => {
        const other = scaled.clipParams.keyframes[i];
        kf.position.forEach((v, axis) => expect(other.position[axis]).toBeCloseTo(v * 0.01, 9));
        expect(other.rotation).toEqual(kf.rotation);
      });
    });

    it('refuses a licence-blocked checkpoint', async () => {
      await expect(
        makeCapability().generate({ ...request, model: blockedModel }),
      ).rejects.toThrow();
    });

    it('cannot be asked for a frame rate — the field is refused by name', () => {
      // The rate belongs to the generator. TypeScript already makes the field
      // unconstructible; this is the runtime half, for a caller that is not
      // TypeScript — an agent emitting JSON, or a saved plan written before the
      // field went away. A permissive schema would STRIP it and succeed, which is
      // the silent failure the removal exists to end.
      expect(() =>
        assertValidMotionRequest({ ...request, fps: 60 } as MotionGenerationRequest),
      ).toThrow(/fps/);
    });

    if (deterministic) {
      it('is deterministic — the same request twice returns the same clip', async () => {
        const a = await makeCapability().generate(request);
        const b = await makeCapability().generate(request);
        expect(a.bvh).toBe(b.bvh);
        expect(a.unitScale).toBe(b.unitScale);
      });
    }
  });
}
