// #1684 — one box for "where is this mesh drawn", and every reader agreeing on it.
//
// A skinned bar is carried 20 m by its root bone. Framing, the sun's shadow fit and the depth
// pass must all find it where it stands, not at its import origin — the shadow fit used to read
// the stored (bind-pose) box and so cast nothing for a moved character. And the per-bone bound
// `drawnBox` uses for a skinned mesh must hold every vertex as three skins it, in any pose.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { drawnBox, drawnWorldBox } from './drawnBox';
import { computeSceneBox } from '../viewport/sceneBounds';
import { markContentShadows } from '../viewport/contentShadows';
import { visibleContentSphere } from './renderToImage';

/** A 2 m bar along +y, 9 rings of 8 points, skinned to a root bone at 0 and a child at 1 m,
 *  blended across the middle. Weights sum to one unless `weightScale` says otherwise. */
function skinnedBar(opts: { weightScale?: number; morph?: boolean } = {}) {
  const positions: number[] = [];
  const indices: number[] = [];
  const weights: number[] = [];
  for (let r = 0; r <= 8; r++) {
    const y = r / 4;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      positions.push(Math.cos(a) * 0.1, y, Math.sin(a) * 0.1);
      const child = Math.min(1, Math.max(0, (y - 0.5) / 1));
      weights.push((1 - child) * (opts.weightScale ?? 1), child * (opts.weightScale ?? 1), 0, 0);
      indices.push(0, 1, 0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  if (opts.morph) {
    g.morphAttributes.position = [
      new THREE.Float32BufferAttribute(
        positions.map((_, i) => (i % 3 === 0 ? 0.5 : 0)),
        3,
      ),
    ];
  }
  const root = new THREE.Bone();
  const child = new THREE.Bone();
  child.position.y = 1;
  root.add(child);
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  if (opts.morph) mesh.morphTargetInfluences = [1];
  const scene = new THREE.Scene();
  scene.add(mesh, root);
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([root, child]));
  return { scene, mesh, root, child };
}

/** Every vertex as three skins it, in world space. */
function skinnedPoints(mesh: THREE.SkinnedMesh): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    out.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  }
  return out;
}

const holdsAll = (box: THREE.Box3, points: THREE.Vector3[]) =>
  points.every((p) => box.clone().expandByScalar(1e-6).containsPoint(p));

describe('#1684 — every reader finds a moved character where it stands', () => {
  it('framing, the sun fit and the depth pass agree, 20 m from the import origin', () => {
    const { scene, mesh, root } = skinnedBar();
    root.position.x = 20;
    scene.updateMatrixWorld(true);
    const drawn = skinnedPoints(mesh);

    const framed = computeSceneBox(scene)!;
    const shadowed = markContentShadows(scene)!;
    const depth = visibleContentSphere(scene)!;
    for (const box of [framed, shadowed]) {
      expect(holdsAll(box, drawn)).toBe(true);
      // Nothing of it is left at the origin, where the bind pose stands.
      expect(box.min.x).toBeGreaterThan(19);
    }
    expect(shadowed.equals(framed)).toBe(true);
    expect(depth.center.distanceTo(framed.getCenter(new THREE.Vector3()))).toBeLessThan(1e-9);
  });

  it('control: at rest the box is the bind-pose box', () => {
    const { mesh } = skinnedBar();
    const box = drawnBox(mesh, new THREE.Box3())!;
    mesh.geometry.computeBoundingBox();
    expect(box.equals(mesh.geometry.boundingBox!)).toBe(true);
  });
});

describe('#1684 — the per-bone bound holds every vertex as drawn', () => {
  it('in bent, carried and scaled poses', () => {
    const { scene, mesh, root, child } = skinnedBar();
    const poses: [string, () => void][] = [
      ['bent 90°', () => child.rotation.set(0, 0, Math.PI / 2)],
      [
        'carried and turned',
        () => (root.position.set(3, -2, 7), root.rotation.set(0.4, 1.2, -0.3)),
      ],
      ['folded back', () => child.rotation.set(Math.PI * 0.9, 0.2, 0)],
      ['squashed', () => child.scale.set(2, 0.3, 1.5)],
    ];
    for (const [label, pose] of poses) {
      pose();
      scene.updateMatrixWorld(true);
      const box = drawnWorldBox(mesh, new THREE.Box3())!;
      expect(holdsAll(box, skinnedPoints(mesh)), label).toBe(true);
    }
  });

  it('writes nothing into three’s own bounds', () => {
    const { scene, mesh, child } = skinnedBar();
    child.rotation.z = 1;
    scene.updateMatrixWorld(true);
    drawnBox(mesh, new THREE.Box3());
    expect(mesh.boundingBox).toBeNull();
    expect(mesh.boundingSphere).toBeNull();
  });

  it('weights that do not sum to one, and morph targets, are measured exactly instead', () => {
    for (const opts of [{ weightScale: 0.5 }, { morph: true }]) {
      const { scene, mesh, child } = skinnedBar(opts);
      child.rotation.z = 1.2;
      scene.updateMatrixWorld(true);
      const box = drawnBox(mesh, new THREE.Box3())!;
      const exact = new THREE.Box3();
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        exact.expandByPoint(mesh.getVertexPosition(i, new THREE.Vector3()));
      }
      expect(box.equals(exact), JSON.stringify(opts)).toBe(true);
      expect(mesh.boundingBox, 'three’s slot is put back').toBeNull();
    }
  });
});
