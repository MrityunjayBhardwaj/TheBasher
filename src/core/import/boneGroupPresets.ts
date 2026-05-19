// Bone-group preset catalog — named bone-mask presets for
// AnimationLayer.boneMask. Editor sugar: a layer's "Upper body" mask
// resolves to a fixed list of bone names; user picks the preset by name
// instead of typing every bone.
//
// Deferred from P3 Wave C; ships as part of P3.1 Wave C alongside
// retargeting because both are bone-name-resolution surfaces. Same
// boundary class.
//
// V0.5 ships standard humanoid groups. Custom rig groups land when a
// real authoring case appears (the user can always type a bone-mask
// list manually in the meantime).
//
// REF: THESIS §42 (bone-group preset catalog mention); project_p31_plan.md.

export interface BoneGroupPreset {
  readonly id: string;
  readonly name: string;
  readonly bones: readonly string[];
}

// Bone names track the glTF humanoid / Rigify deform convention. When a
// rig uses different names (Mixamo, Reze), the user's BoneNameMap must
// translate before the mask applies — same name-resolution boundary
// class.
const UPPER_BODY: BoneGroupPreset = {
  id: 'upperBody',
  name: 'Upper body',
  bones: [
    'spine',
    'spine.001',
    'spine.002',
    'neck',
    'head',
    'shoulder.L',
    'upper_arm.L',
    'forearm.L',
    'hand.L',
    'shoulder.R',
    'upper_arm.R',
    'forearm.R',
    'hand.R',
  ],
};

const LOWER_BODY: BoneGroupPreset = {
  id: 'lowerBody',
  name: 'Lower body',
  bones: ['hips', 'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R'],
};

const ARMS_ONLY: BoneGroupPreset = {
  id: 'arms',
  name: 'Arms only',
  bones: [
    'shoulder.L',
    'upper_arm.L',
    'forearm.L',
    'hand.L',
    'shoulder.R',
    'upper_arm.R',
    'forearm.R',
    'hand.R',
  ],
};

const HEAD_AND_NECK: BoneGroupPreset = {
  id: 'headAndNeck',
  name: 'Head + neck',
  bones: ['neck', 'head'],
};

export const BONE_GROUP_PRESETS: readonly BoneGroupPreset[] = [
  UPPER_BODY,
  LOWER_BODY,
  ARMS_ONLY,
  HEAD_AND_NECK,
];

export function getBoneGroupPreset(id: string): BoneGroupPreset | undefined {
  return BONE_GROUP_PRESETS.find((p) => p.id === id);
}

export function listBoneGroupPresets(): readonly BoneGroupPreset[] {
  return BONE_GROUP_PRESETS;
}
