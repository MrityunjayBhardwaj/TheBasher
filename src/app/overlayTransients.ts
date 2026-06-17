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
// Path-write reuses the SAME `writeAt` the channel patch uses (the one path-writer
// in overlayChannels.ts) — no parallel path-writer, no drift. The inspector and
// gizmo route the WHOLE band (paramPath 'position', value [x,y,z]; or a scalar
// param + its value), exactly the shape KeyframeChannels patch, so writeAt
// round-trips losslessly.
//
// REF: issue #149, PLAN.md Wave B (B1); hetvabhasa H40; vyapti V20.

import { writeAt } from '../nodes/overlayChannels';
import type { TransientEdit } from './stores/transientEditStore';

/**
 * Apply every transient edit targeting `nodeId` onto a clone of `base`.
 * Returns `base` UNCHANGED (same ref → no churn) when no edit matches or when
 * `base` is null. When at least one edit matches, deep-clones `base` (the same
 * JSON deep-clone patchTarget uses — the overlay targets are plain data at this
 * layer) and writes each matching edit's value at its paramPath. The base is
 * never mutated.
 *
 * Generic `<T>` (V20, mirroring overlayChannels) so the SAME primitive serves
 * BOTH the native/AnimationLayer `SceneChild` callers (T = SceneChild) AND the
 * glTF material per-frame loop (T = `{ materials }`) — one band, two callers, no
 * drift. `writeAt` already indexes the `materials.<slot>.<lobe>.<field>` array
 * path (V53), so a glTF material transient round-trips losslessly.
 */
export function overlayTransients<T>(
  base: T | null,
  nodeId: string,
  edits: Map<string, TransientEdit>,
): T | null {
  if (!base || edits.size === 0) return base;

  let hasMatch = false;
  for (const edit of edits.values()) {
    if (edit.nodeId === nodeId) {
      hasMatch = true;
      break;
    }
  }
  if (!hasMatch) return base; // identity — no clone, no churn

  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const edit of edits.values()) {
    if (edit.nodeId !== nodeId) continue;
    writeAt(clone, edit.paramPath, edit.value); // transient > channel (applied last)
  }
  return clone as unknown as T;
}
