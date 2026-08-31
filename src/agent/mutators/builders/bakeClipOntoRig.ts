// bakeClipOntoRig Mutator — materialise an `AnimationClip` onto the glTF rig it
// is already wired to, as per-bone editable channels the RENDERER reads (#803).
//
// ─────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS CLOSES
// ─────────────────────────────────────────────────────────────────────────
// A retargeted clip posed a `GltfSkeleton` correctly in the evaluator and the
// rendered skin ignored it completely. Measured on both sides: the evaluator's
// bone rotations changed over time, and `__basher_gltf_skin().boneRotation(2)`
// was identical at five sample times. The DAG was right at every step and
// nothing consumed it — `SceneFromDAG` drives a glTF skin from the asset's OWN
// embedded clips, and a generated character carries none.
//
// 🔑 THE FIX IS NOT A NEW RENDER PATH. One already exists, is live, and was
// simply never fed from here: baked per-bone `KeyframeChannelVec3` nodes, which
// `bakedChannelSamplersForAsset` enumerates and the renderer's `useFrame`
// samples. Teaching the renderer to consume a `PosedSkeleton` instead would add
// a SECOND writer of per-child TRS — into the one place the code says "never add
// a second" (V20/H36/H33) — and would thread a band into the render surface
// without the read-side, which is the displayed-≠-rendered split (H40) the
// shared enumerator exists to prevent.
//
// So the motion is materialised onto the road that already renders, and the
// precedence question the issue asks us to settle is ALREADY settled and
// documented: a baked channel beats the clip track per-component, on PRESENCE
// (resolveGltfChildTransform.ts). A character with its own embedded animation
// keeps it on every bone this clip does not touch.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THE SPEC IS ONE FIELD
// ─────────────────────────────────────────────────────────────────────────
// `AnimationClip.keyframes[].bone` is an INDEX, and the names live on the
// skeleton. Taking the skeleton as a second parameter would let a caller pass a
// skeleton whose bone ORDER differs from the one the clip's indices were
// authored against — every keyframe would then land on the wrong bone, and the
// result would be a character that moves, confidently and wrongly. Reading the
// skeleton off the clip's OWN `skeleton` edge makes that mismatch
// unrepresentable rather than merely unlikely.
//
// The index → name → bone chain is exact, not heuristic:
//   AnimationClip.keyframes[].bone
//     → GltfSkeleton bones[i].name  ( = skin.jointKeys[i], gltfImportChain:478)
//     → a nodeNameMap key           ( keyByGltfNodeIndex, gltfImportChain:248)
//     → gltfChildDagId(assetRef, childName) — the bone the renderer resolves
//
// ─────────────────────────────────────────────────────────────────────────
// SCALE IS NOT BAKED, AND THAT IS DELIBERATE
// ─────────────────────────────────────────────────────────────────────────
// `AnimationClipParams.keyframes` carries `position` and `rotation` only. A
// retarget cannot express scale, so emitting a scale channel would claim a
// component the source never described — and because the resolver reads
// PRESENCE, that claim would SUPPRESS the asset's own scale track underneath it.
// Omitting it leaves scale to the bands below, which is the honest answer.
//
// REF: issue #803; src/app/bakedGltfChannels.ts (the enumerator);
//      src/app/resolveGltfChildTransform.ts (baked beats clip on presence);
//      builders/bakeChannelOps.ts (the shared emitter);
//      builders/retarget.ts (what usually produces the clip);
//      builders/bakeGltfChannel.ts (the sibling, sourced from the asset's clip).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import type { SkeletonValue, Vec3 } from '../../../nodes/types';
import { evaluate } from '../../../core/dag/evaluator';
import { bakeChannelOpsForBone, type BakedKey } from './bakeChannelOps';
// The radians→degrees boundary this mutator sits on. Same import direction
// `src/core/import/gltfImportChain.ts` already takes for the same reason.
import { radVec3ToDeg } from '../../../viewport/rotation';

const BakeClipOntoRigSpec = z.object({
  /** The `AnimationClip` node to materialise. Its `skeleton` edge names the rig. */
  clipId: z.string().min(1),
});
export type BakeClipOntoRigSpec = z.infer<typeof BakeClipOntoRigSpec>;

/** Bind pose is import-time STATIC, so any frame projects the same skeleton.
 *  Mirrors retarget.ts, which evaluates a GltfSkeleton the same way. */
const BIND_POSE_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

/** Resolve the clip's skeleton node id from its own `skeleton` input edge. */
function skeletonIdOf(state: DagState, clipId: string): string | null {
  const clip = state.nodes[clipId];
  const socket = clip?.inputs?.skeleton;
  if (!socket) return null;
  // A `single` socket resolves to one connection; arrays are tolerated so a
  // cardinality change upstream degrades to "no bake" rather than a crash.
  const one = Array.isArray(socket) ? socket[0] : socket;
  return one?.node ?? null;
}

/** The owning asset's ref, read from the GltfSkeleton's upstream GltfAsset. */
function assetRefOf(state: DagState, skeletonId: string): string | null {
  const skel = state.nodes[skeletonId];
  const socket = skel?.inputs?.asset;
  if (!socket) return null;
  const one = Array.isArray(socket) ? socket[0] : socket;
  const assetNode = one?.node ? state.nodes[one.node] : undefined;
  const ref = (assetNode?.params as { assetRef?: unknown } | undefined)?.assetRef;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

interface ClipKeyframe {
  readonly bone: number;
  readonly time: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
}

function keyframesOf(state: DagState, clipId: string): ClipKeyframe[] {
  const params = state.nodes[clipId]?.params as { keyframes?: unknown } | undefined;
  return Array.isArray(params?.keyframes) ? (params.keyframes as ClipKeyframe[]) : [];
}

export const bakeClipOntoRigMutator: MutatorDefinition<BakeClipOntoRigSpec> = {
  name: 'mutator.animation.bakeClipOntoRig',
  // The FIRST SENTENCE is the agent picker's summary and is charged against a
  // hard 8 KB ceiling on the whole catalog, so it is kept short deliberately;
  // the rest is DETAIL view only. REF: catalog.ts (firstSentence).
  description:
    'Bake an AnimationClip onto the glTF rig it drives, so the render shows it. ' +
    'Given { clipId }, resolves the rig from the clip own skeleton edge, maps each ' +
    'keyframe bone INDEX to that bone name, and emits KeyframeChannelVec3 nodes ' +
    'carrying params.target and params.childName so the renderer resolver ' +
    'enumerates them. Without this a retargeted clip poses the skeleton in the ' +
    'evaluator and the rendered skin never moves. Emits NO edges. Deterministic ' +
    'and idempotent — re-baking the same clip is a no-op.',
  spec: BakeClipOntoRigSpec,
  specExample: { clipId: 'n_clip_retargeted' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['AnimationClip'],
    // The clip is untouched — it keeps driving the dopesheet and any
    // PosedSkeleton consumer. The bake COEXISTS with it (D-02).
    preserves: ['animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the clip. The emitted channels are fresh addNodes (gate-3
    // isFreshAddNode) and carry no edges, so they need no closure membership.
    // The skeleton and its upstream asset are READ via evaluate() in build(),
    // which is not an op — so they stay out of the op-closure, exactly as
    // retarget.ts does it.
    return { rootSelectors: [spec.clipId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const clip = state.nodes[spec.clipId];
    if (!clip) return { ok: false, reason: `No node "${spec.clipId}".` };
    if (clip.type !== 'AnimationClip') {
      return {
        ok: false,
        reason: `Node "${spec.clipId}" is ${clip.type}; expected AnimationClip.`,
      };
    }
    const skeletonId = skeletonIdOf(state, spec.clipId);
    if (!skeletonId) {
      return {
        ok: false,
        reason: `AnimationClip "${spec.clipId}" has no skeleton connected; there is no rig to bake onto.`,
      };
    }
    const skel = state.nodes[skeletonId];
    if (skel?.type !== 'GltfSkeleton') {
      return {
        ok: false,
        // Named precisely: a plain `Skeleton` has no glTF bones to drive, so
        // baking onto it would emit channels no renderer enumerates.
        reason:
          `AnimationClip "${spec.clipId}" is wired to a ${skel?.type ?? 'missing'} skeleton; ` +
          'only a GltfSkeleton addresses rendered glTF bones.',
      };
    }
    if (!assetRefOf(state, skeletonId)) {
      return {
        ok: false,
        reason: `GltfSkeleton "${skeletonId}" has no upstream GltfAsset with an assetRef.`,
      };
    }
    if (keyframesOf(state, spec.clipId).length === 0) {
      return { ok: false, reason: `AnimationClip "${spec.clipId}" has no keyframes to bake.` };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const skeletonId = skeletonIdOf(state, spec.clipId);
    if (!skeletonId) return [];
    const assetRef = assetRefOf(state, skeletonId);
    if (!assetRef) return [];

    // Evaluate the skeleton for its bone NAMES in index order. This is the same
    // read retarget.ts performs, and it is what makes index → name exact.
    const result = evaluate(state, skeletonId, { ctx: BIND_POSE_CTX });
    const skeleton = result.value as SkeletonValue;
    const bones = skeleton?.kind === 'Skeleton' ? skeleton.bones : [];
    if (bones.length === 0) return [];

    // Group by bone index, preserving time order.
    const byBone = new Map<number, ClipKeyframe[]>();
    for (const k of keyframesOf(state, spec.clipId)) {
      const list = byBone.get(k.bone) ?? [];
      list.push(k);
      byBone.set(k.bone, list);
    }

    const ops: Op[] = [];
    // Iterate BONES, not the map, so emission order is the skeleton's own and
    // therefore stable across runs (V22) rather than insertion-dependent.
    for (let i = 0; i < bones.length; i++) {
      const keys = byBone.get(i);
      if (!keys || keys.length === 0) continue;
      const childName = bones[i].name;
      // A bone the skeleton cannot name cannot be addressed. Skipping is right:
      // the alternative is emitting a channel under an empty key, which the
      // enumerator would scope to no asset and silently never apply.
      if (!childName) continue;

      const sorted = keys.slice().sort((a, b) => a.time - b.time);
      const position: BakedKey[] = sorted.map((k) => ({ time: k.time, value: k.position }));
      // 🔴 UNITS CHANGE HERE, AND THIS IS THE ONLY PLACE THAT KNOWS IT.
      //
      // An `AnimationKeyframe.rotation` is RADIANS — `quaternionToEulerVec3`
      // returns a raw `Euler` and nothing converts it on the way in. The
      // `GltfChild` rotation band this bake writes into is DEGREES: the import
      // seeds a child's base rotation with `radVec3ToDeg(...)` (gltfImportChain
      // `defaultTRS`) and the renderer converts back out with
      // `degVec3ToRad(trs.rotation)` (SceneFromDAG's TRS useFrame).
      //
      // Copying the value through unconverted therefore did not fail — it
      // scaled every bone rotation by π/180. A 40° leg swing rendered as 0.7°
      // and a rig's -90° corrective root rendered as -1.57°, so a character
      // with a correct clip stood still while its root POSITION channel — which
      // needs no conversion — travelled at full strength. That is a character
      // sliding across the floor without animating, and it reads as "motion
      // application is broken" rather than as a unit bug (#843).
      //
      // The sibling `bakeGltfChannel` needs no conversion because it reads a
      // `TransformClip`, which is already degrees. The two clip families differ
      // in units, and this is the one that has to say so.
      const rotation: BakedKey[] = sorted.map((k) => ({
        time: k.time,
        value: radVec3ToDeg(k.rotation),
      }));

      ops.push(
        // Scale is deliberately absent — see the header.
        ...bakeChannelOpsForBone({
          assetRef,
          childName,
          byComponent: { position, rotation },
          state,
        }),
      );
    }

    return ops;
  },
};
