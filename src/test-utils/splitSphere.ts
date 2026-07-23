// makeSplitSphere — the canonical object↔data split-sphere fixture for unit tests.
//
// #384 Stage C (C1): a sphere is an `Object` (owning the transform) wired via its `data`
// socket to a `SphereData` (owning geometry `radius`/`widthSegments`/`heightSegments` +
// `material`). This mirrors exactly what the Add ▸ Sphere builder (src/app/addPrimitives.ts)
// and the load-migration (K23) produce, so a single helper keeps the fused-sphere test
// fixtures on one shape after the fused `SphereMesh` value kind retires. Selection + chained
// edits land on the Object; a SphereData owns geometry. Mirrors makeSplitCube exactly.
//
// The migration byte-identity fixture (src/core/project/migrations.test.ts) is the ONE place
// that MUST still hand-build a fused `SphereMesh` — it proves the migration. Do NOT route it here.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md; src/app/addPrimitives.ts; src/app/resolveDataParamOwner.ts.

import { applyOp, type DagState } from '../core/dag';

export interface SplitSphereOpts {
  /** Id for the Object (the pose half — this is the scene child / the node you select). */
  objectId: string;
  /** Id for the SphereData (the geometry+material half). Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  radius?: number;
  widthSegments?: number;
  heightSegments?: number;
  /** Material base color (e.g. '#88aaff'), set on the SphereData. Omit to use the default. */
  color?: string;
  /**
   * Optional edge to wire the Object's `out` into, e.g. `{ node: 'scene', socket: 'children' }`.
   * Omit for a standalone split sphere.
   */
  connectTo?: { node: string; socket: string };
}

export interface SplitSphere {
  state: DagState;
  objectId: string;
  dataId: string;
}

/**
 * Inject an Object → SphereData split sphere into `state` and return the new state plus the two
 * ids. Requires the real node registry to be seeded (`__reseedAllNodesForTests()`), since it
 * builds genuine `SphereData`/`Object` nodes and a `data` edge.
 */
export function makeSplitSphere(state: DagState, opts: SplitSphereOpts): SplitSphere {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;

  const dataParams: Record<string, unknown> = {};
  if (opts.radius !== undefined) dataParams.radius = opts.radius;
  if (opts.widthSegments !== undefined) dataParams.widthSegments = opts.widthSegments;
  if (opts.heightSegments !== undefined) dataParams.heightSegments = opts.heightSegments;
  if (opts.color) dataParams.material = { base: { color: opts.color } };

  const objParams: Record<string, unknown> = {};
  if (opts.position) objParams.position = opts.position;
  if (opts.rotation) objParams.rotation = opts.rotation;
  if (opts.scale) objParams.scale = opts.scale;

  let s = applyOp(state, {
    type: 'addNode',
    nodeId: dataId,
    nodeType: 'SphereData',
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
