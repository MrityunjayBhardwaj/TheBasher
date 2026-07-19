// splitCubeOps — the canonical object↔data split-cube op list for end-to-end specs.
//
// #365 Phase 5a (Slice 2): a cube is an `Object` (owning the transform) wired via its
// `data` socket to a `BoxData` (owning geometry `size` + `material`). This mirrors what
// Add ▸ Cube (src/app/addPrimitives.ts) and the load migration produce, so the ~34 specs
// that used to inject a single fused `BoxMesh` node stay on one shape.
//
// This is a PURE builder — it runs on the Node side and the resulting array is passed
// into `page.evaluate` as an argument. It deliberately does NOT wire the Object into the
// scene: the caller already has the scene id in page scope and appends that connect
// itself, e.g.
//
//     await page.evaluate(({ ops }) => {
//       const dag = w.__basher_dag.getState();
//       const sceneId = dag.state.outputs.scene.node;
//       dag.dispatchAtomic(
//         [...ops, { type: 'connect', from: { node: 'n_box_b', socket: 'out' },
//                    to: { node: sceneId, socket: 'children' } }],
//         'e2e', 'second cube',
//       );
//     }, { ops: splitCubeOps({ objectId: 'n_box_b', position: [3, 0, 0] }) });
//
// WHICH HALF TO TARGET afterwards (the trap this helper exists to make hard to get wrong):
//   transform params — position / rotation / scale  → the OBJECT id
//   geometry + material params — size / material.*  → the DATA id
// A `setParam` aimed at the wrong half is SILENTLY REJECTED (no error, the value simply
// does not change), so a spec that only checks "no throw" will pass while testing nothing.
// Assert the resulting value.

export interface SplitCubeOpts {
  /** Id for the Object — the pose half, and the node a spec selects / poses / animates. */
  objectId: string;
  /** Id for the BoxData — the geometry + material half. Defaults to `${objectId}_data`. */
  dataId?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  size?: [number, number, number];
  /** Material base color (e.g. '#ff0000'), set on the BoxData. Omit for the default. */
  color?: string;
}

/**
 * Build the ops that create one split cube: a `BoxData`, an `Object`, and the `data`
 * edge between them. Returns them in dependency order, ready to splice into a
 * `dispatchAtomic` call.
 */
export function splitCubeOps(opts: SplitCubeOpts): unknown[] {
  const objectId = opts.objectId;
  const dataId = opts.dataId ?? `${objectId}_data`;

  const dataParams: Record<string, unknown> = { size: opts.size ?? [1, 1, 1] };
  if (opts.color) dataParams.material = { base: { color: opts.color } };

  const objParams: Record<string, unknown> = {
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
  };

  return [
    { type: 'addNode', nodeId: dataId, nodeType: 'BoxData', params: dataParams },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: objParams },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/** The data-node id `splitCubeOps` will use for a given Object id. */
export function splitCubeDataId(objectId: string): string {
  return `${objectId}_data`;
}
