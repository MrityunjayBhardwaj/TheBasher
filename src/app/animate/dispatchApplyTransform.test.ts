// dispatchApplyTransform (primitives) — Phase 151 Wave 2 Task 5 (issue #151).
//
// Pins the Box/Sphere Apply contract:
//   - SC-1: Apply a Box scale=[2,1,1] → the BakedMesh geometry bbox is 2×1×1 of
//     the unit box; the new node's transform is identity.
//   - the original node is removed, ONE BakedMesh added, edges rewired.
//   - ONE dispatchAtomic (one Cmd+Z).
//   - the OPFS write is AWAITED before the Op composite (the bytes exist first).
//   - SC-8: an animated TRS band rejects (D-04 dispatch-side belt).
//   - H45: the SHARED registry geometry is NOT mutated (a sibling Box of the same
//     size still resolves to the unit box).
//
// REF: PLAN.md Wave 2 Task 5; hetvabhasa H45; vyapti V1/V20; success SC-1/SC-5/SC-8.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Vector3 } from 'three';
import { applyOp, __resetRegistryForTests } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import * as geometryRegistry from '../geometryRegistry';
import { readBakedGeometry } from '../asset/bakedGeometryStore';
import { dispatchApplyTransform } from './dispatchApplyTransform';

const BOX_ID = 'n_box';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  geometryRegistry.clear();
});

/** Apply a list of ops sequentially, returning the next state. */
function applyAll(state: DagState, ops: Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

/** A dispatchAtomic stub that applies ops to a captured ref + counts calls. */
function makeDispatch(stateRef: { current: DagState }) {
  const calls: Op[][] = [];
  const fn = (ops: Op[]) => {
    calls.push(ops);
    stateRef.current = applyAll(stateRef.current, ops);
    return [];
  };
  return { fn, calls };
}

describe('dispatchApplyTransform (primitives)', () => {
  it('SC-1: Apply a Box scale=[2,1,1] → BakedMesh bbox 2×1×1, transform identity', async () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'scale',
      value: [2, 1, 1],
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const selected: string[] = [];

    const result = await dispatchApplyTransform(BOX_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: (id) => selected.push(id),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ONE atomic composite (one Cmd+Z).
    expect(calls).toHaveLength(1);

    // The original Box is gone; exactly one BakedMesh exists.
    const next = stateRef.current;
    expect(next.nodes[BOX_ID]).toBeUndefined();
    const baked = next.nodes[result.bakedId];
    expect(baked).toBeDefined();
    expect(baked.type).toBe('BakedMesh');
    // transform identity (the TRS is baked into the verts).
    expect(baked.params.position).toEqual([0, 0, 0]);
    expect(baked.params.scale).toEqual([1, 1, 1]);
    // selection moved to the baked node.
    expect(selected).toEqual([result.bakedId]);

    // SC-1 — the baked geometry bbox is 2×1×1 (the unit box scaled on X).
    const ref = baked.params.geometry as { descriptor: { hash: string; vertexCount: number } };
    const geom = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    geom.computeBoundingBox();
    const size = new Vector3();
    new Box3(geom.boundingBox!.min, geom.boundingBox!.max).getSize(size);
    expect(size.x).toBeCloseTo(2, 5);
    expect(size.y).toBeCloseTo(1, 5);
    expect(size.z).toBeCloseTo(1, 5);
  });

  it('rewires the consumer edge: the BakedMesh feeds the Scene where the Box did', async () => {
    const state = buildDefaultDagState();
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);

    const result = await dispatchApplyTransform(BOX_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = stateRef.current;
    // The Scene's children no longer reference the Box; they reference the baked id.
    const refsBox = Object.values(next.nodes).some((n) =>
      Object.values(n.inputs).some((b) =>
        (Array.isArray(b) ? b : [b]).some((r) => r.node === BOX_ID),
      ),
    );
    const refsBaked = Object.values(next.nodes).some((n) =>
      Object.values(n.inputs).some((b) =>
        (Array.isArray(b) ? b : [b]).some((r) => r.node === result.bakedId),
      ),
    );
    expect(refsBox).toBe(false);
    expect(refsBaked).toBe(true);
  });

  it('awaits the OPFS write BEFORE the Op composite (reload-safe ordering)', async () => {
    const state = buildDefaultDagState();
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    const stateRef = { current: state };
    const calls: Op[][] = [];
    const fn = (ops: Op[]) => {
      // At dispatch time the write must already have happened.
      expect(writeSpy).toHaveBeenCalled();
      calls.push(ops);
      stateRef.current = applyAll(stateRef.current, ops);
      return [];
    };

    const result = await dispatchApplyTransform(BOX_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('SC-8: rejects when a TRS band is animated (D-04), DAG byte-unchanged', async () => {
    let state = buildDefaultDagState();
    // Add a KeyframeChannelVec3 targeting the box position → animated.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'kf',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: BOX_ID,
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
    }).next;

    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform(BOX_ID, 'all', {
      state,
      storage,
      currentFrame: 30, // a non-key frame → 'animated'
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('animated');
    // No mutation, no OPFS write.
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('H45: baking one Box does NOT corrupt the shared registry geometry', async () => {
    let state = buildDefaultDagState();
    // A second Box of the SAME size shares the registry geometry key.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_box2',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1] },
    }).next;

    // Prime the shared geometry by resolving + getting it before the bake.
    const sharedRef = {
      key: 'box|1,1,1',
      kind: 'box' as const,
      descriptor: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] },
    };
    const sharedBefore = geometryRegistry.get(sharedRef)!;
    const posBefore = Float32Array.from(sharedBefore.getAttribute('position').array);

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    await dispatchApplyTransform(BOX_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });

    // The shared cached instance is byte-identical (the bake cloned first, H45).
    const posAfter = geometryRegistry.get(sharedRef)!.getAttribute('position').array;
    expect(Array.from(posAfter)).toEqual(Array.from(posBefore));
  });

  it('Sphere path also bakes (covered, not Box-only)', async () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_sphere',
      nodeType: 'SphereMesh',
      params: { radius: 0.5, widthSegments: 8, heightSegments: 6, scale: [2, 2, 2] },
    }).next;
    // Wire it into the scene so it has a consumer edge (mirror the box).
    const sceneId = state.outputs.scene!.node;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_sphere', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_sphere', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    if (!result.ok) return;
    expect(stateRef.current.nodes['n_sphere']).toBeUndefined();
    expect(stateRef.current.nodes[result.bakedId].type).toBe('BakedMesh');
  });
});
