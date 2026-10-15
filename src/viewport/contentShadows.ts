// contentShadows — who casts, who receives, and how big a sun's shadow is (#1644).
//
// ── WHY THE WORK RUNS INSIDE THE SHADOW PASS, NOT IN useFrame ─────────────────────────
//
// A still or video render calls `gl.render` directly — it does not step R3F's frame loop —
// and it swaps in its OWN visibility for that one call (`withEditorChromeHidden`,
// `withRenderVisibility`, #1503). A shadow box fitted in useFrame would be fitted to what the
// VIEWPORT shows, and a render that includes a body the viewport hides would cut its shadow
// off at the box edge. So the fit hooks the one call three.js makes per light per render,
// `shadow.updateMatrices` (three r169 `WebGLShadowMap.js:175`), which runs after the scene is
// projected (`WebGLRenderer.js:1191`) and before any caster is drawn (`WebGLShadowMap.js:339`
// reads `castShadow`) and before the main pass compiles a material against `receiveShadow`
// (`WebGLRenderer.js:1263`). Whatever is visible for that render is exactly what is measured.
//
// ── WHAT IS CONTENT ───────────────────────────────────────────────────────────────────
//
// Everything that is not editor chrome (`isEditorChrome`, V37): chrome must never darken a
// render, so a chrome subtree is pruned and its meshes keep three.js's default of neither
// casting nor receiving. Blender's default is that every object casts and receives; that is
// the default here, with no per-object switch yet.
//
// REF: three r169 src/renderers/WebGLRenderer.js:1191/1216/1263,
//      src/renderers/webgl/WebGLShadowMap.js:74-75/110/175/339, src/lights/LightShadow.js:58;
//      src/app/editorChrome.ts; src/viewport/sceneBounds.ts (the same walk shape for framing).

import * as THREE from 'three';
import { isEditorChrome } from '../app/editorChrome';

/** Shadow-map resolution per light kind. A sun covers the whole scene, so it gets the most. */
export const SHADOW_MAP_SIZE = { directional: 4096, spot: 2048, point: 1024 } as const;

const tmpBox = new THREE.Box3();

/**
 * Flag every content mesh under `root` to cast and receive, and return the world box of the
 * VISIBLE ones (null when nothing visible). Chrome subtrees are pruned entirely; an invisible
 * subtree is still flagged (it may be shown next render) but does not count toward the box,
 * the way three.js itself skips an invisible subtree when drawing.
 */
export function markContentShadows(root: THREE.Object3D): THREE.Box3 | null {
  const box = new THREE.Box3();
  let any = false;
  const walk = (o: THREE.Object3D, shown: boolean): void => {
    if (isEditorChrome(o)) return;
    const visible = shown && o.visible;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (visible && mesh.geometry) {
        const geom = mesh.geometry;
        if (!geom.boundingBox) geom.computeBoundingBox();
        if (geom.boundingBox) {
          tmpBox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
          if (!tmpBox.isEmpty()) {
            box.union(tmpBox);
            any = true;
          }
        }
      }
    }
    for (const child of o.children) walk(child, visible);
  };
  walk(root, true);
  return any && !box.isEmpty() ? box : null;
}

const corner = new THREE.Vector3();

/**
 * Size a directional light's orthographic shadow camera to enclose `box`, in the camera's
 * own (light) space. Call AFTER `LightShadow.updateMatrices` has placed and aimed the camera.
 * Near may be negative: the light's position is only an aim origin, and a sun placed inside
 * the scene still has to shadow what lies behind it.
 */
export function fitDirectionalShadow(shadow: THREE.LightShadow, box: THREE.Box3): void {
  const cam = shadow.camera as THREE.OrthographicCamera;
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    corner
      .set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      )
      .applyMatrix4(cam.matrixWorldInverse);
    lo.min(corner);
    hi.max(corner);
  }
  const pad = Math.max(hi.x - lo.x, hi.y - lo.y) * 0.02 + 0.01;
  cam.left = lo.x - pad;
  cam.right = hi.x + pad;
  cam.bottom = lo.y - pad;
  cam.top = hi.y + pad;
  // The camera looks down -Z: the nearest content has the LARGEST z.
  cam.near = -hi.z - pad;
  cam.far = -lo.z + pad;
  cam.updateProjectionMatrix();
  // Offset along the surface normal by about one shadow texel: enough to stop acne on large,
  // flat scanned triangles without visibly detaching a foot from the ground.
  const texel = Math.max(cam.right - cam.left, cam.top - cam.bottom) / shadow.mapSize.x;
  shadow.normalBias = texel * 1.5;
}

const rootOf = (o: THREE.Object3D): THREE.Object3D => {
  let r = o;
  while (r.parent) r = r.parent;
  return r;
};

const installed = new WeakSet<THREE.LightShadow>();

/**
 * Make `light` cast, and hook its shadow so every render marks content and (for a sun) fits
 * the shadow box first. Idempotent per shadow object.
 */
export function installContentShadow(
  light: THREE.DirectionalLight | THREE.SpotLight | THREE.PointLight,
): void {
  light.castShadow = true;
  const shadow = light.shadow;
  if (installed.has(shadow)) return;
  installed.add(shadow);
  const kind = (light as THREE.DirectionalLight).isDirectionalLight
    ? 'directional'
    : (light as THREE.SpotLight).isSpotLight
      ? 'spot'
      : 'point';
  shadow.mapSize.set(SHADOW_MAP_SIZE[kind], SHADOW_MAP_SIZE[kind]);
  if (kind !== 'directional') shadow.normalBias = 0.02;
  const base = shadow.updateMatrices.bind(shadow) as (
    l: THREE.Light,
    viewportIndex?: number,
  ) => void;
  shadow.updateMatrices = ((l: THREE.Light, viewportIndex = 0) => {
    // A point light calls this once per cube face; one walk per render is enough.
    const box = viewportIndex === 0 ? markContentShadows(rootOf(l)) : null;
    base(l, viewportIndex);
    if (kind === 'directional' && box) {
      fitDirectionalShadow(shadow, box);
      base(l, viewportIndex); // recompute the shadow matrix and frustum from the fitted box
    }
  }) as typeof shadow.updateMatrices;
}
