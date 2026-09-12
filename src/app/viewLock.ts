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
import { useThreeRef } from './character/threeRef';
import { useDagStore } from '../core/dag/store';
import { pointFromScan, scanForFollow } from '../viewport/followScan';

/**
 * Will toggling do anything? Pure, and shared with the affordance ON PURPOSE.
 *
 * 🔴 THIS EXISTS BECAUSE OF THIS ISSUE'S OWN FIRST HALF. That half found the
 * Home button guarding on `primaryNodeId !== null` — a PROXY for "frameSelected
 * will work" — which was true in exactly the case the function did nothing, so
 * the fallback never fired. A menu item cannot ask by calling (the call acts),
 * so the two would be a second proxy waiting to drift apart. They share this
 * predicate instead, and a change to what a lock needs moves both at once.
 */
export function canToggleViewLock(
  viewLock: { nodeId: string } | null,
  primaryNodeId: string | null,
): boolean {
  // Releasing is always available; taking needs something to take it against.
  return viewLock !== null || lockable(primaryNodeId);
}

/** The one statement of what a lock can be TAKEN against. A type predicate so
 *  the toggle narrows through it rather than restating the test — a restatement
 *  is how the two spellings drift apart in the first place. */
function lockable(primaryNodeId: string | null): primaryNodeId is string {
  return primaryNodeId !== null;
}

/**
 * What toggling did. A function that can decline must SAY so, in its return —
 * the lesson this issue's first half was filed for — and "declined" now has two
 * spellings that need different words from the caller, so a boolean can no
 * longer carry it.
 */
export type ViewLockOutcome =
  | { readonly kind: 'locked' }
  | { readonly kind: 'released' }
  | { readonly kind: 'refused'; readonly why: 'nothing-selected' | 'nothing-to-follow' };

/**
 * Toggle the view lock, and report what happened.
 *
 * Locked → unlocked, unconditionally: releasing never depends on what is
 * selected now, because what is selected now is unrelated to what was locked.
 * Unlocked → locked to the primary selection, when there is one AND the scene
 * has something for it to follow.
 *
 * RELEASING LEAVES THE PIVOT WHERE THE CHARACTER WAS, which is a deliberate
 * divergence from Blender: its lock substitutes the point at view-matrix time
 * and never writes the stored pivot, so unlocking snaps the view back to
 * wherever it was before. Ours moves the pivot, so unlocking is CONTINUOUS —
 * nothing on screen changes at the moment you stop following, which is the
 * behaviour a director asked for by turning it off while watching.
 *
 * 🔴 THE FOLLOWABILITY CHECK IS HERE, AND THAT IS THE WHOLE OF #984. Three
 * things can leave a lock with no point: a light or an empty, whose glyphs are
 * editor chrome and are pruned from the bounds; a data-only node that draws
 * nothing at all; and a rig whose every bone is a root. In all three the lock
 * used to sit in the store with its checkmark showing while the view never
 * moved — the same affordance-that-reads-as-live this issue's first half was
 * about, one layer further in.
 *
 * It cannot be answered in the applier, which is where it first looks like it
 * belongs: from inside a frame callback "nothing to follow" and "nothing to
 * follow YET" are the same observation — the resolver returns null for both and
 * the callback holds nothing else that separates them — so a lock restored from
 * a previous session (#985) would be cleared until its asset arrived. And a
 * character is the case that arrives late: measured on a real import, not one
 * node id names an object in the scene, so a character resolves through its rig
 * alone. At the click there is no such window — the director is looking at what
 * they just selected. See `followScan.ts` for the full argument.
 *
 * And it is answered at the CLICK rather than in `canToggleViewLock`, which the
 * menu evaluates on every render: this walks the scene, and the enabled state is
 * recomputed whenever anything in the menu bar changes. `canToggleViewLock` is
 * still the shared rule for the cheap half — whether there is anything to lock
 * to at all — and it does not claim to predict this one.
 */
export function toggleViewLock(): ViewLockOutcome {
  const store = useViewportStore.getState();
  if (store.viewLock) {
    store.setViewLock(null);
    return { kind: 'released' };
  }
  const nodeId = useSelectionStore.getState().primaryNodeId;
  if (!lockable(nodeId)) return { kind: 'refused', why: 'nothing-selected' };
  // The bone comes through `getActiveBone`, never off the raw store, and that
  // IS the check: it returns null unless the bone's rig is the primary
  // selection — the same value being locked. A `bone.nodeId === nodeId` guard
  // here looked prudent and was dead, which a falsification caught: removing it
  // changed no row, because there is no state in which the two disagree.
  const boneName = getActiveBone()?.boneName ?? null;
  if (!hasSomethingToFollow(nodeId, boneName)) {
    return { kind: 'refused', why: 'nothing-to-follow' };
  }
  store.setViewLock({ nodeId, boneName });
  return { kind: 'locked' };
}

/**
 * Is there anything in the live scene this lock could centre on?
 *
 * Asked through the SAME resolver the viewport applies every frame, so the
 * answer a director is given at the click and the answer the viewport acts on
 * cannot come apart. A second implementation here would be the drift this
 * issue's first half already paid for once.
 *
 * 🔴 AN UNANSWERABLE QUESTION IS NOT A NO. With no scene pushed yet there is
 * nothing to walk, and refusing on that would turn "I cannot tell" into "there
 * is nothing there" — a confident wrong answer, and the one failure mode worse
 * than the silence being fixed. The lock is taken and the applier follows it as
 * soon as there is something to follow.
 */
function hasSomethingToFollow(nodeId: string, boneName: string | null): boolean {
  const scene = useThreeRef.getState().scene;
  if (!scene) return true;
  const dag = useDagStore.getState().state;
  const scan = scanForFollow(scene, (name) => dag.nodes[name] !== undefined, nodeId);
  return pointFromScan(scan, nodeId, boneName) !== null;
}
