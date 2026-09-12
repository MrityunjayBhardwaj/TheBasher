// Every split kind returns the id of BOTH nodes it mints (#772).
//
// ── WHY A GATE AND NOT A ROW PER KIND ─────────────────────────────────────────────────
//
// `buildAddPrimitiveOps` mints a data node and an object for a split kind, and returned
// only the object. The agent was therefore handed the id of the node that does NOT hold
// the params it wants to write — `points` is on the `CurveData`, not on the `Object`
// posing it. #772 records why that bites hardest on a camera trajectory: a path IS its
// points, so the one kind whose data the agent most needs is the one it was not told
// about.
//
// The fix is one line per branch, and one line per branch is exactly what rots: a kind
// added later gets a `newNodeId` because the return type demands one and silently gets
// no `dataNodeId`, because the field is optional and MUST be — a fused kind has no
// second node. So the property is asserted over the KINDS rather than written per
// branch: for every kind the Add menu offers, if the ops mint a node the object's `data`
// socket is wired to, then `dataNodeId` names that node. Derived from the ops, so a new
// split kind is covered the day it is added and a new fused one needs no exemption.
//
// REF: src/app/addPrimitives.ts (`AddResult.dataNodeId`); src/agent/tools/meshAdd.ts
//      (the surfacing); issues #772, #774.

import { describe, expect, it } from 'vitest';
import {
  buildAddPrimitiveOps,
  COMPUTE_KINDS,
  RESOURCE_KINDS,
  SCENE_OBJECT_KINDS,
  type PrimitiveKind,
} from './addPrimitives';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';

type AddNodeOp = { type: 'addNode'; nodeId: string; nodeType: string };
type ConnectOp = {
  type: 'connect';
  from: { node: string; socket: string };
  to: { node: string; socket: string };
};

const ALL_KINDS = [...SCENE_OBJECT_KINDS, ...COMPUTE_KINDS, ...RESOURCE_KINDS] as const;

describe('#772 — the add path names the node that holds the params', () => {
  it('gives every split kind its data node id, and every fused kind none', () => {
    registerAllNodes();
    const state = buildDefaultDagState();

    let split = 0;
    let fused = 0;
    for (const kind of ALL_KINDS) {
      const result = buildAddPrimitiveOps(state, kind as PrimitiveKind, [0, 0, 0]);
      expect(result, `${kind}: the default project must be able to add one`).not.toBeNull();
      const ops = result!.ops as unknown as (AddNodeOp | ConnectOp)[];

      // THE SPLIT, read off the ops rather than from a list: an edge into the
      // object's `data` socket is what a split kind IS.
      const dataEdge = ops.find(
        (op): op is ConnectOp =>
          op.type === 'connect' && op.to.node === result!.newNodeId && op.to.socket === 'data',
      );

      if (dataEdge) {
        split++;
        expect(
          result!.dataNodeId,
          `${kind} wires a data node into ${result!.newNodeId} and did not say which node that is`,
        ).toBe(dataEdge.from.node);
        // ...and the id it names is a node these ops actually create, not a
        // dangling reference to something the caller is expected to find.
        expect(
          ops.some((op) => op.type === 'addNode' && op.nodeId === result!.dataNodeId),
          `${kind}: dataNodeId names ${result!.dataNodeId}, which these ops never create`,
        ).toBe(true);
      } else {
        fused++;
        expect(
          result!.dataNodeId,
          `${kind} mints one node, so a dataNodeId here would name the object twice and ` +
            `answer "is there a separate params node" with "yes"`,
        ).toBeUndefined();
      }
    }

    // Both populations, with their denominators. A run that classified every kind
    // as fused would satisfy every assertion above and prove nothing.
    expect(split, 'no split kind was examined').toBeGreaterThan(5);
    expect(fused, 'no fused kind was examined').toBeGreaterThan(5);
    expect(split + fused).toBe(ALL_KINDS.length);
  });

  it('names the CurveData for a Curve — the case the trajectory build needs', () => {
    registerAllNodes();
    const result = buildAddPrimitiveOps(buildDefaultDagState(), 'Curve', [1, 0, 2]);
    const ops = result!.ops as unknown as AddNodeOp[];
    const curveData = ops.find((op) => op.type === 'addNode' && op.nodeType === 'CurveData');
    expect(curveData, 'a Curve must mint a CurveData').toBeDefined();
    expect(result!.dataNodeId).toBe(curveData!.nodeId);
    // ...and it is NOT the object, which is the confusion the field exists to end.
    expect(result!.dataNodeId).not.toBe(result!.newNodeId);
  });
});
