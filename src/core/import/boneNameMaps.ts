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
// glTF-RIG BRIDGE (Phase 7.11 Wave D, #100): a `GltfSkeleton` projection
// (src/nodes/GltfSkeleton.ts) outputs `BoneSpec[]` whose names are the
// glTF asset's NATIVE, SANITIZED joint keys (`skin.joints[]` order). When a
// director drops a Mixamo/BVH clip (a DIFFERENT vocabulary) onto that rig,
// the retarget engine binds source→target by NAME — so a bridge that maps
// the foreign source names ONTO the glTF-native joint keys is load-bearing.
// With glTF-native names an IDENTITY map is a NO-OP (every source bone would
// be unbound — research risk #4: silent all-unbound); the preset below is a
// genuine NON-IDENTITY map (foreign source names → glTF-native keys), and
// the retarget path surfaces `unmappedSourceBones`/`unboundTargetBones`
// (retarget.ts:58-60) so a broken bridge is observable, not silent.
//
// V9 (data not code): every bridge is a static `Record<string,string>` —
// the wiring is data, picked by a stable preset id (no code branch per rig).
//
// REF: THESIS §42.1; project_p31_plan.md; PLAN 7.11 Wave D (D1) / CONTEXT
// D-01; GltfSkeleton.ts (the projected target rig); retarget.ts (the engine
// + unmapped/unbound surfacing).

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

// Foreign source vocabulary → a glTF rig's NATIVE joint keys (Phase 7.11
// Wave D, #100). A GltfSkeleton projects bind data into BoneSpec[] whose
// names are the asset's sanitized joint keys in `skin.joints[]` order — e.g.
// the committed `skinned-bar.glb` rig is `Bone0`/`Bone1`. A Mixamo/BVH clip
// authored on `mixamorig_*` names binds to NOTHING on such a rig without a
// bridge, so this is a deliberately NON-IDENTITY map (the source and target
// vocabularies DIFFER): it proves the bridge is load-bearing rather than the
// no-op an identity map would be (research risk #4: silent all-unbound).
//
// This 2-joint map matches the committed `skinned-bar` rig so the Wave F6b
// cross-vocabulary proof needs no humanoid fixture. Real Blender-exported
// glTF rigs typically carry their own joint vocabulary; a director supplies
// the matching map via `customMap` (V9: data, not code) or a project preset.
const MIXAMO_TO_GLTF_BAR_RIG: Readonly<Record<string, string>> = {
  mixamorig_Hips: 'Bone0',
  mixamorig_Spine: 'Bone1',
};

// SOMA — the skeleton the text-to-motion generator emits (phase A1). Read from
// the generator's own source, not from its docs: `kimodo/skeleton/definitions.py`
// `SOMASkeleton77.bone_order_names_with_parents` (77 joints, verified by count),
// and `kimodo/exports/bvh.py::motion_to_bvh`, which names joints straight from
// `skeleton.bone_order_names` with no namespace prefix. So a generated clip
// arrives on BARE names — `Hips`, `Spine1` — and our sanitiser leaves them alone.
//
// 🔴 SOMA AND MIXAMO DISAGREE ABOUT WHAT A "LEG" IS, and the disagreement is
// silent because both vocabularies contain the word:
//
//     SOMA    Hips → LeftLeg  → LeftShin → LeftFoot → LeftToeBase
//     Mixamo  Hips → LeftUpLeg → LeftLeg  → LeftFoot → LeftToeBase
//
// SOMA's `LeftLeg` is the THIGH; Mixamo's `LeftLeg` is the SHIN. A map built by
// matching names would bind the thigh onto the shin on both sides of the body —
// a rig that animates, looks broken in a way nobody can name, and raises no
// error anywhere. The maps below are written against the PARENTAGE, which is why
// `LeftLeg` appears on the left of one row and the right of another.
//
// Two further mismatches, handled by mapping structurally rather than by name:
// SOMA's spine is Spine1 → Spine2 → Chest where Mixamo's is Spine → Spine1 →
// Spine2, and SOMA has two neck joints (Neck1, Neck2) where the targets have
// one. Neck1 takes it, being the joint in the same position — the direct child
// of the chest. SOMA's fingers, jaw, eyes and end-effectors have no counterpart
// in either target vocabulary and are deliberately left out; the retarget path
// reports them through `unmappedSourceBones`, which is the honest answer.
//
// REF: https://github.com/nv-tlabs/kimodo — kimodo/skeleton/definitions.py,
// kimodo/exports/bvh.py. Licence verdict for the checkpoints that produce this
// skeleton: src/core/licensing/external-models.json.
const SOMA_TO_GLTF_HUMANOID: Readonly<Record<string, string>> = {
  Hips: 'hips',
  Spine1: 'spine',
  Spine2: 'spine.001',
  Chest: 'spine.002',
  Neck1: 'neck',
  Head: 'head',
  LeftShoulder: 'shoulder.L',
  LeftArm: 'upper_arm.L',
  LeftForeArm: 'forearm.L',
  LeftHand: 'hand.L',
  RightShoulder: 'shoulder.R',
  RightArm: 'upper_arm.R',
  RightForeArm: 'forearm.R',
  RightHand: 'hand.R',
  LeftLeg: 'thigh.L', // SOMA's LeftLeg is the thigh — see the note above.
  LeftShin: 'shin.L',
  LeftFoot: 'foot.L',
  LeftToeBase: 'toe.L',
  RightLeg: 'thigh.R',
  RightShin: 'shin.R',
  RightFoot: 'foot.R',
  RightToeBase: 'toe.R',
};

// The A1 story in one map: a generated clip driving an imported Mixamo character.
// Targets are spelled `mixamorig_*` because that is what both roads that carry a
// CHARACTER produce — glTF through our sanitiser, and BVH likewise. (FBX removes
// the separator instead, but `fbx.ts` defers SkinnedMesh import by design, so an
// FBX file supplies motion, never the character being driven.)
const SOMA_TO_MIXAMO: Readonly<Record<string, string>> = {
  Hips: 'mixamorig_Hips',
  Spine1: 'mixamorig_Spine',
  Spine2: 'mixamorig_Spine1',
  Chest: 'mixamorig_Spine2',
  Neck1: 'mixamorig_Neck',
  Head: 'mixamorig_Head',
  LeftShoulder: 'mixamorig_LeftShoulder',
  LeftArm: 'mixamorig_LeftArm',
  LeftForeArm: 'mixamorig_LeftForeArm',
  LeftHand: 'mixamorig_LeftHand',
  RightShoulder: 'mixamorig_RightShoulder',
  RightArm: 'mixamorig_RightArm',
  RightForeArm: 'mixamorig_RightForeArm',
  RightHand: 'mixamorig_RightHand',
  LeftLeg: 'mixamorig_LeftUpLeg', // thigh → thigh, NOT LeftLeg → LeftLeg.
  LeftShin: 'mixamorig_LeftLeg', // shin → shin.
  LeftFoot: 'mixamorig_LeftFoot',
  LeftToeBase: 'mixamorig_LeftToeBase',
  RightLeg: 'mixamorig_RightUpLeg',
  RightShin: 'mixamorig_RightLeg',
  RightFoot: 'mixamorig_RightFoot',
  RightToeBase: 'mixamorig_RightToeBase',
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
  {
    id: 'mixamoToGltfBarRig',
    name: 'Mixamo → glTF bar rig (skinned-bar)',
    source: 'Mixamo',
    target: 'glTF (native joint keys)',
    map: MIXAMO_TO_GLTF_BAR_RIG,
  },
  {
    id: 'somaToGltf',
    name: 'SOMA → glTF humanoid',
    source: 'SOMA (generated motion)',
    target: 'glTF',
    map: SOMA_TO_GLTF_HUMANOID,
  },
  {
    id: 'somaToMixamo',
    name: 'SOMA → Mixamo humanoid',
    source: 'SOMA (generated motion)',
    target: 'Mixamo',
    map: SOMA_TO_MIXAMO,
  },
];

export function getBoneNameMapPreset(id: string): BoneNameMapPreset | undefined {
  return BONE_NAME_MAP_PRESETS.find((p) => p.id === id);
}

export function listBoneNameMapPresets(): readonly BoneNameMapPreset[] {
  return BONE_NAME_MAP_PRESETS;
}
