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

describe('BONE_NAME_MAP_PRESETS catalog', () => {
  it('ships at least mixamoToGltf / mixamoToReze / mixamoToRigify', () => {
    const ids = BONE_NAME_MAP_PRESETS.map((p) => p.id).sort();
    expect(ids).toContain('mixamoToGltf');
    expect(ids).toContain('mixamoToReze');
    expect(ids).toContain('mixamoToRigify');
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
