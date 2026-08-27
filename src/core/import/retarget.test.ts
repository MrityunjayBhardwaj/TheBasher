// Retarget core + preset catalog tests.

import { describe, expect, it } from 'vitest';
import { PropertyBinding } from 'three';
import {
  retargetClip,
  canonicalBoneKey,
  resolveNameMapToSource,
  resolveNameMapToTarget,
} from './retarget';
import { sanitizeBoneName } from './threeAdapter';
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

  it('every preset maps its source rig root — the load-bearing entry', () => {
    // Written as `p.map['mixamorig_Hips']` while every preset was Mixamo-sourced.
    // The literal was standing in for the property, and it went false the moment
    // a SOMA-sourced preset arrived while the property itself stayed true — SOMA
    // spells the same joint `Hips`. So assert the property, and keep the Mixamo
    // case as its own line rather than quietly trading the old coverage away.
    for (const p of BONE_NAME_MAP_PRESETS) {
      const rootKeys = Object.keys(p.map).filter((k) => /(^|_)Hips$/.test(k));
      expect(rootKeys, `${p.id} maps no root bone`).toHaveLength(1);
    }
    for (const p of BONE_NAME_MAP_PRESETS.filter((preset) => preset.source === 'Mixamo')) {
      expect(p.map['mixamorig_Hips'], `${p.id} lost its Mixamo root`).toBeDefined();
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

// ── Two import roads, two spellings, one map ───────────────────────────────
// Measured 2026-08-26 on a real Mixamo export (67-joint rig, 28k keyframes):
// the shipped Mixamo→glTF preset matched 0 of 22 source bones and produced an
// EMPTY clip, with no error. The cause is upstream of us — three's FBXLoader
// sanitises bone names by REMOVING reserved characters, while our glTF road
// REPLACES them with '_'. These tests pin the mechanism, not just the symptom.

describe('bone-name spelling across import roads', () => {
  it("three's sanitiser REMOVES the colon — this is the upstream fact everything else follows from", () => {
    // If this ever changes, the canonical matching below becomes unnecessary
    // rather than wrong — and this test is where you find that out.
    expect(PropertyBinding.sanitizeNodeName('mixamorig:Hips')).toBe('mixamorigHips');
  });

  it('our sanitiser REPLACES it with an underscore — the other spelling', () => {
    expect(sanitizeBoneName('mixamorig:Hips')).toBe('mixamorig_Hips');
  });

  it('canonicalBoneKey collapses both spellings onto one key', () => {
    const fromFbx = PropertyBinding.sanitizeNodeName('mixamorig:LeftForeArm');
    const fromGltf = sanitizeBoneName('mixamorig:LeftForeArm');
    expect(fromFbx).not.toBe(fromGltf); // they really are different strings
    expect(canonicalBoneKey(fromFbx)).toBe(canonicalBoneKey(fromGltf));
  });

  it('every shipped preset key resolves against the FBX spelling of its own bone', () => {
    // The preset is authored in the glTF spelling. Each key must still find the
    // bone when the clip arrived by FBX — which is the case that was broken.
    const preset = getBoneNameMapPreset('mixamoToGltf');
    expect(preset).toBeTruthy();
    const fbxSpelled = Object.keys(preset!.map).map((k) => ({
      name: PropertyBinding.sanitizeNodeName(k.replace(/_/g, ':')),
      parent: -1,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    }));
    const resolved = resolveNameMapToSource(preset!.map, fbxSpelled);
    const names = new Set(fbxSpelled.map((b) => b.name));
    const landed = Object.keys(resolved).filter((k) => names.has(k));
    expect(landed).toHaveLength(Object.keys(preset!.map).length);
  });

  it('an exact key is never second-guessed', () => {
    const bones: BoneSpec[] = [
      { name: 'mixamorig_Hips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'mixamorigHips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    const resolved = resolveNameMapToSource({ mixamorig_Hips: 'hips' }, bones);
    expect(resolved).toEqual({ mixamorig_Hips: 'hips' });
  });

  it('leaves an AMBIGUOUS canonical form unresolved rather than guessing', () => {
    // Two source bones collapsing to one key must not silently pick a winner —
    // a wrong bound bone is worse than an unbound one, because it looks right.
    const bones: BoneSpec[] = [
      { name: 'arm_L', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'armL', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    const resolved = resolveNameMapToSource({ 'arm.L': 'target' }, bones);
    expect(resolved).toEqual({ 'arm.L': 'target' });
  });

  it('never lets an inexact key revise an entry an exact key already claimed', () => {
    // Constructed from the failure: resolving in one pass wrote both keys onto the
    // same bone, so the LAST one won and the exact spelling lost to the fuzzy one.
    // Which of the two won depended on key order, which is no rule at all.
    const bones: BoneSpec[] = [
      { name: 'arm_L', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(resolveNameMapToSource({ arm_L: 'exact', 'arm.L': 'fuzzy' }, bones)).toEqual({
      arm_L: 'exact',
      'arm.L': 'fuzzy',
    });
    // …and the same holds when the fuzzy key is authored first.
    expect(resolveNameMapToSource({ 'arm.L': 'fuzzy', arm_L: 'exact' }, bones)).toEqual({
      arm_L: 'exact',
      'arm.L': 'fuzzy',
    });
  });

  it('leaves a bone claimed by TWO inexact keys unresolved rather than keeping one', () => {
    // The likely case in the field: an author covering both import roads' spellings
    // in one preset. Silently dropping half of it is exactly the class of silent
    // wrong answer this resolver exists to remove.
    const bones: BoneSpec[] = [
      { name: 'mixamorigHips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    const resolved = resolveNameMapToSource({ 'mixamorig:Hips': 'a', mixamorig_Hips: 'b' }, bones);
    expect(resolved).toEqual({ 'mixamorig:Hips': 'a', mixamorig_Hips: 'b' });
    expect(resolved.mixamorigHips).toBeUndefined();
  });

  it('retargets a clip whose bones use the FBX spelling through the glTF-spelled preset', () => {
    // The end-to-end form of the bug: before this fix the result was 0 keyframes.
    const sourceBones: BoneSpec[] = [
      { name: 'mixamorigHips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'mixamorigSpine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    ];
    const targetBones: BoneSpec[] = [
      { name: 'hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    ];
    const keyframes: AnimationKeyframe[] = [
      { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.5, 0] },
      { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
      { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.3, 0] },
    ];
    const result = retargetClip({
      sourceBones,
      sourceClip: { name: 'walk', duration: 1, keyframes },
      targetBones,
      nameMap: { mixamorig_Hips: 'hips', mixamorig_Spine: 'spine' },
    });
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    expect(result.unmappedSourceBones).toEqual([]);
    expect(result.unboundTargetBones).toEqual([]);
  });
});

// The mirror of the block above. A match has two sides, and the loader sanitiser
// that corrupts the names does not care which side a name is standing on — so the
// side nobody reported the bug from had the identical defect, and every test
// written for the first fix passed while it did.
describe("the map's TARGET values resolve by the same rule as its source keys", () => {
  const fbxRig: BoneSpec[] = [
    { name: 'mixamorigHips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'mixamorigSpine', parent: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
  ];

  it('lands an underscore-spelled target value on an FBX-spelled target bone', () => {
    // The reported failure, at unit scale: authored against a glTF import, run
    // against an FBX-derived skeleton. Before this it resolved to nothing.
    expect(resolveNameMapToTarget({ src: 'mixamorig_Hips' }, fbxRig)).toEqual({
      src: 'mixamorigHips',
    });
  });

  it('an exact target value is never second-guessed', () => {
    const bones: BoneSpec[] = [
      { name: 'mixamorig_Hips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'mixamorigHips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(resolveNameMapToTarget({ src: 'mixamorig_Hips' }, bones)).toEqual({
      src: 'mixamorig_Hips',
    });
  });

  it('leaves an AMBIGUOUS canonical form unresolved rather than guessing', () => {
    const bones: BoneSpec[] = [
      { name: 'arm_L', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'armL', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(resolveNameMapToTarget({ src: 'arm.L' }, bones)).toEqual({ src: 'arm.L' });
  });

  it('never lets an inexact value revise a bone an exact value already claimed', () => {
    const bones: BoneSpec[] = [
      { name: 'arm_L', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(resolveNameMapToTarget({ a: 'arm_L', b: 'arm.L' }, bones)).toEqual({
      a: 'arm_L',
      b: 'arm.L',
    });
    // …and the same holds when the fuzzy value is authored first, because the pass
    // counts claims before it writes any of them.
    expect(resolveNameMapToTarget({ b: 'arm.L', a: 'arm_L' }, bones)).toEqual({
      a: 'arm_L',
      b: 'arm.L',
    });
  });

  it('leaves a bone claimed by TWO inexact values unresolved rather than keeping one', () => {
    const resolved = resolveNameMapToTarget({ a: 'mixamorig:Hips', b: 'mixamorig_Hips' }, fbxRig);
    expect(resolved).toEqual({ a: 'mixamorig:Hips', b: 'mixamorig_Hips' });
  });

  it('a value REPEATED across two source bones is one authored name, not a collision', () => {
    // Two source bones legitimately driving one target bone. The repeat is the same
    // spelling, so rule 3 — about two DIFFERENT spellings claiming one bone — must
    // not fire and strand both of them.
    expect(resolveNameMapToTarget({ a: 'mixamorig_Hips', b: 'mixamorig_Hips' }, fbxRig)).toEqual({
      a: 'mixamorigHips',
      b: 'mixamorigHips',
    });
  });

  it('retargets end to end onto an FBX-spelled target through a glTF-spelled map', () => {
    const sourceBones: BoneSpec[] = [
      { name: 'mixamorig_Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'mixamorig_Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    ];
    const result = retargetClip({
      sourceBones,
      sourceClip: { name: 'walk', duration: 1, keyframes: SOURCE_KFS },
      targetBones: fbxRig,
      nameMap: { mixamorig_Hips: 'mixamorig_Hips', mixamorig_Spine: 'mixamorig_Spine' },
    });
    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    // The diagnostics are computed from the RESOLVED map, so they describe the
    // lookup that actually happened rather than the one that was authored.
    expect(result.unboundTargetBones).toEqual([]);
    expect(result.unmappedSourceBones).toEqual([]);
  });
});
