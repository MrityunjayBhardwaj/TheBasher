// overlayTransients — THE single primitive that applies the transient edit SET
// onto a scene child, used by BOTH the render side (AnimationLayerR) AND the
// read side (resolveEvaluatedTransform + resolveEvaluatedParam). Issue #149,
// Wave B/C — "one band, two callers" (the resolveGltfChildTrs precedent).
//
// THE H40 risk this kills: if render and read overlaid the transient with two
// separate code paths, they would drift (different precedence, different value
// shape) and the inspector would disagree with the viewport — the exact #68
// "snaps right back" class. ONE function, two callers → they CANNOT diverge.
//
// Precedence: transient > channel. The caller passes the ALREADY-channel-patched
// child (render: value.sampleTarget(seconds); read: the unwrapped sampled child),
// and the transient is written ON TOP — so a held edit wins over the curve value
// at the same frame, exactly like Blender's base-transient overlaying evaluated.
//
// Path-write reuses the SAME `writeAt` the channel patch uses (lifted/exported
// from AnimationLayer.ts) — no parallel path-writer, no drift. The inspector and
// gizmo route the WHOLE band (paramPath 'position', value [x,y,z]; or a scalar
// param + its value), exactly the shape KeyframeChannels patch, so writeAt
// round-trips losslessly.
//
// REF: issue #149, PLAN.md Wave B (B1); hetvabhasa H40; vyapti V20.

import { writeAt } from '../nodes/AnimationLayer';
import type { SceneChild } from '../nodes/types';
import type { TransientEdit } from './stores/transientEditStore';

/**
 * Apply every transient edit targeting `nodeId` onto a clone of `child`.
 * Returns `child` UNCHANGED (same ref → no churn) when no edit matches or when
 * `child` is null. When at least one edit matches, deep-clones `child` (the same
 * JSON deep-clone patchTarget uses — SceneChild is plain data at this layer) and
 * writes each matching edit's value at its paramPath. The base is never mutated.
 */
export function overlayTransients(
  child: SceneChild | null,
  nodeId: string,
  edits: Map<string, TransientEdit>,
): SceneChild | null {
  if (!child || edits.size === 0) return child;

  let hasMatch = false;
  for (const edit of edits.values()) {
    if (edit.nodeId === nodeId) {
      hasMatch = true;
      break;
    }
  }
  if (!hasMatch) return child; // identity — no clone, no churn

  const clone = JSON.parse(JSON.stringify(child)) as Record<string, unknown>;
  for (const edit of edits.values()) {
    if (edit.nodeId !== nodeId) continue;
    writeAt(clone, edit.paramPath, edit.value); // transient > channel (applied last)
  }
  return clone as unknown as SceneChild;
}
