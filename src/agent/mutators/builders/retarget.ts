// retarget Mutator — apply a source AnimationClip onto a target
// Skeleton via a bone-name map. Resolves the map either from a static
// preset id (Mixamo↔glTF / Reze / Rigify) or from an explicit
// Record<string, string>.
//
// Emits addNode AnimationClip (the retargeted clip) + connect to the
// project TimeSource. The new clip has TARGET-bone-named tracks so
// downstream consumers (Character, AnimationLayer) bind cleanly.
//
// Closure: roots = [sourceClipId, sourceSkeletonId, targetSkeletonId,
// timeId]; followedEdges = []. The new clip id is fresh — V13 allows
// addNode under fresh-add semantics; the connect-to-time targets a
// closure root. A GltfSkeleton target's upstream GltfAsset is read via
// evaluate() in build() (not an op), so it stays out of the op-closure.
//
// P7.11 Wave G (#100) — a `GltfSkeleton` node is now an accepted source/
// target. Its bind pose is NOT in `params.bones` (it has none — D-02 makes
// it a PURE evaluated projection of the upstream GltfAsset's captured skin).
// So bind data is resolved TYPE-AWARELY: a plain `Skeleton` keeps the cheap
// `params.bones` read (byte-identical to its evaluate, zero behavior change);
// a `GltfSkeleton` is EVALUATED (the same `evaluate()` renderSummarizePass
// uses) at frame 0 — bind pose is time-independent — and we read
// `value.bones`. Evaluating a GltfSkeleton READS its upstream GltfAsset, so
// the closure follows 'children' to pull that producer into scope (the gate
// checks op TARGETS, not reads, but making the read-set explicit keeps the
// closure honest about what the mutator touches).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Node, NodeId, Op } from '../../../core/dag/types';
import type { AnimationKeyframe, BoneSpec, SkeletonValue } from '../../../nodes/types';
import { retargetClip } from '../../../core/import/retarget';
import { evaluate } from '../../../core/dag/evaluator';
import { getBoneNameMapPreset, listBoneNameMapPresets } from '../../../core/import/boneNameMaps';

/** Node types whose `out` is a `Skeleton` value — accepted as retarget source/target. */
const SKELETON_NODE_TYPES = ['Skeleton', 'GltfSkeleton'] as const;
type SkeletonNodeType = (typeof SKELETON_NODE_TYPES)[number];

function isSkeletonNode(node: Node): node is Node & { type: SkeletonNodeType } {
  return (SKELETON_NODE_TYPES as readonly string[]).includes(node.type);
}

// Bind pose is import-time STATIC, so any frame works — evaluate a
// GltfSkeleton at frame 0 (mirrors renderSummarizePass.ts).
const BIND_POSE_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

/**
 * Resolve a skeleton node's `BoneSpec[]` regardless of which family member
 * produced it. A plain `Skeleton` carries its bones in `params.bones` — read
 * them directly (cheap, and byte-identical to Skeleton.evaluate, so existing
 * retarget behavior is unchanged). A `GltfSkeleton` has NO `params.bones`
 * (D-02: its rig is a pure evaluated projection of the upstream GltfAsset's
 * captured skin), so EVALUATE it — the same evaluator renderSummarizePass
 * uses — and read the projected `value.bones`. Both yield radians-unit
 * `BoneSpec[]` that `retargetClip`/`specToThreeSkeleton` consume identically.
 */
function resolveSkeletonBones(state: DagState, node: Node): BoneSpec[] {
  if (node.type === 'GltfSkeleton') {
    const result = evaluate(state, node.id, { ctx: BIND_POSE_CTX });
    const value = result.value as SkeletonValue;
    return value.kind === 'Skeleton' ? [...value.bones] : [];
  }
  // Plain `Skeleton` — fast path, preserves pre-Wave-G behavior exactly.
  return (node.params as { bones?: BoneSpec[] }).bones ?? [];
}

const RetargetSpec = z.object({
  sourceClipId: z.string().min(1),
  sourceSkeletonId: z.string().min(1),
  targetSkeletonId: z.string().min(1),
  /** Either a preset id from BONE_NAME_MAP_PRESETS, or an explicit map. At least one required. */
  mapPresetId: z.string().optional(),
  customMap: z.record(z.string(), z.string()).optional(),
  /** Caller-supplied id; defaults to `<sourceClipId>_retargeted`. */
  outputClipId: z.string().optional(),
  outputName: z.string().optional(),
});
export type RetargetSpec = z.infer<typeof RetargetSpec>;

export const retargetMutator: MutatorDefinition<RetargetSpec> = {
  name: 'mutator.animation.retarget',
  description:
    'Retarget an AnimationClip from one Skeleton onto another via a ' +
    'bone-name map. Pass mapPresetId for known rig pairs (mixamoToGltf, ' +
    'mixamoToReze, mixamoToRigify) or customMap for arbitrary rigs. ' +
    'Emits a new AnimationClip with target-bone-named tracks; the ' +
    'source clip is left untouched.',
  spec: RetargetSpec,
  specExample: {
    sourceClipId: 'mixamo_clip',
    sourceSkeletonId: 'mixamo_skel',
    targetSkeletonId: 'char_skel',
    mapPresetId: 'mixamoToGltf',
    outputClipId: 'mixamo_clip_retargeted',
  },
  contract: {
    // requiredNodeTypes is checked as "the closure contains AT LEAST ONE
    // node of each listed type" — so listing only 'AnimationClip' (the one
    // type ALWAYS present) keeps the gate satisfiable whether the skeletons
    // are plain `Skeleton` or `GltfSkeleton`. The skeleton-type discipline
    // is enforced precisely in preconditions (accepting either family).
    requiredEdges: [],
    requiredNodeTypes: ['AnimationClip'],
    preserves: ['rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.sourceClipId, spec.sourceSkeletonId, spec.targetSkeletonId],
      // No followed edges: a `GltfSkeleton` target's upstream `GltfAsset` is
      // read via `evaluate()` inside build(), which is NOT an op — so it never
      // enters the op-closure the gate validates (every emitted op targets the
      // fresh output clip or a closure root). Matches the pre-Wave-G contract.
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const sourceClip = state.nodes[spec.sourceClipId];
    if (!sourceClip)
      return { ok: false, reason: `sourceClipId "${spec.sourceClipId}" not in DAG.` };
    if (sourceClip.type !== 'AnimationClip') {
      return {
        ok: false,
        reason: `sourceClipId "${spec.sourceClipId}" is ${sourceClip.type}; expected AnimationClip.`,
      };
    }
    const sourceSkel = state.nodes[spec.sourceSkeletonId];
    if (!sourceSkel)
      return { ok: false, reason: `sourceSkeletonId "${spec.sourceSkeletonId}" not in DAG.` };
    if (!isSkeletonNode(sourceSkel)) {
      return {
        ok: false,
        reason: `sourceSkeletonId is ${sourceSkel.type}; expected Skeleton or GltfSkeleton.`,
      };
    }
    const targetSkel = state.nodes[spec.targetSkeletonId];
    if (!targetSkel)
      return { ok: false, reason: `targetSkeletonId "${spec.targetSkeletonId}" not in DAG.` };
    if (!isSkeletonNode(targetSkel)) {
      return {
        ok: false,
        reason: `targetSkeletonId is ${targetSkel.type}; expected Skeleton or GltfSkeleton.`,
      };
    }
    if (!findTimeSource(state)) {
      return {
        ok: false,
        reason:
          'No TimeSource node in DAG. Default projects seed `n_time`; restore one before retargeting.',
      };
    }
    if (!spec.mapPresetId && !spec.customMap) {
      const knownIds = listBoneNameMapPresets()
        .map((p) => p.id)
        .join(', ');
      return {
        ok: false,
        reason: `Either mapPresetId or customMap is required. Known presets: ${knownIds}.`,
      };
    }
    if (spec.mapPresetId && !getBoneNameMapPreset(spec.mapPresetId)) {
      const knownIds = listBoneNameMapPresets()
        .map((p) => p.id)
        .join(', ');
      return {
        ok: false,
        reason: `Unknown mapPresetId "${spec.mapPresetId}". Known: ${knownIds}.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const sourceClip = state.nodes[spec.sourceClipId];
    const sourceSkel = state.nodes[spec.sourceSkeletonId];
    const targetSkel = state.nodes[spec.targetSkeletonId];
    const sourceClipParams = sourceClip.params as {
      name?: string;
      duration?: number;
      keyframes?: AnimationKeyframe[];
    };
    // Type-aware bind-pose resolution: plain `Skeleton` → params.bones
    // (unchanged); `GltfSkeleton` → evaluate the node (reads its upstream
    // GltfAsset's captured skin). Both yield radians-unit BoneSpec[].
    const sourceBones = resolveSkeletonBones(state, sourceSkel);
    const targetBones = resolveSkeletonBones(state, targetSkel);

    const nameMap =
      spec.customMap ??
      getBoneNameMapPreset(spec.mapPresetId!)?.map ??
      ({} as Readonly<Record<string, string>>);

    const result = retargetClip({
      sourceBones,
      sourceClip: {
        name: sourceClipParams.name ?? 'imported',
        duration: sourceClipParams.duration ?? 1,
        keyframes: sourceClipParams.keyframes ?? [],
      },
      targetBones,
      nameMap,
      outputName: spec.outputName,
    });

    const outputId = spec.outputClipId ?? `${spec.sourceClipId}_retargeted`;
    const timeId = findTimeSource(state)!;

    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: outputId,
        nodeType: 'AnimationClip',
        params: result.clipParams,
      },
      {
        type: 'connect',
        from: { node: timeId, socket: 'out' },
        to: { node: outputId, socket: 'time' },
      },
      // Wire the retargeted clip to the TARGET skeleton.
      {
        type: 'connect',
        from: { node: spec.targetSkeletonId, socket: 'out' },
        to: { node: outputId, socket: 'skeleton' },
      },
    ];

    return ops;
  },
};

function findTimeSource(state: DagState): NodeId | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'TimeSource') return node.id;
  }
  return null;
}
