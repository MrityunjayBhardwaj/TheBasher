// Unit tests for the PURE render helpers (#168). The full offscreen render
// (renderSceneToPngBlob) needs a real WebGL context — covered by the
// falsifiable real-canvas e2e. Here we pin the math that's testable headless.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { CameraPose } from '../app/activeCamera';
import { buildRenderCamera, flipRowsY, hideEditorChrome, isUniformColor } from './renderToImage';

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

// ── V37 on the RENDER road (#557) ────────────────────────────────────────────
//
// Why these live here and not only in the browser: the render's chrome exclusion
// is a rule with TWO clauses, and until #557 the whole `src/render` tier had no
// case that reached either. The e2e cases that looked like they covered it were
// measured and did not — see the falsification notes in p168.
//
// The discipline these encode: ONE CLAUSE PER CASE. A subject that carries both
// the flag AND the gizmo type would pass whenever either clause survived, which
// is exactly the coverage-shaped failure #557 was filed for. So the flag subject
// is a plain Mesh and the gizmo subject is type-only, and neither is both.
describe('hideEditorChrome — a render shows DAG content only (V37)', () => {
  /** A flagged chrome object: the grid, helpers, the fill rig, the ghost overlay. */
  const flagged = (name = 'grid') => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    o.name = name;
    o.userData.editorChrome = true;
    return o;
  };
  /** drei injects the gizmo raw, so it cannot carry our flag — caught by type. */
  const gizmo = (type = 'TransformControlsGizmo') => {
    const o = new THREE.Object3D();
    o.name = 'gizmo';
    o.type = type;
    return o;
  };
  const content = (name = 'cube') => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    o.name = name;
    return o;
  };

  it('CLAUSE 1 — hides an object carrying userData.editorChrome', () => {
    const scene = new THREE.Scene();
    const chrome = flagged();
    scene.add(chrome);
    const hidden = hideEditorChrome(scene);
    // Drop the flag clause from isEditorChrome → the grid renders → this fails.
    expect(chrome.visible).toBe(false);
    expect(hidden).toContain(chrome);
  });

  it('CLAUSE 2 — hides drei TransformControls* by three.js type, with no flag', () => {
    const scene = new THREE.Scene();
    const g = gizmo();
    scene.add(g);
    expect(g.userData.editorChrome).toBeUndefined(); // the clause exists BECAUSE it can't be flagged
    const hidden = hideEditorChrome(scene);
    // Drop the type clause → the gizmo renders into every image → this fails.
    expect(g.visible).toBe(false);
    expect(hidden).toContain(g);
  });

  it('CLAUSE 2 covers the whole TransformControls* family, not one exact type', () => {
    const scene = new THREE.Scene();
    const parts = ['TransformControls', 'TransformControlsGizmo', 'TransformControlsPlane'].map(
      (t) => gizmo(t),
    );
    parts.forEach((p) => scene.add(p));
    hideEditorChrome(scene);
    // Measured live: selecting an object mounts BOTH the Gizmo and the Plane.
    // An equality check on one type name would leak the others.
    expect(parts.map((p) => p.visible)).toEqual([false, false, false]);
  });

  it('leaves DAG content alone — the denylist never hides a directors object', () => {
    const scene = new THREE.Scene();
    const cube = content();
    scene.add(cube, flagged());
    const hidden = hideEditorChrome(scene);
    // The catastrophic direction (V37): a missed CONTENT mark makes a user's
    // object vanish from their render. Hiding content is worse than leaking chrome.
    expect(cube.visible).toBe(true);
    expect(hidden).not.toContain(cube);
  });

  it('returns only what it flipped, so an already-hidden object stays hidden on restore', () => {
    const scene = new THREE.Scene();
    const chrome = flagged();
    chrome.visible = false; // the director (or a component) already hid it
    scene.add(chrome);
    const hidden = hideEditorChrome(scene);
    // Restoring blindly (`visible = true` for every chrome object) would switch on
    // something nobody asked to see — the reason the pass records what it flips.
    expect(hidden).toEqual([]);
  });

  it('flips the chrome ROOT only and lets three.js inheritance carry it to children', () => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    root.userData.editorChrome = true;
    const leaf = content('helper-line');
    root.add(leaf);
    scene.add(root);
    const hidden = hideEditorChrome(scene);
    // TRAVERSAL is per-consumer by design (#546): the render flips and inherits,
    // the framing read prunes the subtree. Pushing the leaf too would make restore
    // show a child that its parent had independently hidden.
    expect(root.visible).toBe(false);
    expect(hidden).toEqual([root]);
    expect(leaf.visible).toBe(true); // untouched — invisible only via its parent
  });
});
