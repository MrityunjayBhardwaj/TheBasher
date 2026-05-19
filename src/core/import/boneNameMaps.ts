// Pre-built bone-name maps for common rig pairs. Catalog of static
// records keyed by a stable id. The agent's mutator.animation.retarget
// accepts either a catalog id (cheap LLM round) or an explicit
// Record<string, string> (custom rigs).
//
// Sources:
//   - Mixamo bone naming: `mixamorig_<JointName>`. Reference: Adobe
//     Mixamo official docs (humanoid skeleton).
//   - glTF / standard humanoid: lowercase joint names per the Khronos
//     glTF skinning examples.
//   - Reze Studio: PascalCase joint names per their character demos.
//   - Blender Rigify (metarig): Blender's stock human metarig
//     deform-bone naming.
//
// REF: THESIS §42.1; project_p31_plan.md.

export interface BoneNameMapPreset {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly map: Readonly<Record<string, string>>;
}

const MIXAMO_TO_GLTF_HUMANOID: Readonly<Record<string, string>> = {
  mixamorig_Hips: 'hips',
  mixamorig_Spine: 'spine',
  mixamorig_Spine1: 'spine.001',
  mixamorig_Spine2: 'spine.002',
  mixamorig_Neck: 'neck',
  mixamorig_Head: 'head',
  mixamorig_LeftShoulder: 'shoulder.L',
  mixamorig_LeftArm: 'upper_arm.L',
  mixamorig_LeftForeArm: 'forearm.L',
  mixamorig_LeftHand: 'hand.L',
  mixamorig_RightShoulder: 'shoulder.R',
  mixamorig_RightArm: 'upper_arm.R',
  mixamorig_RightForeArm: 'forearm.R',
  mixamorig_RightHand: 'hand.R',
  mixamorig_LeftUpLeg: 'thigh.L',
  mixamorig_LeftLeg: 'shin.L',
  mixamorig_LeftFoot: 'foot.L',
  mixamorig_LeftToeBase: 'toe.L',
  mixamorig_RightUpLeg: 'thigh.R',
  mixamorig_RightLeg: 'shin.R',
  mixamorig_RightFoot: 'foot.R',
  mixamorig_RightToeBase: 'toe.R',
};

const MIXAMO_TO_REZE: Readonly<Record<string, string>> = {
  mixamorig_Hips: 'Hips',
  mixamorig_Spine: 'Spine',
  mixamorig_Spine1: 'Spine1',
  mixamorig_Spine2: 'Chest',
  mixamorig_Neck: 'Neck',
  mixamorig_Head: 'Head',
  mixamorig_LeftShoulder: 'LeftShoulder',
  mixamorig_LeftArm: 'LeftUpperArm',
  mixamorig_LeftForeArm: 'LeftLowerArm',
  mixamorig_LeftHand: 'LeftHand',
  mixamorig_RightShoulder: 'RightShoulder',
  mixamorig_RightArm: 'RightUpperArm',
  mixamorig_RightForeArm: 'RightLowerArm',
  mixamorig_RightHand: 'RightHand',
  mixamorig_LeftUpLeg: 'LeftUpperLeg',
  mixamorig_LeftLeg: 'LeftLowerLeg',
  mixamorig_LeftFoot: 'LeftFoot',
  mixamorig_RightUpLeg: 'RightUpperLeg',
  mixamorig_RightLeg: 'RightLowerLeg',
  mixamorig_RightFoot: 'RightFoot',
};

const MIXAMO_TO_RIGIFY: Readonly<Record<string, string>> = {
  mixamorig_Hips: 'DEF-spine',
  mixamorig_Spine: 'DEF-spine.001',
  mixamorig_Spine1: 'DEF-spine.002',
  mixamorig_Spine2: 'DEF-spine.003',
  mixamorig_Neck: 'DEF-spine.004',
  mixamorig_Head: 'DEF-spine.006',
  mixamorig_LeftShoulder: 'DEF-shoulder.L',
  mixamorig_LeftArm: 'DEF-upper_arm.L',
  mixamorig_LeftForeArm: 'DEF-forearm.L',
  mixamorig_LeftHand: 'DEF-hand.L',
  mixamorig_RightShoulder: 'DEF-shoulder.R',
  mixamorig_RightArm: 'DEF-upper_arm.R',
  mixamorig_RightForeArm: 'DEF-forearm.R',
  mixamorig_RightHand: 'DEF-hand.R',
  mixamorig_LeftUpLeg: 'DEF-thigh.L',
  mixamorig_LeftLeg: 'DEF-shin.L',
  mixamorig_LeftFoot: 'DEF-foot.L',
  mixamorig_RightUpLeg: 'DEF-thigh.R',
  mixamorig_RightLeg: 'DEF-shin.R',
  mixamorig_RightFoot: 'DEF-foot.R',
};

export const BONE_NAME_MAP_PRESETS: readonly BoneNameMapPreset[] = [
  {
    id: 'mixamoToGltf',
    name: 'Mixamo → glTF humanoid',
    source: 'Mixamo',
    target: 'glTF',
    map: MIXAMO_TO_GLTF_HUMANOID,
  },
  {
    id: 'mixamoToReze',
    name: 'Mixamo → Reze Studio',
    source: 'Mixamo',
    target: 'Reze',
    map: MIXAMO_TO_REZE,
  },
  {
    id: 'mixamoToRigify',
    name: 'Mixamo → Blender Rigify',
    source: 'Mixamo',
    target: 'Rigify',
    map: MIXAMO_TO_RIGIFY,
  },
];

export function getBoneNameMapPreset(id: string): BoneNameMapPreset | undefined {
  return BONE_NAME_MAP_PRESETS.find((p) => p.id === id);
}

export function listBoneNameMapPresets(): readonly BoneNameMapPreset[] {
  return BONE_NAME_MAP_PRESETS;
}
