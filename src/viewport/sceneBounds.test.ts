// sceneBounds — world-space content bounds for "frame all" (#186), excluding
// editor chrome with the render hide-pass predicate.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeSceneBounds } from './sceneBounds';

function boxMesh(size: number, at: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
  m.position.set(at[0], at[1], at[2]);
  return m;
}

describe('computeSceneBounds', () => {
  it('returns null for an empty scene', () => {
    expect(computeSceneBounds(new THREE.Scene())).toBeNull();
  });

  it('centers on a single mesh and radius covers its half-diagonal', () => {
    const scene = new THREE.Scene();
    scene.add(boxMesh(2, [0, 0, 0]));
    const b = computeSceneBounds(scene)!;
    expect(b).not.toBeNull();
    expect(b.center).toEqual([0, 0, 0]);
    // A 2-unit cube has half-extent 1 per axis → sphere radius = sqrt(3).
    expect(b.radius).toBeCloseTo(Math.sqrt(3), 4);
  });

  it('spans two separated meshes (center between them, radius reaches both)', () => {
    const scene = new THREE.Scene();
    scene.add(boxMesh(2, [-10, 0, 0]));
    scene.add(boxMesh(2, [10, 0, 0]));
    const b = computeSceneBounds(scene)!;
    expect(b.center[0]).toBeCloseTo(0, 4);
    // box spans x ∈ [-11, 11] → radius ≥ 11.
    expect(b.radius).toBeGreaterThanOrEqual(11);
  });

  it('EXCLUDES editor chrome (V37 flag) and prunes its subtree', () => {
    const scene = new THREE.Scene();
    scene.add(boxMesh(2, [0, 0, 0]));
    // A huge chrome group far away — must NOT inflate the bounds.
    const chrome = new THREE.Group();
    chrome.userData.editorChrome = true;
    chrome.add(boxMesh(100, [1000, 0, 0]));
    scene.add(chrome);
    const b = computeSceneBounds(scene)!;
    expect(b.center).toEqual([0, 0, 0]);
    expect(b.radius).toBeCloseTo(Math.sqrt(3), 4);
  });

  it('respects world transforms (a parent group offsets its child)', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.position.set(5, 0, 0);
    group.add(boxMesh(2, [0, 0, 0]));
    scene.add(group);
    const b = computeSceneBounds(scene)!;
    expect(b.center[0]).toBeCloseTo(5, 4);
  });

  it('returns radius 0 for a degenerate zero-extent geometry but keeps center', () => {
    const scene = new THREE.Scene();
    const m = new THREE.Mesh(new THREE.BufferGeometry());
    m.geometry.setAttribute('position', new THREE.Float32BufferAttribute([3, 4, 5], 3));
    m.geometry.computeBoundingBox();
    scene.add(m);
    const b = computeSceneBounds(scene);
    expect(b).not.toBeNull();
    expect(b!.center).toEqual([3, 4, 5]);
    expect(b!.radius).toBe(0);
  });
});
