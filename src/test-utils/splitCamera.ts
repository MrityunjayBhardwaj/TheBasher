// makeSplitCamera — the canonical object↔data split-camera fixture, and the SINGLE source
// of truth for the split shape every #387 slice asserts against.
//
// #387 Stage C (C4): a camera is an `Object` (owning the transform) wired via its `data`
// socket to a `CameraData` (owning the LENS — projection/fov/orthoScale/clip planes/DoF, plus the
// aim, which is the Object rotation or a Track-To since #487). This
// mirrors exactly what the Add ▸ Camera builder (addPrimitives.ts), the default project, the
// bundled examples, `cameraFromView`, the agent's `cameraSnapshot` and the v6→v7 load
// migration all produce — so one helper keeps the fixtures on ONE shape and none of those
// roads derives it independently and drifts. Mirrors makeSplitLight / makeSplitCurve exactly.
//
// WHICH HALF A FIXTURE MUST TARGET afterwards:
//   transform params — position / rotation / scale                  → the OBJECT id
//   lens params      — fov / near / far / dof* / lookAt / roll / …   → the DATA id
// A `setParam` aimed at the wrong half is surfaced-reportable but still a no-op (#423), so a
// fixture that only checks "no throw" would pass while measuring nothing. Assert the value.
//
// The migration byte-identity fixture (src/core/project/migrations.test.ts) is the ONE place
// that MUST still hand-build a FUSED camera — it is what proves the migration. It asserts its
// OUTPUT against the canonical shape this helper defines.
//
// REF: src/nodes/CameraData.ts; src/app/addPrimitives.ts; src/app/activeCamera.ts (the pose
//      road that recombines the pair); src/test-utils/splitLight.ts (the template).

import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { attachOp } from '../core/dag/worldChildren';
import { dataIdFor, splitOps } from './splitKinds';
import { cameraRotationLookingAt } from '../app/cameraOrientation';

type Vec3 = [number, number, number];
const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');

export interface SplitCameraOpts {
  /** Id for the Object (the pose half — the scene child / the node you select). */
  objectId: string;
  /** Id for the CameraData (the lens half). Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /**
   * Vertical FOV in degrees. The schema REQUIRES it with no default — deliberately, since 45
   * is the value a FAILED pose read returns (see CameraData.ts) — so this helper must choose
   * one. 45 is chosen anyway, because it is what the fused `PerspectiveCamera` fixtures this
   * helper replaces overwhelmingly authored; a fixture that needs the failure value to be
   * distinguishable from a real read must pass something else.
   */
  fov?: number;
  /** Any further lens params to seed on the CameraData (projection/orthoScale/near/far/
   *  sensorSize/dof*; `lookAt`/`roll` here only TURN the camera). Omitted fields take their zod defaults. */
  lens?: Record<string, unknown>;
  /**
   * Optional edge to wire the Object's `out` into, e.g. `{ node: 'scene', socket: 'camera' }`.
   * Omit for a standalone split camera.
   */
  connectTo?: { node: string; socket: string };
}

export interface SplitCamera {
  state: DagState;
  objectId: string;
  dataId: string;
}

/**
 * Inject an Object → CameraData split camera into `state` and return the new state plus the
 * two ids. Requires the real node registry to be seeded (`registerAllNodes()`), since
 * it builds genuine `CameraData`/`Object` nodes and a `data` edge.
 * Wiring: data.out → object.data ; object.out → connectTo.
 */
export function makeSplitCamera(state: DagState, opts: SplitCameraOpts): SplitCamera {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? dataIdFor(objectId);

  // Defaulting stays HERE rather than in the shared descriptor, which owns only the op list;
  // see splitLight.ts for why the unit and e2e builders are deliberately not unified.
  // #1764 — the lens holds no aim. A fixture's `lens.lookAt` / `lens.roll` are read here as the
  // point the camera is turned to look at and its bank, and never written to the lens; a fixture
  // that names a look-at is also FOCUSED there (unless it sets `focusDistance`), so its aim
  // reticle sits on that point as it did when the lens held it.
  const {
    lookAt: lensLookAt,
    roll: _lensRoll,
    ...lensRest
  } = (opts.lens ?? {}) as Record<string, unknown>;
  void _lensRoll;
  const dataParams: Record<string, unknown> = { fov: opts.fov ?? 45, ...lensRest };
  if (isVec3(lensLookAt) && dataParams.focusDistance === undefined) {
    const at = opts.position ?? [0, 0, 0];
    const d = Math.hypot(lensLookAt[0] - at[0], lensLookAt[1] - at[1], lensLookAt[2] - at[2]);
    if (d > 0) dataParams.focusDistance = d;
  }

  const objParams: Record<string, unknown> = {};
  if (opts.position) objParams.position = opts.position;
  if (opts.rotation) objParams.rotation = opts.rotation;
  else {
    // #1760 — as every camera creator does now: turned by its own rotation to the lens look-at,
    // banked by the lens roll (V665). The look-at no longer turns a camera; a fixture that gives
    // a rotation gets exactly that rotation.
    const lens = opts.lens ?? {};
    const lookAt = isVec3(lens.lookAt) ? lens.lookAt : ([0, 0, 0] as Vec3);
    const roll = typeof lens.roll === 'number' ? lens.roll : 0;
    objParams.rotation = cameraRotationLookingAt(opts.position ?? [0, 0, 0], lookAt, roll);
  }
  if (opts.scale) objParams.scale = opts.scale;

  let s = state;
  for (const op of splitOps(
    'camera',
    { objectId, dataId },
    { data: dataParams, object: objParams },
  )) {
    s = applyOp(s, op as Op).next;
  }
  if (opts.connectTo) {
    // #1824 — under a Group or an Object it names its parent through its parent input.
    s = applyOp(s, attachOp(s, objectId, opts.connectTo.node, opts.connectTo.socket)).next;
  }

  return { state: s, objectId, dataId };
}

/** The data-node id `makeSplitCamera` will use for a given Object id. */
export function splitCameraDataId(objectId: string): string {
  return dataIdFor(objectId);
}
