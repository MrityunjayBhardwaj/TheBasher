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
// TWO STEPS, AND THEY FAIL DIFFERENTLY.
//   1. instance → bone. Arithmetic over the same flattening the fill loop did.
//      It cannot be "wrong but plausible": either the offsets describe the array
//      or the index lands outside it.
//   2. bone → node. A walk UP the scene graph looking for an ancestor whose
//      `name` is a live DAG node id — the convention `SceneFromDAG` already
//      establishes by naming each producer's wrapping group with its node id
//      (`<group name={pickId}>`), and which the scale probe already reads. This
//      one CAN come back null: a rig with no DAG ancestor is a rig nothing in
//      the graph produced, and there is nothing to select. Null is returned
//      rather than a guess, and `selectNode` already treats null as "let the
//      click fall through" rather than as an error.

/** The parts of a `BoneFrame` this module needs. */
export interface PickableBone {
  readonly name: string;
  /** Parent index WITHIN its own armature, or -1 for a root. */
  readonly parent: number;
}

/** The minimal `Object3D` shape for the walk up. */
export interface PickAncestor {
  readonly name: string;
  readonly parent: PickAncestor | null;
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

/** The minimal `Object3D` shape for walking an asset's subtree. */
export interface PickNode extends PickAncestor {
  readonly parent: PickNode | null;
  readonly children?: readonly PickNode[];
  readonly userData?: { readonly basherGltfChildId?: unknown };
}

/**
 * Every DAG node id that names some part of the asset this armature belongs to.
 *
 * 🔴 MEASURED, and the obvious version was wrong twice. A glTF character does
 * not put its bones under the node a director clicks:
 *
 *   1. Clicking the body selects a `GltfChild`, which is the armature's SIBLING
 *      under the import group — so the bone's own ancestors never mention it.
 *   2. A `GltfChild`'s scene object is NOT named with its node id either.
 *      `SceneFromDAG` names the wrapping group with the producer's id
 *      (`<group name={pickId}>`) and marks the drilled children with
 *      `userData.basherGltfChildId` instead, so `getObjectByName` finds nothing
 *      and the gate reads "different asset" for a click on the same character.
 *      Measured: `selObj false` on every click.
 *
 * So the asset is identified from the OUTERMOST named ancestor — the import
 * group — and everything the DAG can name inside it is collected in one pass.
 * Both spellings, because both are how a part of this asset can be selected.
 */
export function assetIdsFor(
  armatureRoot: PickNode | null,
  isNodeId: (name: string) => boolean,
): Set<string> {
  const ids = new Set<string>();

  // Up: every named ancestor, remembering the outermost — that is the asset.
  let assetRoot: PickNode | null = null;
  const up = new Set<PickNode>();
  let cursor: PickNode | null = armatureRoot;
  while (cursor && !up.has(cursor)) {
    up.add(cursor);
    if (cursor.name && isNodeId(cursor.name)) {
      ids.add(cursor.name);
      assetRoot = cursor;
    }
    cursor = cursor.parent;
  }
  if (!assetRoot) return ids;

  // Down: everything the DAG can name inside it.
  const stack: PickNode[] = [assetRoot];
  const seen = new Set<PickNode>();
  while (stack.length > 0) {
    const node = stack.pop() as PickNode;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.name && isNodeId(node.name)) ids.add(node.name);
    const childId = node.userData?.basherGltfChildId;
    if (typeof childId === 'string' && childId !== '') ids.add(childId);
    for (const child of node.children ?? []) stack.push(child);
  }
  return ids;
}

/**
 * May a click select a bone of this armature?
 *
 * BLENDER DECIDES THIS WITH A MODE, and the mode is the point: in Object Mode a
 * click selects the armature OBJECT, and only once that armature is active does
 * a click reach an individual bone. We have no modes, so the nearest honest
 * translation is the selection itself — the character has to be the thing being
 * worked on before its bones become clickable.
 *
 * Without the gate the helper would take EVERY click that lands over a bone,
 * because it is drawn in front of the skin unconditionally (#972) and so has to
 * pick in front to match. Selecting the glTF parts of a rigged character would
 * quietly stop working, and most of a torso is over some bone.
 */
export function bonesPickable(
  assetIds: ReadonlySet<string>,
  selectedNodeId: string | null,
): boolean {
  return selectedNodeId !== null && assetIds.has(selectedNodeId);
}

/**
 * The DAG node that produced this armature, or null.
 *
 * Walks up from the rig's root bone to the first ancestor whose name is a live
 * node id. Not the first ancestor with ANY name: an imported glTF is full of
 * named groups from the file itself, and one of those happening to match would
 * be a coincidence, while missing the real wrapper would be silent.
 */
export function ownerNodeId(
  from: PickAncestor | null,
  isNodeId: (name: string) => boolean,
): string | null {
  const seen = new Set<PickAncestor>();
  let cursor = from;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor.name && isNodeId(cursor.name)) return cursor.name;
    cursor = cursor.parent;
  }
  return null;
}
