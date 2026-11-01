// #1756 — a click on a skinned mesh poses each vertex once, not once per triangle corner.
//
// three r169 ray-tests a skinned mesh by posing each triangle corner as it reaches it
// (`Mesh._computeIntersections` → `getVertexPosition` → `SkinnedMesh.applyBoneTransform`, one
// matrix product per bone influence). A vertex shared by six triangles is posed six times, and a
// click tests twice (pointer-down, click): the alley mecha cost 243 + 225 ms a click. Here the
// vertices are posed once into a buffer kept per mesh, re-posed only when the bones (or the morph
// weights, or the rest positions) changed, and three's own raycast reads that buffer: the hit is
// three's, on the positions the bones draw.
//
// The buffer is a per-mesh object a later index can be built over (#1768: a BVH for per-move
// picks), with a version that moves whenever its positions do.
//
// REF: three r169 src/objects/SkinnedMesh.js:105-136 (raycast), :223-256 (applyBoneTransform);
//      src/objects/Mesh.js:188+ (_computeIntersections → getVertexPosition);
//      src/renderers/WebGLRenderer.js:1374-1379 (a null bounding sphere is measured per draw).
import * as THREE from 'three';
import { drawnBox } from './drawnBox';

/** A skinned mesh's vertices where its bones put them, in the mesh's own space. */
export interface PosedPositions {
  /** xyz per vertex. Overwritten in place when the pose changes: read it, do not keep it. */
  readonly positions: Float32Array;
  /** Moves whenever `positions` changed. Equal versions mean equal positions. */
  readonly version: number;
}

interface PoseCache {
  positions: Float32Array;
  version: number;
  /** What the positions were posed from: per-bone matrices, bind matrices, morph weights. */
  inputs: Float32Array;
  restVersion: number;
}

const caches = new WeakMap<THREE.SkinnedMesh, PoseCache>();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** Everything the pose depends on that can change without the geometry changing. */
function poseInputs(mesh: THREE.SkinnedMesh, out: Float32Array | null): Float32Array {
  const { bones, boneInverses } = mesh.skeleton;
  const morph = mesh.morphTargetInfluences ?? [];
  const size = bones.length * 16 + 32 + morph.length;
  const inputs = out && out.length === size ? out : new Float32Array(size);
  for (let i = 0; i < bones.length; i++) {
    _m.multiplyMatrices(bones[i].matrixWorld, boneInverses[i]);
    inputs.set(_m.elements, i * 16);
  }
  inputs.set(mesh.bindMatrix.elements, bones.length * 16);
  inputs.set(mesh.bindMatrixInverse.elements, bones.length * 16 + 16);
  inputs.set(morph, bones.length * 16 + 32);
  return inputs;
}

function samePose(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pose every vertex once with three's own formula (`applyBoneTransform`): the rest position (after
 * morphs) through the bind matrix, the weighted sum of each influence's bone matrix, back through
 * the inverse bind matrix. The per-bone matrices are formed once per pose, not once per influence.
 */
function poseInto(mesh: THREE.SkinnedMesh, inputs: Float32Array, out: Float32Array): void {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const boneCount = mesh.skeleton.bones.length;
  const bind = mesh.bindMatrix.elements;
  const unbind = mesh.bindMatrixInverse.elements;
  const morphed = geometry.morphAttributes.position !== undefined;
  for (let i = 0; i < position.count; i++) {
    if (morphed) THREE.Mesh.prototype.getVertexPosition.call(mesh, i, _v);
    else _v.fromBufferAttribute(position, i);
    const x0 = _v.x;
    const y0 = _v.y;
    const z0 = _v.z;
    const bx = bind[0] * x0 + bind[4] * y0 + bind[8] * z0 + bind[12];
    const by = bind[1] * x0 + bind[5] * y0 + bind[9] * z0 + bind[13];
    const bz = bind[2] * x0 + bind[6] * y0 + bind[10] * z0 + bind[14];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w === 0) continue;
      const bone = skinIndex.getComponent(i, k);
      if (bone >= boneCount) continue;
      const o = bone * 16;
      x += w * (inputs[o] * bx + inputs[o + 4] * by + inputs[o + 8] * bz + inputs[o + 12]);
      y += w * (inputs[o + 1] * bx + inputs[o + 5] * by + inputs[o + 9] * bz + inputs[o + 13]);
      z += w * (inputs[o + 2] * bx + inputs[o + 6] * by + inputs[o + 10] * bz + inputs[o + 14]);
    }
    out[i * 3] = unbind[0] * x + unbind[4] * y + unbind[8] * z + unbind[12];
    out[i * 3 + 1] = unbind[1] * x + unbind[5] * y + unbind[9] * z + unbind[13];
    out[i * 3 + 2] = unbind[2] * x + unbind[6] * y + unbind[10] * z + unbind[14];
  }
}

/** `mesh`'s posed vertices, re-posed only if the pose changed since the last read. */
export function posedPositionsOf(mesh: THREE.SkinnedMesh): PosedPositions {
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const restVersion = position.version;
  let cache = caches.get(mesh);
  const inputs = poseInputs(mesh, null);
  if (
    cache &&
    cache.positions.length === position.count * 3 &&
    cache.restVersion === restVersion &&
    samePose(cache.inputs, inputs)
  ) {
    return cache;
  }
  if (!cache || cache.positions.length !== position.count * 3) {
    cache = { positions: new Float32Array(position.count * 3), version: 0, inputs, restVersion };
    caches.set(mesh, cache);
  }
  poseInto(mesh, inputs, cache.positions);
  cache.inputs = inputs;
  cache.restVersion = restVersion;
  cache.version++;
  return cache;
}

/**
 * Make clicks on `mesh` test it where it is drawn, posing it at most once per pose.
 *
 * #1610 / #1684 — three tests a skinned mesh's own bounds before any triangle (SkinnedMesh.js:114,
 * :128), so they must be where the bones put the mesh now, or a character that has walked away
 * from where it was imported is not under the pointer. They are written from `drawnBox`, the box
 * every reader of "where is this mesh drawn" uses, on this mesh's own fields; the shared geometry
 * is never written. A ray that misses them costs nothing more. They are not cleared on every pose:
 * the renderer measures a null sphere on every draw to sort objects (WebGLRenderer.js:1374-1379),
 * so clearing it re-skinned every character every frame (3.3 ms per frame for one X Bot, #1684).
 *
 * #1756 — for the triangles, three's own raycast runs with `getVertexPosition` reading the posed
 * buffer ({@link posedPositionsOf}), posed on the first vertex it asks for. The swap lasts only
 * the raycast: every other reader of the mesh's vertices is untouched.
 */
export function pickAsDrawn(mesh: THREE.SkinnedMesh): void {
  const measured = new THREE.Box3();
  mesh.raycast = (raycaster, intersects) => {
    if (drawnBox(mesh, measured)) {
      const own = mesh as unknown as {
        boundingBox: THREE.Box3 | null;
        boundingSphere: THREE.Sphere | null;
      };
      own.boundingBox = (own.boundingBox ?? new THREE.Box3()).copy(measured);
      own.boundingSphere = measured.getBoundingSphere(own.boundingSphere ?? new THREE.Sphere());
    }
    let posed: Float32Array | null = null;
    mesh.getVertexPosition = (index, target) => {
      posed ??= posedPositionsOf(mesh).positions;
      return target.fromArray(posed, index * 3);
    };
    try {
      THREE.SkinnedMesh.prototype.raycast.call(mesh, raycaster, intersects);
    } finally {
      delete (mesh as { getVertexPosition?: unknown }).getVertexPosition;
    }
  };
}
