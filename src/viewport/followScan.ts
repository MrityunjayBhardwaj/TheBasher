// followScan — reading the LIVE scene for what a view lock can follow (#984).
//
// `cameraFollow.followPoint` decides WHICH point, from plain data. This is the
// scene half: the traversal that produces that data, and the per-frame placement
// that turns it into a point.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY IT IS A MODULE AND NOT TWO CALLERS DOING THE SAME THING
// ─────────────────────────────────────────────────────────────────────────
// It has two readers and they must not disagree. The applier asks every frame
// "where is it now"; the affordance asks once, at the click, "is there anything
// here to follow at all" — and if those two answered differently, the answer a
// director gets when they click and the answer the viewport acts on would come
// apart. That is the shape #856's first half was filed for, one layer further
// in: an affordance that reads as live and does nothing.
//
// So the split is by COST, not by question. `scanForFollow` walks the scene and
// is run on a cadence by the applier and once by the affordance; `pointFromScan`
// places the bones and is run every frame. Both callers use both.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THE CHECK IS AT THE CLICK AND NOT IN THE APPLIER
// ─────────────────────────────────────────────────────────────────────────
// Clearing a lock that resolved a fresh scan and still found no point is the
// cheaper-looking answer, and it is wrong here. From inside the applier "there
// is nothing to follow" and "there is nothing to follow YET" are the same
// observation — `pointFromScan` returns null for both and the callback holds
// nothing else that separates them — so a lock restored from a previous session
// (#985) would be cleared for as long as its asset had not arrived.
//
// 🔑 AND A CHARACTER WAS EXACTLY THE CASE THAT ARRIVED LATE: on the clone road
// no node id named an object in the scene, so a character lock resolved through
// the rig branch alone, once its live bones were in the scene. That branch read
// the clone road's live `Bone`s and retired with it (#1053); a native character
// has no road here yet — neither its mesh nor its armature Object is found, bone
// or not (#1275).
//
// At the click there is no such window. The director is looking at the thing
// they just selected, so the scene is settled, and the answer is available
// before the lock is taken rather than a frame after.
//
// REF: src/viewport/cameraFollow.ts (which point); src/app/viewLock.ts (the
//      click); src/viewport/EditorViewCamera.tsx (the frame); issues #984, #985.

import * as THREE from 'three';
import { computeSceneBounds } from './sceneBounds';
import { followPoint, type FollowPoint } from './cameraFollow';

/** The expensive half: everything a follow needs that requires walking the
 *  scene. Held across frames by the applier, taken fresh by the affordance. */
export interface FollowScan {
  /** The object `SceneFromDAG` named with this node's id, or null.
   *
   *  🔴 A HANDLE, NOT THE OBJECT. It is a picking wrapper pinned at the world
   *  origin — the transform is applied within it — so its own position is
   *  constant however far the content travels. `pointFromScan` reads the
   *  CONTENT's bounds and never this object's position. */
  readonly object: THREE.Object3D | null;
}

/** Walk the scene for everything a lock on `nodeId` could follow. */
export function scanForFollow(scene: THREE.Object3D, nodeId: string): FollowScan {
  return { object: scene.getObjectByName(nodeId) ?? null };
}

/**
 * The world point to centre on, from a scan — or null when there is nothing in
 * the scene this lock can follow.
 *
 * Null has TWO meanings and this function cannot tell them apart: nothing to
 * follow, and nothing to follow YET. Which one it is depends on where the lock
 * came from, and only the caller knows that (see this module's header).
 */
export function pointFromScan(
  scan: FollowScan,
  nodeId: string,
  boneName: string | null,
): FollowPoint | null {
  // The centre of what this node actually DRAWS, through the same reader "frame
  // all" uses — live world bounds over non-chrome meshes. Reading the scene
  // rather than the node's authored `position`: a follow has to track what is on screen, so a
  // keyframed, driven or constrained object is followed without any of those
  // needing to be known about here. A node that draws no measurable content
  // yields no point — which is the whole of #984, because a LIGHT's glyphs are
  // editor chrome and `computeSceneBounds` prunes them.
  const bounds = scan.object ? computeSceneBounds(scan.object) : null;
  // No rig is offered: the only rig source read the clone road's live bones (#1275).
  return followPoint([], nodeId, boneName, bounds ? bounds.center : null);
}
