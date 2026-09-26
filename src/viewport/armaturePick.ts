// Turning a click on one instanced octahedron into a bone and its owner (#973).
//
// The helper draws EVERY armature in the scene from ONE `InstancedMesh` (#972),
// which is what keeps a 78-bone rig at one draw call. The price is that a click
// arrives as an integer: `instanceId`. This module is the whole of the way back
// from that integer to "the left shin of the character produced by node N" —
// kept pure so it can be tested without a renderer, and separate from the
// component so the mapping is one definition rather than a rule the click
// handler and the fill loop each keep in their heads.
//
// instance → bone is arithmetic over the same flattening the fill loop did. It
// cannot be "wrong but plausible": either the offsets describe the array or the
// index lands outside it. (bone → node is known when a rig is collected: every
// rig drawn is a skeleton Object, which is its own owner. The scene-graph walk
// that found the owner of the clone road's live bones retired with them, #1053.)

/** The parts of a `BoneFrame` this module needs. */
export interface PickableBone {
  readonly name: string;
  /** Parent index WITHIN its own armature, or -1 for a root. */
  readonly parent: number;
}

export interface PickedBone {
  /** Which armature in the scan order. */
  readonly armature: number;
  /** Index within that armature. */
  readonly index: number;
  readonly name: string;
  /**
   * Root first, this bone last. The chain is what makes a bone name mean
   * something: `LeftHandIndex1` says little, and
   * `Hips → Spine → … → LeftHand → LeftHandIndex1` says where the director is.
   */
  readonly chain: readonly string[];
}

/**
 * Which bone is instance `id`, given the per-armature start offsets the fill
 * loop used and the flattened frames it wrote.
 *
 * `offsets[a]` is where armature `a` starts in `frames`; the array is ascending
 * and its length is the armature count.
 */
export function pickBone(
  id: number,
  offsets: readonly number[],
  frames: readonly PickableBone[],
): PickedBone | null {
  if (!Number.isInteger(id) || id < 0 || id >= frames.length) return null;

  // The last offset at or below the id. Linear over a handful of armatures.
  let armature = -1;
  for (let a = 0; a < offsets.length; a++) {
    if (offsets[a] <= id) armature = a;
    else break;
  }
  if (armature < 0) return null;
  const base = offsets[armature];
  const end = armature + 1 < offsets.length ? offsets[armature + 1] : frames.length;
  if (id >= end) return null;

  // Root first. Walked with a visited guard rather than a trusted `parent`
  // chain: a cycle here would hang the click handler, and the frames come from
  // a scene walk rather than from a schema that forbids one.
  const chain: string[] = [];
  const seen = new Set<number>();
  let cursor = id - base;
  while (cursor >= 0 && !seen.has(cursor)) {
    seen.add(cursor);
    const frame = frames[base + cursor];
    if (!frame) break;
    chain.unshift(frame.name);
    cursor = frame.parent;
  }

  return { armature, index: id - base, name: frames[id].name, chain };
}
