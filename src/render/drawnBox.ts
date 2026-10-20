// drawnBox — the box a mesh is drawn in, for every reader that asks (#1684).
//
// Framing ("frame all"), the sun's shadow fit, the depth pass's content range, a click's first
// test and the Group panel's origin each needed "where is this mesh drawn", and each worked it out
// its own way: three of them from the geometry's stored box, which for a skinned mesh is its bind
// pose at the import origin, so a character carried 20 m by its root bone cast no shadow and
// framed as if it had not moved; one by re-skinning every vertex on the CPU; and a click by
// clearing three's own bounds on every pose so three would re-skin them. This is the one answer.
//
// ── A SKINNED MESH ──────────────────────────────────────────────────────────────────────
//
// three skins on the GPU (`skinning_vertex.glsl.js`): a vertex `v` is drawn at
//   bindMatrixInverse · Σᵢ wᵢ (boneᵢ.matrixWorld · boneInverseᵢ) · bindMatrix · v
// in the mesh's own space. With the weights summing to one that is a weighted average of the
// points Mᵢ·v, one per bone it follows, where Mᵢ = bindMatrixInverse · boneᵢ.matrixWorld ·
// boneInverseᵢ · bindMatrix. Each Mᵢ·v lies inside Mᵢ applied to the bind-pose box of the
// vertices bone i moves, and an average of points lies inside the box around them, so the union
// of those per-bone boxes, each moved by its bone, holds every vertex as drawn. It costs eight
// corners per bone instead of a skinning per vertex (an X Bot mesh: 1.6 ms re-skinned on the
// software renderer CI uses), so any reader can ask every frame. It is a bound, not the tight
// box: a bone's box turned 45° grows. Where the argument does not hold — morph targets move
// vertices before skinning, and weights that do not sum to one are not an average — the mesh is
// re-skinned exactly instead.
//
// Nothing here writes three's own bounds (`boundingBox` / `boundingSphere` on the mesh or its
// geometry), except computing a plain geometry's box once, which three would do itself.
//
// REF: three r169 src/renderers/shaders/ShaderChunk/skinning_vertex.glsl.js,
//      src/objects/Skeleton.js (update: boneMatrices = bone.matrixWorld · boneInverse),
//      src/objects/SkinnedMesh.js (applyBoneTransform, computeBoundingBox).

import * as THREE from 'three';

/** Per skinned geometry: for each bone, the bind-pose box of the vertices it moves (null for a
 *  bone that moves none), or 'exact' when the per-bone bound does not hold. */
type BoneBoxes = (THREE.Box3 | null)[] | 'exact';

const boneBoxesByGeometry = new WeakMap<
  THREE.BufferGeometry,
  { version: number; boxes: BoneBoxes }
>();

const WEIGHT_SUM_TOLERANCE = 1e-3;

function boneBoxesOf(mesh: THREE.SkinnedMesh): BoneBoxes {
  const g = mesh.geometry;
  const position = g.attributes.position as THREE.BufferAttribute | undefined;
  const version = position?.version ?? -1;
  const cached = boneBoxesByGeometry.get(g);
  if (cached && cached.version === version) return cached.boxes;
  const boxes = measureBoneBoxes(g, mesh.skeleton.bones.length);
  boneBoxesByGeometry.set(g, { version, boxes });
  return boxes;
}

function measureBoneBoxes(g: THREE.BufferGeometry, boneCount: number): BoneBoxes {
  const position = g.attributes.position;
  const skinIndex = g.attributes.skinIndex;
  const skinWeight = g.attributes.skinWeight;
  if (!position || !skinIndex || !skinWeight) return 'exact';
  if (g.morphAttributes.position && g.morphAttributes.position.length > 0) return 'exact';
  const boxes: (THREE.Box3 | null)[] = new Array(boneCount).fill(null);
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w <= 0) continue;
      sum += w;
      const bone = skinIndex.getComponent(i, k);
      if (bone >= boneCount) return 'exact';
      (boxes[bone] ??= new THREE.Box3()).expandByPoint(v);
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) return 'exact';
  }
  return boxes;
}

const toBone = new THREE.Matrix4();
const moved = new THREE.Box3();

/** The skinned mesh's box as drawn, from its per-bone boxes; null when the bound does not hold. */
function boundFromBones(mesh: THREE.SkinnedMesh, target: THREE.Box3): THREE.Box3 | null {
  const boxes = boneBoxesOf(mesh);
  if (boxes === 'exact') return null;
  const { bones, boneInverses } = mesh.skeleton;
  target.makeEmpty();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    toBone.copy(mesh.bindMatrix);
    // A missing bone skins as identity, as three does (Skeleton.update).
    const bone = bones[i];
    if (bone) toBone.premultiply(boneInverses[i]).premultiply(bone.matrixWorld);
    toBone.premultiply(mesh.bindMatrixInverse);
    target.union(moved.copy(box).applyMatrix4(toBone));
  }
  return target;
}

/** The skinned mesh's box re-skinned vertex by vertex, without leaving it in three's slot. */
function exactSkinnedBox(mesh: THREE.SkinnedMesh, target: THREE.Box3): THREE.Box3 {
  const slot = mesh as unknown as { boundingBox: THREE.Box3 | null };
  const before = slot.boundingBox;
  mesh.computeBoundingBox();
  target.copy(slot.boundingBox ?? target.makeEmpty());
  slot.boundingBox = before;
  return target;
}

/**
 * The box `mesh` is drawn in, in its OWN space, written into `target`: for a skinned mesh, where
 * its bones put it; otherwise its geometry's box. Null when the mesh has no geometry to measure.
 */
export function drawnBox(mesh: THREE.Mesh, target: THREE.Box3): THREE.Box3 | null {
  if (!mesh.geometry) return null;
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh && skinned.skeleton) {
    return boundFromBones(skinned, target) ?? exactSkinnedBox(skinned, target);
  }
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox ? target.copy(g.boundingBox) : null;
}

/** {@link drawnBox} in world space: the mesh's own box through its world matrix. */
export function drawnWorldBox(mesh: THREE.Mesh, target: THREE.Box3): THREE.Box3 | null {
  return drawnBox(mesh, target)?.applyMatrix4(mesh.matrixWorld) ?? null;
}
