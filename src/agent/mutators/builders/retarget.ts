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
// closure root.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import type { AnimationKeyframe, BoneSpec } from '../../../nodes/types';
import { retargetClip } from '../../../core/import/retarget';
import {
  getBoneNameMapPreset,
  listBoneNameMapPresets,
} from '../../../core/import/boneNameMaps';

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
    requiredEdges: [],
    requiredNodeTypes: ['AnimationClip', 'Skeleton'],
    preserves: ['rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.sourceClipId, spec.sourceSkeletonId, spec.targetSkeletonId],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const sourceClip = state.nodes[spec.sourceClipId];
    if (!sourceClip) return { ok: false, reason: `sourceClipId "${spec.sourceClipId}" not in DAG.` };
    if (sourceClip.type !== 'AnimationClip') {
      return { ok: false, reason: `sourceClipId "${spec.sourceClipId}" is ${sourceClip.type}; expected AnimationClip.` };
    }
    const sourceSkel = state.nodes[spec.sourceSkeletonId];
    if (!sourceSkel) return { ok: false, reason: `sourceSkeletonId "${spec.sourceSkeletonId}" not in DAG.` };
    if (sourceSkel.type !== 'Skeleton') {
      return { ok: false, reason: `sourceSkeletonId is ${sourceSkel.type}; expected Skeleton.` };
    }
    const targetSkel = state.nodes[spec.targetSkeletonId];
    if (!targetSkel) return { ok: false, reason: `targetSkeletonId "${spec.targetSkeletonId}" not in DAG.` };
    if (targetSkel.type !== 'Skeleton') {
      return { ok: false, reason: `targetSkeletonId is ${targetSkel.type}; expected Skeleton.` };
    }
    if (!findTimeSource(state)) {
      return {
        ok: false,
        reason: 'No TimeSource node in DAG. Default projects seed `n_time`; restore one before retargeting.',
      };
    }
    if (!spec.mapPresetId && !spec.customMap) {
      const knownIds = listBoneNameMapPresets().map((p) => p.id).join(', ');
      return {
        ok: false,
        reason: `Either mapPresetId or customMap is required. Known presets: ${knownIds}.`,
      };
    }
    if (spec.mapPresetId && !getBoneNameMapPreset(spec.mapPresetId)) {
      const knownIds = listBoneNameMapPresets().map((p) => p.id).join(', ');
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
    const sourceBones = (sourceSkel.params as { bones?: BoneSpec[] }).bones ?? [];
    const targetBones = (targetSkel.params as { bones?: BoneSpec[] }).bones ?? [];

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
