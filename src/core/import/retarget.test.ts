// Retarget core + preset catalog tests.

import { describe, expect, it } from 'vitest';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS, getBoneNameMapPreset } from './boneNameMaps';
import { BONE_GROUP_PRESETS, getBoneGroupPreset } from './boneGroupPresets';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';

const SOURCE_BONES: BoneSpec[] = [
  { name: 'mixamorig_Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 'mixamorig_Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
];
const TARGET_BONES: BoneSpec[] = [
  { name: 'hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 'spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
];

const SOURCE_KFS: AnimationKeyframe[] = [
  { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
  { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
  { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
];

describe('retargetClip', () => {
  it('produces a clip whose tracks reference target bone indices (colon-free names)', () => {
    // Use colon-free names — THREE.PropertyBinding's regex parser
    // mishandles `mixamorig:Spine` style. Real Mixamo content carries
    // colons; the import path could rename `mixamorig:X` → `mixamoX`
    // on parse to dodge this. Tracking as a known Wave C limitation.
    const sourceBones: BoneSpec[] = [
      { name: 'mixamoHips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'mixamoSpine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    ];
    const targetBones: BoneSpec[] = [
      { name: 'hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    ];
    const sourceKfs: AnimationKeyframe[] = [
      { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
      { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
      { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
    ];
    const result = retargetClip({
      sourceBones,
      sourceClip: { name: 'walk', duration: 1, keyframes: sourceKfs },
      targetBones,
      nameMap: { mixamoHips: 'hips', mixamoSpine: 'spine' },
    });
    expect(result.clipParams.duration).toBeGreaterThan(0);
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    for (const kf of result.clipParams.keyframes) {
      expect(kf.bone).toBeGreaterThanOrEqual(0);
      expect(kf.bone).toBeLessThan(targetBones.length);
    }
  });

  it('twice-call returns deep-equal output for the same inputs (V2)', () => {
    const a = retargetClip({
      sourceBones: SOURCE_BONES,
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: TARGET_BONES,
      nameMap: { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' },
    });
    const b = retargetClip({
      sourceBones: SOURCE_BONES,
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: TARGET_BONES,
      nameMap: { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' },
    });
    expect(a.clipParams).toEqual(b.clipParams);
  });

  it('flags unmapped source bones whose name has no target match', () => {
    const orphanSource: BoneSpec[] = [
      ...SOURCE_BONES,
      { name: 'mixamorig_Tail', parent: 0, position: [0, 0, 0.2], rotation: [0, 0, 0] },
    ];
    const result = retargetClip({
      sourceBones: orphanSource,
      sourceClip: { name: 'wag', duration: 1, keyframes: [] },
      targetBones: TARGET_BONES,
      nameMap: { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' },
    });
    expect(result.unmappedSourceBones).toContain('mixamorig_Tail');
  });

  it('flags target bones nothing mapped to', () => {
    const richerTarget: BoneSpec[] = [
      ...TARGET_BONES,
      { name: 'tail', parent: 0, position: [0, 0, 0.2], rotation: [0, 0, 0] },
    ];
    const result = retargetClip({
      sourceBones: SOURCE_BONES,
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: richerTarget,
      nameMap: { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' },
    });
    expect(result.unboundTargetBones).toContain('tail');
  });
});

// Phase 7.11 Wave D (D1): a foreign-vocabulary source clip retargets onto a
// glTF rig whose target bones are the GltfSkeleton projection's NATIVE joint
// keys, bridged by a NON-IDENTITY nameMap. This is the D-01 director story
// ("drop a Mixamo/BVH clip onto a dropped glTF character") proven at the
// `retargetClip` layer — the bridge is load-bearing, not the no-op an
// identity map would be (research risk #4: silent all-unbound). The full
// drop→render e2e (F6a) + the headline cross-vocabulary proof (F6b) land in
// Wave F; this is the Wave-D-level observation that the bridge maps.
describe('retarget onto a glTF rig via a non-identity name bridge (Wave D / D-01)', () => {
  // Stand-in for a GltfSkeleton projection output: BoneSpec[] whose names are
  // the glTF asset's native joint keys (the committed `skinned-bar` rig is
  // `Bone0`/`Bone1`). projectGltfSkeleton is covered by its own unit suite;
  // here we only need the SHAPE a GltfSkeleton emits as the retarget target.
  const GLTF_RIG_BONES: BoneSpec[] = [
    { name: 'Bone0', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'Bone1', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];

  it('a foreign-named source binds to glTF-native target keys through the bridge preset', () => {
    const bridge = getBoneNameMapPreset('mixamoToGltfBarRig');
    expect(bridge).toBeDefined();
    // The bridge is genuinely NON-IDENTITY: source names differ from targets.
    expect(bridge!.map['mixamorig_Hips']).toBe('Bone0');
    expect(bridge!.map['mixamorig_Spine']).toBe('Bone1');

    const result = retargetClip({
      sourceBones: SOURCE_BONES, // mixamorig_Hips / mixamorig_Spine
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: GLTF_RIG_BONES, // glTF-native Bone0 / Bone1
      nameMap: bridge!.map,
    });

    // The foreign source actually drove the glTF rig: tracks exist and bind to
    // the glTF target bone indices — i.e. mixamorig_* mapped ONTO Bone0/Bone1.
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    for (const kf of result.clipParams.keyframes) {
      expect(kf.bone).toBeGreaterThanOrEqual(0);
      expect(kf.bone).toBeLessThan(GLTF_RIG_BONES.length);
    }
    // Both glTF target bones were bound by the bridge — nothing left dangling.
    expect(result.unboundTargetBones).toEqual([]);
    expect(result.unmappedSourceBones).toEqual([]);
  });

  it('FALSIFICATION: an empty nameMap leaves every glTF target bone unbound', () => {
    // With glTF-native names, an empty (or identity) map is a no-op: the
    // mixamorig_* source matches NO glTF joint key, so the bridge is what
    // makes binding succeed. A broken bridge is observable, not silent.
    const result = retargetClip({
      sourceBones: SOURCE_BONES,
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: GLTF_RIG_BONES,
      nameMap: {},
    });
    expect(result.unboundTargetBones).toEqual(['Bone0', 'Bone1']);
    expect(result.unmappedSourceBones).toEqual(['mixamorig_Hips', 'mixamorig_Spine']);
  });
});

describe('BONE_NAME_MAP_PRESETS catalog', () => {
  it('ships at least mixamoToGltf / mixamoToReze / mixamoToRigify', () => {
    const ids = BONE_NAME_MAP_PRESETS.map((p) => p.id).sort();
    expect(ids).toContain('mixamoToGltf');
    expect(ids).toContain('mixamoToReze');
    expect(ids).toContain('mixamoToRigify');
  });

  it('ships the glTF-rig bridge preset (mixamoToGltfBarRig) for Wave D / D-01', () => {
    const ids = BONE_NAME_MAP_PRESETS.map((p) => p.id);
    expect(ids).toContain('mixamoToGltfBarRig');
    const bridge = getBoneNameMapPreset('mixamoToGltfBarRig');
    // Load-bearing: the bridge maps foreign source names ONTO different
    // glTF-native target keys (NON-IDENTITY).
    expect(bridge?.map['mixamorig_Hips']).toBe('Bone0');
    for (const [src, tgt] of Object.entries(bridge!.map)) {
      expect(src).not.toBe(tgt);
    }
  });

  it('every preset includes the Mixamo Hips entry as the load-bearing root mapping', () => {
    for (const p of BONE_NAME_MAP_PRESETS) {
      expect(p.map['mixamorig_Hips']).toBeDefined();
    }
  });

  it('getBoneNameMapPreset(id) round-trips', () => {
    const preset = getBoneNameMapPreset('mixamoToGltf');
    expect(preset?.map['mixamorig_Hips']).toBe('hips');
  });
});

describe('BONE_GROUP_PRESETS catalog', () => {
  it('ships standard humanoid groups', () => {
    const ids = BONE_GROUP_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(['arms', 'headAndNeck', 'lowerBody', 'upperBody']);
  });

  it('upperBody covers spine + neck + arms', () => {
    const upper = getBoneGroupPreset('upperBody');
    expect(upper?.bones).toContain('spine');
    expect(upper?.bones).toContain('neck');
    expect(upper?.bones).toContain('upper_arm.L');
  });
});
