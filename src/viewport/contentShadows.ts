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

// ── #1682 — SHADOW MAPS REDRAW ONLY WHEN WHAT THEY DRAW CHANGED ───────────────────────
//
// three redraws every shadow map on every render by default (`shadowMap.autoUpdate`), and the
// canvas renders every frame, so a still scene paid for a 4096² sun map and six 1024² point
// faces per frame — 2.3 → 16.2 ms an idle frame on the software renderer CI uses. A shadow map
// depends only on the casters and the lights, never on the view, so orbiting needs no redraw.
// Blender's EEVEE does the same: it re-renders only the shadow pages whose casters changed.
//
// So `autoUpdate` is off, and the scene's `onBeforeRender` — which three calls after it has
// updated every world matrix and before the shadow pass (three r169 WebGLRenderer.js:1145,
// :1161, :1216) — compares what the shadow pass would draw with what it drew last time, and asks
// for one redraw when they differ (`needsUpdate`, cleared by three after the pass,
// WebGLShadowMap.js:75/:197). A control pass (depth, normal) draws with one override material
// and reads no shadow, so it never asks; the next beauty render still sees the change.
//
// REF: three r169 src/renderers/WebGLRenderer.js:1145/1161/1216,
//      src/renderers/webgl/WebGLShadowMap.js:66-75/110/197.

/**
 * Every number the shadow pass's output depends on, in scene order: each non-chrome object's id,
 * whether it is shown, and (shown) its world matrix; for a mesh, its geometry and attribute
 * versions, draw range, materials and their versions, cast flag, instance matrices and morph
 * weights; for a light, whether it casts and its shadow map size. Bones are objects, so a pose
 * is in it; a CPU-deformed mesh bumps its position attribute's version. Chrome is pruned whole:
 * it never casts.
 */
export function shadowInputs(root: THREE.Object3D): number[] {
  const out: number[] = [];
  const walk = (o: THREE.Object3D, shown: boolean): void => {
    if (isEditorChrome(o)) return;
    const visible = shown && o.visible;
    out.push(o.id, visible ? 1 : 0);
    if (!visible) return;
    // Only the matrices a shadow pass reads: what it draws, the bones that skin it, and the
    // lights. A group's or a camera's own matrix reaches the pass only through its drawn
    // children, whose world matrices are recorded — the editor's view camera lives in the scene,
    // and recording it redrew every map on every orbit frame (measured, #1682).
    const drawn =
      (o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints;
    if (drawn || (o as THREE.Bone).isBone || (o as THREE.Light).isLight) {
      for (const e of o.matrixWorld.elements) out.push(e);
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const g = mesh.geometry;
      out.push(g.id, g.drawRange.start, g.drawRange.count, g.index?.version ?? -1);
      for (const name in g.attributes) {
        const a = g.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        out.push(
          (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
            ? (a as THREE.InterleavedBufferAttribute).data.version
            : (a as THREE.BufferAttribute).version,
        );
      }
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        out.push(m.id, m.version);
      }
      out.push(mesh.castShadow ? 1 : 0);
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh) out.push(inst.count, inst.instanceMatrix.version);
      if (mesh.morphTargetInfluences) out.push(...mesh.morphTargetInfluences);
    }
    const light = o as THREE.DirectionalLight;
    if (light.isLight && light.shadow) {
      out.push(light.castShadow ? 1 : 0, light.shadow.mapSize.x, light.shadow.mapSize.y);
      // A sun or spot aims at its target (three r169 src/lights/LightShadow.js:66 reads
      // `light.target.matrixWorld`), which need not sit in the scene.
      if (light.target) for (const e of light.target.matrixWorld.elements) out.push(e);
    }
    for (const child of o.children) walk(child, visible);
  };
  walk(root, true);
  return out;
}

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Turn `gl`'s shadow maps from every-render to on-change for `scene`. Returns the undo.
 * The first render after installing always draws them.
 */
export function installShadowInvalidation(
  gl: Pick<THREE.WebGLRenderer, 'shadowMap'>,
  scene: THREE.Scene,
): () => void {
  const prevAutoUpdate = gl.shadowMap.autoUpdate;
  const prevHook = scene.onBeforeRender;
  gl.shadowMap.autoUpdate = false;
  gl.shadowMap.needsUpdate = true;
  let last: number[] | null = null;
  scene.onBeforeRender = function (this: THREE.Scene, ...args) {
    prevHook.apply(this, args);
    if (scene.overrideMaterial) return;
    const now = shadowInputs(scene);
    if (last === null || !sameNumbers(now, last)) {
      gl.shadowMap.needsUpdate = true;
      last = now;
    }
  } as typeof scene.onBeforeRender;
  return () => {
    scene.onBeforeRender = prevHook;
    gl.shadowMap.autoUpdate = prevAutoUpdate;
  };
}
