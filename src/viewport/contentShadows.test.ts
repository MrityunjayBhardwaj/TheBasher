import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fitDirectionalShadow, installContentShadow, markContentShadows } from './contentShadows';

const box = (size: number, at: [number, number, number]) => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial(),
  );
  m.position.set(...at);
  return m;
};

describe('#1644 content shadows', () => {
  it('content casts and receives; chrome does neither', () => {
    const scene = new THREE.Scene();
    const body = box(1, [0, 0, 0]);
    const helper = new THREE.Group();
    helper.userData.editorChrome = true;
    const gizmo = box(1, [0, 0, 0]);
    helper.add(gizmo);
    scene.add(body, helper);
    scene.updateMatrixWorld(true);
    markContentShadows(scene);
    expect([body.castShadow, body.receiveShadow]).toEqual([true, true]);
    expect([gizmo.castShadow, gizmo.receiveShadow]).toEqual([false, false]);
  });

  it('measures only what this render shows: a hidden body is flagged but not boxed', () => {
    const scene = new THREE.Scene();
    const shown = box(2, [0, 0, 0]);
    const hidden = box(2, [100, 0, 0]);
    hidden.visible = false;
    const helper = box(2, [-100, 0, 0]);
    helper.userData.editorChrome = true;
    scene.add(shown, hidden, helper);
    scene.updateMatrixWorld(true);
    const b = markContentShadows(scene)!;
    expect(hidden.castShadow).toBe(true);
    expect(b.min.x).toBeCloseTo(-1);
    expect(b.max.x).toBeCloseTo(1);
  });

  it('a sun placed INSIDE the scene still shadows everything: the fitted box encloses every corner', () => {
    const scene = new THREE.Scene();
    const ground = box(1, [0, 0, 0]);
    ground.scale.set(80, 0.1, 100);
    scene.add(ground, box(2, [30, 5, -40]));
    const sun = new THREE.DirectionalLight();
    sun.position.set(12, 15, -7); // inside the content's extent
    scene.add(sun, sun.target);
    scene.updateMatrixWorld(true);
    const b = markContentShadows(scene)!;
    sun.shadow.updateMatrices(sun);
    fitDirectionalShadow(sun.shadow, b);
    sun.shadow.updateMatrices(sun);
    const cam = sun.shadow.camera;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(
        i & 1 ? b.max.x : b.min.x,
        i & 2 ? b.max.y : b.min.y,
        i & 4 ? b.max.z : b.min.z,
      ).project(cam);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1);
    }
    expect(cam.near).toBeLessThan(0);
  });

  it('the hook runs inside the shadow pass: a body added after install is flagged and boxed on the next pass', () => {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight();
    sun.position.set(0, 10, 0);
    scene.add(sun, sun.target);
    installContentShadow(sun);
    expect(sun.castShadow).toBe(true);
    expect(sun.shadow.mapSize.x).toBe(4096);
    const late = box(1, [50, 0, 0]);
    scene.add(late);
    scene.updateMatrixWorld(true);
    sun.shadow.updateMatrices(sun);
    expect(late.castShadow).toBe(true);
    const cam = sun.shadow.camera;
    expect(new THREE.Vector3(50.5, 0, 0).project(cam).x).toBeLessThanOrEqual(1);
  });
});
