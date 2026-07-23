// addPrimitives — Op-chain shape tests for the Blender-style Add menu.
// Verifies node-type mapping, scene wiring, and the spawn-position hook
// without ever mutating the DAG store (the builders are pure).

import { describe, expect, it } from 'vitest';
import { emptyDagState, applyOp } from '../core/dag';
import type { Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildAddPrimitiveOps, type PrimitiveKind } from './addPrimitives';

function seedSceneState() {
  __reseedAllNodesForTests();
  let state = emptyDagState();
  const seed: Op[] = [{ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} }];
  for (const op of seed) state = applyOp(state, op).next;
  return {
    ...state,
    outputs: { scene: { node: 'n_scene', socket: 'out' as const } },
  };
}

describe('buildAddPrimitiveOps', () => {
  it('returns null when no scene output is wired', () => {
    __reseedAllNodesForTests();
    const empty = emptyDagState();
    expect(buildAddPrimitiveOps(empty, 'Cube', [0, 0, 0])).toBeNull();
  });

  it('Cube: emits the object↔data split — BoxData + Object + wire + connect to scene.children', () => {
    // #365 Phase 5a (Slice 1b) — a Cube is the split-native pair now: a BoxData (geometry)
    // and an Object (pose) wired data→object, the Object into scene.children. Selection lands
    // on the Object (the posable half), so newNodeId is the Object's id.
    const state = seedSceneState();
    const r = buildAddPrimitiveOps(state, 'Cube', [1, 2, 3])!;
    expect(r.ops).toHaveLength(4);
    if (r.ops[0].type !== 'addNode' || r.ops[1].type !== 'addNode') throw new Error();
    expect(r.ops[0].nodeType).toBe('BoxData');
    expect(r.ops[1].nodeType).toBe('Object');
    expect((r.ops[1].params as { position: number[] }).position).toEqual([1, 2, 3]);
    // BoxData → Object.data, then Object → scene.children.
    expect(r.ops[2]).toMatchObject({
      type: 'connect',
      from: { node: r.ops[0].nodeId },
      to: { node: r.ops[1].nodeId, socket: 'data' },
    });
    expect(r.ops[3]).toMatchObject({
      type: 'connect',
      from: { node: r.ops[1].nodeId },
      to: { node: 'n_scene', socket: 'children' },
    });
    expect(r.newNodeId).toBe(r.ops[1].nodeId);
  });

  it('Sphere: emits the object↔data split — SphereData + Object + wire + connect to scene.children', () => {
    // #384 Stage C — a Sphere is the split-native pair now (mirroring Cube): a SphereData
    // (geometry radius/segments + material) and an Object (pose) wired data→object, the Object
    // into scene.children. Selection lands on the Object, so newNodeId is the Object's id.
    const r = buildAddPrimitiveOps(seedSceneState(), 'Sphere', [1, 2, 3])!;
    expect(r.ops).toHaveLength(4);
    if (r.ops[0].type !== 'addNode' || r.ops[1].type !== 'addNode') throw new Error();
    expect(r.ops[0].nodeType).toBe('SphereData');
    expect((r.ops[0].params as { radius: number }).radius).toBe(0.5);
    expect(r.ops[1].nodeType).toBe('Object');
    expect((r.ops[1].params as { position: number[] }).position).toEqual([1, 2, 3]);
    // SphereData → Object.data, then Object → scene.children.
    expect(r.ops[2]).toMatchObject({
      type: 'connect',
      from: { node: r.ops[0].nodeId },
      to: { node: r.ops[1].nodeId, socket: 'data' },
    });
    expect(r.ops[3]).toMatchObject({
      type: 'connect',
      from: { node: r.ops[1].nodeId },
      to: { node: 'n_scene', socket: 'children' },
    });
    expect(r.newNodeId).toBe(r.ops[1].nodeId);
  });

  it('lights connect to scene.lights, not children', () => {
    const lights: PrimitiveKind[] = [
      'DirectionalLight',
      'PointLight',
      'SpotLight',
      'AreaLight',
      'AmbientLight',
    ];
    const state = seedSceneState();
    for (const k of lights) {
      const r = buildAddPrimitiveOps(state, k, [5, 5, 5])!;
      const connectOp = r.ops.find((o) => o.type === 'connect');
      if (connectOp?.type !== 'connect') throw new Error();
      expect(connectOp.to.socket).toBe('lights');
    }
  });

  it('cameras add only — no auto-wire to scene.camera (single-cardinality)', () => {
    const r = buildAddPrimitiveOps(seedSceneState(), 'PerspectiveCamera', [3, 2, 3])!;
    expect(r.ops.filter((o) => o.type === 'connect')).toHaveLength(0);
    expect(r.ops[0].type).toBe('addNode');
  });

  it('empties add only — Group / Transform stay floating until wired', () => {
    const a = buildAddPrimitiveOps(seedSceneState(), 'Group', [0, 0, 0])!;
    const b = buildAddPrimitiveOps(seedSceneState(), 'Transform', [0, 0, 0])!;
    expect(a.ops.filter((o) => o.type === 'connect')).toHaveLength(0);
    expect(b.ops.filter((o) => o.type === 'connect')).toHaveLength(0);
  });

  it('Null: standalone controller — auto-wires to scene.children with its TRS', () => {
    const r = buildAddPrimitiveOps(seedSceneState(), 'Null', [2, 0, 0])!;
    if (r.ops[0].type !== 'addNode') throw new Error();
    expect(r.ops[0].nodeType).toBe('Null');
    expect((r.ops[0].params as { position: number[]; scale: number[] }).position).toEqual([
      2, 0, 0,
    ]);
    expect((r.ops[0].params as { scale: number[] }).scale).toEqual([1, 1, 1]);
    expect(r.ops[1]).toMatchObject({
      type: 'connect',
      to: { node: 'n_scene', socket: 'children' },
    });
    expect(r.newNodeId).toMatch(/^null/);
  });

  it('every result carries a unique newNodeId + a human description', () => {
    const a = buildAddPrimitiveOps(seedSceneState(), 'Cube', [0, 0, 0])!;
    const b = buildAddPrimitiveOps(seedSceneState(), 'Cube', [0, 0, 0])!;
    expect(a.newNodeId).not.toBe(b.newNodeId);
    expect(a.description).toMatch(/cube/i);
  });
});
