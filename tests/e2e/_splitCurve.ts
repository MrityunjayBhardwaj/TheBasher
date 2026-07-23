// splitCurveOps — the canonical object↔data split-curve op list for end-to-end specs.
//
// #385 Stage C (C2): a curve is an `Object` (owning the transform) wired via its `data` socket
// to a `CurveData` (owning `points`/`closed`/`resolution` — the FIRST non-mesh ObjectData).
// This mirrors what Add ▸ Curve (src/app/addPrimitives.ts) and the load migration produce, so
// the specs that used to inject a single fused `Curve` node stay on one shape.
//
// This is a PURE builder — it runs on the Node side and the resulting array is passed into
// `page.evaluate` as an argument. Like _splitCube it does NOT wire the Object into the scene:
// the caller appends the `connect object.out → scene.children` itself.
//
// WHICH HALF TO TARGET afterwards (the trap this helper exists to make hard to get wrong):
//   transform params — position / rotation / scale  → the OBJECT id
//   geometry params — points / closed / resolution  → the DATA id
// A `setParam` aimed at the wrong half is SILENTLY REJECTED (the value simply does not change),
// so a spec that only checks "no throw" would pass while testing nothing. Assert the value.
//
// Control points carry stable ids ({ id, co } — epic #453), minted `cp0..` here so the
// CurveDataParams schema accepts them (a bare Vec3[] would fail validation).

export interface SplitCurveOpts {
  /** Id for the Object — the pose half, and the node a spec selects / poses / references. */
  objectId: string;
  /** Id for the CurveData — the points/closed/resolution half. Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** Bare control-point coordinates; stable ids (cp0..) are minted here. */
  points?: [number, number, number][];
  closed?: boolean;
  resolution?: number;
}

/** The default lopsided path — a long first span then two tight ones (arc-length exposer). */
const DEFAULT_POINTS: [number, number, number][] = [
  [0, 0, 0],
  [10, 0, 0],
  [11, 0, 0],
  [12, 0, 0],
];

/**
 * Build the ops that create one split curve: a `CurveData`, an `Object`, and the `data` edge
 * between them. Returns them in dependency order, ready to splice into a `dispatchAtomic` call.
 */
export function splitCurveOps(opts: SplitCurveOpts): unknown[] {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;
  const pts = opts.points ?? DEFAULT_POINTS;

  const dataParams: Record<string, unknown> = {
    points: pts.map((co, i) => ({ id: `cp${i}`, co })),
    closed: opts.closed ?? false,
    resolution: opts.resolution ?? 32,
  };
  const objParams: Record<string, unknown> = {
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  };

  return [
    { type: 'addNode', nodeId: dataId, nodeType: 'CurveData', params: dataParams },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: objParams },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/** The data-node id `splitCurveOps` will use for a given Object id. */
export function splitCurveDataId(objectId: string): string {
  return `${objectId}_data`;
}
