// FBX import — converts three's FBXLoader output to our DAG-native
// AnimationClipParams + Skeleton bone list.
//
// THREE.FBXLoader.parse(buffer) returns a THREE.Group whose subtree may
// contain SkinnedMesh children (each with their own .skeleton) and a
// .animations[] array of THREE.AnimationClip. We take the rig that holds
// the first skin (every bone in it, not only the skin's — `extractBones`)
// and the first clip — multi-skeleton / multi-clip FBX files are rare in
// director workflows; revisit if a real authoring case appears.
//
// SkinnedMesh geometry import is deferred to a later wave / phase.
// The skeleton + clip alone are enough to drive Mixamo retargeting onto
// existing rigs — which IS the load-bearing P3.1 use case.
//
// THREE.FBXLoader is a full-JS parser (no FBX SDK). Some proprietary
// FBX features (NURBS, certain subdivs) won't parse — fail loudly per
// project_p31_plan honesty contract.
//
// REF: THESIS §42.1 (P3.1); project_p31_plan.md.

import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type {
  Bone,
  Group,
  Object3D,
  AnimationClip as ThreeAnimationClip,
  SkinnedMesh,
} from 'three';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';
import { bonesToSpec, clipToKeyframes, type ClipShape } from './threeAdapter';
import { scaleBonePositions, scaleKeyframePositions } from './unitScale';
import type { ClipLoop } from '../../nodes/clipLoop';

export interface FbxSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface FbxClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: ClipLoop;
  readonly keyframes: readonly AnimationKeyframe[];
}

export interface FbxImportResult {
  readonly skeletonParams: FbxSkeletonParams;
  readonly clipParams: FbxClipParams;
}

/**
 * FBX's base length unit is the centimetre: `UnitScaleFactor` is centimetres per file unit, and
 * a file that omits it means 1 — centimetres. Blender reads it exactly so, and multiplies its
 * scene scale by `UnitScaleFactor / 100` for a metre scene (`io_scene_fbx/import_fbx.py:3132-3135`,
 * default 1.0 at `:3133`).
 */
const FBX_DEFAULT_UNIT_SCALE_FACTOR = 1;
const CENTIMETRES_PER_METRE = 100;

/**
 * #1086 — metres per file unit, from the unit the file DECLARES.
 *
 * Three's FBXLoader reads `GlobalSettings.UnitScaleFactor` and records it on the returned group
 * (`FBXLoader.js`, `userData.unitScaleFactor`) without applying it, so a Mixamo file — which
 * declares 1, centimetres — parses with its hips 99.67 units up. Read here, where every FBX
 * door passes, so the drop, the picker, the Library and both dev seams all get it.
 *
 * A declared factor that is not a positive, finite number is refused rather than defaulted:
 * the file has stated its unit and stated it wrongly, and guessing over that is the silent
 * wrong size this exists to remove.
 */
export function fbxMetresPerUnit(group: { userData?: Record<string, unknown> }): number {
  const declared = group.userData?.unitScaleFactor;
  const factor = declared === undefined ? FBX_DEFAULT_UNIT_SCALE_FACTOR : declared;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(
      `FBX declares UnitScaleFactor ${String(declared)} — not a positive number of centimetres per unit, so its size cannot be read.`,
    );
  }
  return factor / CENTIMETRES_PER_METRE;
}

/**
 * Parse an FBX payload (ArrayBuffer for binary, string for ASCII).
 * Throws when three's FBXLoader rejects the input.
 *
 * Lengths come out in METRES, in the unit the file declares (`fbxMetresPerUnit`) — the same
 * place the BVH road applies a unit its producer declares (#790), so nothing downstream sizes
 * the rig a second time.
 *
 * Measured against the reference on `mixamo-samba.fbx`: Blender 5.1.1 imports it with the hips
 * at 0.95577 m world height on its first frame; this road draws them at 0.95577 m. Blender
 * reaches that number differently — it leaves the bones in centimetres and puts 0.01 on the
 * armature OBJECT's scale — so the two agree in the world and differ in what the Scale field
 * reads (#1086).
 *
 * The unit goes into the bones on purpose, not by omission. Blender's placement is forced by
 * its axis conversion, not chosen for the unit: it multiplies the unit into the same matrix
 * as FBX's Y-up → Z-up rotation (`import_fbx.py:3135`, `:3146`, Blender 4.5.9) and hangs that
 * matrix on the root objects (`:2364`), because its option to bake the transform into data
 * skips armatures and bones (`:2358`) and is labelled broken with them (`__init__.py:90`).
 * Its own BVH importer, which has no axis matrix to carry, bakes its scale into the bone
 * data (`io_anim_bvh/import_bvh.py:151`, `:277`). Three is Y-up like FBX, so there is no
 * matrix here, and putting the unit in the bones keeps one convention across roads: a
 * generated clip's declared unit lands in its bones too (#790), and every stand-in Object
 * stays at scale 1.
 */
export function parseFbx(input: ArrayBuffer | string, name = 'imported-fbx'): FbxImportResult {
  const loader = new FBXLoader();
  const group = loader.parse(input as ArrayBuffer, '');
  // FBXLoader.parse signature: (data: ArrayBuffer, path: string) → Group
  // The path is used to resolve textures; we pass empty since we don't
  // import meshes/textures in this wave.
  const metresPerUnit = fbxMetresPerUnit(group);

  const bones = extractBones(group);
  if (bones.length === 0) {
    throw new Error('FBX contains no skeleton or skinned mesh — nothing to import.');
  }
  const skeletonBones = bonesToSpec(bones);

  // First animation clip wins. group.animations[] is THREE.AnimationClip[].
  const clip = (group as unknown as { animations: ThreeAnimationClip[] }).animations[0];
  if (!clip) {
    // Skeleton-only FBX — rare but valid (T-pose import). Empty clip.
    return {
      skeletonParams: { bones: scaleBonePositions(skeletonBones, metresPerUnit) },
      clipParams: { name, duration: 0, loop: 'hold', keyframes: [] },
    };
  }

  const keyframes = clipToKeyframes(clip as ClipShape, skeletonBones);
  return {
    skeletonParams: { bones: scaleBonePositions(skeletonBones, metresPerUnit) },
    clipParams: {
      name,
      duration: clip.duration > 0 ? clip.duration : 1,
      // #927 — an assertion about the file, not a value from it. See the long
      // note at the same decision in `bvh.ts`: no FBX animation stack states that
      // its motion returns to its start, the reference systems default to holding
      // the endpoint, and since #924 an asserted `true` makes a one-shot travel
      // away from its own end instead of stopping there. The skeleton-only branch
      // above has always said `false`; these two now agree.
      loop: 'hold',
      keyframes: scaleKeyframePositions(keyframes, metresPerUnit),
    },
  };
}

/**
 * The rig's bones, root first and every parent before its children.
 *
 * #1184 — a skin lists only the bones it is weighted to, so reading the bone set off one skin
 * dropped every bone no mesh is weighted to: on `mixamo-samba.fbx` the head top, both eyes,
 * the ten fingertips and both toe ends — 52 of the file's 67. The file declares its bones by
 * node type, and a skin only supplies bind data; Blender reads it so, making every `LimbNode`
 * a bone (`io_scene_fbx/import_fbx.py:3397`, Blender 4.5.9) and keeping leaf bones by default
 * (`:3039`). Measured in Blender 5.1.1 on the same file: 67 bones.
 *
 * Which rig: the one holding the FIRST skin — the topmost bone above its first bone, and
 * everything under that. A file with two characters stays two skeletons in Blender (measured:
 * a two-armature export re-imports as two armatures), so taking every bone in the file would
 * merge them under two roots.
 *
 * A node inside the rig that is not a bone but has bones under it is a bone too — Blender's
 * "fake bone" (`import_fbx.py:2511-2513`). Three types a `Null` as a `Group` (`FBXLoader.js`,
 * `parseModels`), so a walk that kept only `Bone`s split `Hips → Mid → Tip` at a `Null` Mid
 * into two roots; Blender keeps the chain (measured). The node above the root — the armature
 * — is not a bone in Blender either, and its transform is #1190's.
 *
 * Children are visited in the loader's order: ascending FBX node ID, since it builds its node
 * map with `for…in` over `Objects.Model` (`FBXLoader.js`, `parseModels`) — not the file's
 * order. On samba it keeps the order the skin listed its 52 bones in, under every parent
 * (measured). The retarget aligns a bone by the first of its children it maps (#1186), so this
 * order is load-bearing.
 *
 * A file with no skin keeps what it had: every Bone in the subtree.
 */
function extractBones(group: Group): Object3D[] {
  let skin: SkinnedMesh | null = null;
  group.traverse((obj) => {
    const sm = obj as SkinnedMesh;
    if (!skin && sm.isSkinnedMesh && sm.skeleton?.bones?.length) skin = sm;
  });
  if (skin) return rigOf(sceneBoneOf((skin as SkinnedMesh).skeleton.bones[0]));

  // Fallback: collect every Bone in the subtree.
  const bones: Bone[] = [];
  group.traverse((obj) => {
    if ((obj as Bone).isBone) bones.push(obj as Bone);
  });
  return bones;
}

/** The topmost bone above `bone` — through fake bones — and every rig node under it, in order. */
function rigOf(bone: Bone): Object3D[] {
  let root: Object3D = bone;
  for (let node = bone.parent; node; node = node.parent) if (isBone(node)) root = node;

  const rig: Object3D[] = [];
  const visit = (node: Object3D): void => {
    rig.push(node);
    for (const child of node.children)
      if (!isTwinOf(child, node) && holdsABone(child)) visit(child);
  };
  visit(root);
  return rig;
}

const isBone = (node: Object3D): boolean => (node as Bone).isBone === true;

/** A node is in the rig when it is a bone or has a bone under it (a fake bone). */
function holdsABone(node: Object3D): boolean {
  let found = false;
  node.traverse((n) => {
    if (isBone(n)) found = true;
  });
  return found;
}

/** #1181 — an inner per-skin copy of `parent`: a Bone of the same FBX node. */
function isTwinOf(child: Object3D, parent: Object3D): boolean {
  const id = (child as Object3D & { ID?: unknown }).ID;
  return isBone(child) && id !== undefined && (parent as Object3D & { ID?: unknown }).ID === id;
}

/**
 * #1181 — the Bone in the scene graph that a skin's bone stands for.
 *
 * FBXLoader builds one Bone per skin a bone deforms. When a second skin shares it — Mixamo
 * exports two, `Alpha_Surface` and `Alpha_Joints` — the loader makes a new Bone and nests the
 * previous one under it (`FBXLoader.js`, `buildSkeleton`), so an earlier skin's `skeleton.bones`
 * holds the INNER twin: at [0, 0, 0] under a parent of its own name. Read as they are, every
 * rest offset is zero and, since parents resolve by name, every bone is its own parent. The
 * outermost twin sits in the real hierarchy with the file's transform; twins share the FBX
 * node's `ID`, which is what identifies them — a name alone could be a real child that
 * happens to share its parent's.
 *
 * The outer twin's local offsets equal the rest Blender builds from each cluster's
 * `TransformLink` made local to its parent's (`import_fbx.py:3480-3491`, `:2562-2573`,
 * Blender 4.5.9) — measured on `mixamo-samba.fbx`, every bone, largest difference 0.
 */
function sceneBoneOf(bone: Bone): Bone {
  const id = (bone as Bone & { ID?: unknown }).ID;
  if (id === undefined) return bone;
  let outer = bone;
  for (;;) {
    const parent = outer.parent as (Bone & { ID?: unknown }) | null;
    if (!parent?.isBone || parent.ID !== id) return outer;
    outer = parent;
  }
}
