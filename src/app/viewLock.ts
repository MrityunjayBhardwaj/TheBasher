// Taking and releasing the view lock (#856) — the decision half of "follow the
// character", kept out of the menu so it can be stated and tested.
//
// THE ONE DECISION IT MAKES is what a lock is taken AGAINST. Blender's
// `View3D.lock_object` is a POINTER, not "the active object", and that is the
// behaviour worth copying: a lock that tracked the live selection would swing
// the camera onto whatever a director clicked next, which is the opposite of
// what someone asks for when they say "keep watching this". So the selection is
// read ONCE, here, at the moment the lock is taken, and the viewport then
// follows that node whether or not it stays selected.
//
// The bone rides along for the same reason it exists in Blender: an armature's
// object origin does not move when the motion lives in the pose, so a rig is
// followed by a bone. If a bone of the node being locked is active, that is the
// point the director is looking at and the lock takes it; otherwise the lock
// follows the rig as a whole and `cameraFollow` picks the point.
//
// Reports rather than acts silently — the same contract `frameSelected` was
// given in this issue's first half. "Nothing is selected" is a real outcome of
// asking to lock, and a caller that wants to say so needs to be told.
//
// REF: src/viewport/cameraFollow.ts (where the point comes from);
//      src/app/boneSelection.ts (the validated bone pair);
//      src/app/character/framing.ts (the sibling one-shot, `frameSelected`);
//      issue #856.

import { getActiveBone } from './boneSelection';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore } from './stores/viewportStore';

/**
 * Toggle the view lock. Returns whether the view is locked AFTER the call.
 *
 * Locked → unlocked, unconditionally: releasing never depends on what is
 * selected now, because what is selected now is unrelated to what was locked.
 * Unlocked → locked to the primary selection, or false when there is none.
 */
export function toggleViewLock(): boolean {
  const store = useViewportStore.getState();
  if (store.viewLock) {
    store.setViewLock(null);
    return false;
  }
  const nodeId = useSelectionStore.getState().primaryNodeId;
  if (!nodeId) return false;
  const bone = getActiveBone();
  // The bone comes through `getActiveBone`, never off the raw store, and that
  // IS the check: it returns null unless the bone's rig is the primary
  // selection — the same value being locked. A `bone.nodeId === nodeId` guard
  // here looked prudent and was dead, which a falsification caught: removing it
  // changed no row, because there is no state in which the two disagree.
  store.setViewLock({ nodeId, boneName: bone?.boneName ?? null });
  return true;
}
