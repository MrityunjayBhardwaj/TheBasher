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
// The tracks arrive in the rig's space and unit — folded and scaled by `readFbx` exactly as its
// bones are (#1190, #1086) — so the keys and the rest they override agree.
//
// SCALE IS KEPT. The clip this road used to write dropped every scale track; they are channels now,
// and counted (`scaleChannels`), so a file that scales a bone plays it.
//
// A NODE THAT IS NOT A BONE (#1441) plays its keys as Object channels, the shape the glTF road and
// Auto-Key write (`objectChannelOp`), in the form Blender's FBX import gives: `rotation` in Euler,
// `position` and `scale`, all linear, folded as the node's transform is (`fbxScene.ts`).
//
// NOTHING IS DROPPED UNSAID: every track that plays nowhere is counted in `dropped` (even at zero)
// and named in `notices`, the field every landing says — a count nothing reads is a silent loss
// (#1441: the node tracks used to be counted into a field no product code read). The armature
// node's own tracks are counted apart when they only hold its rest, which the bones already carry.

import { readFbx } from './fbx';
import type { FbxMaterialSlot, FbxMeshRead, FbxSlotImage } from './fbxMesh';
import type { FbxKeyTrack, FbxLeftOutReason, FbxSceneRead } from './fbxScene';
import { gltfJsonMaterialToOpenpbr, type GltfJsonMaterial } from './gltfJsonMaterialToOpenpbr';
import {
  emptyOps,
  objectChannelOp,
  parentEdge,
  withCentrePivot,
  withProjectImages,
  type ImportedTransform,
} from './modelImport';
import { uniqueBoneName } from './nativeGltfSkeleton';
import { skeletonObjectId } from './skeletonObject';
import type { Op } from '../../core/dag/types';
import { packMeshData } from '../../app/meshGeometryData';
import type { BoneSpec, InlineMaterialSpec, Quat, Vec3 } from '../../nodes/types';
import type { PoseLayerChannel, PoseLayerMember, PoseLayerParams } from '../../nodes/PoseLayer';

/** What of an FBX's animation plays nowhere in the import, counted even at zero. Each count above
 *  zero is also said in the import's `notices`. */
export interface FbxImportDropped {
  /** #1441 — tracks on a node that is not a bone, that play nowhere (`fbxScene.ts` says why). */
  readonly nodeTracks: number;
  /** Tracks on a bone, on a property that is not position, quaternion or scale. */
  readonly otherPropertyTracks: number;
  /** Tracks whose name three wrote in a shape that names no node and property. */
  readonly unparsedTracks: number;
  /** #1446 — the file's takes after the first. */
  readonly otherTakes: number;
}

/**
 * #1434 — what an FBX import lands as. A CHARACTER is a rig with anything of the scene beside it (a
 * mesh, an empty); a MOTION is a rig alone, which a landing binds onto a character; a MODEL has no
 * bone, and writes no Skeleton, no pose layer and nothing to bind, as Blender makes no armature.
 */
export type FbxImportKind = 'character' | 'motion' | 'model';

interface FbxImportChainCommon {
  readonly ops: Op[];
  /** #1441 — channels keying the file's empties and loose meshes. */
  readonly objectChannels: number;
  readonly dropped: FbxImportDropped;
  /**
   * #1434 — the Group a character or a model lands in, as a glTF import does (user decision, #1434):
   * an id, and the pivot it turns about — the centre of the file's meshes as drawn at load. The
   * landing writes it at the origin with that pivot (`importGroupOp`), so it moves nothing.
   */
  readonly group: { readonly id: string; readonly pivot: Vec3 };
  /**
   * #1429 — the ops that stand the file's meshes and empties, under `parentId` (the import Group, or
   * a motion's scene node): each skinned mesh with an Armature modifier on its stack, each other mesh
   * and empty where the file hangs it. On a rig they name the skeleton's Object, so they go after the
   * ops that make it (`buildSkeletonObjectOps`). Empty for a file with neither.
   */
  readonly meshOps: (parentId: string) => Op[];
  /** #1429 — how many meshes those ops stand. */
  readonly meshCount: number;
  /** #1429 — what of the file was left out, each said once: its meshes, and (#1441) every count in
   *  `dropped` above zero. Empty when nothing was. */
  readonly notices: readonly string[];
}

/** A file with a rig: its skeleton, and its motion as keys on a base pose layer (#1211). */
export interface FbxRigImportResult extends FbxImportChainCommon {
  readonly kind: 'character' | 'motion';
  readonly skeletonId: string;
  /** The base pose layer holding the file's keys: the motion, what a bind retargets from. */
  readonly motionId: string;
  /** Scale channels on the layer: the tracks the clip road used to drop. */
  readonly scaleChannels: number;
  /** #1441 — tracks on the armature node that only hold its rest, which the bones already carry:
   *  counted, and nothing of them lost. */
  readonly armatureRestTracks: number;
}

/** #1434 — a file with no bone: its meshes and empties, and nothing of a rig. */
export interface FbxModelImportResult extends FbxImportChainCommon {
  readonly kind: 'model';
}

export type FbxImportChainResult = FbxRigImportResult | FbxModelImportResult;

export interface FbxImportChainArgs {
  readonly data: ArrayBuffer | string;
  readonly name?: string;
  /** Caller-supplied ids — tests pass deterministic ones. `group` defaults to a fresh id; a model's
   *  nodes take their ids from it, as a rig's meshes take theirs from `skeleton`. */
  readonly ids?: { skeleton: string; layer: string; group?: string };
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
  const parsed = readFbx(args.data, name);
  const ids = args.ids ?? { skeleton: uniqueId('fbx_skel'), layer: uniqueId('fbx_motion') };
  const group = { id: ids.group ?? uniqueId('fbx_group'), pivot: parsed.meshes.centre };

  const meshes = parsed.meshes.meshes;
  // #1434 — every image is stored once, after the whole file has been read.
  const imageKeys = new Map<number, StoredImage>();
  for (const [i, image] of parsed.meshes.images.entries()) {
    const key = await args.storeImage(image.bytes, image.mime);
    imageKeys.set(i, { key, hasAlpha: image.hasAlpha });
  }
  const { scene } = parsed;
  const objectChannels = scene.nodes.reduce(
    (n, node) => n + (node.keys ? Object.keys(node.keys).length : 0),
    0,
  );

  if (parsed.kind === 'model') {
    const dropped: FbxImportDropped = {
      nodeTracks: scene.leftOut.length,
      otherPropertyTracks: 0,
      unparsedTracks: parsed.unparsedTracks,
      otherTakes: parsed.otherTakes.length,
    };
    return {
      kind: 'model',
      ops: [],
      objectChannels,
      dropped,
      group,
      // Its nodes are the Group's: a model has no skeleton for an id to name.
      meshOps: (parentId) => sceneOps(scene, meshes, [], group.id, null, parentId, imageKeys),
      meshCount: meshes.length,
      notices: [
        ...parsed.meshes.notices,
        ...scene.notices,
        ...droppedNotices(scene.leftOut, dropped, parsed.otherTakes),
      ],
    };
  }

  // One spelling per bone, unique within the rig, as the glTF and BVH readers spell them. Which
  // bone a track keys is `readFbx`'s to say (`boneIndex`): it folds the track with that bone.
  const taken = new Set<string>();
  const bones: BoneSpec[] = parsed.skeletonParams.bones.map((b) => {
    const unique = uniqueBoneName(b.name, (n) => taken.has(n));
    taken.add(unique);
    return { ...b, name: unique };
  });

  const tracksOf = new Map<number, Map<TrackProperty, (typeof parsed.tracks)[number]>>();
  let otherPropertyTracks = 0;
  for (const track of parsed.tracks) {
    const index = track.boneIndex;
    if (index === null) continue; // #1441 — a node's: placed, or named as left out, by the scene pass
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

  const dropped: FbxImportDropped = {
    nodeTracks: scene.leftOut.length,
    otherPropertyTracks,
    unparsedTracks: parsed.unparsedTracks,
    otherTakes: parsed.otherTakes.length,
  };
  return {
    kind: meshes.length > 0 || scene.nodes.length > 0 ? 'character' : 'motion',
    ops,
    skeletonId: ids.skeleton,
    motionId: ids.layer,
    scaleChannels,
    objectChannels,
    armatureRestTracks: scene.armatureRestTracks,
    dropped,
    group,
    meshOps: (parentId) => [
      ...meshes.flatMap((mesh, i) =>
        mesh.vertexGroupBones === null
          ? []
          : skinnedMeshOps(
              { ...mesh, vertexGroupBones: mesh.vertexGroupBones },
              `${ids.skeleton}_mesh${i}`,
              bones,
              ids.skeleton,
              parentId,
              imageKeys,
            ),
      ),
      ...sceneOps(
        scene,
        meshes,
        bones,
        ids.skeleton,
        skeletonObjectId(ids.skeleton),
        parentId,
        imageKeys,
      ),
    ],
    meshCount: meshes.length,
    notices: [
      ...parsed.meshes.notices,
      ...scene.notices,
      ...droppedNotices(scene.leftOut, dropped, parsed.otherTakes),
    ],
  };
}

/** #1441 — every count of `dropped` above zero, said: the field every landing surfaces. */
function droppedNotices(
  leftOut: FbxSceneRead['leftOut'],
  dropped: FbxImportDropped,
  otherTakes: readonly string[],
): string[] {
  return [
    ...leftOutNotices(leftOut),
    ...(dropped.otherPropertyTracks > 0
      ? [
          `${tracksSaid(dropped.otherPropertyTracks)} on a bone, on a property that is not a transform, did not play`,
        ]
      : []),
    ...(dropped.unparsedTracks > 0
      ? [`${tracksSaid(dropped.unparsedTracks)} whose names name no node did not play`]
      : []),
    ...(otherTakes.length > 0
      ? [
          `${otherTakes.length} more take${otherTakes.length === 1 ? '' : 's'} (${otherTakes.map((t) => `"${t}"`).join(', ')}) did not play: an import plays the file's first (#1446)`,
        ]
      : []),
  ];
}

const tracksSaid = (n: number) => `${n} track${n === 1 ? '' : 's'}`;

/** #1441 — why a node's keys do not play, as the notice says it. */
const LEFT_OUT_BECAUSE: Record<FbxLeftOutReason, string> = {
  'no-node': 'no node of that name is brought across',
  ambiguous: 'more than one node has that name, so the file does not say which they move',
  'mesh-under-armature':
    "a mesh parented to an armature plays no keys of its own, as in Blender's FBX import",
  shear: "under its parent's stretch they would shear, which an Object cannot hold",
  property: 'they key a property that is not a transform',
  'armature-moves': "the skeleton's Object plays no keys of its own; its bones' keys play",
};

/** #1441 — one notice per reason, naming each node once. */
function leftOutNotices(leftOut: FbxSceneRead['leftOut']): string[] {
  const byReason = new Map<FbxLeftOutReason, Set<string>>();
  for (const { node, reason } of leftOut) {
    byReason.set(reason, (byReason.get(reason) ?? new Set()).add(node));
  }
  return [...byReason].map(
    ([reason, nodes]) =>
      `keys on ${[...nodes].map((n) => `"${n}"`).join(', ')} did not play: ${LEFT_OUT_BECAUSE[reason]}`,
  );
}

/** #1441 — a keyed field as a channel's keys: linear, as Blender keys an FBX's animation (`:879`). */
const linearKeys = (track: FbxKeyTrack) =>
  track.times.map((time, i) => ({ time, value: track.values[i], easing: 'linear' as const }));

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
 * #1434 — the file's scene as Blender's FBX importer lays it out (`fbxScene.ts`): each empty a Group,
 * each unskinned mesh an Object, each under what it hangs from — a node written before it, the
 * skeleton's Object (from a bone, named by `parentBone`, or from the armature), or `topId`. Every
 * one in euler mode, as Blender's FBX import makes every object (`XYZ`, measured 4 of 4). Ids are
 * `prefix`'s: the skeleton's id on a rig, a model's own on a file with none.
 */
function sceneOps(
  scene: FbxSceneRead,
  meshes: readonly FbxMeshRead[],
  bones: readonly BoneSpec[],
  prefix: string,
  // The skeleton's Object; null on a model, whose scene the reader gave no bone or armature parent.
  armatureObject: string | null,
  topId: string,
  imageKeys: ReadonlyMap<number, StoredImage>,
): Op[] {
  const idOf = scene.nodes.map((node, k) =>
    node.mesh === null ? `${prefix}_empty${k}` : `${prefix}_mesh${node.mesh}_object`,
  );
  const ops: Op[] = [];
  const edges: Op[] = [];
  scene.nodes.forEach((node, k) => {
    const { parent } = node;
    const transform: ImportedTransform = {
      ...node.transform,
      ...(parent?.kind === 'bone' ? { parentBone: bones[parent.bone].name } : {}),
    };
    if (node.mesh === null) ops.push(...emptyOps(idOf[k], transform, node.name));
    else {
      const id = `${prefix}_mesh${node.mesh}`;
      ops.push(...meshOps(meshes[node.mesh], id, transform, imageKeys), {
        type: 'connect',
        from: { node: `${id}_data`, socket: 'out' },
        to: { node: idOf[k], socket: 'data' },
      });
    }
    const parentId =
      parent === null ? topId : parent.kind === 'node' ? idOf[parent.index] : armatureObject;
    if (parentId === null)
      throw new Error(`FBX node "${node.name}" hangs from a rig the file has none of`);
    edges.push(parentEdge(idOf[k], parentId));
    // #1441 — its keys, as the channels Auto-Key would have made on the same params.
    for (const field of ['position', 'rotation', 'scale'] as const) {
      const track = node.keys?.[field];
      if (track) ops.push(objectChannelOp(idOf[k], field, 'vec3', linearKeys(track)));
    }
  });
  // Every edge after every node, as on the glTF road: an edge names two nodes that both exist.
  return [...ops, ...edges];
}

/**
 * #1429 — one mesh's data and its Object at `transform`, named. What feeds the Object's `data` is
 * the caller's: the data itself (`sceneOps`), or an Armature modifier over it (`skinnedMeshOps`).
 */
function meshOps(
  mesh: FbxMeshRead,
  id: string,
  transform: ImportedTransform,
  imageKeys: ReadonlyMap<number, StoredImage>,
): Op[] {
  const dataId = `${id}_data`;
  const objectId = `${id}_object`;
  const slots = mesh.materials.map((slot) => slotMaterial(slot, imageKeys));
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: dataId,
      nodeType: 'PolyMeshData',
      params: {
        mesh: packMeshData(mesh.data),
        material: slots[0] ?? null,
        // Only for more than one slot: absent already means "one slot, and it is `material`".
        ...(slots.length > 1 ? { materialSlots: slots } : {}),
      },
    },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: transform },
    { type: 'setMeta', nodeId: objectId, name: mesh.name },
  ];
  return ops;
}

/** Blender's skinned mesh: at identity, in euler mode, like every object its FBX import makes. */
const IDENTITY: ImportedTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/**
 * #1429 — a skinned mesh as Blender's FBX importer makes it: an Armature modifier on its stack
 * pointed at the skeleton's Object, with no transform of its own.
 */
function skinnedMeshOps(
  mesh: FbxMeshRead & { readonly vertexGroupBones: readonly number[] },
  id: string,
  bones: readonly BoneSpec[],
  skeletonId: string,
  parentId: string,
  imageKeys: ReadonlyMap<number, StoredImage>,
): Op[] {
  const data = { ...mesh.data, vertexGroups: mesh.vertexGroupBones.map((b) => bones[b].name) };
  const ops = meshOps({ ...mesh, data }, id, IDENTITY, imageKeys);
  const dataId = `${id}_data`;
  const objectId = `${id}_object`;
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
    // child edge back would close a cycle. Both stand at identity under one parent, so the mesh is
    // where Blender's child of the armature is; moved, the armature carries the points through the
    // deform (its placement is the modifier's `armatureMatrix`).
    parentEdge(objectId, parentId),
  );
  return ops;
}
