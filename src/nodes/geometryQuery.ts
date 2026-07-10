// geometryQuery — the SampleGeometry node: the compute/driver rail's GEOMETRY reader
// (#300 follow-up; the north-star "tires respecting the terrain" primitive).
//
// Every other compute node reads numbers or transforms; this one reads GEOMETRY —
// it drops a vertical ray onto a terrain mesh and outputs the ground point under a
// query position (a controller Null's world XZ). Wire its `out` into a ParamDriver's
// `inVec` and the driven object rides the surface as the Null moves across it.
//
// WHY it is a SEAM-RESOLVED node (not a pure evaluate): the ground point needs the
// terrain's WORLD-space triangles — the geometry registry (a runtime cache) AND the
// terrain's world matrix (`resolveWorldTransform`, which walks the scene graph). Both
// need `state`, which a pure `evaluate(params, inputs)` does not have. So — exactly
// like the Solver/Lag stateful road and the Null Point-controller (`sourceTransformVec`)
// — the real value is computed at the driver-resolution SEAM (geometrySampleSource.ts),
// and `evaluate` returns a benign origin. KNOWN LIMIT (mirrors the stateful/compute-in
// limit [[H152]]): a SampleGeometry produces a real value ONLY as the direct source of a
// ParamDriver; wired mid-graph (into a Vec3Math) it reads the origin.
//
// The terrain + the query Null are named by PARAM REF ({node}), not wired edges — the
// same shape as `sourceTransformVec` — because the value is resolved with `state` at the
// seam, and (per [[H152]]) a controller can't feed a bare compute node's input anyway.
//
// REF: src/app/geometrySampleSource.ts (the seam reader); src/app/sampleTerrain.ts (the
//      pure ray-vs-mesh core); memory project_drivers-controllers-opnet (the north-star).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { Vec3 } from './types';

/** A node reference param ({node}) — the terrain mesh, and the query controller. */
const nodeRef = z.object({ node: z.string() }).optional();

export const SampleGeometryParams = z.object({
  /** The terrain mesh sampled (a mesh node id). */
  sourceGeometry: nodeRef,
  /** The controller whose world XZ is the query point (a Null / any transformable). */
  at: nodeRef,
});
export type SampleGeometryParams = z.infer<typeof SampleGeometryParams>;

export const SampleGeometryNode: NodeDefinition<SampleGeometryParams, Vec3> = {
  type: 'SampleGeometry',
  version: 1,
  // Not stateless-pure in spirit (its real value is seam-resolved from world geometry),
  // but its `evaluate` IS a pure constant, so the evaluator may cache it freely.
  pure: true,
  cost: 'cheap',
  paramSchema: SampleGeometryParams,
  inputs: {},
  // Two output faces (Houdini Ray SOP parity: hit position + hit normal):
  //   `out`    — the world ground POINT under the query (drives a position).
  //   `normal` — the surface NORMAL there (drives orientation — tilt to the slope).
  // A multi-output node (like VecBreak3): a consumer wires the socket it wants; the seam
  // resolves whichever socket the driver reads. (A scalar height is not a 3rd socket — it
  // is just `VecBreak3(out).y`, composable, the way Houdini reads position.y.)
  outputs: {
    out: { type: 'Vector3', cardinality: 'single' },
    normal: { type: 'Vector3', cardinality: 'single' },
  },
  // The two inputs are authored through the general node-ref picker in the inspector
  // (not a bespoke preset) — terrain filtered to meshes, the query to transformables.
  refParams: {
    sourceGeometry: { label: 'terrain', kind: 'mesh' },
    at: { label: 'query', kind: 'transformable' },
  },
  // The seam (geometrySampleSource.ts) supplies the real point/normal; a bare evaluate
  // has no `state` to read world geometry, so it returns benign defaults (origin + up).
  evaluate: () => ({ out: [0, 0, 0], normal: [0, 1, 0] }),
};
