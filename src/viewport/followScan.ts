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
// 🔑 AND A CHARACTER IS EXACTLY THE CASE THAT ARRIVES LATE. Measured on a real
// import: of the node ids in the graph, NOT ONE names an object in the scene —
// not the `GltfAsset`, not the `GltfSkeleton`, not any of the twenty
// `GltfChild`s; only the seed cube's own id does. So a character lock resolves
// through the rig branch alone, which means it resolves only once the armature
// is in the scene, and until then it looks exactly like a light.
//
// (How LONG that window is has not been measured — an import made through a
// test seam is not persisted, so a reload has no character to wait for. The
// argument above does not need the duration: it needs the two states to be
// indistinguishable here, and they are.)
//
// At the click there is no such window. The director is looking at the thing
// they just selected, so the scene is settled, and the answer is available
// before the lock is taken rather than a frame after.
//
// REF: src/viewport/cameraFollow.ts (which point); src/app/viewLock.ts (the
//      click); src/viewport/EditorViewCamera.tsx (the frame); issues #984, #985.

import * as THREE from 'three';
import { scanArmatures } from './ArmatureHelper';
import { assetIdsFor, type PickNode } from './armaturePick';
import { placeBones } from './boneShape';
import { computeSceneBounds } from './sceneBounds';
import { followPoint, type FollowArmature, type FollowPoint } from './cameraFollow';

interface ScannedRig {
  readonly root: THREE.Object3D;
  readonly bones: THREE.Object3D[];
  readonly parents: number[];
  readonly ids: ReadonlySet<string>;
}

/** The expensive half: everything a follow needs that requires walking the
 *  scene. Held across frames by the applier, taken fresh by the affordance. */
export interface FollowScan {
  readonly rigs: readonly ScannedRig[];
  /** The object `SceneFromDAG` named with this node's id, or null.
   *
   *  🔴 A HANDLE, NOT THE OBJECT. It is a picking wrapper pinned at the world
   *  origin — the transform is applied within it — so its own position is
   *  constant however far the content travels. `pointFromScan` reads the
   *  CONTENT's bounds and never this object's position. */
  readonly object: THREE.Object3D | null;
}

/**
 * Walk the scene for everything a lock on `nodeId` could follow.
 *
 * `isLiveNodeId` is asked rather than assumed: `assetIdsFor` collects the names
 * inside an asset's outermost named ancestor, and a name is only an id if the
 * graph still carries it.
 */
export function scanForFollow(
  scene: THREE.Object3D,
  isLiveNodeId: (name: string) => boolean,
  nodeId: string,
): FollowScan {
  return {
    rigs: scanArmatures(scene).map((scan) => ({
      ...scan,
      ids: assetIdsFor(scan.root as unknown as PickNode, isLiveNodeId),
    })),
    // Resolved unconditionally rather than only when no rig matched: skipping it
    // there would put the rig-beats-object priority in a second place, free to
    // disagree with `followPoint`'s copy silently.
    object: scene.getObjectByName(nodeId) ?? null,
  };
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
  // Only the rig(s) the lock names get placed. The `ids.has` here is a COST
  // pre-pass, not a second decision — it is the same expression `followPoint`
  // selects with, so the two cannot disagree; placing every rig in the scene to
  // throw all but one away is simply work with no reader.
  const armatures: FollowArmature[] = [];
  for (const rig of scan.rigs) {
    if (!rig.ids.has(nodeId)) continue;
    // The TRS pass that poses the bones runs at the same default priority, so
    // its order against the applier's is mount order. Forcing the update makes
    // the read correct either way — the same guard the armature helper takes.
    rig.root.updateWorldMatrix(true, true);
    armatures.push({
      ids: rig.ids,
      frames: placeBones(
        rig.bones.map((b, i) => ({
          name: b.name,
          parent: rig.parents[i],
          matrix: b.matrixWorld,
        })),
      ),
    });
  }
  // The centre of what this node actually DRAWS, through the same reader "frame
  // all" uses — live world bounds over non-chrome meshes. Reading the scene
  // rather than the node's authored `position` is the same choice the rig branch
  // makes and for the same reason: a follow has to track what is on screen, so a
  // keyframed, driven or constrained object is followed without any of those
  // needing to be known about here. A node that draws no measurable content
  // yields no point — which is the whole of #984, because a LIGHT's glyphs are
  // editor chrome and `computeSceneBounds` prunes them.
  const bounds = scan.object ? computeSceneBounds(scan.object) : null;
  return followPoint(armatures, nodeId, boneName, bounds ? bounds.center : null);
}
