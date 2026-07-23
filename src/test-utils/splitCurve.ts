// makeSplitCurve — the canonical object↔data split-curve fixture for unit tests.
//
// #385 Stage C (C2): a curve is an `Object` (owning the transform) wired via its `data` socket
// to a `CurveData` (owning `points`/`closed`/`resolution` — the FIRST non-mesh ObjectData).
// This mirrors exactly what the Add ▸ Curve builder (src/app/addPrimitives.ts) and the
// load-migration produce, so a single helper keeps the fused-curve test fixtures on one shape
// after the fused `Curve` value kind retires. Selection + the point editor land on the Object
// (curvePoints resolves the points through `data`); the CurveData owns the geometry. Mirrors
// makeSplitSphere exactly.
//
// The migration byte-identity fixture (src/core/project/migrations.test.ts) is the ONE place
// that MUST still hand-build a fused `Curve` — it proves the migration. Do NOT route it here.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md; src/app/addPrimitives.ts; src/app/resolveDataParamOwner.ts.

import { applyOp, type DagState } from '../core/dag';
import type { Vec3 } from '../nodes/types';
import { withIds } from './curvePoints';

export interface SplitCurveOpts {
  /** Id for the Object (the pose half — this is the scene child / the node you select). */
  objectId: string;
  /** Id for the CurveData (the points/closed/resolution half). Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Bare control-point coordinates; stable ids (cp0..) are minted via `withIds`. */
  points?: Vec3[];
  closed?: boolean;
  resolution?: number;
  /**
   * Optional edge to wire the Object's `out` into, e.g. `{ node: 'scene', socket: 'children' }`.
   * Omit for a standalone split curve.
   */
  connectTo?: { node: string; socket: string };
}

export interface SplitCurve {
  state: DagState;
  objectId: string;
  dataId: string;
}

/**
 * Inject an Object → CurveData split curve into `state` and return the new state plus the two
 * ids. Requires the real node registry to be seeded (`__reseedAllNodesForTests()`), since it
 * builds genuine `CurveData`/`Object` nodes and a `data` edge.
 */
export function makeSplitCurve(state: DagState, opts: SplitCurveOpts): SplitCurve {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;

  const dataParams: Record<string, unknown> = {};
  if (opts.points !== undefined) dataParams.points = withIds(opts.points);
  if (opts.closed !== undefined) dataParams.closed = opts.closed;
  if (opts.resolution !== undefined) dataParams.resolution = opts.resolution;

  const objParams: Record<string, unknown> = {};
  if (opts.position) objParams.position = opts.position;
  if (opts.rotation) objParams.rotation = opts.rotation;
  if (opts.scale) objParams.scale = opts.scale;

  let s = applyOp(state, {
    type: 'addNode',
    nodeId: dataId,
    nodeType: 'CurveData',
    params: dataParams,
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: objectId,
    nodeType: 'Object',
    params: objParams,
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: dataId, socket: 'out' },
    to: { node: objectId, socket: 'data' },
  }).next;
  if (opts.connectTo) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: objectId, socket: 'out' },
      to: opts.connectTo,
    }).next;
  }

  return { state: s, objectId, dataId };
}
