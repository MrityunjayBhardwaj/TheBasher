// retarget Mutator — apply a source AnimationClip onto a target
// Skeleton via a bone-name map. Resolves the map either from a static
// preset id (Mixamo↔glTF / Reze / Rigify) or from an explicit
// Record<string, string>.
//
// ─────────────────────────────────────────────────────────────────────────
// #901 — IT EMITS THE RELATIONSHIP, NOT A SNAPSHOT OF WHAT IT PRODUCED
// ─────────────────────────────────────────────────────────────────────────
// This used to run the retarget math here, at build time, and write the result
// into a brand-new AnimationClip's params. That is a copy, and it had a copy's
// failure mode: change the source clip or fix a wrong bone map and nothing
// re-flowed — the target kept playing the old mapping with nothing on screen
// saying the two had drifted.
//
// It now emits a `BoneNameMap` node carrying the resolved map, a `RetargetClip`
// node, and the three edges between them and the operands. The math runs where
// the graph is read instead of where it is built.
//
// 🔴 ONE ROAD, NOT TWO. The obvious smaller change was to leave this mutator
// baking and give the UI drop-a-motion road its own graph-shaped builder. That
// would have made the agent's verb and the director's gesture produce DIFFERENT
// graphs for the same act — the divergence this codebase has already paid for
// at the read band, and the reason `boundClipsForAsset` is one walk. So the verb
// changed instead of forking.
//
// WHAT WENT AWAY WITH THE BAKE: the connect to the project TimeSource, and the
// precondition that demanded one. `RetargetClip` is deliberately time-free — it
// is a function of the graph, not of the frame — so a TimeSource is no longer an
// operand, and requiring one would refuse a retarget that has everything it
// needs. Its own header says why the time-freedom is the whole cost decision.
//
// Closure: roots = [sourceClipId, sourceSkeletonId, targetSkeletonId];
// followedEdges = []. Both new node ids are fresh — V13 allows addNode under
// fresh-add semantics — and every connect TARGETS a fresh node.
//
// P7.11 Wave G (#100) — a `GltfSkeleton` is an accepted source/target. It used
// to need type-aware bind-pose resolution HERE, because its rig is not in
// `params.bones` (D-02: it is a pure evaluated projection of the upstream
// GltfAsset's captured skin) and the bake needed the bones at build time. #901
// took the bake out, so this builder reads no bind pose at all — it names the
// rig with an edge and lets the reader project it. That is why the `evaluate()`
// call, and the note about keeping it out of the op-closure, are gone rather
// than merely unused.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Node, Op } from '../../../core/dag/types';
import { getBoneNameMapPreset, listBoneNameMapPresets } from '../../../core/import/boneNameMaps';

/** Node types whose `out` is a `Skeleton` value — accepted as retarget source/target. */
const SKELETON_NODE_TYPES = ['Skeleton', 'GltfSkeleton'] as const;
type SkeletonNodeType = (typeof SKELETON_NODE_TYPES)[number];

function isSkeletonNode(node: Node): node is Node & { type: SkeletonNodeType } {
  return (SKELETON_NODE_TYPES as readonly string[]).includes(node.type);
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
  // The preset list is DERIVED, not spelled. It used to be the literal
  // "mixamoToGltf, mixamoToReze, mixamoToRigify", which was already one short
  // when the glTF bar-rig bridge shipped and went two short when the SOMA
  // presets did. A preset the agent cannot read about is a preset the agent can
  // only reach by guessing wrong first and reading the rejection — the
  // rejections have always enumerated the catalogue, and the description is
  // where the choice is actually made. Deriving it means a new preset is
  // announced by the act of registering it.
  description:
    'Retarget an AnimationClip from one Skeleton onto another via a ' +
    'bone-name map. Pass mapPresetId for a known rig pair (' +
    listBoneNameMapPresets()
      .map((p) => p.id)
      .join(', ') +
    ') or customMap for arbitrary rigs. ' +
    'Emits a RetargetClip node wired to the source clip, the map and the ' +
    'target rig, so editing either operand re-poses the target with no ' +
    're-run; the source clip is left untouched.',
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
    // The output reads its SOURCE rig off the source clip's own `skeleton` edge,
    // because a keyframe's `bone` is an index and an index means nothing except
    // against the rig it was authored for. So a spec that names a different rig
    // than the clip is wired to is a disagreement, not a preference — refuse it
    // rather than silently preferring one. (There is no TimeSource requirement
    // any more: the emitted node is time-free, so a clock is not an operand.)
    const clipRigId = edgeSource(sourceClip, 'skeleton');
    if (!clipRigId) {
      return {
        ok: false,
        reason:
          `sourceClipId "${spec.sourceClipId}" has no skeleton connected. A clip's ` +
          'keyframes are bone INDICES, so the rig they were authored against has to ' +
          'be on the graph before they can be retargeted.',
      };
    }
    if (clipRigId !== spec.sourceSkeletonId) {
      return {
        ok: false,
        reason:
          `sourceSkeletonId "${spec.sourceSkeletonId}" is not the rig "${spec.sourceClipId}" ` +
          `is connected to ("${clipRigId}"). The clip's own edge is what the retarget reads.`,
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
  // No `state`: the build reads nothing off the graph any more. Every operand it
  // used to sample is now named by an edge instead, which is the whole change.
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    const nameMap =
      spec.customMap ??
      getBoneNameMapPreset(spec.mapPresetId!)?.map ??
      ({} as Readonly<Record<string, string>>);

    const outputId = spec.outputClipId ?? `${spec.sourceClipId}_retargeted`;
    // Derived from the output id, so two binds of the same clip onto two
    // characters get their own maps and neither can overwrite the other's.
    const mapId = `${outputId}_map`;

    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: mapId,
        nodeType: 'BoneNameMap',
        // The RESOLVED map, not the preset id: the node is where the director
        // fixes a bone-name typo, and a preset id is not editable. Resolving it
        // once here is also what makes the choice legible after the fact.
        params: { name: spec.mapPresetId ?? 'custom bone map', map: nameMap },
      },
      {
        type: 'addNode',
        nodeId: outputId,
        nodeType: 'RetargetClip',
        params: { name: spec.outputName ?? '' },
      },
      {
        type: 'connect',
        from: { node: spec.sourceClipId, socket: 'out' },
        to: { node: outputId, socket: 'sourceClip' },
      },
      {
        type: 'connect',
        from: { node: mapId, socket: 'out' },
        to: { node: outputId, socket: 'boneMap' },
      },
      // Wire the retarget to the TARGET skeleton.
      {
        type: 'connect',
        from: { node: spec.targetSkeletonId, socket: 'out' },
        to: { node: outputId, socket: 'skeleton' },
      },
    ];

    return ops;
  },
};

/** The node id feeding `node.inputs[socket]`, or null. */
function edgeSource(node: Node, socket: string): string | null {
  const c = (node.inputs as Record<string, unknown> | undefined)?.[socket];
  const one = (Array.isArray(c) ? c[0] : c) as { node?: unknown } | undefined;
  return typeof one?.node === 'string' ? one.node : null;
}
