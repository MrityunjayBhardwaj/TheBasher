// FBX import — converts three's FBXLoader output to our DAG-native
// Skeleton bone list, the first clip's raw tracks (what the import road's base
// pose layer is built from, #1211), and AnimationClipParams (the clip shape
// retarget tests and saved projects still read).
//
// #1279 — a bone's X, Y and Z curves may be keyed at different times (Blender's
// default export simplifies each axis on its own). three r169 paired them by index;
// our patch to it (`patches/three+0.169.0.patch`) reads them by Blender's rule
// instead: every curve filled at the union of the item's key times, linearly, with
// the initial value before a curve's first key. Checked every frame against
// Blender in `fbxImportChain.test.ts`, edge cases in `fbxAxisCurves.test.ts`.
//
// THREE.FBXLoader.parse(buffer) returns a THREE.Group whose subtree may
// contain SkinnedMesh children (each with their own .skeleton) and a
// .animations[] array of THREE.AnimationClip. We take the rig that holds
// the first skin (every bone in it, not only the skin's — `extractBones`)
// and the first clip — multi-skeleton / multi-clip FBX files are rare in
// director workflows; revisit if a real authoring case appears.
//
// #1429 — and every mesh in the file, as stored polygon meshes (`fbxMesh.ts`): a skinned one in
// the rig's space at rest, with every weight the file gives it.
//
// THREE.FBXLoader is a full-JS parser (no FBX SDK). Some proprietary
// FBX features (NURBS, certain subdivs) won't parse — fail loudly per
// project_p31_plan honesty contract.
//
// REF: THESIS §42.1 (P3.1); project_p31_plan.md.

import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  Euler,
  Quaternion,
  Vector3,
  type Bone,
  type Group,
  type Object3D,
  type AnimationClip as ThreeAnimationClip,
  type SkinnedMesh,
} from 'three';
import type { AnimationKeyframe, BoneSpec, Vec3 } from '../../nodes/types';
import {
  bonesToSpec,
  clipToKeyframes,
  continuousEuler,
  parseTrackName,
  quaternionToEulerVec3,
  type ClipShape,
} from './threeAdapter';
import { scaleBonePositions, scaleKeyframePositions } from './unitScale';
import type { ClipLoop } from '../../nodes/clipLoop';
import { readFbxMeshes, type FbxMeshesRead } from './fbxMesh';

export interface FbxSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface FbxClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: ClipLoop;
  readonly keyframes: readonly AnimationKeyframe[];
}

/**
 * #1211 — one of three's tracks at the file's own key times: a bone (sanitised as `bonesToSpec`
 * spells it), the property, and the times and flat values. What the import road's base pose layer
 * is built from, so the file's own key times and its scale survive; `clipParams` merges each bone's
 * times and drops scale.
 *
 * The VALUES are the rig's, not the file's raw ones: they go through the same fold of the node above
 * the root (#1190) and the same unit (#1086) as the bones and the clip's keys, so a layer built from
 * them keys the skeleton it stands on. Read raw, a Mixamo walk's positions stayed in centimetres
 * over a rest pose in metres.
 */
export interface FbxTrack {
  readonly bone: string;
  /** The bone of the rig this track keys — the k-th track on a name and property keys the k-th bone
   *  of that name, in rig order. Null when no bone of the rig has the name (the armature node, a
   *  mesh…). */
  readonly boneIndex: number | null;
  /** three's property name: `position`, `quaternion` (xyzw), `scale`, or anything else it wrote. */
  readonly property: string;
  readonly times: readonly number[];
  readonly values: readonly number[];
}

export interface FbxImportResult {
  readonly skeletonParams: FbxSkeletonParams;
  readonly clipParams: FbxClipParams;
  /** The first clip's tracks, in three's order; a track whose name does not parse is left out. */
  readonly tracks: readonly FbxTrack[];
  /** Tracks of the first clip whose name does not parse as `node.property` — counted, not read. */
  readonly unparsedTracks: number;
  /** #1429 — the file's meshes, and what of them was left out. */
  readonly meshes: FbxMeshesRead;
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
 * #1296 — a file whose models all sit under one group comes back as THAT group, and the loader
 * had recorded the unit on the scene it discarded; our patch to it (`patches/three+0.169.0.patch`)
 * carries the unit across, so the group read here holds it on either shape of file.
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
  // The path is used to resolve textures; we pass empty because textures are not carried yet
  // (#1429 brings meshes and their colours; a texture is named in the import's notices).
  const metresPerUnit = fbxMetresPerUnit(group);

  const bones = extractBones(group);
  if (bones.length === 0) {
    throw new Error('FBX contains no skeleton or skinned mesh — nothing to import.');
  }
  // First animation clip wins. group.animations[] is THREE.AnimationClip[].
  const clip = (group as unknown as { animations: ThreeAnimationClip[] }).animations[0];
  // The clip's keys are read against the rest AS THE FILE HOLDS IT (a rotation-only bone's key
  // takes its position from that rest), and only then is the node above the rig folded into
  // both, so the two move together.
  const fileRest = bonesToSpec(bones);
  const read = clip ? readTracks(clip, fileRest) : { tracks: [], unparsedTracks: 0 };
  const {
    bones: skeletonBones,
    keyframes,
    tracks,
  } = foldTransformAboveRoots(
    group,
    bones,
    fileRest,
    clip ? clipToKeyframes(clip as ClipShape, fileRest) : [],
    read.tracks,
  );
  const unparsedTracks = read.unparsedTracks;
  // #1429 — read after the fold, which updates world matrices and leaves the scene untouched.
  const meshes = readFbxMeshes(
    group,
    (bone) => (isBone(bone) ? bones.indexOf(sceneBoneOf(bone as Bone)) : -1),
    metresPerUnit,
  );

  if (!clip) {
    // Skeleton-only FBX — rare but valid (T-pose import). Empty clip.
    return {
      skeletonParams: { bones: scaleBonePositions(skeletonBones, metresPerUnit) },
      clipParams: { name, duration: 0, loop: 'hold', keyframes: [] },
      tracks: [],
      unparsedTracks: 0,
      meshes,
    };
  }

  return {
    skeletonParams: { bones: scaleBonePositions(skeletonBones, metresPerUnit) },
    tracks: scaleTrackPositions(tracks, metresPerUnit),
    unparsedTracks,
    meshes,
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
 * #1190 — fold the transform of the nodes ABOVE each root bone into that root, and into the keys.
 *
 * Blender writes an armature as a `Null` above the bones and puts its axis and unit conversion
 * on that node: on a Blender export it reads −90° about X and ×100. Starting at the bones, the
 * rig came in 100× small and lying along +Z. Blender treats that node as the armature OBJECT
 * (`io_scene_fbx/import_fbx.py:2473-2497`, 4.5.9), and on re-import its own Y-up → Z-up and
 * unit conversion cancel it: measured in Blender 5.1.1, the armature Object reads location 0,
 * rotation 0, scale 1, and the chain stands upright at 1 m and 1.5 m.
 *
 * So the transform goes into the rig, not onto our stand-in Object — the same place the unit
 * goes (#1086), and the stand-in's fields then read what Blender's do: nothing. Carried on the
 * Object instead, they would read −90° and ×100, which Blender never shows for this file.
 *
 * How it folds: with the transform above a root `T · R · k` (k a uniform scale), the root's
 * rest and keys become `T + R·(k·p)` and `R · q`, and every length below it scales by k — which
 * is exactly what the rig's world pose was. A NON-uniform scale cannot fold into lengths and
 * rotations without shear, so it is refused rather than approximated. A root with nothing
 * above it but the loader's own group folds through identity; its values move by rounding only
 * (measured on `mixamo-samba.fbx`: 561 of 28537 keys, at most 7.1e-15 rad).
 *
 * Only the transform at load is read: a node above the rig that is itself animated keeps its
 * rest here (its track is not a bone's).
 */
function foldTransformAboveRoots(
  group: Group,
  nodes: readonly Object3D[],
  rest: readonly BoneSpec[],
  keyframes: readonly AnimationKeyframe[],
  fileTracks: readonly FbxTrack[],
): { bones: BoneSpec[]; keyframes: AnimationKeyframe[]; tracks: FbxTrack[] } {
  group.updateMatrixWorld(true);
  const bones = rest.map((b) => ({ ...b }));
  let keys = keyframes.map((k) => ({ ...k }));
  let tracks = [...fileTracks];

  rest.forEach((spec, root) => {
    if (spec.parent >= 0) return;
    const above = nodes[root].parent;
    if (!above) return;
    // #1296 — measured from the scene root, not from the group the loader returned: for a file
    // whose models all sit under one group, FBXLoader returns THAT group as the scene
    // (FBXLoader.js:907-913, r169), and on a Blender export it is the armature node itself. Taken
    // relative to it, its ×100 and its turn cancelled to nothing and the rig came in at a
    // hundredth of Blender's size. The returned group has no parent, so its world is the scene's.
    const matrix = above.matrixWorld.clone();

    const offset = new Vector3();
    const turn = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(offset, turn, scale);
    const k = scale.x;
    if (!(k > 0) || Math.abs(scale.y - k) > 1e-9 * k || Math.abs(scale.z - k) > 1e-9 * k) {
      throw new Error(
        `FBX node "${above.name}" above the rig's root "${spec.name}" has scale ` +
          `${scale.toArray().join(', ')} — not one uniform scale, so it cannot be folded into the ` +
          'bones without distorting them.',
      );
    }

    const inSubtree = new Set<number>([root]);
    rest.forEach((b, i) => {
      if (inSubtree.has(b.parent)) inSubtree.add(i);
    });
    const placeRoot = (p: Vec3): Vec3 => {
      const v = new Vector3(...p).multiplyScalar(k).applyQuaternion(turn).add(offset);
      return [v.x, v.y, v.z];
    };
    const turnRoot = (r: Vec3): Vec3 =>
      quaternionToEulerVec3(
        turn.clone().multiply(new Quaternion().setFromEuler(new Euler(...r, 'XYZ'))),
      );
    const lengthen = (p: Vec3): Vec3 => [p[0] * k, p[1] * k, p[2] * k];

    for (const i of inSubtree) {
      const b = bones[i];
      bones[i] =
        i === root
          ? { ...b, position: placeRoot(b.position), rotation: turnRoot(b.rotation) }
          : { ...b, position: lengthen(b.position) };
    }
    // The root's new angles are chained in time order onto the branch nearest the key before,
    // as the import road already does (#867): the sampler interpolates Euler components
    // linearly, and a freshly converted triple can sit a whole turn from its neighbour.
    const rootAngles = new Map<AnimationKeyframe, Vec3>();
    let previous: Vec3 | null = null;
    for (const key of keys.filter((k) => k.bone === root).sort((a, b) => a.time - b.time)) {
      previous = continuousEuler(turnRoot(key.rotation), previous);
      rootAngles.set(key, previous);
    }
    keys = keys.map((key) => {
      if (!inSubtree.has(key.bone)) return key;
      const angles = rootAngles.get(key);
      return angles
        ? { ...key, position: placeRoot(key.position), rotation: angles }
        : { ...key, position: lengthen(key.position) };
    });
    // #1211's tracks, folded as the keys are: the root's positions placed and its quaternions
    // turned, every other position in the subtree lengthened. A quaternion is turned as one, so
    // it needs none of the Euler branch-chaining above. Scale is a ratio and is left alone.
    tracks = tracks.map((track) => {
      if (track.boneIndex === null || !inSubtree.has(track.boneIndex)) return track;
      const v = track.values;
      if (track.property === 'position') {
        const move = track.boneIndex === root ? placeRoot : lengthen;
        const values: number[] = [];
        for (let i = 0; i + 2 < v.length; i += 3) values.push(...move([v[i], v[i + 1], v[i + 2]]));
        return { ...track, values };
      }
      if (track.property === 'quaternion' && track.boneIndex === root) {
        const values: number[] = [];
        const q = new Quaternion();
        for (let i = 0; i + 3 < v.length; i += 4) {
          q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(turn);
          values.push(q.x, q.y, q.z, q.w);
        }
        return { ...track, values };
      }
      return track;
    });
  });
  return { bones, keyframes: keys, tracks };
}

/**
 * #1211 — the clip's tracks, each resolved to the bone it keys. A track names a bone by three's
 * spelling, and names repeat, so the k-th track on a name and property keys the k-th bone of that
 * name. A track whose name does not parse is counted and left out.
 */
function readTracks(
  clip: ThreeAnimationClip,
  rest: readonly BoneSpec[],
): { tracks: FbxTrack[]; unparsedTracks: number } {
  const byName = new Map<string, number[]>();
  rest.forEach((b, i) => byName.set(b.name, [...(byName.get(b.name) ?? []), i]));
  const claimed = new Map<string, number>();
  const tracks: FbxTrack[] = [];
  let unparsedTracks = 0;
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed) {
      unparsedTracks += 1;
      continue;
    }
    const key = `${parsed.bone}\u0000${parsed.property}`;
    const k = claimed.get(key) ?? 0;
    const boneIndex = byName.get(parsed.bone)?.[k] ?? null;
    if (boneIndex !== null) claimed.set(key, k + 1);
    tracks.push({
      bone: parsed.bone,
      boneIndex,
      property: parsed.property,
      times: Array.from(track.times),
      values: Array.from(track.values),
    });
  }
  return { tracks, unparsedTracks };
}

/** #1086's unit on the tracks' lengths — positions only, as `scaleKeyframePositions` does. */
function scaleTrackPositions(tracks: readonly FbxTrack[], by: number): readonly FbxTrack[] {
  if (by === 1) return tracks;
  return tracks.map((t) =>
    t.property === 'position' ? { ...t, values: t.values.map((v) => v * by) } : t,
  );
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
