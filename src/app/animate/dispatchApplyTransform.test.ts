// dispatchApplyTransform (primitives) — Phase 151 Wave 2 Task 5 (issue #151).
//
// Pins the primitive Apply contract. Both fused value kinds are retired (box #365 Slice 2,
// sphere #384 Stage C), so the mechanism now runs entirely on the split Object → data road:
//   - SC-1: Apply scale=[2,1,1] → the BakedMesh geometry bbox is 2×1×1 of the unit
//     1×1×1 bbox; the new node's transform is identity.
//   - the original node is removed, ONE BakedMesh added, edges rewired.
//   - ONE dispatchAtomic (one Cmd+Z).
//   - the OPFS write is AWAITED before the Op composite (the bytes exist first).
//   - SC-8: an animated TRS band rejects (D-04 dispatch-side belt).
//   - H45: the SHARED registry geometry is NOT mutated (a sibling primitive of the
//     same size still resolves to the unit geometry).
//
// REF: PLAN.md Wave 2 Task 5; hetvabhasa H45; vyapti V1/V20; success SC-1/SC-5/SC-8.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import { applyOp, emptyDagState, __resetRegistryForTests } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { useTransientEditStore } from '../stores/transientEditStore';
import * as geometryRegistry from '../geometryRegistry';
import { readBakedGeometry } from '../asset/bakedGeometryStore';
import {
  dispatchApplyTransform,
  canApplyTransform,
  isApplySourceAnimated,
} from './dispatchApplyTransform';
import { makeSplitCube } from '../../test-utils/splitCube';
import { makeSplitSphere } from '../../test-utils/splitSphere';

const PRIM_ID = 'n_prim';
// The SphereData half of the split sphere `buildSplitSphereState` mints (makeSplitSphere's
// default `${objectId}_data`). Geometry params (radius/segments) + material live here.
const PRIM_DATA_ID = `${PRIM_ID}_data`;

// #384 Stage C (C1) — the fused SphereMesh value kind is now retired too, so EVERY primitive
// bakes through the split Object → data road. `buildSceneScaffold` is the camera/light/scene/
// render frame with NO mesh child; a test then adds its own subject (a split sphere at PRIM_ID
// via `buildSplitSphereState`, or a split cube via makeSplitCube) so the "no Object remains
// after the bake" assertions see ONLY the subject under test, never an incidental primitive.
function buildSceneScaffold(): DagState {
  let s = emptyDagState();
  const add = (op: Op) => {
    s = applyOp(s, op).next;
  };
  add({
    type: 'addNode',
    nodeId: 'n_camera',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, near: 0.01, far: 500, position: [3, 2, 3], lookAt: [0, 0, 0] },
  });
  add({
    type: 'addNode',
    nodeId: 'n_light',
    nodeType: 'DirectionalLight',
    params: { intensity: 1.1, position: [5, 5, 3], color: '#ffffff' },
  });
  add({ type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} });
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  add({
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  });
  add({
    type: 'connect',
    from: { node: 'n_camera', socket: 'out' },
    to: { node: 'n_scene', socket: 'camera' },
  });
  add({
    type: 'connect',
    from: { node: 'n_light', socket: 'out' },
    to: { node: 'n_scene', socket: 'lights' },
  });
  add({
    type: 'connect',
    from: { node: 'n_scene', socket: 'out' },
    to: { node: 'n_render', socket: 'scene' },
  });
  return {
    ...s,
    outputs: {
      scene: { node: 'n_scene', socket: 'out' },
      render: { node: 'n_render', socket: 'out' },
    },
  };
}

// A scaffold with a split sphere at PRIM_ID wired into Scene.children. The Object owns the TRS;
// the SphereData (PRIM_DATA_ID) owns radius/segments + material. radius 0.5 → a 1×1×1 bounding
// box, identical to the retired unit box, so every bbox-bake assertion carries over verbatim.
// This is the road the whole primitive Apply MECHANISM (bbox bake, consumer rewire, OPFS
// ordering, animated-reject) now runs on — the same road makeSplitCube exercises for #376.
function buildSplitSphereState(): DagState {
  return makeSplitSphere(buildSceneScaffold(), {
    objectId: PRIM_ID,
    radius: 0.5,
    widthSegments: 16,
    heightSegments: 16,
    color: '#5af07a',
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
}

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
  it('SC-1: Apply scale=[2,1,1] → BakedMesh bbox 2×1×1, transform identity', async () => {
    let state = buildSplitSphereState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: PRIM_ID,
      paramPath: 'scale',
      value: [2, 1, 1],
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const selected: string[] = [];

    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
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

    // #412 — the id is RETAINED: the BakedMesh takes the Box's place AT THE SAME id, so
    // everything keyed by that id (a constraint/driver target, an NLA strip) still
    // resolves. What changes is the node's TYPE, not its identity.
    const next = stateRef.current;
    expect(result.bakedId).toBe(PRIM_ID);
    expect(next.nodes[PRIM_ID].type).toBe('BakedMesh');
    // ...and the split sphere is gone: exactly one BakedMesh, the SphereData half retired,
    // and no Object survives — no primitive left.
    expect(Object.values(next.nodes).filter((n) => n.type === 'BakedMesh')).toHaveLength(1);
    expect(next.nodes[PRIM_DATA_ID]).toBeUndefined();
    expect(Object.values(next.nodes).some((n) => n.type === 'Object')).toBe(false);
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

  it('preserves the consumer edge: the BakedMesh feeds the Scene at the id the Box held', async () => {
    const state = buildSplitSphereState();
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);

    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = stateRef.current;
    // #412 — the id is inherited, so "did the rewire land?" can no longer be asked as
    // "old id absent, new id present": those are now the SAME id and the question answers
    // itself. Ask instead what actually has to hold — the Scene edge SURVIVED the swap,
    // and the node it lands on is the baked one.
    const sceneChildren = next.nodes['n_scene'].inputs.children;
    expect(Array.isArray(sceneChildren)).toBe(true);
    const childRefs = (Array.isArray(sceneChildren) ? sceneChildren : []).map((r) => r.node);
    expect(childRefs).toContain(result.bakedId);
    expect(next.nodes[result.bakedId].type).toBe('BakedMesh');
    // Nothing points at an id that no longer exists — the real failure this guards.
    for (const n of Object.values(next.nodes)) {
      for (const binding of Object.values(n.inputs)) {
        for (const ref of Array.isArray(binding) ? binding : [binding]) {
          expect(next.nodes[ref.node]).toBeDefined();
        }
      }
    }
  });

  it('#412: an id-keyed reference to the applied node still resolves after the bake', async () => {
    // The POINT of id-inheritance, asserted on the thing it exists to protect. A
    // constraint is EDGE-LESS — it names its subject by id in `params.target`, so the
    // consumer-edge rewire is structurally blind to it. Under the old mint the target
    // pointed at a removed id and the constraint silently stopped firing; a dangling
    // `aimNode` was worse still, coercing to the origin so the object re-aimed at world
    // zero. Neither failure is visible in a node count or an edge walk, which is why this
    // asserts resolution rather than shape.
    const state = buildSplitSphereState();
    const withConstraint = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_track',
      nodeType: 'TrackTo',
      params: { target: PRIM_ID, aimNode: PRIM_ID, order: 0 },
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: withConstraint };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state: withConstraint,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = stateRef.current;
    const track = next.nodes['n_track'].params as { target: string; aimNode: string };
    // Both id refs still name a node that EXISTS — and specifically the baked one.
    expect(next.nodes[track.target]).toBeDefined();
    expect(next.nodes[track.aimNode]).toBeDefined();
    expect(track.target).toBe(result.bakedId);
    expect(next.nodes[track.target].type).toBe('BakedMesh');
  });

  it('#412: a HELD transient edit on the applied node does not survive onto the baked one', async () => {
    // The one hazard id-inheritance INTRODUCES rather than fixes. A transient is keyed by
    // `${nodeId}|${paramPath}` in a module-level store that only a frame change clears —
    // not selection, not undo. Under the old fresh id the stale key named a removed node
    // and every lookup missed; under inheritance it HITS, and resolveEvaluatedParam gives
    // a transient unconditional priority with no type check. The read surfaces would then
    // report a pre-bake offset while the viewport draws the baked mesh at the origin.
    const state = buildSplitSphereState();
    useTransientEditStore.getState().set(PRIM_ID, 'position', [9, 9, 9]);
    expect(useTransientEditStore.getState().get(PRIM_ID, 'position')).toBeDefined();

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      // NOT stubbed — the live store is the thing under test here.
    });
    expect(result.ok).toBe(true);

    expect(useTransientEditStore.getState().get(PRIM_ID, 'position')).toBeUndefined();
  });

  it("#412: the baked node keeps the user's name, not just the id", async () => {
    // `meta` lives on the node, so removeNode drops it. With the id inherited, an object
    // that keeps its constraints and its edges but loses its label reads as a different
    // object to the only observer who matters. The outliner falls back to `node.id` and
    // BakedMesh has no `name` param, so without this the row shows a raw id.
    const state = buildSplitSphereState();
    const named = applyOp(state, { type: 'setMeta', nodeId: PRIM_ID, name: 'Hero' }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: named };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state: named,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(stateRef.current.nodes[result.bakedId].meta?.name).toBe('Hero');
  });

  it('#259/H140: rewires a SINGLE-cardinality consumer socket (a modifier target) without rolling back', async () => {
    // The box feeds TWO consumers of different cardinality at once: Scene.children
    // (LIST) and an ArrayModifier's `target` (SINGLE). Before the fix, the single
    // socket's connect-before-disconnect threw ("bound producer is <baked>, not
    // n_box") and rolled back the whole atomic composite → Apply silently no-op'd.
    let state = buildSplitSphereState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_mod',
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0], muted: false },
    }).next;
    // box.out → n_mod.target (single). Box stays wired to Scene.children (list) too.
    state = applyOp(state, {
      type: 'connect',
      from: { node: PRIM_ID, socket: 'out' },
      to: { node: 'n_mod', socket: 'target' },
    }).next;
    // non-identity scale so Apply actually bakes.
    state = applyOp(state, {
      type: 'setParam',
      nodeId: PRIM_ID,
      paramPath: 'scale',
      value: [2, 1, 1],
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);

    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });

    expect(result.ok).toBe(true); // no rollback (the #259 regression)
    if (!result.ok) return;
    expect(calls).toHaveLength(1); // still ONE atomic composite

    const next = stateRef.current;
    expect(next.nodes[PRIM_ID].type).toBe('BakedMesh'); // baked away as a TYPE, id kept (#412)
    // the modifier's single `target` now points at the baked node (still a bare
    // ref, not promoted to a list), and Scene.children too.
    const modTarget = next.nodes['n_mod'].inputs.target;
    expect(Array.isArray(modTarget)).toBe(false);
    expect((modTarget as { node: string }).node).toBe(result.bakedId);

    // Undo round-trip: applying each op's inverse in reverse restores the box and
    // its single-socket binding (the applyConnect single-socket inverse path).
    const composite = calls[0];
    let fwd = state;
    const inverses: Op[] = [];
    for (const op of composite) {
      const r = applyOp(fwd, op);
      fwd = r.next;
      inverses.push(r.inverse);
    }
    let back = fwd;
    for (let i = inverses.length - 1; i >= 0; i--) back = applyOp(back, inverses[i]).next;
    // Under id-inheritance the id is present either way, so "toBeDefined" would pass
    // without undo running at all. Assert the TYPE came back — that is what undo restores.
    expect(back.nodes[PRIM_ID].type).toBe(state.nodes[PRIM_ID].type);
    expect(back.nodes[PRIM_ID].type).not.toBe('BakedMesh');
    expect((back.nodes['n_mod'].inputs.target as { node: string }).node).toBe(PRIM_ID);
  });

  it('awaits the OPFS write BEFORE the Op composite (reload-safe ordering)', async () => {
    const state = buildSplitSphereState();
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

    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
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
    let state = buildSplitSphereState();
    // Add a KeyframeChannelVec3 targeting the box position → animated.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'kf',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: PRIM_ID,
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
    }).next;

    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
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

  it('H45: baking one primitive does NOT corrupt the shared registry geometry', async () => {
    // A second split sphere with the SAME geometry params shares the registry key
    // `sphere|0.5|16|16` with PRIM_ID — the sibling that must still resolve to the unit
    // geometry after PRIM_ID bakes (proving the bake cloned first, not mutated in place).
    const state = makeSplitSphere(buildSplitSphereState(), {
      objectId: 'n_sphere2',
      radius: 0.5,
      widthSegments: 16,
      heightSegments: 16,
    }).state;

    // Prime the shared geometry by resolving + getting it before the bake.
    const sharedRef = {
      key: 'sphere|0.5|16|16',
      kind: 'sphere' as const,
      descriptor: {
        kind: 'sphere' as const,
        radius: 0.5,
        widthSegments: 16,
        heightSegments: 16,
      },
    };
    const sharedBefore = geometryRegistry.get(sharedRef)!;
    const posBefore = Float32Array.from(sharedBefore.getAttribute('position').array);

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    await dispatchApplyTransform(PRIM_ID, 'all', {
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

  it('a split cube (Object) bakes its pose, retiring the Object AND its BoxData (#376)', async () => {
    // The Slice-2 gap is closed: a posed Object over a BoxData bakes through the same
    // mechanism as the fused sphere. The PAIR retires — leaving the BoxData behind would
    // orphan it in the graph (no consumer, still saved).
    let state = buildSceneScaffold();
    const cube = makeSplitCube(state, {
      objectId: 'n_cube',
      position: [2, 0, 0],
      connectTo: { node: state.outputs.scene!.node, socket: 'children' },
    });
    state = cube.state;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(cube.objectId, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });

    expect(result.ok).toBe(true);
    const next = stateRef.current;
    // Both halves of the pair are retired as NODES — but the OBJECT's id is inherited by
    // the BakedMesh (#412), so it survives as an identity while its type changes. Only the
    // data node's id genuinely disappears (nothing replaces it).
    const bakedId = (result as { ok: true; bakedId: string }).bakedId;
    expect(bakedId).toBe(cube.objectId);
    expect(next.nodes[cube.objectId].type).toBe('BakedMesh');
    expect(next.nodes[cube.dataId]).toBeUndefined();
    expect(Object.values(next.nodes).some((n) => n.type === 'Object')).toBe(false);

    // The pose baked INTO the geometry: the BakedMesh sits at identity, and the geometry's
    // bbox carries the Object's +2 x-offset (bake-what-renders, not a re-posed node).
    expect(next.nodes[bakedId].params.position).toEqual([0, 0, 0]);
    const ref = next.nodes[bakedId].params.geometry as {
      descriptor: { hash: string; vertexCount: number };
    };
    const geom = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    geom.computeBoundingBox();
    expect(geom.boundingBox!.min.x).toBeCloseTo(1.5, 5);
    expect(geom.boundingBox!.max.x).toBeCloseTo(2.5, 5);
    expect(calls).toHaveLength(1); // ONE atomic composite = one Cmd+Z
  });

  it('a SHARED BoxData survives the bake — only the baking Object retires (#376 fan-out)', async () => {
    // Two Objects posing ONE BoxData. Baking the first must not consume the data node, or
    // the sibling Object renders empty. The exclusivity guard is what makes fan-out (#391)
    // safe to expose later.
    let state = buildSceneScaffold();
    const sceneId = state.outputs.scene!.node;
    const first = makeSplitCube(state, {
      objectId: 'n_cube_a',
      dataId: 'n_shared_data',
      position: [2, 0, 0],
      connectTo: { node: sceneId, socket: 'children' },
    });
    state = first.state;
    // A second Object bound to the SAME data node.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cube_b',
      nodeType: 'Object',
      params: { position: [-2, 0, 0] },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_shared_data', socket: 'out' },
      to: { node: 'n_cube_b', socket: 'data' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cube_b', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    }).next;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_cube_a', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });

    expect(result.ok).toBe(true);
    const next = stateRef.current;
    expect(next.nodes['n_cube_a'].type).toBe('BakedMesh'); // the baked Object retired (id kept)
    expect(next.nodes['n_shared_data']).toBeDefined(); // the SHARED data survived
    expect(next.nodes['n_cube_b']).toBeDefined(); // …and the sibling still poses it
    expect(next.nodes['n_cube_b'].inputs.data).toEqual({ node: 'n_shared_data', socket: 'out' });
  });

  it('undo restores BOTH halves of a baked split cube (one Cmd+Z)', async () => {
    // The bake retires two nodes in one composite, so undo has to bring both back. The
    // sphere's undo round-trip (SC-5) only ever exercised a ONE-node retirement, so this
    // is genuinely new ground rather than a re-assertion — the second removeNode is the
    // part that could have had no inverse.
    let state = buildSceneScaffold();
    const cube = makeSplitCube(state, {
      objectId: 'n_cube',
      position: [2, 0, 0],
      connectTo: { node: state.outputs.scene!.node, socket: 'children' },
    });
    state = cube.state;

    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(cube.objectId, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result.ok).toBe(true);
    expect(stateRef.current.nodes[cube.objectId].type).toBe('BakedMesh'); // id kept (#412)
    expect(stateRef.current.nodes[cube.dataId]).toBeUndefined();

    // Apply each op's inverse in reverse — the same round-trip SC-5 uses.
    const composite = calls[0];
    let fwd = state;
    const inverses: Op[] = [];
    for (const op of composite) {
      const r = applyOp(fwd, op);
      fwd = r.next;
      inverses.push(r.inverse);
    }
    let back = fwd;
    for (let i = inverses.length - 1; i >= 0; i--) back = applyOp(back, inverses[i]).next;

    // Both halves are back AND re-wired to each other — restoring the nodes without the
    // `data` edge would leave a cube that renders nothing, which is the failure this
    // asserts against rather than merely counting nodes.
    // The Object's id is present either way (inherited), so assert its TYPE came back —
    // `toBeDefined` alone would now pass without undo having run.
    expect(back.nodes[cube.objectId].type).toBe('Object');
    expect(back.nodes[cube.dataId]).toBeDefined();
    expect(back.nodes[cube.objectId].inputs.data).toEqual({ node: cube.dataId, socket: 'out' });
  });
});

describe('#411 — the animated guard covers every param the bake consumes', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
    geometryRegistry.clear();
  });

  /** A channel of `type` driving `paramPath` on `target`. */
  function withChannel(
    state: DagState,
    type: string,
    target: string,
    paramPath: string,
    keyframes: unknown[],
  ): DagState {
    return applyOp(state, {
      type: 'addNode',
      nodeId: `kf_${paramPath}`,
      nodeType: type,
      params: { name: paramPath, target, paramPath, keyframes },
    }).next;
  }

  it('rejects a split sphere whose radius is animated — the channel targets the DATA node', async () => {
    // The bake resolves geometry from `radius`, so freezing it at the current frame destroys
    // the animation exactly as freezing a TRS band would. `radius` lives on the SphereData now,
    // so the guard must reach through the selected Object's `data` edge to see the channel —
    // the same reach the split-cube `size` case below exercises. The old guard enumerated
    // position/rotation/scale and never saw geometry params at all.
    let state = buildSplitSphereState();
    state = withChannel(state, 'KeyframeChannelNumber', PRIM_DATA_ID, 'radius', [
      { time: 0, value: 0.5, easing: 'linear' },
      { time: 1, value: 2, easing: 'linear' },
    ]);

    // The guard is asked about the OBJECT (what the user selects) and still finds the data
    // node's channel.
    expect(isApplySourceAnimated(state, PRIM_ID, 30)).toBe(true);

    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage,
      currentFrame: 30,
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('animated');
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('rejects a SPLIT cube whose size is animated — the channel targets the DATA node', async () => {
    // The reach is the whole point: `size` lives on the BoxData, so asking only the
    // selected Object returns the honest answer "nothing animated here" and the bake
    // proceeds. Observed on `main` as ok:true with the animation silently gone.
    let state = emptyDagState();
    const cube = makeSplitCube(state, { objectId: 'n_cube', size: [1, 1, 1] });
    state = withChannel(cube.state, 'KeyframeChannelVec3', cube.dataId, 'size', [
      { time: 0, value: [1, 1, 1], easing: 'linear' },
      { time: 1, value: [3, 1, 1], easing: 'linear' },
    ]);

    // The guard must be asked about the OBJECT (what the user selects) and still
    // find the data node's channel.
    expect(isApplySourceAnimated(state, cube.objectId, 30)).toBe(true);

    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform(cube.objectId, 'all', {
      state,
      storage,
      currentFrame: 30,
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('animated');
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('rejects an animated MATERIAL on the data node — the bake captures material too', () => {
    let state = emptyDagState();
    const cube = makeSplitCube(state, { objectId: 'n_cube', size: [1, 1, 1] });
    state = withChannel(cube.state, 'KeyframeChannelColor', cube.dataId, 'material.base.color', [
      { time: 0, value: '#ff0000', easing: 'linear' },
      { time: 1, value: '#00ff00', easing: 'linear' },
    ]);
    expect(isApplySourceAnimated(state, cube.objectId, 30)).toBe(true);
  });

  it('leaves a STATIC split cube offerable — the guard did not become blanket-true', () => {
    const cube = makeSplitCube(emptyDagState(), { objectId: 'n_cube', size: [1, 1, 1] });
    expect(isApplySourceAnimated(cube.state, cube.objectId, 30)).toBe(false);
    expect(canApplyTransform(cube.state, cube.objectId)).toBe(true);
  });

  it('ignores a channel targeting an UNRELATED node', () => {
    let state = emptyDagState();
    const cube = makeSplitCube(state, { objectId: 'n_cube', size: [1, 1, 1] });
    const other = makeSplitCube(cube.state, { objectId: 'n_other', size: [1, 1, 1] });
    state = withChannel(other.state, 'KeyframeChannelVec3', other.dataId, 'size', [
      { time: 0, value: [1, 1, 1], easing: 'linear' },
      { time: 1, value: [3, 1, 1], easing: 'linear' },
    ]);
    // The neighbour's animation must not block this cube's bake.
    expect(isApplySourceAnimated(state, cube.objectId, 30)).toBe(false);
    expect(isApplySourceAnimated(state, other.objectId, 30)).toBe(true);
  });
});

describe('canApplyTransform — the offer side of the boundary-pair (#376)', () => {
  it('offers Apply for a split cube, and NOT for an Empty Object', () => {
    // The predicate the menu item and the NPanel control both consume. Admitting every
    // `Object` by type alone left Apply enabled for an Empty, which then failed with an
    // internal-sounding "could not resolve mesh" — an affordance that promises something
    // the dispatcher will refuse.
    let state = buildSplitSphereState();
    const cube = makeSplitCube(state, { objectId: 'n_cube' });
    state = cube.state;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_empty',
      nodeType: 'Object',
      params: {},
    }).next;

    expect(canApplyTransform(state, cube.objectId)).toBe(true);
    expect(canApplyTransform(state, 'n_empty')).toBe(false);
    expect(canApplyTransform(state, PRIM_ID)).toBe(true); // the split sphere (Object + data)
    expect(canApplyTransform(state, 'no_such_node')).toBe(false);
  });

  it('agrees with the dispatcher — anything it refuses is never offered', async () => {
    // The property that makes this a boundary-pair rather than a second list: for an
    // Empty, the predicate says no AND the dispatcher rejects. If these ever diverge the
    // UI is lying about what will happen.
    let state = buildSceneScaffold();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_empty',
      nodeType: 'Object',
      params: {},
    }).next;

    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_empty', 'all', {
      state,
      storage: new MemoryStorage(),
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });

    expect(canApplyTransform(state, 'n_empty')).toBe(false);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0); // refused before any mutation
  });
});

// ---------------------------------------------------------------------------
// glTF-child path (Wave 4 Task 10) — the R-1 edge-less satellite.
// ---------------------------------------------------------------------------
//
// Pins the DAG-side contract with a MOCKED live clone (the real render proof is
// the t11 e2e against a textured fixture). A map-LESS MeshStandardMaterial is used
// so captureBakedMaterial never invokes the canvas readback (happy-dom has no
// decoder) — the textured capture is the e2e's job.
//
// REF: PLAN.md Wave 4 Task 10; RESEARCH §Q1/§Q4/§M2/§M7; hetvabhasa H45/H58/H59.

const ASSET_REF = 'assets/textured.glb';
const CHILD_NAME = 'Cube';

/** A state with a GltfAsset (→Scene.children) + one GltfChild proxy at scale 2. */
function gltfChildState() {
  let state = buildSceneScaffold();
  const sceneId = state.outputs.scene!.node;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET_REF, nodeNameMap: { [CHILD_NAME]: 'n_child' } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'n_gltf', socket: 'out' },
    to: { node: sceneId, socket: 'children' },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'n_child',
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET_REF,
      childName: CHILD_NAME,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
      overridden: { position: false, rotation: false, scale: true },
    },
  }).next;
  return state;
}

/** A fake render clone: a Group holding one named unit-box Mesh + a map-less
 *  MeshStandardMaterial. Mirrors what GltfAssetR registers. */
function fakeClone(): THREE.Group {
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: '#abcdef', roughness: 0.25, metalness: 0.75 }),
  );
  mesh.name = CHILD_NAME;
  grp.add(mesh);
  return grp;
}

describe('dispatchApplyTransform (glTF child)', () => {
  it('bakes resolved geom + rich material, removes GltfChild, suppresses by name, ONE atomic', async () => {
    const state = gltfChildState();
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const selected: string[] = [];

    const result = await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: (id) => selected.push(id),
      gltfClone: fakeClone(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1); // ONE Cmd+Z

    const next = stateRef.current;
    // GltfChild removed; one BakedMesh added with the rich captured spec.
    expect(next.nodes['n_child']).toBeUndefined();
    const baked = next.nodes[result.bakedId];
    expect(baked.type).toBe('BakedMesh');
    expect(baked.params.scale).toEqual([1, 1, 1]);
    const spec = baked.params.material as { color: string; roughness: number; metalness: number };
    expect(spec.color).toBe('#abcdef'); // captured from the live clone material
    expect(spec.roughness).toBeCloseTo(0.25, 5);
    expect(spec.metalness).toBeCloseTo(0.75, 5);

    // suppressedChildren appended on the owning asset (no double-render).
    expect(next.nodes['n_gltf'].params.suppressedChildren).toEqual([CHILD_NAME]);
    // selection moved to the baked node.
    expect(selected).toEqual([result.bakedId]);

    // SC-2 (resolver half) — the baked geometry carries the scale=2 (2×2×2 box).
    const ref = baked.params.geometry as { descriptor: { hash: string; vertexCount: number } };
    const geom = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    geom.computeBoundingBox();
    const size = new Vector3();
    new Box3(geom.boundingBox!.min, geom.boundingBox!.max).getSize(size);
    expect(size.x).toBeCloseTo(2, 4);
    expect(size.y).toBeCloseTo(2, 4);
    expect(size.z).toBeCloseTo(2, 4);
  });

  it('H45: the live clone geometry is NOT mutated by the bake', async () => {
    const state = gltfChildState();
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const clone = fakeClone();
    const childGeom = (clone.getObjectByName(CHILD_NAME) as THREE.Mesh).geometry;
    const posBefore = Float32Array.from(childGeom.getAttribute('position').array);

    await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      gltfClone: clone,
    });

    const posAfter = childGeom.getAttribute('position').array;
    expect(Array.from(posAfter)).toEqual(Array.from(posBefore));
  });

  it('rejects with no live clone (asset not rendered) — no mutation', async () => {
    const state = gltfChildState();
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
      // no gltfClone injected, and the registry is empty for this assetRef.
    });
    expect(result.ok).toBe(false);
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('SC-8 (C-2): a CLIP-driven child rejects (D-04 clip half), DAG byte-unchanged', async () => {
    // The keyframe-channel half of the animated guard is covered above; THIS
    // pins the OTHER half — `isGltfChildClipDriven`. A TransformClip wired into
    // the owning GltfAsset's `transformClip` socket, carrying a track keyed for
    // this child's name, drives the child via clip sampling
    // (resolveEvaluatedTransform.ts:206 reads the SAME `sample(seconds)[name]`).
    // Baking a single static pose would silently freeze the animation, so Apply
    // must reject with the animated reason — no OPFS write, no dispatch.
    let state = gltfChildState();
    // A TransformClip whose track targets CHILD_NAME ("Cube") — a non-trivial
    // motion (position 0→5 over 2s) so sampling at a mid-frame is non-identity.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_clip',
      nodeType: 'TransformClip',
      params: {
        name: 'walk',
        duration: 2,
        loop: 'clamp',
        keyframes: [
          { targetNodeId: CHILD_NAME, time: 0, position: [0, 0, 0] },
          { targetNodeId: CHILD_NAME, time: 2, position: [5, 0, 0] },
        ],
      },
    }).next;
    // Wire the clip into the owning GltfAsset's transformClip input — this is
    // the edge the renderer (GltfAssetR) + the guard both read.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_clip', socket: 'out' },
      to: { node: 'n_gltf', socket: 'transformClip' },
    }).next;

    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 60, // 1.0s — mid-clip, the track samples to [2.5,0,0]
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
      gltfClone: fakeClone(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('animated'); // the clip-driven half fired
    // No mutation, no OPFS write — proving the reject is BEFORE any side effect.
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('SC-8 extend: a keyframed child rejects (D-04), DAG byte-unchanged', async () => {
    let state = gltfChildState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'kf',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: 'n_child',
        paramPath: 'position',
        keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
      },
    }).next;
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 30,
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
      gltfClone: fakeClone(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('animated');
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
