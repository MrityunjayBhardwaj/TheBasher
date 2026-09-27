// FBX import → Op chain: a Skeleton and the file's motion as KEYS on a base pose layer (#1211).
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
//
// SCALE IS KEPT. The clip this road used to write dropped every scale track; they are channels now,
// and counted (`scaleChannels`), so a file that scales a bone plays it.
//
// NOTHING IS DROPPED UNCOUNTED: a track on a node that is not a bone (Blender's export keys the
// armature node itself), a track on a property that is not a transform, and a track whose name
// does not parse are each counted in `dropped`.

import { parseFbx } from './fbx';
import { uniqueBoneName } from './nativeGltfSkeleton';
import type { Op } from '../../core/dag/types';
import type { BoneSpec, Quat, Vec3 } from '../../nodes/types';
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
}

export interface FbxImportChainArgs {
  readonly data: ArrayBuffer | string;
  readonly name?: string;
  /** Caller-supplied ids — tests pass deterministic ones. */
  readonly ids?: { skeleton: string; layer: string };
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

export function buildFbxImportOps(args: FbxImportChainArgs): FbxImportChainResult {
  const name = args.name ?? 'imported-fbx';
  const parsed = parseFbx(args.data, name);
  const ids = args.ids ?? { skeleton: uniqueId('fbx_skel'), layer: uniqueId('fbx_motion') };

  // One spelling per bone, unique within the rig, as the glTF and BVH readers spell them. A track
  // names a bone by three's spelling, so the k-th track on a name keys the k-th bone of that name.
  const taken = new Set<string>();
  const byName = new Map<string, number[]>();
  const bones: BoneSpec[] = parsed.skeletonParams.bones.map((b, i) => {
    const unique = uniqueBoneName(b.name, (n) => taken.has(n));
    taken.add(unique);
    byName.set(b.name, [...(byName.get(b.name) ?? []), i]);
    return { ...b, name: unique };
  });

  const tracksOf = new Map<number, Map<TrackProperty, (typeof parsed.tracks)[number]>>();
  const claimed = new Map<string, number>();
  let unknownBoneTracks = 0;
  let otherPropertyTracks = 0;
  for (const track of parsed.tracks) {
    const key = `${track.bone}\u0000${track.property}`;
    const k = claimed.get(key) ?? 0;
    const index = byName.get(track.bone)?.[k];
    if (index === undefined) {
      unknownBoneTracks += 1;
      continue;
    }
    claimed.set(key, k + 1);
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

  return {
    ops,
    skeletonId: ids.skeleton,
    motionId: ids.layer,
    scaleChannels,
    dropped: { unknownBoneTracks, otherPropertyTracks, unparsedTracks: parsed.unparsedTracks },
  };
}
