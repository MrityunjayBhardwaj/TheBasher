// Object↔data split, Phase 2 (#362) — the read-road parity pin.
//
// Phase 1 pinned that an `Object → BoxData` pair EVALUATES to the same geometry
// handle + material as a fused `BoxMesh` (objectDataSplit.test.ts). Phase 2 wires
// the Object into the read-side producer the gizmo, inspector, and UV editor all
// consume — `resolveEvaluatedMesh` — reaching THROUGH the `data` socket. This pins
// that the read road sees the Object as the same mesh the renderer draws (K22 step
// 7): same geometry key, same material, and the Object's OWN TRS as the transform
// band. Without this the gizmo/inspector would be blind to an Object (a silent miss).
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §9; src/app/resolveEvaluatedMesh.ts (the
// Object branch); src/nodes/objectDataSplit.test.ts (the Phase-1 evaluate parity).

import { describe, it, expect } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import type { DagState, Op } from '../core/dag/types';

registerAllNodes();

const SIZE: [number, number, number] = [2, 3, 4];
const POS: [number, number, number] = [1, 2, 3];
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

describe('object↔data split (#362) — the read road sees an Object as its data mesh', () => {
  it('resolveEvaluatedMesh(Object) ≡ resolveEvaluatedMesh(fused BoxMesh): same handle + material', () => {
    const objState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const objMesh = resolveEvaluatedMesh(objState, 'o', ctx);
    expect(objMesh).not.toBeNull();

    const fusedState = build([
      { type: 'addNode', nodeId: 'b', nodeType: 'BoxMesh', params: { size: SIZE, position: POS } },
    ]);
    const fusedMesh = resolveEvaluatedMesh(fusedState, 'b', ctx);
    expect(fusedMesh).not.toBeNull();

    // Same geometry HANDLE (deterministic key → one registry build → same buffers).
    expect(objMesh!.geometry.key).toBe(fusedMesh!.geometry.key);
    expect(objMesh!.geometry).toEqual(fusedMesh!.geometry);
    // Same material spec (BoxData hydrates via the SAME schema BoxMesh uses).
    expect(objMesh!.material).toEqual(fusedMesh!.material);
    // Same UV islands (both project through the shared registry).
    expect(objMesh!.uvs).toEqual(fusedMesh!.uvs);
  });

  it('the transform band is the OBJECT’s pose, not the data node’s (data owns no TRS)', () => {
    const state = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const mesh = resolveEvaluatedMesh(state, 'o', ctx);
    // The Object composes its own TRS over the data's geometry (raw-fallback band —
    // the node isn't in a rendered scene here, so the walk falls back to its params).
    expect(mesh!.transform.position).toEqual(POS);
    expect(mesh!.transform.rotation).toEqual([0, 0, 0]);
    expect(mesh!.transform.scale).toEqual([1, 1, 1]);
  });

  it('an Object with no data resolves to no mesh (an Empty is not a mesh producer)', () => {
    const state = build([
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
    ]);
    expect(resolveEvaluatedMesh(state, 'o', ctx)).toBeNull();
  });
});
