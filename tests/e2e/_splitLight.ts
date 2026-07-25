// splitLightOps — the canonical object↔data split-light op list for end-to-end specs.
//
// #386 Stage C (C3): a posable light is an `Object` (owning the transform) wired via its
// `data` socket to a `LightData` (owning the shading — kind + intensity/colour/falloff/aim,
// the SECOND non-mesh ObjectData). This mirrors what Add ▸ {Point,Spot,Area,Directional}
// Light (src/app/addPrimitives.ts) and the load migration produce, so a spec that used to
// inject a single fused light node stays on one shape. AmbientLight does NOT split.
//
// This is a PURE builder — it runs on the Node side and the resulting array is passed into
// `page.evaluate` as an argument. Like _splitCurve it does NOT wire the Object into the scene:
// the caller appends the `connect object.out → scene.lights` itself.
//
// WHICH HALF TO TARGET afterwards (the trap this helper exists to make hard to get wrong):
//   transform params — position / rotation / scale        → the OBJECT id
//   shading params   — intensity / color / width / … / tex → the DATA id
// A `setParam` aimed at the wrong half is SURFACED-REPORTABLE but still a no-op (#423) — the
// value does not change — so a spec that only checks "no throw" would pass while testing
// nothing. Assert the value.

import { dataIdFor, splitOps } from '../../src/test-utils/splitKinds';

export type SplitLightKind = 'Directional' | 'Point' | 'Spot' | 'Area';

export interface SplitLightOpts {
  /** Id for the Object — the pose half, and the node a spec selects / poses / references. */
  objectId: string;
  /** Id for the LightData — the shading half. Defaults to `${objectId}_data`. */
  dataId?: string;
  /** Which posable kind (Ambient does not split — the builder rejects it). */
  lightKind: SplitLightKind;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Shading params to seed on the LightData (intensity/color/width/height/target/lookAt/tex). */
  shading?: Record<string, unknown>;
}

/**
 * Build the ops that create one split light: a `LightData`, an `Object`, and the `data` edge
 * between them. Returns them in dependency order, ready to splice into a `dispatchAtomic` call.
 */
export function splitLightOps(opts: SplitLightOpts): unknown[] {
  if ((opts.lightKind as string) === 'Ambient') {
    throw new Error('splitLightOps: AmbientLight does not split (ambient = a World datablock)');
  }
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? dataIdFor(objectId);

  // This builder's OWN defaulting, deliberately not shared with the unit helper:
  // it writes all three pose params unconditionally, where
  // `makeSplitLight` omits the ones the caller did not pass. ~75 consumers across both
  // tiers depend on the current behaviour, so splitKinds shares the op LIST and
  // leaves the defaults here. See src/test-utils/splitKinds.ts.
  const dataParams: Record<string, unknown> = {
    lightKind: opts.lightKind,
    ...(opts.shading ?? {}),
  };
  const objParams: Record<string, unknown> = {
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  };

  return splitOps('light', { objectId, dataId }, { data: dataParams, object: objParams });
}

/** The data-node id `splitLightOps` will use for a given Object id. */
export function splitLightDataId(objectId: string): string {
  return dataIdFor(objectId);
}
