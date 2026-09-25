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
// Closure: roots = [sourceClipId, sourceSkeletonId, targetSkeletonId, targetObjectId?];
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
import {
  skeletonObjectId,
  standInObjectOf,
  standingObjectsOf,
} from '../../../core/import/skeletonObject';
import { poseLayerChain } from '../../../app/animate/poseChain';
import type { GraphNodeLike } from '../../../app/animate/graphNodes';

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
  /**
   * #1213 — the armature Object whose pose the retarget becomes. Optional: omitted, it is the one
   * Object standing the target skeleton, and a skeleton several Objects stand is refused by name.
   */
  targetObjectId: z.string().min(1).optional(),
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
    're-run; the source clip is left untouched. The retarget becomes the pose of the armature ' +
    'Object standing the target skeleton (targetObjectId names it when several do), replacing ' +
    'the pose it had. The Object the import stood the ' +
    'source skeleton up with is hidden in the same step, unless source and target are ' +
    'one skeleton.',
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
      rootSelectors: [
        spec.sourceClipId,
        spec.sourceSkeletonId,
        spec.targetSkeletonId,
        // #1244 — the Object the retarget poses, so its layer chain can be walked (`pose` below).
        // Named, or else the one the import derived for the target skeleton; an Object pointed at
        // the skeleton by hand with layers under it needs `targetObjectId` to be reached.
        spec.targetObjectId ?? skeletonObjectId(spec.targetSkeletonId),
      ],
      // ONE 'parent' hop (#907) — the clips already bound to the target rig.
      //
      // A bind now stands its predecessor down, and 'parent' walks consumer-side:
      // any node listing a root in its inputs. A clip lists the skeleton it is
      // bound to, so one hop from `targetSkeletonId` is exactly the set of
      // siblings the rebind may touch, and `maxDepth: 1` stops it being more.
      //
      // Declared rather than worked around, and the gate is why: it REFUSED the
      // stand-down op as out-of-closure the first time, which is the system
      // working. A mutator that reaches further than it declares is the thing
      // this gate exists to catch; the answer is to declare the reach, not to
      // move the write somewhere the gate cannot see it.
      followedEdges: ['parent', 'pose'],
      maxDepth: 1,
      // #1244 — the layer chain under the Object is walked to its bottom, whatever its length; the
      // consumer-side reach above stays one hop.
      depthByKind: { pose: 256 },
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
    const posed = posedObjectOf(spec, state);
    if (!posed.ok) return posed;
    return { ok: true };
  },
  // The build samples no operand off the graph: every one is named by an edge instead
  // (#901). It reads `state` only to find what the bind must stand down within its
  // closure — the rig's previous active clip (#907) and the source rig's Object (#1056).
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
        // ACTIVE — this is the clip the director just asked for (#907).
        params: { name: spec.outputName ?? '', active: true },
      },
      {
        type: 'connect',
        // #1225 — the retarget reads the pose wire: the clip's pose, which carries its range.
        from: { node: spec.sourceClipId, socket: 'pose' },
        to: { node: outputId, socket: 'source' },
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

    // LAST BIND WINS, and the predecessor is DEACTIVATED rather than unbound
    // (#907). Before this, both clips stayed bound and the walk broke the tie by
    // clip id — so which motion played was decided by the alphabetical order of
    // the two source filenames, and dropping a second walk onto a character did
    // one of two completely different things depending on what the files were
    // called. Both looked like a successful bind.
    //
    // The reference's model, and the reason this is not an unbind: an animated
    // data-block has ONE active action, and assigning a new one auto-stashes the
    // previous onto a muted track — it is still there to unmute or delete. A
    // director may well want two clips on a rig; what they could not do was say
    // which one is playing.
    //
    // Emitted in the SAME op batch as the bind, so the two land atomically: a
    // batch that added the new clip without standing the old one down would put
    // two active clips on one rig, which is the state this flag exists to make
    // unrepresentable.
    // Iterated over the CLOSURE rather than over the whole graph: every op this
    // emits is then inside the declared set by construction, instead of being
    // checked against it afterwards.
    for (const id of _closure.nodes) {
      if (id === outputId) continue;
      const node = _state.nodes[id];
      if (!node) continue;
      if (node.type !== 'AnimationClip' && node.type !== 'RetargetClip') continue;
      if (edgeSource(node, 'skeleton') !== spec.targetSkeletonId) continue;
      // Only clips that ARE active: a no-op setParam on every sibling would put
      // undo entries and dirty params on nodes nothing asked about.
      if ((node.params as { active?: unknown }).active !== true) continue;
      ops.push({ type: 'setParam', nodeId: id, paramPath: 'active', value: false });
    }

    // #1213 — THE RETARGET BECOMES THE TARGET OBJECT'S POSE. An armature Object is posed by its
    // `pose` edge and by nothing else (#1224): the deform, the bone draw and bone-parented Objects
    // all read it, so a bind that left it alone moved nothing on a native character. A single
    // socket holds one edge, so the connect REPLACES the pose it had — Blender's armature Object
    // holds one action, and Houdini's retarget output is the animated pose Joint Deform reads.
    // `replace: true` declares the displacement, and the inverse restores the old edge on undo.
    // No Object (a clone-road `GltfSkeleton`, whose pose is the active clip above) wires nothing.
    //
    // #1244 — AT THE BOTTOM OF THE OBJECT'S LAYERS. A pose layer edits whatever motion arrives, so a
    // hand-pose stays on when the motion under it is replaced: the retarget takes the place of the
    // chain's SOURCE, not of the Object's pose, and every layer above keeps its keys. With no layers
    // the bottom is the Object itself.
    const posed = posedObjectOf(spec, _state);
    if (posed.ok && posed.objectId !== null) {
      ops.push(...bindPosedOps(_state, outputId, posed.objectId));
    }

    // #1056 — THE SOURCE RIG STEPS ASIDE. Every imported motion stands in the scene as an
    // Object pointed at its skeleton, so it can be looked at before anything plays it. Once a
    // character does, that Object is a second rig standing beside the character, so the bind
    // hides it — in this same batch, so undoing the bind brings the rig back and a refused
    // bind leaves it visible. Hidden, never removed: it stays in the outliner to unhide, and
    // outlives the character. The closure's one `parent` hop from `sourceSkeletonId` is what
    // reaches it.
    //
    // #1088 — ONLY THAT OBJECT, AND NOT ON A SELF-RETARGET. Matching every Object whose `data`
    // is the source skeleton also hid Objects the director pointed at it; `standInObjectOf`
    // names the import's own. And when source and target are one skeleton, its Object is the
    // rig the new clip drives, so hiding it would make the bind's result disappear. The Object
    // it names reads the source skeleton through `data`, so the closure's `parent` hop holds it.
    const standIn =
      spec.sourceSkeletonId === spec.targetSkeletonId
        ? null
        : standInObjectOf(_state, spec.sourceSkeletonId);
    if (standIn !== null) {
      ops.push({ type: 'setHidden', nodeId: standIn, hidden: true });
    }

    return ops;
  },
};

/**
 * #1213 #1244 — a retarget becomes the pose of the armature Object `objectId`: its `posed` output
 * connects at the BOTTOM of the Object's layer chain (the Object itself when there are none), so
 * every layer above keeps its edits.
 *
 * #1211 — the chain's BASE layer holds the character's own motion as keys (an imported file's, or a
 * hand-keyed one). The bound motion replaces it, as Blender swaps an armature's action: muted, never
 * removed, so undo or an unmute brings it back.
 *
 * The one builder of a bind's wiring: the mutator and a saved clone-road bind converting at load
 * (#1216) both call it.
 */
export function bindPosedOps(state: DagState, retargetId: string, objectId: string): Op[] {
  const { layers, base } = poseLayerChain(
    state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    objectId,
  );
  const ops: Op[] = [];
  if (base !== null) {
    ops.push({ type: 'setParam', nodeId: base, paramPath: 'mute', value: true });
  }
  ops.push({
    type: 'connect',
    from: { node: retargetId, socket: 'posed' },
    to: { node: layers.length > 0 ? layers[layers.length - 1] : objectId, socket: 'pose' },
    replace: true,
  });
  return ops;
}

/**
 * #1213 — the armature Object the retarget poses: the one named, which must stand the target
 * skeleton, or else the one Object standing it. Null when none stands it (a clone-road rig). Several
 * with none named is refused, naming them, because which of two Objects plays a motion is a choice.
 */
function posedObjectOf(
  spec: RetargetSpec,
  state: DagState,
): { ok: true; objectId: string | null } | { ok: false; reason: string } {
  if (spec.targetObjectId !== undefined) {
    const node = state.nodes[spec.targetObjectId];
    if (node?.type !== 'Object' || edgeSource(node, 'data') !== spec.targetSkeletonId) {
      return {
        ok: false,
        reason:
          `targetObjectId "${spec.targetObjectId}" is not an Object standing the target skeleton ` +
          `"${spec.targetSkeletonId}" (its data must be that skeleton).`,
      };
    }
    return { ok: true, objectId: spec.targetObjectId };
  }
  const standing = standingObjectsOf(state, spec.targetSkeletonId);
  if (standing.length > 1) {
    return {
      ok: false,
      reason:
        `the target skeleton "${spec.targetSkeletonId}" stands as several Objects ` +
        `(${standing.join(', ')}); pass targetObjectId to say which one takes the motion.`,
    };
  }
  return { ok: true, objectId: standing[0] ?? null };
}

/** The node id feeding `node.inputs[socket]`, or null. */
function edgeSource(node: Node, socket: string): string | null {
  const c = (node.inputs as Record<string, unknown> | undefined)?.[socket];
  const one = (Array.isArray(c) ? c[0] : c) as { node?: unknown } | undefined;
  return typeof one?.node === 'string' ? one.node : null;
}
