// UX #8 — readGltfMaterials extracts a read-only per-slot summary from a glTF
// clone (the inspector's only window onto embedded materials).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readGltfMaterials } from './readGltfMaterials';

function meshWith(mat: THREE.Material, name: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  m.name = name;
  return m;
}

describe('readGltfMaterials', () => {
  it('summarizes one slot per mesh, in traversal order, with childId from the nearest stamp', () => {
    const root = new THREE.Group();

    // A stamped node group with one mesh (the "body").
    const bodyNode = new THREE.Group();
    bodyNode.userData.basherGltfChildId = 'cid-body';
    const red = new THREE.MeshStandardMaterial({ color: '#c0392b', metalness: 0, roughness: 0.5 });
    red.name = 'RedMat';
    bodyNode.add(meshWith(red, 'Body'));

    // A stamped node group with a textured mesh (the "glass").
    const glassNode = new THREE.Group();
    glassNode.userData.basherGltfChildId = 'cid-glass';
    const blue = new THREE.MeshStandardMaterial({ color: '#2c3e9b', metalness: 1, roughness: 0.4 });
    blue.name = 'BlueMat';
    blue.roughnessMap = new THREE.Texture();
    blue.metalnessMap = new THREE.Texture();
    glassNode.add(meshWith(blue, 'Glass'));

    root.add(bodyNode, glassNode);
    const slots = readGltfMaterials(root);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      slot: 0,
      childId: 'cid-body',
      materialName: 'RedMat',
      color: '#c0392b',
      metalness: 0,
      roughness: 0.5,
      maps: [],
    });
    expect(slots[1]).toMatchObject({
      slot: 1,
      childId: 'cid-glass',
      materialName: 'BlueMat',
      color: '#2c3e9b',
      metalness: 1,
      roughness: 0.4,
    });
    expect(slots[1].maps).toEqual(['roughness', 'metalness']);
  });

  it('reports null fields for an unlit material (no metalness/roughness/emissive)', () => {
    const root = new THREE.Group();
    const basic = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    root.add(meshWith(basic, 'Unlit'));
    const [slot] = readGltfMaterials(root);
    expect(slot.color).toBe('#ffffff');
    expect(slot.metalness).toBeNull();
    expect(slot.roughness).toBeNull();
    expect(slot.emissive).toBeNull();
    expect(slot.childId).toBeNull(); // no stamp
  });

  it('returns an empty array for a clone with no meshes', () => {
    expect(readGltfMaterials(new THREE.Group())).toEqual([]);
  });
});
