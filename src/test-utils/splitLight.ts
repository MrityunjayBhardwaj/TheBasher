// makeSplitLight — the canonical object↔data split-light fixture + the SINGLE source
// of truth for the split shape every #386 slice asserts against.
//
// #386 Stage C (C3): a posable light is an `Object` (owning the transform) wired via
// its `data` socket to a `LightData` (owning the shading — kind + intensity/colour/
// falloff/aim, the SECOND non-mesh ObjectData). This mirrors exactly what the
// Add ▸ Light builder (addPrimitives.ts), the default project, the bundled examples,
// addStudioLight, and the load-migration all produce — so a single helper keeps the
// fixtures on ONE shape and none of those roads derives it independently and drifts.
// Selection + the studio panel land on the Object (shading resolves through `data`);
// the LightData owns the shading. Mirrors makeSplitCurve / makeSplitSphere exactly.
//
// AmbientLight does NOT split (ambient = a World datablock, only 4 light OBJECT types)
// — `makeSplitLight` REJECTS 'Ambient' so a fixture can never mint an illegal split.
//
// The migration byte-identity fixture (src/core/project/migrations.test.ts) is the ONE
// place that MUST still hand-build a FUSED light — it proves the migration. It asserts
// its OUTPUT against the canonical shape this helper defines.
//
// REF: src/nodes/LightData.ts; src/app/addPrimitives.ts; src/app/resolveDataParamOwner.ts.

import { applyOp, type DagState } from '../core/dag';

/** The four posable light kinds — the LightData `lightKind` discriminator domain.
 *  Ambient is intentionally absent (it never splits). */
export type SplitLightKind = 'Directional' | 'Point' | 'Spot' | 'Area';

/** Which fused light node TYPE a given split kind migrates from / maps to. */
export const FUSED_TYPE_OF: Record<SplitLightKind, string> = {
  Directional: 'DirectionalLight',
  Point: 'PointLight',
  Spot: 'SpotLight',
  Area: 'AreaLight',
};

export interface SplitLightOpts {
  /** Id for the Object (the pose half — the scene child / the node you select). */
  objectId: string;
  /** Id for the LightData (the shading half). Defaults to `${objectId}_data`. */
  dataId?: string;
  /** Which posable kind. Rejects 'Ambient' (ambient cannot split). */
  lightKind: SplitLightKind;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Any shading params to seed on the LightData (intensity/color/distance/decay/
   *  angle/penumbra/width/height/target/lookAt/tex). Omitted fields take zod defaults. */
  shading?: Record<string, unknown>;
  /**
   * Optional edge to wire the Object's `out` into, e.g. `{ node: 'scene', socket: 'lights' }`.
   * Omit for a standalone split light.
   */
  connectTo?: { node: string; socket: string };
}

export interface SplitLight {
  state: DagState;
  objectId: string;
  dataId: string;
}

/**
 * Inject an Object → LightData split light into `state` and return the new state plus
 * the two ids. Requires the real node registry to be seeded
 * (`__reseedAllNodesForTests()`), since it builds genuine `LightData`/`Object` nodes
 * and a `data` edge. Wiring: data.out → object.data ; object.out → connectTo.
 */
export function makeSplitLight(state: DagState, opts: SplitLightOpts): SplitLight {
  // Ambient has no pose — it is not one of the four posable OBJECT kinds and must
  // never be minted as a split. Guard the compiler-invisible partial-retirement
  // asymmetry at the fixture boundary.
  if ((opts.lightKind as string) === 'Ambient') {
    throw new Error('makeSplitLight: AmbientLight does not split (ambient = a World datablock)');
  }
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;

  const dataParams: Record<string, unknown> = {
    lightKind: opts.lightKind,
    ...(opts.shading ?? {}),
  };

  const objParams: Record<string, unknown> = {};
  if (opts.position) objParams.position = opts.position;
  if (opts.rotation) objParams.rotation = opts.rotation;
  if (opts.scale) objParams.scale = opts.scale;

  let s = applyOp(state, {
    type: 'addNode',
    nodeId: dataId,
    nodeType: 'LightData',
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
