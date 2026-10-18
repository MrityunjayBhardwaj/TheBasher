import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  fitDirectionalShadow,
  installContentShadow,
  installShadowInvalidation,
  markContentShadows,
} from './contentShadows';

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

describe('#1682 — shadow maps redraw only when what they draw changed', () => {
  /** One render as three runs it: world matrices, then the scene hook; a pass clears the flag. */
  function rig() {
    const gl = { shadowMap: { autoUpdate: true, needsUpdate: false } } as unknown as Pick<
      THREE.WebGLRenderer,
      'shadowMap'
    >;
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const body = box(1, [0, 0, 0]);
    const helper = box(1, [0, 0, 0]);
    helper.userData.editorChrome = true;
    scene.add(sun, body, helper);
    const camera = new THREE.PerspectiveCamera();
    const undo = installShadowInvalidation(gl, scene);
    /** Renders once; true when that render redrew the shadow maps. */
    const render = (): boolean => {
      scene.updateMatrixWorld(true);
      scene.onBeforeRender(
        null as unknown as THREE.WebGLRenderer,
        scene,
        camera,
        null as unknown as THREE.BufferGeometry,
        null as unknown as THREE.Material,
        null,
      );
      const redrew = gl.shadowMap.needsUpdate;
      gl.shadowMap.needsUpdate = false; // three clears it after the pass (WebGLShadowMap.js:197)
      return redrew;
    };
    return { gl, scene, sun, body, helper, camera, undo, render };
  }

  it('turns the every-frame redraw off and draws once at the start', () => {
    const { gl, render } = rig();
    expect(gl.shadowMap.autoUpdate).toBe(false);
    expect(render()).toBe(true);
    expect(render()).toBe(false);
    expect(render()).toBe(false);
  });

  it('orbiting the view needs no redraw; moving a body does', () => {
    const { body, camera, render } = rig();
    render();
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    expect(render()).toBe(false);
    body.position.x = 2;
    expect(render()).toBe(true);
    expect(render()).toBe(false);
  });

  it('a bone, a hide, a deformed vertex and a moved light each ask for one redraw', () => {
    const { scene, body, sun, render } = rig();
    const bone = new THREE.Bone();
    scene.add(bone);
    render();
    bone.rotation.z = 0.3;
    expect(render()).toBe(true);
    body.visible = false;
    expect(render()).toBe(true);
    body.visible = true;
    render();
    (body.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    expect(render()).toBe(true);
    sun.position.set(3, 10, 1);
    expect(render()).toBe(true);
    expect(render()).toBe(false);
  });

  // Measured in the app: the editor's view camera is a child of the scene, so counting every
  // object's matrix redrew the shadows on every orbit frame (61 redraws in ~30 frames).
  it('a camera in the scene casts nothing: moving it asks for nothing, aiming a sun does', () => {
    const { scene, sun, render } = rig();
    const view = new THREE.PerspectiveCamera();
    scene.add(view, sun.target);
    render();
    view.position.set(4, 2, 7);
    view.lookAt(0, 0, 0);
    expect(render()).toBe(false);
    sun.target.position.set(1, 0, 0);
    expect(render()).toBe(true);
  });

  it('a group moving its drawn child asks for a redraw through the child', () => {
    const { scene, body, render } = rig();
    const group = new THREE.Group();
    scene.add(group);
    group.add(body);
    render();
    group.position.y = 3;
    expect(render()).toBe(true);
  });

  it('editor chrome never casts, so moving it asks for nothing', () => {
    const { helper, render } = rig();
    render();
    helper.position.set(9, 9, 9);
    expect(render()).toBe(false);
  });

  it('a depth or normal pass reads no shadow: it never redraws, and the next beauty render still does', () => {
    const { scene, body, render } = rig();
    render();
    body.position.x = 4;
    scene.overrideMaterial = new THREE.MeshNormalMaterial();
    expect(render()).toBe(false);
    scene.overrideMaterial = null;
    expect(render()).toBe(true);
  });

  it('undoing it restores every-frame redraws and the scene hook', () => {
    const { gl, scene, undo } = rig();
    undo();
    expect(gl.shadowMap.autoUpdate).toBe(true);
    expect(scene.onBeforeRender).toBe(THREE.Object3D.prototype.onBeforeRender);
  });
});
