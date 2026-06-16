// cameraFit — pure "frame all" math (#186). Given a scene's bounding sphere
// (center + radius), produce everything the editor orbit camera needs to fit
// the whole model on screen WITHOUT clipping: an orbit distance, a camera
// position along the canonical viewing direction, and near/far clip planes +
// OrbitControls min/max distance DERIVED FROM the radius (not constants) so a
// 0.01-unit gem and a 10,000-unit terrain both frame correctly.
//
// Why this exists: fixed planes (three's ≈0.1/1000) clip a large model past
// `far` and clip a tiny one at `near` when you zoom in. Tying the planes to the
// framed radius — and bounding the far/near RATIO — kills both at once and
// avoids z-fighting.
//
// Discipline: pure function of numbers. No THREE, no DOM, no store — unit
// testable in isolation (mirrors `orthoZoomForView`). The caller reads the
// scene bounds from the live THREE scene and applies the result.
//
// REF: issue #186; vyapti V8 (file-rooted, UI projection); sibling of
// `orthoZoomForView` (EditorViewCamera.tsx).

/** The canonical 3/4 viewing direction — the seed camera's [3,2,3] offset,
 *  normalized. Framing along this keeps the familiar Basher boot angle while
 *  the DISTANCE scales to the model. */
const DEFAULT_DIR: readonly [number, number, number] = (() => {
  const len = Math.hypot(3, 2, 3);
  return [3 / len, 2 / len, 3 / len];
})();

/** Breathing room around the fitted sphere (1 = sphere exactly tangent to the
 *  frustum). 1.3 leaves a comfortable margin like Blender's "View Selected". */
const DEFAULT_MARGIN = 1.3;

/** Upper bound on far/near so the depth buffer keeps precision (z-fighting
 *  appears past ~10^5 on a 24-bit buffer). near is raised to far/RATIO if the
 *  geometric near would be smaller. */
const MAX_DEPTH_RATIO = 50_000;

export interface CameraFit {
  /** Camera world position. */
  position: [number, number, number];
  /** Orbit pivot / lookAt — the sphere center. */
  lookAt: [number, number, number];
  /** Distance from camera to center (drives ortho zoom + plane math). */
  distance: number;
  near: number;
  far: number;
  /** OrbitControls dolly limits, scaled from the radius so you can zoom into a
   *  tiny model and out of a huge one. */
  minDistance: number;
  maxDistance: number;
}

export interface FitOptions {
  margin?: number;
  /** Override the viewing direction (already-normalized or not — normalized
   *  here). Defaults to the canonical [3,2,3] angle. */
  dir?: readonly [number, number, number];
}

/**
 * Distance at which a sphere of radius `r` is tangent to a frustum with
 * vertical FOV `fovDeg` and the given `aspect` (width/height). Uses the
 * TIGHTER of the vertical and horizontal fits so the sphere fits both
 * dimensions (portrait viewports are horizontal-constrained, landscape
 * vertical-constrained). Pure.
 */
export function fitDistanceForSphere(r: number, fovDeg: number, aspect: number): number {
  const radius = Number.isFinite(r) && r > 0 ? r : 1;
  const fovV =
    Number.isFinite(fovDeg) && fovDeg > 0 ? (fovDeg * Math.PI) / 180 : (45 * Math.PI) / 180;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // Horizontal FOV from vertical FOV + aspect (three's convention).
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * a);
  const dV = radius / Math.sin(fovV / 2);
  const dH = radius / Math.sin(fovH / 2);
  // The LARGER distance fits the tighter dimension (the constraint).
  return Math.max(dV, dH);
}

/**
 * Full fit: position + lookAt + clip planes + orbit limits for a bounding
 * sphere. `aspect` is the viewport width/height. Degenerate inputs (zero /
 * non-finite radius) fall back to a unit sphere so the result is always sane
 * (a camera-less / empty scene still frames at a usable distance). Pure.
 */
export function fitViewToSphere(
  center: readonly [number, number, number],
  radius: number,
  fovDeg: number,
  aspect: number,
  opts?: FitOptions,
): CameraFit {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const margin = opts?.margin && opts.margin > 0 ? opts.margin : DEFAULT_MARGIN;
  const distance = fitDistanceForSphere(r, fovDeg, aspect) * margin;

  const rawDir = opts?.dir ?? DEFAULT_DIR;
  const dirLen = Math.hypot(rawDir[0], rawDir[1], rawDir[2]);
  const dir: readonly [number, number, number] =
    dirLen > 0 ? [rawDir[0] / dirLen, rawDir[1] / dirLen, rawDir[2] / dirLen] : DEFAULT_DIR;

  const position: [number, number, number] = [
    center[0] + dir[0] * distance,
    center[1] + dir[1] * distance,
    center[2] + dir[2] * distance,
  ];

  // far must clear the BACK of the sphere; near hugs the FRONT but is bounded
  // by the depth-ratio so precision survives, and is always > 0.
  const far = distance + r * margin;
  const nearGeometric = distance - r * margin;
  const near = Math.max(nearGeometric, far / MAX_DEPTH_RATIO);

  return {
    position,
    lookAt: [center[0], center[1], center[2]],
    distance,
    near,
    far,
    // Let the user dolly from nearly touching the surface to well outside it.
    minDistance: Math.max(r * 0.01, far / MAX_DEPTH_RATIO),
    maxDistance: (distance + r) * 10,
  };
}
