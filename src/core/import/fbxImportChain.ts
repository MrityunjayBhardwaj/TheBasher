// FBX import → Op chain: a Skeleton and the file's motion as KEYS on a base pose layer (#1211),
// and (#1429) the ops that stand the file's meshes beside it (`meshOps`, at the end of this file).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT BLENDER'S FBX IMPORTER WRITES, AND SO WHAT THIS WRITES
// ─────────────────────────────────────────────────────────────────────────
// Blender 5.1.1 (`io_import_fbx`, `import_fbx.py`) makes an armature and one action on it:
//   - it never sets a bone's rotation mode, so every pose bone stays QUATERNION (`:944`);
//   - it keys location, rotation and scale on every animated bone, all LINEAR (`:879`), at the
//     file's own key times, sampling each FBX curve there.
// Measured on Blender's default FBX export of walk.bvh re-imported with defaults: 78 bones keyed
// location + quaternion + scale, every key LINEAR, key counts per curve from 2 to 120 (the
// exporter simplifies), scale kept on every bone. Probe `q1211_fbx_walk_oracle.py`.
//
// Here the action is a base override `PoseLayer` over the skeleton's rest pose, the shape a glTF
// and a BVH import's motion already have. three's FBXLoader has already sampled each FBX curve at
// the file's key times into one track per bone and property; each track becomes one channel as it
// stands: `position` and `scale` as vec3 keys, `quaternion` as quaternion keys on a member in
// quaternion mode, all linear. Members are in bone order. The layer is named after the file.
// The tracks arrive in the rig's space and unit — folded and scaled by `parseFbx` exactly as its
// bones are (#1190, #1086) — so the keys and the rest they override agree.
//
// SCALE IS KEPT. The clip this road used to write dropped every scale track; they are channels now,
// and counted (`scaleChannels`), so a file that scales a bone plays it.
//
// NOTHING IS DROPPED UNCOUNTED: a track on a node that is not a bone (Blender's export keys the
// armature node itself), a track on a property that is not a transform, and a track whose name
// does not parse are each counted in `dropped`.

import { parseFbx } from './fbx';
import type { FbxMaterialSlot, FbxMeshRead, FbxSlotImage } from './fbxMesh';
import { gltfJsonMaterialToOpenpbr, type GltfJsonMaterial } from './gltfJsonMaterialToOpenpbr';
import { withCentrePivot, withProjectImages } from './nativeGltfImport';
import { uniqueBoneName } from './nativeGltfSkeleton';
import { skeletonObjectId } from './skeletonObject';
import type { Op } from '../../core/dag/types';
import { packMeshData } from '../../app/meshGeometryData';
import type { BoneSpec, InlineMaterialSpec, Quat, Vec3 } from '../../nodes/types';
import type { PoseLayerChannel, PoseLayerMember, PoseLayerParams } from '../../nodes/PoseLayer';

/** What an FBX import left out of the layer, counted even at zero. */
export interface FbxImportDropped {
  /** Tracks on a node no bone of the skeleton is (the armature node, a mesh, a camera…). */
  readonly unknownBoneTracks: number;
  /** Tracks on a bone, on a property that is not position, quaternion or scale. */
  readonly otherPropertyTracks: number;
  /** Tracks whose name three wrote in a shape that names no node and property. */
  readonly unparsedTracks: number;
}

export interface FbxImportChainResult {
  readonly ops: Op[];
  readonly skeletonId: string;
  /** The base pose layer holding the file's keys: the motion, what a bind retargets from. */
  readonly motionId: string;
  /** Scale channels on the layer: the tracks the clip road used to drop. */
  readonly scaleChannels: number;
  readonly dropped: FbxImportDropped;
  /**
   * #1429 — the ops that stand the file's meshes in the scene, for a scene node: each skinned mesh
   * under the skeleton's Object with an Armature modifier on its stack, each other mesh as an Object
   * of its own. They name the skeleton's Object, so they go after the ops that make it
   * (`buildSkeletonObjectOps`). Empty for a file with no mesh.
   */
  readonly meshOps: (sceneNodeId: string) => Op[];
  /** #1429 — how many meshes those ops stand. */
  readonly meshCount: number;
  /** #1429 — what of the file's meshes was left out, each said once. Empty when nothing was. */
  readonly notices: readonly string[];
}

export interface FbxImportChainArgs {
  readonly data: ArrayBuffer | string;
  readonly name?: string;
  /** Caller-supplied ids — tests pass deterministic ones. */
  readonly ids?: { skeleton: string; layer: string };
  /**
   * #1434 — store an image's encoded bytes in the project and return the key its texture ref names,
   * as the glTF road's (`NativeGltfImportArgs.storeImage`). Required, so there is no road on which a
   * textured file arrives with nowhere to put its pixels.
   */
  readonly storeImage: (bytes: Uint8Array, mime: string) => Promise<string>;
}

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `n_${prefix}_${counter.toString(36)}${r}`;
}

export function __resetFbxImportCounterForTests(): void {
  counter = 0;
}

/** three's property → the layer component it keys, in the order a bone's channels are written. */
const COMPONENT = { position: 'position', quaternion: 'quaternion', scale: 'scale' } as const;
type TrackProperty = keyof typeof COMPONENT;
const PROPERTIES = Object.keys(COMPONENT) as TrackProperty[];

export async function buildFbxImportOps(args: FbxImportChainArgs): Promise<FbxImportChainResult> {
  const name = args.name ?? 'imported-fbx';
  const parsed = parseFbx(args.data, name);
  const ids = args.ids ?? { skeleton: uniqueId('fbx_skel'), layer: uniqueId('fbx_motion') };

  // One spelling per bone, unique within the rig, as the glTF and BVH readers spell them. Which
  // bone a track keys is `parseFbx`'s to say (`boneIndex`): it folds the track with that bone.
  const taken = new Set<string>();
  const bones: BoneSpec[] = parsed.skeletonParams.bones.map((b) => {
    const unique = uniqueBoneName(b.name, (n) => taken.has(n));
    taken.add(unique);
    return { ...b, name: unique };
  });

  const tracksOf = new Map<number, Map<TrackProperty, (typeof parsed.tracks)[number]>>();
  let unknownBoneTracks = 0;
  let otherPropertyTracks = 0;
  for (const track of parsed.tracks) {
    const index = track.boneIndex;
    if (index === null) {
      unknownBoneTracks += 1;
      continue;
    }
    if (!(track.property in COMPONENT)) {
      otherPropertyTracks += 1;
      continue;
    }
    const own = tracksOf.get(index) ?? new Map();
    own.set(track.property as TrackProperty, track);
    tracksOf.set(index, own);
  }

  const members: PoseLayerMember[] = [];
  const channels: PoseLayerChannel[] = [];
  let scaleChannels = 0;
  for (let i = 0; i < bones.length; i++) {
    const own = tracksOf.get(i);
    if (!own) continue;
    const bone = bones[i].name;
    members.push({ bone, rotationMode: 'quaternion' });
    for (const property of PROPERTIES) {
      const track = own.get(property);
      if (!track) continue;
      const v = track.values;
      if (property === 'quaternion') {
        channels.push({
          bone,
          component: 'quaternion',
          keyframes: track.times.map((time, k) => ({
            time,
            value: [v[4 * k], v[4 * k + 1], v[4 * k + 2], v[4 * k + 3]] as Quat,
            easing: 'linear' as const,
          })),
        } as PoseLayerChannel);
        continue;
      }
      if (property === 'scale') scaleChannels += 1;
      channels.push({
        bone,
        component: COMPONENT[property],
        keyframes: track.times.map((time, k) => ({
          time,
          value: [v[3 * k], v[3 * k + 1], v[3 * k + 2]] as Vec3,
          easing: 'linear' as const,
        })),
      } as PoseLayerChannel);
    }
  }

  const layer: Partial<PoseLayerParams> = { name, mode: 'override', members, channels };
  const ops: Op[] = [
    { type: 'addNode', nodeId: ids.skeleton, nodeType: 'Skeleton', params: { bones } },
    { type: 'addNode', nodeId: ids.layer, nodeType: 'PoseLayer', params: layer },
    {
      type: 'connect',
      from: { node: ids.skeleton, socket: 'pose' },
      to: { node: ids.layer, socket: 'pose' },
    },
  ];

  const meshes = parsed.meshes.meshes;
  // #1434 — every image is stored once, after the whole file has been read.
  const imageKeys = new Map<number, StoredImage>();
  for (const [i, image] of parsed.meshes.images.entries()) {
    const key = await args.storeImage(image.bytes, image.mime);
    imageKeys.set(i, { key, hasAlpha: image.hasAlpha });
  }
  return {
    ops,
    skeletonId: ids.skeleton,
    motionId: ids.layer,
    scaleChannels,
    dropped: { unknownBoneTracks, otherPropertyTracks, unparsedTracks: parsed.unparsedTracks },
    meshOps: (sceneNodeId) =>
      meshes.flatMap((mesh, i) =>
        meshOps(mesh, `${ids.skeleton}_mesh${i}`, bones, ids.skeleton, sceneNodeId, imageKeys),
      ),
    meshCount: meshes.length,
    notices: parsed.meshes.notices,
  };
}

// #1434 — the sampler tables a slot's textures index: texture 2i samples image i repeating, 2i + 1
// clamped. Blender's image node defaults to Linear and, unclamped, to Repeat (oracle
// `blender-oracle-fbx-tile-textured.json`); no filter is stated, so the renderer's linear ones apply,
// as on the glTF road.
const REPEAT = 10497;
const CLAMP_TO_EDGE = 33071;
const SAMPLERS = [
  { wrapS: REPEAT, wrapT: REPEAT },
  { wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE },
];
const textureOf = (t: FbxSlotImage): number => t.image * 2 + (t.clamp ? 1 : 0);

/** #1434 — an image of the file as the project holds it; #1435 with whether it has alpha. */
interface StoredImage {
  readonly key: string;
  readonly hasAlpha: boolean;
}

/**
 * #1429 — a slot as the native material, through the one translation the import roads share; #1434
 * its images as the glTF road's are, pointing at the project's copies.
 */
function slotMaterial(
  slot: FbxMaterialSlot,
  imageKeys: ReadonlyMap<number, StoredImage>,
): InlineMaterialSpec {
  const material: GltfJsonMaterial = {
    name: slot.name,
    pbrMetallicRoughness: {
      // An image on the base colour replaces the colour: Blender links the image to the socket,
      // whose own value then goes unread (oracle `blender-oracle-fbx-tile-textured.json`), while
      // glTF would multiply the two.
      baseColorFactor: slot.baseColorImage === undefined ? [...slot.color, 1] : [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: slot.roughness,
      ...(slot.baseColorImage === undefined
        ? {}
        : { baseColorTexture: { index: textureOf(slot.baseColorImage) } }),
    },
    ...(slot.normalImage === undefined
      ? {}
      : {
          normalTexture: { index: textureOf(slot.normalImage), scale: slot.normalImage.strength },
        }),
  };
  const used = [slot.baseColorImage, slot.normalImage].filter((t) => t !== undefined);
  const tables = {
    textures: Array.from({ length: imageKeys.size * 2 }, (_, t) => ({ sampler: t % 2 })),
    samplers: SAMPLERS,
  };
  const keys = new Map(used.map((t) => [textureOf(t), imageKeys.get(t.image)!.key]));
  const native = withProjectImages(
    withCentrePivot(gltfJsonMaterialToOpenpbr(material, tables)),
    tables,
    keys,
  );
  // #1435 — a base colour image with an alpha channel gives the surface its alpha, drawn dithered:
  // Blender's FBX importer wires the image's Alpha into the material and sets that render method
  // (`import_fbx.py`, the `image.depth == 32` pass; `node_shader_utils.py` `use_alpha`). glTF has
  // no word for it, so it is said on the native material.
  const base = slot.baseColorImage === undefined ? null : imageKeys.get(slot.baseColorImage.image)!;
  return base?.hasAlpha
    ? { ...native, geometry: { ...native.geometry, renderMethod: 'dithered' } }
    : native;
}

/**
 * #1429 — one mesh as Blender's FBX importer makes it: mesh data under an Object; skinned, an
 * Armature modifier on its stack pointed at the skeleton's Object, with no transform of its own;
 * unskinned, an Object of its own at the node's placement.
 */
function meshOps(
  mesh: FbxMeshRead,
  id: string,
  bones: readonly BoneSpec[],
  skeletonId: string,
  sceneNodeId: string,
  imageKeys: ReadonlyMap<number, StoredImage>,
): Op[] {
  const dataId = `${id}_data`;
  const objectId = `${id}_object`;
  const data =
    mesh.vertexGroupBones === null
      ? mesh.data
      : { ...mesh.data, vertexGroups: mesh.vertexGroupBones.map((b) => bones[b].name) };
  const slots = mesh.materials.map((slot) => slotMaterial(slot, imageKeys));
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: dataId,
      nodeType: 'PolyMeshData',
      params: {
        mesh: packMeshData(data),
        material: slots[0] ?? null,
        // Only for more than one slot: absent already means "one slot, and it is `material`".
        ...(slots.length > 1 ? { materialSlots: slots } : {}),
      },
    },
    {
      type: 'addNode',
      nodeId: objectId,
      nodeType: 'Object',
      params:
        mesh.placement === null
          ? {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
              rotationMode: 'quaternion',
              quaternion: [0, 0, 0, 1],
            }
          : {
              position: mesh.placement.position,
              rotation: [0, 0, 0],
              scale: mesh.placement.scale,
              rotationMode: 'quaternion',
              quaternion: mesh.placement.quaternion,
            },
    },
    { type: 'setMeta', nodeId: objectId, name: mesh.name },
  ];
  if (mesh.vertexGroupBones === null) {
    ops.push(
      {
        type: 'connect',
        from: { node: dataId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: objectId, socket: 'out' },
        to: { node: sceneNodeId, socket: 'children' },
      },
    );
    return ops;
  }
  const modifierId = `${id}_armature`;
  const armatureObject = skeletonObjectId(skeletonId);
  ops.push(
    { type: 'addNode', nodeId: modifierId, nodeType: 'ArmatureModifier', params: {} },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: modifierId, socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: modifierId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: armatureObject, socket: 'out' },
      to: { node: modifierId, socket: 'armature' },
    },
    // Beside the armature's Object, not under it: that Object already feeds the modifier, and a
    // child edge back would close a cycle. Both stand at identity in the scene, so the mesh is where
    // Blender's child of the armature is; moved, the armature carries the points through the deform
    // (its placement is the modifier's `armatureMatrix`).
    {
      type: 'connect',
      from: { node: objectId, socket: 'out' },
      to: { node: sceneNodeId, socket: 'children' },
    },
  );
  return ops;
}
