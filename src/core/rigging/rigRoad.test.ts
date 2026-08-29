// The rig road, end to end and offline: a rigged mesh comes back from the
// capability, travels Basher's REAL glTF skin-import path, and a generated motion
// clip retargets onto the skeleton that arrives.
//
// This is the phase's discriminating observation. Everything it asserts is
// checkable with no server, and the ONE thing that is not — whether Tripo's
// `spec: mixamo` emits this vocabulary — is deliberately not asserted here. It is
// checked at runtime instead, on whatever a real service returns.
//
// REF: issue #795; src/core/rigging/RiggingCapability.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from '../import/glb';
import { buildNodeNameMap, buildSkinMetadata } from '../import/gltfImportChain';
import { projectGltfSkeleton } from '../import/projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from '../import/bvh';
import { retargetClip } from '../import/retarget';
import { BONE_NAME_MAP_PRESETS } from '../import/boneNameMaps';
import { StubRiggingCapability, STUB_RIG_BONES } from './StubRiggingCapability';
import {
  classifyRigSpec,
  missingForRetarget,
  mixamoBonesRequiredForRetarget,
  DEFAULT_RIG_SPEC,
} from './RiggingCapability';
import type { GltfSkinMetadata } from '../../nodes/types';

const somaToMixamo = () => BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

/** What a generated SOMA clip needs to exist on the target, derived from the
 *  preset rather than listed, so the two cannot drift apart. */
const requiredBones = () => mixamoBonesRequiredForRetarget(Object.values(somaToMixamo().map));

/** Run a rigged GLB down the production skin-import path and return its skeleton. */
async function skeletonOf(glb: ArrayBuffer) {
  const { json, bin } = parseGltfContainer(glb);
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
  const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  expect(skins).toHaveLength(1);
  return projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
}

describe('a rigged mesh travels the ordinary glTF skin road', () => {
  it('the capability returns a GLB Basher imports AS A SKIN, not merely as geometry', async () => {
    const result = await new StubRiggingCapability().rig({ sourceTaskId: 'task-abc' });
    const skeleton = await skeletonOf(result.glb);

    // A skin, with joints — a GLB that parsed but carried no skin would be a mesh
    // that arrived and a rig that did not, which is the failure worth naming.
    expect(skeleton.bones.length).toBe(STUB_RIG_BONES.length);
    expect(skeleton.bones[0].parent).toBe(-1);
    // Hierarchy survives the trip: every non-root names a parent inside the skin.
    for (const bone of skeleton.bones.slice(1)) {
      expect(bone.parent).toBeGreaterThanOrEqual(0);
      expect(bone.parent).toBeLessThan(skeleton.bones.length);
    }
  });

  it('defaults to the spec anything downstream can actually drive', async () => {
    const result = await new StubRiggingCapability().rig({ sourceTaskId: 'task-abc' });
    // The service's own default is `tripo`, which has no bone-name map here. A
    // default that produces an unusable rig is worse than one that disagrees with
    // upstream, so Basher's default is mixamo.
    expect(result.requestedSpec).toBe(DEFAULT_RIG_SPEC);
    expect(DEFAULT_RIG_SPEC).toBe('mixamo');
  });
});

describe('the skeleton that arrives is READ, never taken on the request’s word', () => {
  it('classifies the returned skeleton from its own bone names', async () => {
    const result = await new StubRiggingCapability().rig({ sourceTaskId: 't', spec: 'mixamo' });
    const skeleton = await skeletonOf(result.glb);
    expect(classifyRigSpec(skeleton.bones.map((b) => b.name))).toBe('mixamo');
  });

  it('a service that ignored the spec is CAUGHT, not believed', () => {
    // The whole reason `requestedSpec` is not called `spec`. A rig that came back
    // with the service's own convention while the request said mixamo would
    // otherwise be invisible: the call succeeded, the field reads `mixamo`, and
    // the retarget silently binds nothing.
    const foreign = ['Bip01_Pelvis', 'Bip01_Spine', 'Bip01_Head', 'Bip01_L_Hand'];
    expect(classifyRigSpec(foreign)).toBe('unknown');
    expect(missingForRetarget(foreign, requiredBones()).length).toBe(requiredBones().length);
  });

  it('one stray Mixamo-shaped name does not make a foreign skeleton read as Mixamo', () => {
    expect(classifyRigSpec(['mixamorig_Hips', 'Bip01_Spine', 'Bip01_Head', 'Bip01_L_Hand'])).toBe(
      'unknown',
    );
  });

  it('an empty skeleton is unknown, never a spec', () => {
    expect(classifyRigSpec([])).toBe('unknown');
  });
});

describe('a GENERATED motion clip drives the rig that comes back', () => {
  it('every bone the retarget needs is present, and the clip binds to them', async () => {
    const result = await new StubRiggingCapability().rig({ sourceTaskId: 't' });
    const skeleton = await skeletonOf(result.glb);
    const targetNames = skeleton.bones.map((b) => b.name);

    // 1. The rig carries what a generated clip needs. Named, so a gap says which.
    expect(missingForRetarget(targetNames, requiredBones())).toEqual([]);

    // 2. A real generated clip — the SOMA fixture, in centimetres, Hips-posed —
    //    retargets onto it through the existing preset. No new road.
    const soma = parseBvh(
      readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'), 'utf8'),
      'generated',
      BVH_UNIT_SCALE_CENTIMETRES,
    );
    const retargeted = retargetClip({
      sourceBones: soma.skeletonParams.bones,
      sourceClip: {
        name: soma.clipParams.name,
        duration: soma.clipParams.duration,
        keyframes: soma.clipParams.keyframes,
      },
      targetBones: skeleton.bones,
      nameMap: somaToMixamo().map,
    });

    // 3. It produced motion, and it landed on the rig's OWN bones.
    expect(retargeted.clipParams.keyframes.length).toBeGreaterThan(0);
    expect(retargeted.clipParams.duration).toBeCloseTo(soma.clipParams.duration, 6);
    const touched = new Set(retargeted.clipParams.keyframes.map((k) => targetNames[k.bone]));
    for (const name of requiredBones()) expect(touched.has(name)).toBe(true);
  });

  it('the road is not vacuous — a rig WITHOUT the vocabulary fails the same check', async () => {
    // The failing arm, constructed. Without it, "every bone is present" passes
    // forever and says nothing about whether the check can see an absence.
    const missing = missingForRetarget(['mixamorig_Hips', 'mixamorig_Head'], requiredBones());
    expect(missing.length).toBe(requiredBones().length - 2);
    expect(missing).toContain('mixamorig_LeftFoot');
  });
});
