// stripDrive — "can an NLA Strip placed on this node actually drive it?", answered ONCE
// for every surface that offers a strip, accepts one, or DESTROYS something on the way.
//
// WHY THIS IS ONE PREDICATE AND NOT A FILTER ON A MENU (#479).
// `Strip.ts:13-16` records the known limit — a strip whose target is a camera is not
// picked up, because the camera pose is resolved by a private channel scan
// (`activeCamera.ts`) that overwrites per-channel instead of folding strips — and claims
// the mitigation is that "the UI simply must not offer" cameras. That mitigation was real
// but covered ONE of three roads: the add-strip picker had it, push-down did not, and the
// agent mutator did not. Push-down is a COMPOSITE whose destructive half (delete the bare
// channels) is correct only because the placement it converts drives the same target — so
// on a camera it minted a strip that folds nothing and deleted the animation anyway.
// Measured: fov animated 30→130, pushed down, channel gone, the pose falling back to the
// static base, with the inspector and the NLA lane still showing the animation.
//
// ⇒ THE INVARIANT IS NOT "do not offer this target". It is: NEVER DELETE A CHANNEL WHOSE
// REPLACEMENT CANNOT DRIVE WHAT IT DROVE. A filter lives on a surface and surfaces
// multiply; the limit is a property of the data and does not.
//
// ⏳ TEMPORARY — THIS MODULE EXPIRES WITH #480. #480 folds the camera's private overlay
// scan onto the shared channel+strip seam (`layeredChannels.ts`), at which point a strip
// CAN drive a camera and this refusal is wrong. When it lands, delete this module and its
// three call sites rather than extending it — a permanent-looking guard around a
// temporary limit is how the limit becomes permanent.
//
// REF: src/nodes/Strip.ts:13-16 (the limit), src/app/activeCamera.ts:294-325 (the scan
//      that folds nothing), src/app/animate/dispatchMutator.ts (the accept),
//      src/timeline/NlaLanePane.tsx (the offer), src/timeline/NlaAddStripPopover.tsx
//      (the picker); issues #479, #480, epic #283.

import type { DagState } from '../core/dag/state';
import { isCameraNode } from './cameraNode';

/**
 * Why a Strip placed on `nodeId` could not drive it — a sentence fit for both a
 * disabled button's title and a dispatch `reason` — or `null` when it can.
 *
 * ONE expression for the offer AND the accept (V108): a guard added to a dispatcher
 * binds on the affordance's enable condition exactly as a capability would, or the
 * button stays live and the mutator refuses what the UI promised.
 *
 * An unknown id is NOT refused here — "this node does not exist" belongs to the caller's
 * own existence check, and answering it twice would put two different messages on one
 * failure.
 *
 * The subject is deliberately UNNAMED: a camera node carries no `name` param (measured —
 * `PerspectiveCameraParams` has none, and `addNode` stores PARSED params, so one written
 * anyway is stripped), so templating a display name here would print the raw node id into
 * a button title. Callers that want to name the subject prefix it themselves.
 */
export function stripDriveRefusal(state: DagState, nodeId: string): string | null {
  if (!isCameraNode(state, nodeId)) return null;
  return 'An NLA strip cannot drive a camera — the camera pose is resolved outside the strip fold, so pushing down would delete the animation instead of converting it (issue #480).';
}
