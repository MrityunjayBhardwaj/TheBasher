// The corpus gap, closed. See scripts/gen-mixamo-naming-fixture.mjs.
//
// Every other committed animation fixture is minimal — 2 bones named Hips and
// Spine, 1 joint and 2 frames — and minimal turned out to mean "cannot express
// the hazard". A total, silent retarget failure on every real Mixamo file was
// unreachable by the entire suite, a dedicated e2e import gate included, because
// nothing in the corpus carried a vendor namespace. It took a hand-run 3.7 MB
// export to surface it.
//
// These tests read GENERATED fixtures that carry the characteristic without the
// asset: `mixamorig:`-style colon names across the same 22 joints the shipped
// preset maps. Measured against the pre-fix resolver, the FBX case reports 22 of
// 22 bones unmapped and 0 keyframes — the field failure, reproduced from files in
// this repo, at 5 KB and with no licence exposure.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBvh } from './bvh';
import { parseFbx } from './fbx';
import { retargetClip } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec } from '../../nodes/types';

const fixture = (file: string) =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim', file));

const PRESET = getBoneNameMapPreset('mixamoToGltf');

/** A rig whose bones are exactly the preset's target vocabulary. */
function targetRig(): BoneSpec[] {
  return Object.values(PRESET!.map).map((name) => ({
    name,
    parent: -1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }));
}

describe('the generated Mixamo-naming fixtures carry the namespace', () => {
  // Asserted on the RAW bytes, because everything below reads the sanitised
  // names and would stay green if a regeneration quietly dropped the namespace —
  // which would take the whole class back out of reach without changing a colour.
  it('the .bvh source text really contains colon-namespaced joints', () => {
    const text = fixture('mixamo-naming.bvh').toString('utf8');
    expect(text).toContain('ROOT mixamorig:Hips');
    expect(text.match(/mixamorig:/g)?.length).toBe(22);
  });

  it('the .fbx source text really contains colon-namespaced models', () => {
    const text = fixture('mixamo-naming.fbx').toString('utf8');
    expect(text).toContain('"Model::mixamorig:Hips"');
    expect(text.match(/Model::mixamorig:/g)?.length).toBe(22);
  });
});

describe('the two import roads spell the same bone differently', () => {
  it('BVH arrives underscored, FBX arrives with the separator removed', () => {
    const bvh = parseBvh(fixture('mixamo-naming.bvh').toString('utf8'), 'bvh');
    const fbx = parseFbx(fixture('mixamo-naming.fbx').buffer as ArrayBuffer, 'fbx');

    const bvhNames = bvh.skeletonParams.bones.map((b) => b.name);
    const fbxNames = fbx.skeletonParams.bones.map((b) => b.name);

    // Our sanitiser replaces the colon; three's FBXLoader removes it. Both are
    // reasonable on their own terms, and the gap between them was the bug.
    expect(bvhNames).toContain('mixamorig_Hips');
    expect(fbxNames).toContain('mixamorigHips');
    expect(bvhNames).not.toContain('mixamorigHips');
    expect(fbxNames).not.toContain('mixamorig_Hips');
  });
});

describe('the shipped preset lands on BOTH roads — the regression this guards', () => {
  it('retargets an FBX-spelled source through the underscore-spelled preset', () => {
    // The exact shape of the field failure. Before the resolver landed this
    // reported 22 unmapped and 0 keyframes, with no throw and no warning.
    const src = parseFbx(fixture('mixamo-naming.fbx').buffer as ArrayBuffer, 'fbx');
    expect(src.clipParams).toBeTruthy();
    const result = retargetClip({
      sourceBones: src.skeletonParams.bones,
      sourceClip: src.clipParams!,
      targetBones: targetRig(),
      nameMap: PRESET!.map,
    });
    expect(result.unmappedSourceBones).toEqual([]);
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
  });

  it('retargets a BVH-spelled source through the same preset', () => {
    const src = parseBvh(fixture('mixamo-naming.bvh').toString('utf8'), 'bvh');
    const result = retargetClip({
      sourceBones: src.skeletonParams.bones,
      sourceClip: src.clipParams,
      targetBones: targetRig(),
      nameMap: PRESET!.map,
    });
    // The leaves three's BVHLoader names ENDSITE are legitimately outside the
    // preset's vocabulary; every real joint binds.
    expect(result.unmappedSourceBones.every((n) => n.startsWith('ENDSITE'))).toBe(true);
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
  });
});

describe('the same fixtures, with the roads swapped — the TARGET side', () => {
  it('retargets a BVH-spelled source onto an FBX-derived TARGET rig', () => {
    // The mirror of the regression above, and it failed just as completely: before
    // the target side was resolved this reported 22 of 22 target bones unbound and
    // 0 keyframes — no throw, no warning, an empty clip. Reachable because parseFbx
    // really does produce a skeletonParams.bones list, so an FBX rig can be the
    // TARGET and not only the source.
    const src = parseBvh(fixture('mixamo-naming.bvh').toString('utf8'), 'bvh');
    const tgt = parseFbx(fixture('mixamo-naming.fbx').buffer as ArrayBuffer, 'fbx');

    // An identity map in the underscore spelling — what an author writes after
    // looking at a glTF import, applied to a rig that arrived by FBX.
    const nameMap: Record<string, string> = {};
    for (const bone of src.skeletonParams.bones) {
      if (!bone.name.startsWith('ENDSITE')) nameMap[bone.name] = bone.name;
    }

    const result = retargetClip({
      sourceBones: src.skeletonParams.bones,
      sourceClip: src.clipParams,
      targetBones: tgt.skeletonParams.bones,
      nameMap,
    });

    expect(tgt.skeletonParams.bones).toHaveLength(22);
    expect(result.unboundTargetBones).toEqual([]);
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
  });
});
