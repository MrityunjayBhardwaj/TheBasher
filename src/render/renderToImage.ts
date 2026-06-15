// renderToImage — produce a final still PNG of the production scene (#168).
//
// The viewport canvas IS the live beauty pass (SceneFromDAG mounts <PostFx>),
// but a render must be a deterministic product of the PROJECT, not the
// transient editor view: it goes through the production scene camera at an
// explicit resolution (RenderOutput.width/height), excludes editor chrome,
// and applies the same ACES tone-map production sees. So it cannot be a
// `toDataURL()` of the live canvas (wrong size, wrong camera, chrome visible,
// and `preserveDrawingBuffer:false` yields a blank buffer anyway — H68).
//
// Mechanism (grounded in three 0.169 source):
//   1. Build a production camera from the active camera node's pose at the
//      target aspect (reuses #165 `cameraPoseFromNode`).
//   2. Hide every object flagged `userData.editorChrome` (grid, gizmo, light/
//      camera helpers, editor fill lights) — a render shows DAG content only.
//   3. Render the live scene into an offscreen MSAA + sRGB WebGLRenderTarget
//      at width×height. `render()` auto-resolves the multisample buffer to a
//      readable texture (WebGLRenderer.js:1273); ACES is applied via a
//      temporary `renderer.toneMapping` (matches the PostFx ACES curve).
//   4. Read the resolved pixels, flip GL's bottom-up rows to top-down, encode
//      a PNG via a 2D canvas. Renderer state + chrome visibility are always
//      restored (finally), so the live viewport is untouched.
//
// SMAA → MSAA is a deliberate, documented divergence: 4× MSAA is higher
// quality than post-process SMAA for a still, and avoids a second composer.
//
// REF: THESIS.md §11 (viewport renders evaluated DAG), §27 (beauty pass);
// issue #168; hetvabhasa H68 (preserve-drawing-buffer silent-blank).

import * as THREE from 'three';
import {
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import type { CameraPose } from '../app/activeCamera';
import type { DofEffectSettings } from '../app/cameraDof';
import type { PostFxConfig } from '../nodes/types';

export interface RenderToImageOptions {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  pose: CameraPose;
  width: number;
  height: number;
  postFx: PostFxConfig;
  /** Active camera depth of field (UX #12), or null/undefined when off. When
   *  present, the still is rendered through a postprocessing EffectComposer
   *  (DepthOfField + SMAA + ToneMapping) so its bokeh matches the live viewport
   *  exactly (V37 parity); when absent, the fast manual MSAA path is used
   *  unchanged (so non-DoF renders — incl. #168 — are byte-for-byte as before). */
  dof?: DofEffectSettings | null;
}

/** PURE — build the production render camera from a camera-node pose at the
 *  render aspect ratio (independent of the viewport's aspect). */
export function buildRenderCamera(pose: CameraPose, width: number, height: number): THREE.Camera {
  const aspect = width / height;
  let cam: THREE.Camera;
  if (pose.kind === 'OrthographicCamera') {
    // Ortho is rare; derive a nominal frustum half-height from the fov+distance
    // so the framing is sane (cameraPoseFromNode defaults fov=45 for ortho).
    const dist = Math.hypot(
      pose.position[0] - pose.lookAt[0],
      pose.position[1] - pose.lookAt[1],
      pose.position[2] - pose.lookAt[2],
    );
    const halfH = Math.tan((pose.fov * Math.PI) / 360) * dist || 1;
    cam = new THREE.OrthographicCamera(
      -halfH * aspect,
      halfH * aspect,
      halfH,
      -halfH,
      pose.near,
      pose.far,
    );
  } else {
    cam = new THREE.PerspectiveCamera(pose.fov, aspect, pose.near, pose.far);
  }
  cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
  cam.lookAt(new THREE.Vector3(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]));
  cam.updateMatrixWorld(true);
  return cam;
}

/** PURE — flip an RGBA pixel buffer vertically. WebGL's readPixels origin is
 *  bottom-left; canvas ImageData is top-left, so rows must be reversed. */
export function flipRowsY(buf: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const rowBytes = width * 4;
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * rowBytes;
    out.set(buf.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return out;
}

/** PURE — is this RGBA buffer effectively blank (all pixels one colour)? Used
 *  by the falsification e2e to prove the render isn't the H68 empty-buffer. */
export function isUniformColor(buf: Uint8Array | Uint8ClampedArray): boolean {
  if (buf.length < 8) return true;
  const r = buf[0];
  const g = buf[1];
  const b = buf[2];
  for (let i = 4; i < buf.length; i += 4) {
    if (buf[i] !== r || buf[i + 1] !== g || buf[i + 2] !== b) return false;
  }
  return true;
}

/**
 * IMPURE — render the DAG scene offscreen through the production camera and
 * return a 2D canvas holding the (top-down) RGBA pixels. The SHARED render core:
 * the still PNG (#168) and the animation render (#189) both consume this ONE
 * path, so the still and every animation frame have identical production parity
 * (V37 chrome-exclusion / V47 env / V51 DoF). Always restores renderer state +
 * chrome visibility (the GL render happens inside a finally; the canvas is built
 * from the already-captured pixels afterward).
 */
export async function renderSceneToImageCanvas(
  opts: RenderToImageOptions,
): Promise<HTMLCanvasElement> {
  const { gl, scene, pose, postFx } = opts;
  // Clamp the resolution to the GPU's max texture size, preserving aspect — a
  // user can set width/height to anything ≥1 (the zod bound), and an oversized
  // WebGLRenderTarget loses the GL context / OOMs. Scale BOTH dims by one
  // factor so the framing (camera aspect) is unchanged.
  const maxTex = gl.capabilities.maxTextureSize;
  const fit = Math.min(1, maxTex / Math.max(opts.width, opts.height));
  const width = Math.max(1, Math.floor(opts.width * fit));
  const height = Math.max(1, Math.floor(opts.height * fit));
  const camera = buildRenderCamera(pose, width, height);

  // Hide editor chrome — a render shows DAG content only (parity with what
  // production sees). Record only the ones we actually flip, to restore exactly.
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    // Denylist: explicit editor-chrome flag, OR the drei TransformControls
    // gizmo (a helper object injected straight into the scene — it can't carry
    // our userData flag, so catch it by three.js type).
    const isChrome = o.userData?.editorChrome === true || o.type.startsWith('TransformControls');
    if (isChrome && o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  });

  let flipped: Uint8ClampedArray;
  try {
    // DoF on → go through the postprocessing EffectComposer so the bokeh
    // matches the live viewport (V37). DoF off → the fast manual MSAA path,
    // unchanged (non-DoF renders, incl. #168, are byte-for-byte as before).
    const buf = opts.dof
      ? renderViaComposer(gl, scene, camera, width, height, postFx, opts.dof)
      : renderViaManual(gl, scene, camera, width, height, postFx);
    flipped = flipRowsY(buf, width, height);
  } finally {
    for (const o of hidden) o.visible = true;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderToImage: 2D context unavailable for image encode');
  // Build an ArrayBuffer-backed ImageData then copy — sidesteps the TS 5.7
  // typed-array-generics complaint about ArrayBufferLike vs ArrayBuffer.
  const img = new ImageData(width, height);
  img.data.set(flipped);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * IMPURE — render the DAG scene offscreen through the production camera and
 * return a PNG Blob. A thin encode over {@link renderSceneToImageCanvas}, so
 * #168 output is byte-identical to before the canvas extraction.
 */
export async function renderSceneToPngBlob(opts: RenderToImageOptions): Promise<Blob> {
  const canvas = await renderSceneToImageCanvas(opts);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/png',
    );
  });
}

/** Manual MSAA + tone-map render into an offscreen sRGB target; returns the
 *  bottom-up RGBA buffer. Restores renderer state in a finally. */
function renderViaManual(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  postFx: PostFxConfig,
): Uint8Array {
  const target = new THREE.WebGLRenderTarget(width, height, {
    samples: postFx.smaa ? 4 : 0,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const prevTarget = gl.getRenderTarget();
  const prevToneMapping = gl.toneMapping;
  const prevExposure = gl.toneMappingExposure;
  try {
    gl.toneMapping = postFx.tonemap === 'ACES' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    gl.toneMappingExposure = 1;
    gl.setRenderTarget(target);
    gl.clear();
    gl.render(scene, camera); // auto-resolves MSAA → readable texture (WebGLRenderer.js:1273)
    const buf = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, buf);
    return buf;
  } finally {
    gl.setRenderTarget(prevTarget);
    gl.toneMapping = prevToneMapping;
    gl.toneMappingExposure = prevExposure;
    target.dispose();
  }
}

/** DoF render via a postprocessing EffectComposer: RenderPass → EffectPass
 *  (DepthOfField + SMAA + ToneMapping), into the composer's HalfFloat output
 *  buffer (autoRenderToScreen off). The DepthOfFieldEffect is built from the
 *  SAME settings the live <DepthOfField> uses (cameraDof.ts) so the bokeh
 *  matches. Returns the bottom-up RGBA buffer; restores renderer target + tone
 *  mapping (the composer drives tone-mapping via the effect, not gl.toneMapping)
 *  and disposes everything in a finally. */
function renderViaComposer(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  postFx: PostFxConfig,
  dof: DofEffectSettings,
): Uint8Array {
  // 8-bit sRGB buffers (UnsignedByte) so the final outputBuffer reads back
  // cleanly as Uint8 — matches the manual path's 8-bit sRGB target. (HalfFloat
  // intermediates would carry HDR further before ACES, but can't be read back
  // as Uint8; the bokeh — the thing this path exists for — is identical, and a
  // mild highlight-clamp divergence mirrors the documented SMAA→MSAA one.)
  const composer = new EffectComposer(gl, {
    multisampling: postFx.smaa ? 4 : 0,
  });
  composer.autoRenderToScreen = false; // keep the result in composer.outputBuffer
  composer.setSize(width, height);

  const dofEffect = new DepthOfFieldEffect(camera, {
    worldFocusDistance: dof.focusDistance,
    worldFocusRange: dof.focusRange,
    bokehScale: dof.bokehScale,
  });
  const effects = [dofEffect];
  let smaa: SMAAEffect | undefined;
  if (postFx.smaa) {
    smaa = new SMAAEffect();
    effects.push(smaa);
  }
  const tonemap = new ToneMappingEffect({
    mode: postFx.tonemap === 'ACES' ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.LINEAR,
  });
  effects.push(tonemap);

  const renderPass = new RenderPass(scene, camera);
  const effectPass = new EffectPass(camera, ...effects);
  composer.addPass(renderPass);
  composer.addPass(effectPass);

  const prevTarget = gl.getRenderTarget();
  const prevToneMapping = gl.toneMapping;
  try {
    // The composer applies tone-mapping via the ToneMappingEffect, so the
    // renderer itself must stay neutral (else it double-tonemaps).
    gl.toneMapping = THREE.NoToneMapping;
    composer.render();
    // autoRenderToScreen=false leaves the final (tone-mapped, sRGB-encoded)
    // result in composer.outputBuffer; read it straight as 8-bit RGBA.
    const buf = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(composer.outputBuffer, 0, 0, width, height, buf);
    return buf;
  } finally {
    gl.setRenderTarget(prevTarget);
    gl.toneMapping = prevToneMapping;
    composer.dispose();
    dofEffect.dispose();
    smaa?.dispose();
    tonemap.dispose();
    renderPass.dispose();
    effectPass.dispose();
  }
}
