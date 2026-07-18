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
import { nodeRefCandidates } from './nodeRefCandidates';
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
  it('resolveEvaluatedMesh(Object) ≡ an independently-built Object→BoxData: same handle + material', () => {
    const objState = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    const objMesh = resolveEvaluatedMesh(objState, 'o', ctx);
    expect(objMesh).not.toBeNull();

    // The fused `BoxMesh` value kind is retired (Slice 2) — it is unrepresentable as an
    // evaluated mesh. The parity anchor is now a SECOND, independently-built split cube with
    // the same size + pose: it must land on the same deterministic geometry key + material.
    const cubeState = build([
      { type: 'addNode', nodeId: 'd2', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o2', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd2', socket: 'out' }, to: { node: 'o2', socket: 'data' } },
    ]);
    const cubeMesh = resolveEvaluatedMesh(cubeState, 'o2', ctx);
    expect(cubeMesh).not.toBeNull();

    // Same geometry HANDLE (deterministic key → one registry build → same buffers).
    expect(objMesh!.geometry.key).toBe(cubeMesh!.geometry.key);
    expect(objMesh!.geometry).toEqual(cubeMesh!.geometry);
    // Same material spec (BoxData hydrates via the SAME schema each split cube uses).
    expect(objMesh!.material).toEqual(cubeMesh!.material);
    // Same UV islands (both project through the shared registry).
    expect(objMesh!.uvs).toEqual(cubeMesh!.uvs);
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

  it('the constraint/ref picker offers the Object but NOT its data node (§4: data has no pose)', () => {
    const state = build([
      { type: 'addNode', nodeId: 'd', nodeType: 'BoxData', params: { size: SIZE } },
      { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: { position: POS } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'o', socket: 'data' } },
    ]);
    // 'transformable' (a Track-To aim / Copy-Location target): has a world pose.
    const posable = nodeRefCandidates(state, 'transformable', 'other', ctx).map((c) => c.id);
    expect(posable).toContain('o'); // the Object is a valid pose target
    expect(posable).not.toContain('d'); // a data node has no world pose (§4)
    // 'mesh' (a geometry sampler source): resolves to an evaluated mesh. The Object
    // does (through its data, Slice 2); the raw data node does not (it has no pose).
    const meshes = nodeRefCandidates(state, 'mesh', 'other', ctx).map((c) => c.id);
    expect(meshes).toContain('o');
    expect(meshes).not.toContain('d');
  });
});
