// BVH import → Op chain: a Skeleton and the file's motion as KEYS on a base pose layer (#1211).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT BLENDER'S BVH IMPORTER WRITES, AND SO WHAT THIS WRITES
// ─────────────────────────────────────────────────────────────────────────
// Blender 5.1.1 (`io_anim_bvh/import_bvh.py`) makes an armature and one action on it:
//   - each pose bone's rotation mode is the file's channel order as written (`:509`,
//     `rot_order_str`, from `_eul_order_lookup` `:52-59`), so `ZYX` for `Zrotation Yrotation
//     Xrotation`;
//   - its rotation keys are the file's rotation re-expressed in that mode, `to_euler(mode, prev)`,
//     so they stay continuous across frames (`:618-631`);
//   - location is keyed only on joints the file positions (`has_loc`, `:576`);
//   - every key is LINEAR (`:651`), one per file frame.
// Here the action is a base override `PoseLayer` over the skeleton's rest pose: the shape a glTF
// import's motion already has, so a character, a hand-keyed rig and every imported motion are one
// kind of thing. Its members and keys follow the list above. The layer is named after the file, as
// Blender names the action.
//
// NOTHING IS DROPPED UNCOUNTED. three's loader writes a position track for EVERY animated joint
// (the rest OFFSET where the file has no position channel); those are not the file's keys, so
// they are left out, counted, and checked equal to the rest offset they claim to be. A track on a
// bone no header joint declares is counted too.
//
// The CLIP shape (Skeleton + AnimationClip) is what saved projects and generated motion still
// carry; it is no longer what a dropped .bvh or .fbx becomes (`fbxImportChain.ts`).

import { BVH_UNIT_SCALE_METRES, parseBvh } from './bvh';
import { readJointChannels } from './bvhProfile';
import { sanitizeBoneName } from './threeAdapter';
import { uniqueBoneName } from './nativeGltfSkeleton';
import type { Op } from '../../core/dag/types';
import type { BoneSpec, Vec3 } from '../../nodes/types';
import {
  EULER_ORDERS,
  continuousEulerIn,
  eulerFromQuat,
  quatFromEulerXYZ,
  type EulerOrder,
} from '../../nodes/bonePose';
import type { PoseLayerParams } from '../../nodes/PoseLayer';

/** What a BVH import left out of the layer, counted even at zero. */
export interface BvhImportDropped {
  /** Position tracks three wrote on joints the file does not position (its rest offset). */
  readonly restPositionTracks: number;
  /** …of which, the ones whose keys were NOT the rest offset — a disagreement, not bookkeeping. */
  readonly restPositionMismatches: number;
  /** Tracks on bones no header joint declares (no channels to key). */
  readonly undeclaredTracks: number;
}

export interface BvhImportChainResult {
  readonly ops: Op[];
  readonly skeletonId: string;
  /** The base pose layer holding the file's keys: the motion, what a bind retargets from. */
  readonly motionId: string;
  readonly dropped: BvhImportDropped;
}

export interface BvhImportChainArgs {
  readonly text: string;
  readonly name?: string;
  /** Caller-supplied ids — tests pass deterministic ones. */
  readonly ids?: { skeleton: string; layer: string };
  /**
   * Metres per BVH length unit. BVH declares no unit, so the road cannot derive one and whoever
   * produced the file has to say. Defaults to 1, what a file import has always assumed.
   */
  readonly unitScale?: number;
}

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  // Counter + random suffix for cross-restart collision avoidance. Safe under V2 (ids are UI artifacts, not
  // pure-evaluator values).
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `n_${prefix}_${counter.toString(36)}${r}`;
}

/** Test-only — reset the monotonic counter so id sequences are reproducible. */
export function __resetBvhImportCounterForTests(): void {
  counter = 0;
}

/** The euler order a joint's rotation channels name, as Blender names it: the axes as listed. A
 *  joint listing fewer than three takes the rest in XYZ order (Blender's own lookup has no entry
 *  for a partial list). */
function orderOf(axes: string): EulerOrder {
  const listed = [...new Set(axes.split(''))].filter((a) => 'XYZ'.includes(a));
  const full = [...listed, ...'XYZ'.split('').filter((a) => !listed.includes(a))].join('');
  return (EULER_ORDERS as readonly string[]).includes(full) ? (full as EulerOrder) : 'XYZ';
}

const DEG = 180 / Math.PI;
/** Metres: a kept-out position key further than this from the rest offset is a mismatch. */
const REST_EPS = 1e-6;

export function buildBvhImportOps(args: BvhImportChainArgs): BvhImportChainResult {
  const name = args.name ?? 'imported-bvh';
  const parsed = parseBvh(args.text, name, args.unitScale ?? BVH_UNIT_SCALE_METRES);
  const ids = args.ids ?? { skeleton: uniqueId('bvh_skel'), layer: uniqueId('bvh_motion') };

  // One spelling per bone, unique within the rig, as the glTF reader spells them (Blender's rule:
  // `ENDSITE`, `ENDSITE.001`, …).
  const taken = new Set<string>();
  const bones: BoneSpec[] = parsed.skeletonParams.bones.map((b) => {
    const unique = uniqueBoneName(b.name, (n) => taken.has(n));
    taken.add(unique);
    return { ...b, name: unique };
  });

  // Header joint → bone index, by the sanitised name, in declaration order (end sites declare no
  // joint and take no channels).
  const joints = readJointChannels(args.text);
  const jointOfBone = new Map<number, (typeof joints)[number]>();
  const claimed = new Set<number>();
  for (const j of joints) {
    const want = sanitizeBoneName(j.name);
    const i = parsed.skeletonParams.bones.findIndex((b, k) => !claimed.has(k) && b.name === want);
    if (i < 0) continue;
    claimed.add(i);
    jointOfBone.set(i, j);
  }

  const byBone = new Map<number, (typeof parsed.clipParams.keyframes)[number][]>();
  for (const k of parsed.clipParams.keyframes) {
    const list = byBone.get(k.bone);
    if (list) list.push(k);
    else byBone.set(k.bone, [k]);
  }

  const members: PoseLayerParams['members'] = [];
  const channels: PoseLayerParams['channels'] = [];
  let restPositionTracks = 0;
  let restPositionMismatches = 0;
  let undeclaredTracks = 0;

  for (let i = 0; i < bones.length; i++) {
    const keys = (byBone.get(i) ?? []).slice().sort((a, b) => a.time - b.time);
    if (keys.length === 0) continue;
    const joint = jointOfBone.get(i);
    if (!joint) {
      undeclaredTracks += 1;
      continue;
    }
    const bone = bones[i].name;
    const order = joint.rotationAxes ? orderOf(joint.rotationAxes) : 'XYZ';
    if (!joint.rotationAxes && !joint.positioned) continue;
    members.push({ bone, rotationMode: order });

    if (joint.rotationAxes) {
      let prev: Vec3 | null = null;
      channels.push({
        bone,
        component: 'rotation',
        keyframes: keys.map((k) => {
          const e = continuousEulerIn(
            eulerFromQuat(quatFromEulerXYZ(k.rotation), order),
            prev,
            order,
          );
          prev = e;
          return {
            time: k.time,
            value: [e[0] * DEG, e[1] * DEG, e[2] * DEG] as Vec3,
            easing: 'linear' as const,
          };
        }),
      } as PoseLayerParams['channels'][number]);
    }
    if (joint.positioned) {
      channels.push({
        bone,
        component: 'position',
        keyframes: keys.map((k) => ({
          time: k.time,
          value: [k.position[0], k.position[1], k.position[2]] as Vec3,
          easing: 'linear' as const,
        })),
      } as PoseLayerParams['channels'][number]);
    } else {
      restPositionTracks += 1;
      const rest = bones[i].position;
      if (keys.some((k) => k.position.some((v, a) => Math.abs(v - rest[a]) > REST_EPS))) {
        restPositionMismatches += 1;
      }
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
    dropped: { restPositionTracks, restPositionMismatches, undeclaredTracks },
  };
}
