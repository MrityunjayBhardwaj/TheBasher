// splitSphereOps — the canonical object↔data split-sphere op list for end-to-end specs.
//
// #384 Stage C (C1): a sphere is an `Object` (owning the transform) wired via its `data`
// socket to a `SphereData` (owning geometry `radius`/`widthSegments`/`heightSegments` +
// `material`). This mirrors what Add ▸ Sphere (src/app/addPrimitives.ts) and the load
// migration produce, so the specs that used to inject a single fused `SphereMesh` stay on
// one shape. `SphereMesh.evaluate` has been a THROWING sentinel since C1 Slice 4, so a
// fixture that still builds one does not merely test the wrong shape — it fails (#462).
//
// This is a PURE builder — it runs on the Node side and the resulting array is passed into
// `page.evaluate` as an argument. Like _splitCube it does NOT wire the Object anywhere: the
// caller appends the edge it wants (`scene.children`, or a modifier's `target` socket).
//
// WHY SPECS REACH FOR A SPHERE RATHER THAN THE SPLIT CUBE: a default sphere carries ~425
// verts against a cube's 24, and several of these assertions locate their subject by a
// vertex COUNT that must be unique in a starter scene carrying thousands of verts. Keeping
// the sphere keeps that discriminating power (H180 — the measurement instrument is part
// of the fixture). A radius-0.5 sphere also shares the unit cube's [-0.5, 0.5] bounding box,
// so every bbox-derived number carries over from the fused fixtures verbatim.
//
// WHICH HALF TO TARGET afterwards (the trap this helper exists to make hard to get wrong):
//   transform params — position / rotation / scale                    → the OBJECT id
//   geometry + material params — radius / *Segments / material.*      → the DATA id
// A `setParam` aimed at the wrong half is SURFACED-REPORTABLE but still a no-op (#423) — the
// value does not change — so a spec that only checks "no throw" would pass while testing
// nothing. Assert the resulting value.
//
// A MODIFIER attaches to the OBJECT, not to the data node (#377): `modifierSource`
// (src/app/modifierGeometry.ts:120) reaches through the `data` socket for geometry+material
// and inherits the Object's TRS. Wire `object.out → modifier.target`.

export interface SplitSphereOpts {
  /** Id for the Object — the pose half, and the node a spec selects / poses / animates. */
  objectId: string;
  /** Id for the SphereData — the geometry + material half. Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Sphere radius, set on the SphereData. Defaults to 0.5 → a 1×1×1 bounding box. */
  radius?: number;
  widthSegments?: number;
  heightSegments?: number;
  /** Material base color (e.g. '#ff0000'), set on the SphereData. Omit for the default. */
  color?: string;
}

/**
 * Build the ops that create one split sphere: a `SphereData`, an `Object`, and the `data`
 * edge between them. Returns them in dependency order, ready to splice into a
 * `dispatchAtomic` call.
 */
export function splitSphereOps(opts: SplitSphereOpts): unknown[] {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;

  const dataParams: Record<string, unknown> = { radius: opts.radius ?? 0.5 };
  if (opts.widthSegments !== undefined) dataParams.widthSegments = opts.widthSegments;
  if (opts.heightSegments !== undefined) dataParams.heightSegments = opts.heightSegments;
  if (opts.color) dataParams.material = { base: { color: opts.color } };

  const objParams: Record<string, unknown> = {
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  };

  return [
    { type: 'addNode', nodeId: dataId, nodeType: 'SphereData', params: dataParams },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: objParams },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/** The data-node id `splitSphereOps` will use for a given Object id. */
export function splitSphereDataId(objectId: string): string {
  return `${objectId}_data`;
}
