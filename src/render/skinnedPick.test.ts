import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { pickAsDrawn, posedPositionsOf } from './skinnedPick';

/**
 * A bent, four-bone tube, up to four influences a vertex. `loose`: some weights sum past 1, which
 * three poses as written (and `drawnBox` measures exactly instead of from the bones).
 */
function rig(opts: { morph?: boolean; loose?: boolean } = {}) {
  const geometry = new THREE.CylinderGeometry(1, 1, 4, 24, 24);
  const position = geometry.getAttribute('position');
  const n = position.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = (position.getY(i) + 2) / 4;
    const b = Math.min(3, Math.floor(t * 4));
    si.set([b, Math.max(0, b - 1), Math.min(3, b + 1), 0], i * 4);
    sw.set(opts.loose ? [0.6, 0.25, 0.2, i % 7 === 0 ? 0.05 : 0] : [0.6, 0.25, 0.15, 0], i * 4);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  if (opts.morph) {
    const bulge = new Float32Array(n * 3);
    for (let i = 0; i < n; i++)
      bulge.set([position.getX(i) * 0.3, 0, position.getZ(i) * 0.3], i * 3);
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(bulge, 3)];
  }
  const bones = [0, 1, 2, 3].map(() => new THREE.Bone());
  bones.forEach((b, i) => {
    b.position.y = i === 0 ? -2 : 1.3;
    if (i) bones[i - 1].add(b);
  });
  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  if (opts.morph) {
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 0.5;
  }
  mesh.add(bones[0]);
  mesh.position.set(3, 1, -2);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  bones[1].rotation.z = 0.5;
  bones[2].rotation.x = 0.4;
  bones[3].rotation.z = -0.3;
  mesh.updateMatrixWorld(true);
  return { mesh, bones };
}

/** Stock three: the same mesh, ray-tested by `SkinnedMesh.raycast` posing corner by corner. */
function stockHits(mesh: THREE.SkinnedMesh, raycaster: THREE.Raycaster) {
  const hits: THREE.Intersection[] = [];
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  THREE.SkinnedMesh.prototype.raycast.call(mesh, raycaster, hits);
  return hits;
}

function picked(mesh: THREE.SkinnedMesh, raycaster: THREE.Raycaster) {
  const hits: THREE.Intersection[] = [];
  mesh.raycast(raycaster, hits);
  return hits;
}

const summary = (hits: THREE.Intersection[]) =>
  hits
    .map((h) => ({
      object: h.object,
      faceIndex: h.faceIndex,
      distance: h.distance,
      point: h.point.toArray(),
    }))
    .sort((a, b) => a.distance - b.distance);

/** A ray through the bent upper part of the tube, from world +x. */
const across = (y = 2.2) =>
  new THREE.Raycaster(new THREE.Vector3(12, y, -1.8), new THREE.Vector3(-1, 0, 0));

describe('#1756 — a skinned mesh is posed once per pose, and a click hits what is drawn', () => {
  it('poses every vertex where three’s own applyBoneTransform puts it', () => {
    for (const opts of [{}, { morph: true }, { loose: true }]) {
      const { mesh } = rig(opts);
      const { positions } = posedPositionsOf(mesh);
      const v = new THREE.Vector3();
      let worst = 0;
      for (let i = 0; i < positions.length / 3; i++) {
        mesh.getVertexPosition(i, v);
        worst = Math.max(worst, v.distanceTo(new THREE.Vector3().fromArray(positions, i * 3)));
      }
      expect(worst, JSON.stringify(opts)).toBeLessThan(1e-5);
    }
  });

  it('a click returns three’s own hits, on the skinned mesh itself', () => {
    const { mesh } = rig();
    const expected = summary(stockHits(mesh, across()));
    pickAsDrawn(mesh);
    const got = summary(picked(mesh, across()));
    expect(expected.length).toBeGreaterThan(0);
    expect(got.map((h) => [h.object, h.faceIndex])).toEqual(
      expected.map((h) => [h.object, h.faceIndex]),
    );
    got.forEach((h, i) => {
      expect(h.distance).toBeCloseTo(expected[i].distance, 5);
      h.point.forEach((c, k) => expect(c).toBeCloseTo(expected[i].point[k], 5));
    });
  });

  it('the bones are not applied per triangle corner: one pose serves every corner', () => {
    const { mesh } = rig();
    pickAsDrawn(mesh);
    const perCorner = vi.spyOn(mesh, 'applyBoneTransform');
    expect(picked(mesh, across()).length).toBeGreaterThan(0);
    expect(perCorner).not.toHaveBeenCalled();
    // CONTROL: stock three does apply them per corner.
    stockHits(mesh, across());
    expect(perCorner.mock.calls.length).toBeGreaterThan(mesh.geometry.index!.count);
  });

  it('the pose is kept until the bones move, and the next click hits the moved mesh', () => {
    const { mesh, bones } = rig();
    pickAsDrawn(mesh);
    picked(mesh, across());
    const first = posedPositionsOf(mesh).version;
    picked(mesh, across());
    expect(posedPositionsOf(mesh).version, 'same pose, no re-pose').toBe(first);

    bones[2].rotation.x = -0.6;
    mesh.updateMatrixWorld(true);
    const expected = summary(stockHits(mesh, across()));
    const got = summary(picked(mesh, across()));
    expect(posedPositionsOf(mesh).version).toBe(first + 1);
    expect(got.map((h) => h.faceIndex)).toEqual(expected.map((h) => h.faceIndex));
    expect(got[0].distance).toBeCloseTo(expected[0].distance, 5);
  });

  it('a ray that misses the drawn box poses nothing, and the swap does not outlive the pick', () => {
    const { mesh } = rig();
    pickAsDrawn(mesh);
    expect(picked(mesh, across(40))).toEqual([]);
    expect(posedPositionsOf(mesh).version, 'the first pose happens only now').toBe(1);
    expect(Object.prototype.hasOwnProperty.call(mesh, 'getVertexPosition')).toBe(false);
  });
});
