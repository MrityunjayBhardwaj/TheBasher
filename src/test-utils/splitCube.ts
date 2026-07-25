// makeSplitCube — the canonical object↔data split-cube fixture for unit tests.
//
// #365 Phase 5a (Slice 2): a cube is an `Object` (owning the transform) wired via its `data`
// socket to a `BoxData` (owning geometry `size` + `material`). This mirrors exactly what the
// Add ▸ Cube builder (src/app/addPrimitives.ts) and the load-migration (K23) produce, so a
// single helper keeps the ~56 fused-box test fixtures on one shape after the fused `BoxMesh`
// value kind retires. Selection + chained edits land on the Object; a BoxData owns geometry.
//
// The migration byte-identity fixture (src/core/project/migrations.test.ts) is the ONE place
// that MUST still hand-build a fused `BoxMesh` — it proves the migration. Do NOT route it here.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md; src/app/addPrimitives.ts; src/app/resolveDataParamOwner.ts.

import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { dataIdFor, splitOps } from './splitKinds';

export interface SplitCubeOpts {
  /** Id for the Object (the pose half — this is the scene child / the node you select). */
  objectId: string;
  /** Id for the BoxData (the geometry+material half). Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  size?: [number, number, number];
  /** Material base color (e.g. '#ff0000'), set on the BoxData. Omit to use the default. */
  color?: string;
  /**
   * Optional edge to wire the Object's `out` into, e.g. `{ node: 'scene', socket: 'children' }`.
   * Omit for a standalone split cube.
   */
  connectTo?: { node: string; socket: string };
}

export interface SplitCube {
  state: DagState;
  objectId: string;
  dataId: string;
}

/**
 * Inject an Object → BoxData split cube into `state` and return the new state plus the two ids.
 * Requires the real node registry to be seeded (`__reseedAllNodesForTests()`), since it builds
 * genuine `BoxData`/`Object` nodes and a `data` edge.
 */
export function makeSplitCube(state: DagState, opts: SplitCubeOpts): SplitCube {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? dataIdFor(objectId);

  // This helper's OWN defaulting, deliberately not shared: it writes a pose param only
  // when the caller passed one (the e2e builder always writes all three). Unifying the
  // two would change what ~75 existing consumers see — see splitKinds.ts.
  const dataParams: Record<string, unknown> = { size: opts.size ?? [1, 1, 1] };
  if (opts.color) dataParams.material = { base: { color: opts.color } };

  const objParams: Record<string, unknown> = {};
  if (opts.position) objParams.position = opts.position;
  if (opts.rotation) objParams.rotation = opts.rotation;
  if (opts.scale) objParams.scale = opts.scale;

  let s = state;
  for (const op of splitOps('box', { objectId, dataId }, { data: dataParams, object: objParams })) {
    s = applyOp(s, op as Op).next;
  }
  if (opts.connectTo) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: objectId, socket: 'out' },
      to: opts.connectTo,
    }).next;
  }

  return { state: s, objectId, dataId };
}
