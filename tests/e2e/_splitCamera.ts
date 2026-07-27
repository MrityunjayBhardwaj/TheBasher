// splitCameraOps — the canonical object↔data split-camera op list for end-to-end specs.
//
// #387 Stage C (C4): a camera is an `Object` (owning the transform) wired via its `data`
// socket to a `CameraData` (owning the LENS — projection/fov/zoom/clip planes/DoF, plus the
// aim params `lookAt` and `roll`, which stay on the data half parity-first). This mirrors
// what Add ▸ Camera (src/app/addPrimitives.ts), `default.ts`'s seed and the v6→v7 load
// migration all produce, so a spec that used to inject a single fused camera node stays on
// one shape. Like _splitLight / _splitCurve it does NOT wire the Object into the scene — the
// caller appends its own `connect object.out → scene.camera` (or `→ group.children`).
//
// WHICH HALF TO TARGET afterwards (the trap this helper exists to make hard to get wrong):
//   transform params — position / rotation / scale                  → the OBJECT id
//   lens params      — fov / near / far / dof* / lookAt / roll / …   → the DATA id
// A `setParam` aimed at the wrong half is SURFACED-REPORTABLE but still a no-op (#423) — the
// value does not change — so a spec that only checks "no throw" would pass while testing
// nothing. Assert the value.
//
// ⚠️ The same split applies to INSPECTOR testids: post-split the lens rows are keyed on the
// CameraData's id (`inspector-camera-fov-<objectId>_data`), not on the id you selected.

import { dataIdFor, splitOps } from '../../src/test-utils/splitKinds';

export interface SplitCameraOpts {
  /** Id for the Object — the pose half, and the node a spec selects / poses / references. */
  objectId: string;
  /** Id for the CameraData — the lens half. Defaults to `${objectId}_data`. */
  dataId?: string;
  /** Pose, on the Object half. */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Vertical FOV in degrees. Required by the schema with no default — see CameraData.ts on
   *  why 45 is deliberately NOT a default there — so this builder must supply one. */
  fov?: number;
  /** Aim point, on the CameraData half (parity-first, #387 D1). */
  lookAt?: [number, number, number];
  /** Any further lens params to seed on the CameraData (near, far, roll, the DoF fields, …). */
  lens?: Record<string, unknown>;
}

/**
 * Build the ops that create one split camera: a `CameraData`, an `Object`, and the `data`
 * edge between them. Returns them in dependency order, ready to splice into a dispatch list.
 */
export function splitCameraOps(opts: SplitCameraOpts): unknown[] {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? dataIdFor(objectId);

  // Defaulting stays HERE rather than in the shared descriptor, which owns only the op list
  // (see _splitLight.ts for the full reasoning). `fov: 50` is the value the two p231 specs
  // this helper first served were authored with; every other lens param below is either the
  // schema's own default or absent, so writing it is byte-identical to omitting it.
  const dataParams: Record<string, unknown> = {
    fov: opts.fov ?? 50,
    lookAt: opts.lookAt ?? [0, 0, 0],
    ...(opts.lens ?? {}),
  };
  const objParams: Record<string, unknown> = {
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  };

  return splitOps('camera', { objectId, dataId }, { data: dataParams, object: objParams });
}

/** The data-node id `splitCameraOps` will use for a given Object id. */
export function splitCameraDataId(objectId: string): string {
  return dataIdFor(objectId);
}
