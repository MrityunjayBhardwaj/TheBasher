// The skeleton Objects in a scene, ready to draw (#1056).
//
// An Object whose data is a `Skeleton` draws no scene geometry — `ObjectR` returns null for it,
// the camera precedent — because its body is its bones, and bones are editor chrome drawn by
// the armature band. This is the read that band needs: which Objects those are, where they
// stand, their rest bones, and the clip that poses them.
//
// THE POSE IS THE OBJECT'S ACTION (#1203). An armature Object carries the clip that poses it on
// its `action` edge, as in Blender, and that is the one answer to "what poses this rig": the band
// here and a deform pointed at the Object (#393) both read it. Before #1203 the band chose "the one
// clip wired to the skeleton, else rest"; the format-15 migration wrote that choice down as the
// edge, so a saved project poses exactly as it did. `clipCount` still counts the clips wired to the
// skeleton, as a diagnostic: a rig resting with clips beside it has no action, not a broken one.
//
// Pure over the DAG, so it is testable without a renderer. Evaluated at frame 0 like the other
// chrome bands: a clip is sampled at the playhead later, per frame, by the helper.
//
// REF: src/viewport/ArmatureHelper.tsx (the consumer); src/app/resolveWorldTransform.ts;
//      issue #1056.

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { actionPoseOf } from '../nodes/AnimationClip';
import type { AnimationClipValue, BoneSpec, ObjectValue } from '../nodes/types';
import { resolveWorldTransform } from './resolveWorldTransform';

export interface SkeletonObject {
  /** The Object node — what a click on its bones selects. */
  readonly id: string;
  /** The Skeleton node its `data` points at. */
  readonly skeletonId: string;
  /** The Object's world matrix, column-major (three's `toArray`). */
  readonly world: readonly number[];
  /** The rest bones. */
  readonly bones: readonly BoneSpec[];
  /** The Object's action, or null when it has none or it is keyed on another rig (`actionPoseOf`). */
  readonly clip: AnimationClipValue | null;
  /** How many clips are wired to the skeleton — a diagnostic beside an unposed rig. */
  readonly clipCount: number;
}

const FRAME_0 = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

function refNode(binding: unknown): string | null {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const node = (binding as { node?: unknown }).node;
  return typeof node === 'string' ? node : null;
}

export function collectSkeletonObjects(state: DagState, cache?: EvaluatorCache): SkeletonObject[] {
  const out: SkeletonObject[] = [];
  const nodes = Object.values(state.nodes);
  for (const node of nodes) {
    if (node.type !== 'Object') continue;
    // Hidden in the outliner ⇒ hidden here too, as `SceneFromDAG` hides a top-level node.
    // Without this the eye toggle would blank the Object's slot and leave its bones standing.
    if (node.meta?.hidden) continue;
    const skeletonId = refNode(node.inputs.data);
    if (!skeletonId) continue;
    try {
      const data = evaluate(state, skeletonId, { cache, ctx: FRAME_0 }).value as
        | { kind?: string; bones?: BoneSpec[] }
        | undefined;
      if (data?.kind !== 'Skeleton' || !data.bones?.length) continue;
      // Not reachable as a scene descendant ⇒ nothing in the scene stands there to draw.
      const world = resolveWorldTransform(state, node.id, FRAME_0, cache);
      if (!world) continue;
      const clipCount = nodes.filter(
        (n) => n.type === 'AnimationClip' && refNode(n.inputs.skeleton) === skeletonId,
      ).length;
      const object = evaluate(state, node.id, { cache, ctx: FRAME_0 }).value as ObjectValue;
      const clip = actionPoseOf(object) === null ? null : (object.action ?? null);
      out.push({
        id: node.id,
        skeletonId,
        world: world.matrix,
        bones: data.bones,
        clip,
        clipCount,
      });
    } catch {
      // A half-wired or mid-edit graph draws no rig. This runs in a render path, and a throw
      // here would take the viewport down for a chrome band.
      continue;
    }
  }
  return out;
}
