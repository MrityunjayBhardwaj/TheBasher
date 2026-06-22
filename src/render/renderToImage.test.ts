// Unit tests for the PURE render helpers (#168). The full offscreen render
// (renderSceneToPngBlob) needs a real WebGL context — covered by the
// falsifiable real-canvas e2e. Here we pin the math that's testable headless.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { CameraPose } from '../app/activeCamera';
import { buildRenderCamera, flipRowsY, isUniformColor } from './renderToImage';

const PERSP: CameraPose = {
  kind: 'PerspectiveCamera',
  position: [3, 2, 3],
  lookAt: [0, 0, 0],
  fov: 45,
  near: 0.1,
  far: 1000,
  roll: 0,
};

describe('buildRenderCamera', () => {
  it('builds a perspective camera at the render aspect, not the viewport aspect', () => {
    const cam = buildRenderCamera(PERSP, 1920, 1080) as THREE.PerspectiveCamera;
    expect(cam.isPerspectiveCamera).toBe(true);
    expect(cam.fov).toBeCloseTo(45);
    expect(cam.aspect).toBeCloseTo(1920 / 1080);
    expect(cam.near).toBeCloseTo(0.1);
    expect(cam.far).toBeCloseTo(1000);
  });

  it('places the camera at the pose and aims it at the lookAt', () => {
    const cam = buildRenderCamera(PERSP, 800, 800);
    expect(cam.position.toArray()).toEqual([3, 2, 3]);
    // After lookAt([0,0,0]) the forward (-Z) axis points toward the origin.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const toTarget = new THREE.Vector3(0, 0, 0).sub(cam.position).normalize();
    expect(fwd.dot(toTarget)).toBeCloseTo(1, 5);
  });

  it('banks the render camera by roll while keeping the aim (#229)', () => {
    // Looking down -Z from +Z, a +90° roll rotates the camera up-vector to +X.
    const rolled = buildRenderCamera(
      { ...PERSP, position: [0, 0, 5], lookAt: [0, 0, 0], roll: 90 },
      800,
      800,
    );
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rolled.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rolled.quaternion);
    expect(fwd.z).toBeCloseTo(-1); // aim unchanged by roll
    expect(up.x).toBeCloseTo(1); // up banked 90° about the view axis
    expect(up.y).toBeCloseTo(0);
  });

  it('aspect changes with the requested resolution (square vs wide)', () => {
    const wide = buildRenderCamera(PERSP, 1920, 1080) as THREE.PerspectiveCamera;
    const square = buildRenderCamera(PERSP, 1000, 1000) as THREE.PerspectiveCamera;
    expect(wide.aspect).toBeGreaterThan(square.aspect);
    expect(square.aspect).toBeCloseTo(1);
  });

  it('builds an orthographic camera for an ortho pose', () => {
    const cam = buildRenderCamera({ ...PERSP, kind: 'OrthographicCamera' }, 1600, 900);
    expect((cam as THREE.OrthographicCamera).isOrthographicCamera).toBe(true);
  });
});

describe('flipRowsY', () => {
  it('reverses row order (GL bottom-up → canvas top-down)', () => {
    // 1×2 image: bottom row red, top row green (GL order = bottom first).
    const w = 1;
    const h = 2;
    const buf = new Uint8Array([255, 0, 0, 255, /* row0 */ 0, 255, 0, 255 /* row1 */]);
    const out = flipRowsY(buf, w, h);
    // Top row (index 0) should now be the GL last row (green).
    expect(Array.from(out.slice(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(out.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it('preserves a single-row image unchanged', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(flipRowsY(buf, 2, 1))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('isUniformColor (blank-render guard)', () => {
  it('flags an all-black buffer as uniform (the H68 blank trap)', () => {
    expect(isUniformColor(new Uint8Array(16))).toBe(true);
  });

  it('flags an all-one-color buffer as uniform', () => {
    const buf = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) {
      buf[i] = 10;
      buf[i + 1] = 10;
      buf[i + 2] = 10;
      buf[i + 3] = 255;
    }
    expect(isUniformColor(buf)).toBe(true);
  });

  it('returns false when any pixel differs (a real render)', () => {
    const buf = new Uint8Array(16);
    buf[8] = 200; // one pixel's red channel differs
    expect(isUniformColor(buf)).toBe(false);
  });
});
