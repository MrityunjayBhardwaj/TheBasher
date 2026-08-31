// Retarget core + preset catalog tests.

import { describe, expect, it } from 'vitest';
import { PropertyBinding } from 'three';
import {
  retargetClip,
  restPoseLocalOffsets,
  canonicalBoneKey,
  resolveNameMapToSource,
  resolveNameMapToTarget,
  retargetScale,
} from './retarget';
import { specToThreeSkeleton } from './threeAdapter';
import { Quaternion, Matrix4 } from 'three';
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

describe('the target keeps its own proportions (#828)', () => {
  // The defect this pins was measured in a browser first: binding ANY clip folded
  // the character into a blob at the origin. Not a scale — every bone was placed
  // at its parent's origin, because every baked position channel carried [0,0,0].
  //
  // The chain: a retarget emits ROTATION tracks only (by design — the target keeps
  // its proportions), `clipToKeyframes` therefore falls back to the bind pose for
  // position on every bone, and the bind pose was read AFTER `threeRetargetClip`
  // had already flattened the bone objects it poses. So "this bone has no position
  // track" resolved to "this bone is at the origin".
  //
  // Every gate on this road reads ROTATION, and rotations were correct throughout,
  // which is why 4,920 assertions stayed green while the character was destroyed.
  const armSource: BoneSpec[] = [
    { name: 'src_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'src_spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    { name: 'src_head', parent: 1, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  ];
  // Deliberately DIFFERENT proportions from the source: this is the whole point of
  // a retarget, and the values that must survive it.
  const armTarget: BoneSpec[] = [
    { name: 'tgt_hips', parent: -1, position: [0, 0.9, 0], rotation: [0, 0, 0] },
    { name: 'tgt_spine', parent: 0, position: [0, 0.25, 0], rotation: [0, 0, 0] },
    { name: 'tgt_head', parent: 1, position: [0, 0.17, 0], rotation: [0, 0, 0] },
  ];
  const NAME_MAP = { src_hips: 'tgt_hips', src_spine: 'tgt_spine', src_head: 'tgt_head' };

  /** A rotation-only clip — what a BVH is for every joint below the root. */
  const rotationOnly: AnimationKeyframe[] = [
    { bone: 0, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 1, position: [0, 1, 0], rotation: [0, 0.4, 0] },
    { bone: 1, time: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 0.4, 0], rotation: [0, 0.5, 0] },
    { bone: 2, time: 0, position: [0, 0.3, 0], rotation: [0, 0, 0] },
    { bone: 2, time: 1, position: [0, 0.3, 0], rotation: [0, 0.2, 0] },
  ];

  it('keeps every bone at its own bind translation, never at the origin', () => {
    const result = retargetClip({
      sourceBones: armSource,
      sourceClip: { name: 'wave', duration: 1, keyframes: rotationOnly },
      targetBones: armTarget,
      nameMap: NAME_MAP,
    });

    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    for (const kf of result.clipParams.keyframes) {
      const bind = armTarget[kf.bone];
      expect(
        bind,
        `keyframe references bone ${kf.bone}, which the target does not have`,
      ).toBeDefined();
      // The assertion the defect fails: the target's OWN translation, not zero and
      // not the source's.
      expect(kf.position.map((n) => Number(n.toFixed(6)))).toEqual(bind.position);
    }
  });

  it('FALSIFICATION: a zeroed translation is not silently accepted', () => {
    // The check above is only worth anything if [0,0,0] would fail it. Two of the
    // three target bones sit off their parent's origin, so a collapse is visible
    // to this comparison by construction.
    expect(armTarget.filter((b) => b.position.some((n) => n !== 0)).length).toBeGreaterThan(1);
  });

  it('still transfers the ROTATION, so this is not a clip that does nothing', () => {
    // The pair. A fix that stopped emitting keyframes at all would satisfy the
    // proportions check and destroy the feature.
    const result = retargetClip({
      sourceBones: armSource,
      sourceClip: { name: 'wave', duration: 1, keyframes: rotationOnly },
      targetBones: armTarget,
      nameMap: NAME_MAP,
    });
    const moved = result.clipParams.keyframes.some((kf) =>
      kf.rotation.some((n) => Math.abs(n) > 1e-6),
    );
    expect(moved).toBe(true);
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

describe('a corrective root survives, and the root travels (#838, #839)', () => {
  // Both were reported as one symptom — "the motion is not mapping to the
  // character cleanly" — and they are two defects with two causes.
  const R = Math.PI / 2;

  /** A target shaped like a real Tripo rig: Z-up under a corrective root. */
  const target: BoneSpec[] = [
    { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [-R, 0, R] },
    { name: 'tgt_hips', parent: 0, position: [0, 0, 0.5], rotation: [0, 0, 0] },
    { name: 'tgt_spine', parent: 1, position: [0, 0.05, 0], rotation: [0, 0, 0] },
  ];
  /** A Y-up source, twice the size — as a SOMA clip is against a Tripo rig. */
  //
  // 🔑 THE SOURCE CARRIES A BONE NAMED `Root` TOO, AND THAT IS THE POINT. A SOMA
  // BVH's first joint is literally `ROOT Root`, and so is the Tripo rig's
  // corrective bone — two bones that share a name and nothing else. Nothing maps
  // between them, but `SkeletonUtils.retargetClip` falls back to a bone's OWN
  // name when the map is silent (SkeletonUtils.js:253), so the collision emits a
  // track for the target's `Root` driven by the source's. Without this bone in
  // the fixture no track is emitted at all and the gate passes vacuously.
  const source: BoneSpec[] = [
    { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'src_hips', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'src_spine', parent: 1, position: [0, 0.1, 0], rotation: [0, 0, 0] },
  ];
  const NAME_MAP = { src_hips: 'tgt_hips', src_spine: 'tgt_spine' };

  /** A clip that WALKS: the root translates 4 units along Z while the spine bends. */
  const walk: AnimationKeyframe[] = [
    { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone: 0, time: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 1, 4], rotation: [0, 0, 0] },
    { bone: 2, time: 0, position: [0, 0.1, 0], rotation: [0, 0, 0] },
    { bone: 2, time: 1, position: [0, 0.1, 0], rotation: [0, 0.5, 0] },
  ];

  const run = () =>
    retargetClip({
      sourceBones: source,
      sourceClip: { name: 'walk', duration: 1, keyframes: walk },
      targetBones: target,
      nameMap: NAME_MAP,
    });

  it('#838 the corrective root keeps its bind rotation instead of being flattened', () => {
    // `Root` stands a Z-up skeleton upright inside a Y-up glTF. Driving it to
    // identity lies the whole character down, and nothing else in the suite can
    // see it because every other fixture rig has an identity root.
    const rootKeys = run().clipParams.keyframes.filter((k) => k.bone === 0);
    expect(rootKeys.length).toBeGreaterThan(0);
    for (const k of rootKeys) {
      const deg = k.rotation.map((n) => {
        const d = (n * 180) / Math.PI;
        return Math.abs(d) < 1e-6 ? 0 : +d.toFixed(2);
      });
      expect(deg).toEqual([-90, 0, 90]);
    }
  });

  it('#839 the root TRAVELS, scaled by the two rigs’ height ratio', () => {
    const hips = run().clipParams.keyframes.filter((k) => k.bone === 1);
    const travel = [0, 1, 2].map(
      (i) =>
        Math.max(...hips.map((k) => k.position[i])) - Math.min(...hips.map((k) => k.position[i])),
    );
    const moved = Math.max(...travel);
    // Source travels 4 along its own Z; the target's hips sit at 0.5 against the
    // source's 1.0, so the ratio is 0.5 and the target must travel 2.
    expect(moved).toBeGreaterThan(1.9);
    expect(moved).toBeLessThan(2.1);
  });

  it('FALSIFICATION: a NON-root bone does not take the source translation', () => {
    // The pair that keeps #839 from becoming #828 again. A limb's translation IS
    // its bone length; taking the source's would stretch the character to the
    // source's proportions, which is the thing a retarget exists to prevent.
    const spine = run().clipParams.keyframes.filter((k) => k.bone === 2);
    for (const k of spine) {
      expect(k.position.map((n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(4)))).toEqual([0, 0.05, 0]);
    }
  });

  it('still transfers ROTATION, so none of this bought a clip that does nothing', () => {
    const spine = run().clipParams.keyframes.filter((k) => k.bone === 2);
    expect(spine.some((k) => k.rotation.some((n) => Math.abs(n) > 1e-6))).toBe(true);
  });
});

describe('rest-pose reconciliation between rigs with different bone axes (#844)', () => {
  // A source shaped like a real SOMA BVH: the REST lays the chain along +X
  // (degenerate), and the CALIBRATION rotation at frame 0 stands it up along
  // +Y. A target shaped like Mixamo: its bind already runs up +Y.
  //
  // The axes are the whole point of the fixture. A source whose rest already
  // pointed the same way as the target could not tell a correct reconciliation
  // from no reconciliation at all — the defect would be unreachable, and the
  // suite would be measuring the fixture rather than the code.
  const SRC: BoneSpec[] = [
    { name: 's_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 's_spine', parent: 0, position: [1, 0, 0], rotation: [0, 0, 0] },
  ];
  const TRG: BoneSpec[] = [
    { name: 't_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 't_spine', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];
  const TARGET_TO_SOURCE = { t_hips: 's_hips', t_spine: 's_spine' };
  // +90° about Z takes the source's +X chain onto +Y — its "A-pose".
  const CALIBRATION = new Map<number, [number, number, number]>([[0, [0, 0, Math.PI / 2]]]);

  const build = () => {
    const src = specToThreeSkeleton(SRC);
    const trg = specToThreeSkeleton(TRG);
    return { src, trg };
  };

  it('an offset carries the source reference orientation onto the target bind', () => {
    const { src, trg } = build();
    const offsets = restPoseLocalOffsets(src.bones, trg.bones, TARGET_TO_SOURCE, CALIBRATION);

    // Re-pose the source to the calibration and read the world rotation the
    // retarget would hand us for the mapped bone.
    src.bones[0].rotation.set(0, 0, Math.PI / 2, 'XYZ');
    src.bones[0].updateMatrixWorld(true);
    const sourceWorld = new Quaternion().setFromRotationMatrix(src.bones[0].matrixWorld);

    // THE CONTRACT: sourceWorld * offset === the target's bind world rotation.
    // That equality is what makes a copied world rotation mean the same thing
    // on the target as it did on the source.
    const composed = sourceWorld
      .clone()
      .multiply(new Quaternion().setFromRotationMatrix(offsets['t_hips']));
    trg.bones[0].updateMatrixWorld(true);
    const targetBind = new Quaternion().setFromRotationMatrix(trg.bones[0].matrixWorld);
    expect(composed.angleTo(targetBind)).toBeLessThan(1e-6);
  });

  it('the falsifying arm: without the offset the two differ by the calibration angle', () => {
    // Not a tautology — it pins that the fixture actually EXERCISES an axis
    // mismatch. If this arm ever goes to zero the fixture has gone degenerate
    // and the test above proves nothing.
    const { src, trg } = build();
    src.bones[0].rotation.set(0, 0, Math.PI / 2, 'XYZ');
    src.bones[0].updateMatrixWorld(true);
    trg.bones[0].updateMatrixWorld(true);
    const sourceWorld = new Quaternion().setFromRotationMatrix(src.bones[0].matrixWorld);
    const targetBind = new Quaternion().setFromRotationMatrix(trg.bones[0].matrixWorld);
    expect(sourceWorld.angleTo(targetBind)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('leaves the source skeleton exactly as it found it', () => {
    // The caller shares these bone objects with the retarget that runs next, so
    // borrowing them to read a reference pose must leave no trace (V20).
    const { src, trg } = build();
    const before = src.bones.map((b) => b.quaternion.clone());
    restPoseLocalOffsets(src.bones, trg.bones, TARGET_TO_SOURCE, CALIBRATION);
    src.bones.forEach((b, i) => {
      expect(b.quaternion.angleTo(before[i])).toBeLessThan(1e-9);
    });
  });

  it('emits no entry for a target bone the map does not cover', () => {
    const { src, trg } = build();
    const offsets = restPoseLocalOffsets(src.bones, trg.bones, { t_hips: 's_hips' }, CALIBRATION);
    expect(offsets['t_hips']).toBeInstanceOf(Matrix4);
    // An unmapped bone keeps whatever the retarget gives it — notably the root,
    // which is never in a name map.
    expect(offsets['t_spine']).toBeUndefined();
  });
});

describe('the retarget scale comes from the leg chain, not the hip offset (#846)', () => {
  // THE FIXTURE HAS TO SEPARATE FOUR ANSWERS, not two. Every basis that was
  // considered must produce a DIFFERENT number here, or a green assertion cannot
  // say which one the code used — the failure V322 records one level down.
  //
  //   hip offset      0.5 / 1.0                    = 0.5
  //   longest leg     0.4 / 1.0                    = 0.4
  //   shorter leg     0.6 / 0.8                    = 0.75
  //   both legs       (0.6 + 0.4) / (0.8 + 1.0)    = 0.5555…   ← what ships
  //
  // The source is shaped like a SOMA rig: a NOMINAL hip offset of 1.0 that is not
  // a measurement of anything, legs laid along +X. The target is shaped like
  // Mixamo: a hip offset that really is its hip height, legs along +Y. The two
  // rigs are also deliberately ASYMMETRIC — left and right differ — because a
  // symmetric fixture cannot tell "sum both legs" from "pick one".

  /** legs given as [upper, lower] segment lengths per side. */
  const rig = (
    prefix: string,
    axis: 0 | 1,
    hipOffset: number,
    left: readonly [number, number],
    right: readonly [number, number],
  ): BoneSpec[] => {
    const along = (n: number): [number, number, number] => (axis === 0 ? [n, 0, 0] : [0, n, 0]);
    const hip: [number, number, number] = axis === 0 ? [0, hipOffset, 0] : [0, hipOffset, 0];
    const bones: BoneSpec[] = [
      { name: `${prefix}_root`, parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: `${prefix}_hips`, parent: 0, position: hip, rotation: [0, 0, 0] },
      // A spine, so the leg has something to be picked OVER. Its two joints are
      // short, which is what makes "the longest limb below the pelvis" a leg.
      { name: `${prefix}_spine`, parent: 1, position: along(0.05), rotation: [0, 0, 0] },
      { name: `${prefix}_chest`, parent: 2, position: along(0.05), rotation: [0, 0, 0] },
      { name: `${prefix}_neck`, parent: 3, position: along(0.05), rotation: [0, 0, 0] },
    ];
    for (const [side, seg] of [
      ['L', left],
      ['R', right],
    ] as const) {
      const base = bones.length;
      bones.push(
        {
          name: `${prefix}_thigh${side}`,
          parent: 1,
          position: [0, 0, side === 'L' ? 0.1 : -0.1],
          rotation: [0, 0, 0],
        },
        {
          name: `${prefix}_knee${side}`,
          parent: base,
          position: along(seg[0]),
          rotation: [0, 0, 0],
        },
        {
          name: `${prefix}_ankle${side}`,
          parent: base + 1,
          position: along(seg[1]),
          rotation: [0, 0, 0],
        },
        // A foot, so the chain has somewhere to stop. Feet are the one part two
        // humanoids do NOT scale together, so they must not enter the measure.
        {
          name: `${prefix}_toe${side}`,
          parent: base + 2,
          position: along(0.4),
          rotation: [0, 0, 0],
        },
      );
    }
    return bones;
  };

  const NAMES = [
    'hips',
    'spine',
    'chest',
    'neck',
    'thighL',
    'kneeL',
    'ankleL',
    'toeL',
    'thighR',
    'kneeR',
    'ankleR',
    'toeR',
  ];
  const MAP = Object.fromEntries(NAMES.map((n) => [`s_${n}`, `t_${n}`]));

  const source = (left: [number, number], right: [number, number]) => rig('s', 0, 1.0, left, right);
  const target = (left: [number, number], right: [number, number]) => rig('t', 1, 0.5, left, right);

  const SRC_LEGS: [[number, number], [number, number]] = [
    [0.4, 0.4],
    [0.5, 0.5],
  ];
  const TRG_LEGS: [[number, number], [number, number]] = [
    [0.3, 0.3],
    [0.2, 0.2],
  ];

  it('sums thigh and shin over BOTH legs', () => {
    const scale = retargetScale('s_hips', source(...SRC_LEGS), MAP, target(...TRG_LEGS));
    expect(scale).toBeCloseTo((0.6 + 0.4) / (0.8 + 1.0), 10);
  });

  it('FALSIFICATION: it is none of the three other bases the fixture offers', () => {
    // Not decoration. Without this the assertion above is a number that happens to
    // be right; with it, every basis that was actually considered is excluded by
    // measurement rather than by reading the code.
    const scale = retargetScale('s_hips', source(...SRC_LEGS), MAP, target(...TRG_LEGS));
    expect(scale).not.toBeCloseTo(0.5, 3); // the hip offset — the shipped bug
    expect(scale).not.toBeCloseTo(0.4, 3); // the longest leg alone
    expect(scale).not.toBeCloseTo(0.75, 3); // the shorter leg alone
  });

  it('does not turn on WHICH of the source legs is longer', () => {
    // THE COIN FLIP THIS REPLACED, reproduced at the proportions that produced it.
    // Taking the single longest leg selects on the SOURCE while the answer varies
    // with the TARGET, so a 0.5% difference between two source legs chose between
    // two target legs 50% apart. On the real rig the source legs differ by 0.1%
    // and the targets by 2.6% — near-identical inputs, materially different
    // answers, decided by rounding.
    //
    // Swapping both rigs together would NOT catch this: the selection flips and
    // so does the thing selected, and the wrong rule survives. Only the source
    // moves here.
    const targets = target([0.3, 0.3], [0.2, 0.2]);
    const rightLonger = retargetScale('s_hips', source([0.45, 0.45], [0.455, 0.455]), MAP, targets);
    const leftLonger = retargetScale('s_hips', source([0.455, 0.455], [0.45, 0.45]), MAP, targets);
    expect(leftLonger).toBeCloseTo(rightLonger, 10);
    // …and it is the sum, not either leg: 1.0 / 1.81, against 0.44 and 0.66.
    expect(rightLonger).toBeCloseTo(1.0 / 1.81, 10);
  });

  it('the foot is excluded, so a rig with an outsized foot measures the same', () => {
    // The real pair's toe segments are 0.142 against 0.036 — a factor of four
    // where thigh and shin agree within 2%. A measure that included them would
    // move here; this one must not.
    const stretched = target(...TRG_LEGS).map((b) =>
      b.name.startsWith('t_toe') ? { ...b, position: [0, 4, 0] as [number, number, number] } : b,
    );
    expect(retargetScale('s_hips', source(...SRC_LEGS), MAP, stretched)).toBeCloseTo(
      (0.6 + 0.4) / (0.8 + 1.0),
      10,
    );
  });

  it('the spine is not mistaken for a leg', () => {
    // Removing it must not move the number. If it did, the spine was in the
    // measure — silently, and in the direction that flatters the old basis,
    // because two rigs' spines are proportioned far more alike than their legs.
    const noSpine = (bones: BoneSpec[]) =>
      bones.filter((b) => !/_(spine|chest|neck)$/.test(b.name));
    const reindex = (bones: BoneSpec[]): BoneSpec[] => {
      const kept = noSpine(bones);
      const at = new Map(kept.map((b, i) => [b.name, i]));
      const nameOf = new Map(bones.map((b, i) => [i, b.name]));
      return kept.map((b) => ({
        ...b,
        parent: b.parent < 0 ? -1 : (at.get(nameOf.get(b.parent) as string) ?? -1),
      }));
    };
    expect(
      retargetScale('s_hips', reindex(source(...SRC_LEGS)), MAP, reindex(target(...TRG_LEGS))),
    ).toBeCloseTo((0.6 + 0.4) / (0.8 + 1.0), 10);
  });

  it('falls back to the hip offset — never to 1 — when no leg is readable', () => {
    // A rig too simple to carry a two-segment limb still needs SOME basis. 1 is
    // not it: an unscaled source hip at 1.0 lands a target whose hips belong at
    // 0.5 exactly twice as high, which is the bug #839 fixed seen from the far
    // side. This is also the arm the 3-bone fixtures elsewhere in this file
    // exercise, so their expectations are characterising the fallback on purpose.
    const flatSource: BoneSpec[] = [
      { name: 's_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 's_spine', parent: 0, position: [0, 0.1, 0], rotation: [0, 0, 0] },
    ];
    const flatTarget: BoneSpec[] = [
      { name: 't_hips', parent: -1, position: [0, 0.5, 0], rotation: [0, 0, 0] },
      { name: 't_spine', parent: 0, position: [0, 0.05, 0], rotation: [0, 0, 0] },
    ];
    expect(
      retargetScale('s_hips', flatSource, { s_hips: 't_hips', s_spine: 't_spine' }, flatTarget),
    ).toBeCloseTo(0.5, 10);
  });

  it('the root TRAVELS by the leg-chain ratio — measured at the consumer', () => {
    // The product-side arm: what a director would actually see is the root moving
    // a different distance than the legs are stepping. Asserting the scalar alone
    // would not catch a scale that is computed correctly and then not passed on.
    const src = source(...SRC_LEGS);
    const trg = target(...TRG_LEGS);
    const hips = src.findIndex((b) => b.name === 's_hips');
    const keyframes: AnimationKeyframe[] = [
      { bone: hips, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { bone: hips, time: 1, position: [0, 1, 4], rotation: [0, 0, 0] },
    ];
    const out = retargetClip({
      sourceBones: src,
      sourceClip: { name: 'walk', duration: 1, keyframes },
      targetBones: trg,
      nameMap: MAP,
    });
    const tHips = trg.findIndex((b) => b.name === 't_hips');
    const keys = out.clipParams.keyframes.filter((k) => k.bone === tHips);
    const travel = Math.max(
      ...[0, 1, 2].map(
        (i) =>
          Math.max(...keys.map((k) => k.position[i])) - Math.min(...keys.map((k) => k.position[i])),
      ),
    );
    // 4 source units at 0.5555… — and NOT the 2.0 the hip offset would have given.
    expect(travel).toBeCloseTo(4 * ((0.6 + 0.4) / (0.8 + 1.0)), 4);
    expect(travel).not.toBeCloseTo(2.0, 2);
  });
});
