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
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { useTransientEditStore } from '../stores/transientEditStore';
import * as geometryRegistry from '../geometryRegistry';
import { readBakedGeometry } from '../asset/bakedGeometryStore';
import { evaluatedMeshFromMeshData, resolveEvaluatedMesh } from '../resolveEvaluatedMesh';
import { resolveWorldTransform } from '../resolveWorldTransform';
import {
  dispatchApplyTransform,
  canApplyTransform,
  isApplySourceAnimated,
  unheldAttributesBakeRefusal,
} from './dispatchApplyTransform';
import { makeSplitCube } from '../../test-utils/splitCube';
import { makeSplitSphere } from '../../test-utils/splitSphere';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { makeSplitLight } from '../../test-utils/splitLight';
import { importedChildOps } from '../../test-utils/importedChildFixture';
import { twoMaterialMeshData } from '../../test-utils/twoMaterialMesh';
import { materialAssignmentOf } from '../materialAssignment';

// #1132 — the registry road's material refusals read `mesh.materials`, and no real node yet
// resolves to a two-material or clone-owned assignment on that road. The mock passes straight
// through to the real resolver unless a test swaps one answer for a mesh with those materials.
vi.mock('../resolveEvaluatedMesh', async (importOriginal) => {
  const real = await importOriginal<typeof import('../resolveEvaluatedMesh')>();
  return { ...real, resolveEvaluatedMesh: vi.fn(real.resolveEvaluatedMesh) };
});
import { packMeshData, unpackMeshData, type PackedMeshData } from '../meshGeometryData';
import { gltfJsonMaterialToOpenpbr } from '../../core/import/gltfJsonMaterialToOpenpbr';
import type { EvaluatedMesh, InlineMaterialSpec, MeshGeometryData, Vec3 } from '../../nodes/types';

/** The DATA half of a split pair — reached through the `data` edge, never by id spelling.
 *  #388 made this the load-bearing question in this file: an Apply now mints an
 *  `Object` + `BakedData` pair, and a split primitive is ALSO an `Object`, so the node's
 *  own `type` no longer changes across a bake. What changes is what it POSES. */
function dataHalfOf(state: DagState, objectId: string) {
  const binding = state.nodes[objectId]?.inputs?.data;
  const ref = Array.isArray(binding) ? binding[0] : binding;
  return ref ? state.nodes[ref.node] : undefined;
}

/**
 * The Objects that pose GEOMETRY — the population the bake assertions are about.
 *
 * They used to enumerate every Object, which was only equivalent while the scaffold's camera
 * and light were fused kinds. Post-split those are Objects too and are permanent frame, not
 * leftovers, so an unfiltered walk reports them as survivors of a bake they had nothing to do
 * with. The claim being made is "the SOURCE mesh pair was retired and exactly one mesh Object
 * remains", so the filter is on what the Object poses, not on its type.
 */
function meshObjectIds(state: DagState): string[] {
  const MESH_DATA = new Set(['BoxData', 'SphereData', 'CurveData', 'BakedData']);
  return Object.values(state.nodes)
    .filter((n) => n.type === 'Object' && MESH_DATA.has(dataHalfOf(state, n.id)?.type ?? ''))
    .map((n) => n.id);
}

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
  // The camera and the light are split pairs too — the scaffold is the frame the bake
  // assertions count Objects against, so a fused one there would be an Object the split road
  // never produces.
  s = makeSplitCamera(s, {
    objectId: 'n_camera',
    fov: 45,
    position: [3, 2, 3],
    lens: { near: 0.01, far: 500, lookAt: [0, 0, 0] },
  }).state;
  s = makeSplitLight(s, {
    objectId: 'n_light',
    lightKind: 'Directional',
    position: [5, 5, 3],
    shading: { intensity: 1.1, color: '#ffffff' },
  }).state;
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
  registerAllNodes();
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
    expect(next.nodes[PRIM_ID].type).toBe('Object');
    // #388 — the bake mints the PAIR, so what sits at the inherited id is an Object POSING
    // a BakedData. The split sphere is gone: its SphereData half retired, and exactly one
    // BakedData exists — the one this Object poses.
    const bakedData = dataHalfOf(next, PRIM_ID);
    expect(bakedData?.type).toBe('BakedData');
    expect(Object.values(next.nodes).filter((n) => n.type === 'BakedData')).toHaveLength(1);
    expect(next.nodes[PRIM_DATA_ID]).toBeUndefined();
    // Exactly ONE Object, the baked one at the inherited id. This used to read "no Object
    // survives"; post-flip the bake's own product is an Object, so the assertion has to
    // name WHICH — a second one would mean the source pair was never retired.
    expect(meshObjectIds(next)).toEqual([PRIM_ID]);
    const baked = next.nodes[result.bakedId];
    expect(baked).toBeDefined();
    expect(baked.type).toBe('Object');
    // transform identity (the TRS is baked into the verts).
    expect(baked.params.position).toEqual([0, 0, 0]);
    expect(baked.params.scale).toEqual([1, 1, 1]);
    // selection moved to the baked node.
    expect(selected).toEqual([result.bakedId]);

    // SC-1 — the baked geometry bbox is 2×1×1 (the unit box scaled on X).
    // The buffer handle lives on the DATA half now, not on the posed node.
    const ref = bakedData!.params.geometry as {
      descriptor: { hash: string; vertexCount: number };
    };
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
    expect(next.nodes[result.bakedId].type).toBe('Object');
    expect(dataHalfOf(next, result.bakedId)?.type).toBe('BakedData');
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
    expect(next.nodes[track.target].type).toBe('Object');
    expect(dataHalfOf(next, track.target)?.type).toBe('BakedData');
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

  it('#259/H140: rewires a SINGLE-cardinality consumer socket (a wrapper target) without rolling back', async () => {
    // The box feeds TWO consumers of different cardinality at once: Scene.children
    // (LIST) and a wrapper's `target` (SINGLE). Before the fix, the single socket's
    // connect-before-disconnect threw ("bound producer is <baked>, not n_box") and
    // rolled back the whole atomic composite → Apply silently no-op'd.
    //
    // ⚠️ #415 RE-ANCHORED THE WRAPPER, and the reason is worth stating: this case used
    // an `ArrayModifier`, whose `target` was the handiest single-cardinality socket
    // taking a `SceneObject`. It no longer takes one — a modifier consumes `ObjectData`
    // now, so an Object cannot be wired into it and the fixture could not be built at
    // all. `Transform` is the same SHAPE (single-cardinality `target: SceneObject`) and
    // is what the invariant was always about: the subject here is `applyConnect`'s
    // single-socket rewire, not anything specific to modifiers.
    let state = buildSplitSphereState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_mod',
      nodeType: 'Transform',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
    // Baked away, id kept (#412). Post-#388 the id holds an Object either way, so the
    // BAKE is visible in what it poses, not in the node's own type.
    expect(dataHalfOf(next, PRIM_ID)?.type).toBe('BakedData');
    // the wrapper's single `target` now points at the baked node (still a bare
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
    // ⚠️ #388 — the TYPE comparison alone is now VACUOUS: a split sphere and a baked pair
    // both put an `Object` at this id, so it passes whether or not undo ran. The DATA half
    // is the discriminator, so assert the pair's substance came back.
    expect(back.nodes[PRIM_ID].type).toBe(state.nodes[PRIM_ID].type);
    expect(dataHalfOf(back, PRIM_ID)?.type).toBe(dataHalfOf(state, PRIM_ID)?.type);
    expect(dataHalfOf(back, PRIM_ID)?.type).not.toBe('BakedData');
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
    const sharedBefore = geometryRegistry.getForRead(sharedRef)!;
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
    const posAfter = geometryRegistry.getForRead(sharedRef)!.getAttribute('position').array;
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
    // The source pair is retired as NODES — but the OBJECT's id is inherited by the bake's
    // own Object (#412), so it survives as an identity while what it poses changes from a
    // BoxData to a BakedData. The source data node's id genuinely disappears.
    const bakedId = (result as { ok: true; bakedId: string }).bakedId;
    expect(bakedId).toBe(cube.objectId);
    expect(next.nodes[cube.objectId].type).toBe('Object');
    expect(dataHalfOf(next, cube.objectId)?.type).toBe('BakedData');
    expect(next.nodes[cube.dataId]).toBeUndefined();
    expect(Object.values(next.nodes).some((n) => n.type === 'BoxData')).toBe(false);
    expect(meshObjectIds(next)).toEqual([cube.objectId]);

    // The pose baked INTO the geometry: the baked Object sits at identity, and the
    // geometry's bbox carries the source Object's +2 x-offset (bake-what-renders, not a
    // re-posed node). The handle is on the DATA half.
    expect(next.nodes[bakedId].params.position).toEqual([0, 0, 0]);
    const ref = dataHalfOf(next, bakedId)!.params.geometry as {
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
    expect(dataHalfOf(next, 'n_cube_a')?.type).toBe('BakedData'); // baked (id kept, #412)
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
    expect(dataHalfOf(stateRef.current, cube.objectId)?.type).toBe('BakedData'); // id kept (#412)
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

describe('#1077 — Apply over stored mesh data applies INTO it, and never bakes', () => {
  const OBJ = 'n_stored';
  const DATA = 'n_stored_data';
  type Pose = { position: Vec3; rotation: Vec3; scale: Vec3 };

  // A cube off the origin, every face wound outward, with per-corner UVs and outward normals, so
  // every array a transform touches has something to get wrong.
  function cubeData(turnZDegrees = 0): MeshGeometryData {
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    const faces = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [1, 2, 6, 5],
      [3, 0, 4, 7],
    ];
    const axes = [
      [0, 0, -1],
      [0, 0, 1],
      [0, -1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [-1, 0, 0],
    ];
    // Optionally turned about z IN THE DATA, so its faces are not aligned with a scale axis: under
    // a scale along an axis a face is aligned with, a normal carried by the plain matrix and one
    // carried by the normal matrix point the same way, and a test could not tell them apart.
    const turn = new THREE.Matrix4().makeRotationZ((turnZDegrees * Math.PI) / 180);
    const turned = (xyz: number[], w: 0 | 1) =>
      w === 1
        ? new Vector3(...(xyz as Vec3)).applyMatrix4(turn).toArray()
        : new Vector3(...(xyz as Vec3)).transformDirection(turn).toArray();
    return {
      points: Float32Array.from(
        corners.flatMap(([x, y, z]) => turned([x * 0.5 + 0.3, y * 0.5 + 0.1, z * 0.5 - 0.2], 1)),
      ),
      faceSizes: Uint32Array.from(faces.map((f) => f.length)),
      cornerPoints: Uint32Array.from(faces.flat()),
      cornerLayers: [
        {
          name: 'UVMap',
          type: 'float2' as const,
          data: Float32Array.from(faces.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1])),
        },
      ],
      cornerNormals: Float32Array.from(axes.flatMap((a) => Array(4).fill(turned(a, 0)).flat())),
      faceLayers: [],
    };
  }

  // A material an import really writes, carrying the fields a baked spec has no room for, plus a
  // base map that points at an image the project holds.
  const MATERIAL: InlineMaterialSpec = (() => {
    const m = gltfJsonMaterialToOpenpbr({
      pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], roughnessFactor: 0.8 },
      doubleSided: true,
      alphaMode: 'MASK',
      alphaCutoff: 0.3,
    });
    return {
      ...m,
      maps: {
        ...m.maps,
        albedo: {
          hash: 'abc.png',
          store: 'project',
          colorSpace: 'srgb',
          flipY: false,
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
          magFilter: THREE.NearestFilter,
          minFilter: THREE.NearestFilter,
        },
      },
    };
  })();

  /** The id of the `i`th operator `build` splices between the mesh data and the Object. */
  const opId = (i: number) => `n_stored_op${i}`;

  function build(
    pose: Pose,
    opts: {
      /** A second Object wearing the mesh data (`base`) or the top of the stack (`top`). */
      sharedAt?: 'base' | 'top';
      turnZDegrees?: number;
      /** Operator node types spliced, bottom first, between the mesh data and the Object. */
      between?: readonly string[];
    } = {},
  ): DagState {
    const s = buildSceneScaffold();
    const scene = s.outputs.scene!.node;
    const between = opts.between ?? [];
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: DATA,
        nodeType: 'PolyMeshData',
        params: { mesh: packMeshData(cubeData(opts.turnZDegrees)), material: MATERIAL },
      },
      { type: 'addNode', nodeId: OBJ, nodeType: 'Object', params: { ...pose } },
    ];
    let below = DATA;
    between.forEach((type, i) => {
      ops.push(
        { type: 'addNode', nodeId: opId(i), nodeType: type, params: {} },
        {
          type: 'connect',
          from: { node: below, socket: 'out' },
          to: { node: opId(i), socket: 'target' },
        },
      );
      below = opId(i);
    });
    ops.push(
      { type: 'connect', from: { node: below, socket: 'out' }, to: { node: OBJ, socket: 'data' } },
      {
        type: 'connect',
        from: { node: OBJ, socket: 'out' },
        to: { node: scene, socket: 'children' },
      },
    );
    if (opts.sharedAt) {
      ops.push(
        { type: 'addNode', nodeId: 'n_stored_b', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: opts.sharedAt === 'base' ? DATA : below, socket: 'out' },
          to: { node: 'n_stored_b', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'n_stored_b', socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
      );
    }
    return applyAll(s, ops);
  }

  async function apply(state: DagState, mask: 'all' | 'location' | 'rotation' | 'scale') {
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const cleared: string[] = [];
    const selected: string[] = [];
    const storage = new MemoryStorage();
    const result = await dispatchApplyTransform(OBJ, mask, {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      clearTransients: (id) => cleared.push(id),
      setSelection: (id) => selected.push(id),
    });
    return { result, next: stateRef.current, calls, cleared, selected, storage };
  }

  /** The Object's matrix as three builds it for the draw (an Object3D, rotation in radians). */
  function objectMatrix(state: DagState): THREE.Matrix4 {
    const pose = state.nodes[OBJ].params as Pose;
    const o = new THREE.Object3D();
    o.position.set(...pose.position);
    o.rotation.set(...(pose.rotation.map((d) => (d * Math.PI) / 180) as Vec3));
    o.scale.set(...pose.scale);
    o.updateMatrix();
    return o.matrix;
  }

  function storedOf(state: DagState): MeshGeometryData {
    return unpackMeshData(state.nodes[DATA].params.mesh as PackedMeshData);
  }

  function worldPoints(state: DagState): number[][] {
    const m = objectMatrix(state);
    const { points } = storedOf(state);
    const out: number[][] = [];
    for (let i = 0; i < points.length; i += 3) {
      out.push(new Vector3().fromArray(points, i).applyMatrix4(m).toArray());
    }
    return out;
  }

  function expectSameWorld(a: number[][], b: number[][]) {
    expect(a.length).toBe(b.length);
    const worst = Math.max(...a.flatMap((p, i) => p.map((x, k) => Math.abs(x - b[i][k]))));
    expect(worst).toBeLessThan(1e-4);
  }

  /** Per face, in the stored mesh's own space: is it wound inward, and are its corner normals? */
  function inwardCounts(data: MeshGeometryData): { faces: number; normals: number } {
    const at = (p: number) => new Vector3().fromArray(data.points, p * 3);
    const centre = new Vector3();
    for (let i = 0; i < data.points.length / 3; i++) centre.add(at(i));
    centre.divideScalar(data.points.length / 3);
    let faces = 0;
    let normals = 0;
    let start = 0;
    for (const size of data.faceSizes) {
      const rim = Array.from(data.cornerPoints.subarray(start, start + size)).map(at);
      const outward = rim
        .reduce((acc, p) => acc.add(p), new Vector3())
        .divideScalar(size)
        .sub(centre);
      const winding = new Vector3()
        .subVectors(rim[1], rim[0])
        .cross(new Vector3().subVectors(rim[2], rim[0]));
      if (winding.dot(outward) <= 0) faces++;
      for (let c = start; c < start + size; c++) {
        if (
          data.cornerNormals &&
          new Vector3().fromArray(data.cornerNormals, c * 3).dot(outward) <= 0
        )
          normals++;
      }
      start += size;
    }
    return { faces, normals };
  }

  const POSE: Pose = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 1, 0.5] };

  it('moves the pose into the mesh data: the same Object poses the same PolyMeshData, the world shape is unchanged', async () => {
    const state = build(POSE);
    const before = worldPoints(state);
    const { result, next, calls, storage } = await apply(state, 'all');

    expect(result.ok).toBe(true);
    expect(next.nodes[OBJ].inputs.data).toEqual({ node: DATA, socket: 'out' });
    expect(next.nodes[DATA].type).toBe('PolyMeshData');
    expect(Object.values(next.nodes).some((n) => n.type === 'BakedData')).toBe(false);
    expect(next.nodes[OBJ].params).toMatchObject({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expectSameWorld(worldPoints(next), before);
    expect(calls).toHaveLength(1); // one Cmd+Z
    // Nothing went to the baked stores: there is no bake.
    expect(await storage.list('')).toEqual([]);
  });

  it('keeps the material exactly: every scalar, the alpha cutoff, double-siding and the project map ref', async () => {
    const { result, next } = await apply(build(POSE), 'all');
    expect(result.ok).toBe(true);
    expect(next.nodes[DATA].params.material).toEqual(MATERIAL);
    const kept = next.nodes[DATA].params.material as InlineMaterialSpec;
    expect(kept.specular.roughness).toBe(0.8);
    expect(kept.geometry).toMatchObject({ alphaCutoff: 0.3, doubleSided: true });
    expect(kept.maps.albedo).toMatchObject({ hash: 'abc.png', store: 'project' });
  });

  it.each(['location', 'rotation', 'scale'] as const)(
    'Apply %s resets only that band and keeps the world shape (a non-uniform scale stays on for rotation)',
    async (mask) => {
      const state = build(POSE);
      const before = worldPoints(state);
      const { result, next } = await apply(state, mask);
      expect(result.ok).toBe(true);
      const band = { location: 'position', rotation: 'rotation', scale: 'scale' }[
        mask
      ] as keyof Pose;
      const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }[band];
      const params = next.nodes[OBJ].params as Pose;
      for (const other of ['position', 'rotation', 'scale'] as const) {
        expect(params[other]).toEqual(other === band ? identity : POSE[other]);
      }
      expectSameWorld(worldPoints(next), before);
    },
  );

  it('a mirroring Apply reverses each face (first corner kept) so no face and no normal points inward', async () => {
    const state = build({ position: [0, 0, 0], rotation: [0, 15, 0], scale: [-1, 1, 1] });
    expect(inwardCounts(storedOf(state))).toEqual({ faces: 0, normals: 0 }); // the fixture is sound
    const firstCorners = (d: MeshGeometryData) =>
      [0, 4, 8, 12, 16, 20].map((c) => d.cornerPoints[c]);
    const firstBefore = firstCorners(storedOf(state));
    const before = worldPoints(state);

    const { result, next } = await apply(state, 'all');
    expect(result.ok).toBe(true);
    expectSameWorld(worldPoints(next), before);
    expect(inwardCounts(storedOf(next))).toEqual({ faces: 0, normals: 0 });
    expect(firstCorners(storedOf(next))).toEqual(firstBefore);
  });

  it('corner layers (a second UV set, a colour) keep their values and move with their corners, under a plain and a mirroring Apply', async () => {
    const mirroring: Pose = { position: [0, 0, 0], rotation: [0, 15, 0], scale: [-1, 1, 1] };
    for (const pose of [POSE, mirroring]) {
      const base = build(pose);
      const cube = storedOf(base);
      const corners = cube.cornerPoints.length;
      // A distinct value at every corner, so a layer left behind when corners reorder cannot pass.
      const layered: MeshGeometryData = {
        ...cube,
        cornerLayers: [
          ...cube.cornerLayers,
          {
            name: 'UVMap.001',
            type: 'float2',
            data: Float32Array.from({ length: corners * 2 }, (_, i) => i / 2),
          },
          {
            name: 'Color',
            type: 'float4',
            data: Float32Array.from({ length: corners * 4 }, (_, i) => i / (corners * 4)),
          },
        ],
      };
      const state = applyAll(base, [
        { type: 'setParam', nodeId: DATA, paramPath: 'mesh', value: packMeshData(layered) },
      ]);
      /** Per (face, point): every layer's values at the corner of that face sitting on that point. */
      const byFacePoint = (d: MeshGeometryData) => {
        const out = new Map<string, number[][]>();
        let c = 0;
        d.faceSizes.forEach((size, f) => {
          for (let k = 0; k < size; k++, c++) {
            out.set(
              `${f}:${d.cornerPoints[c]}`,
              d.cornerLayers.map((l) => {
                const w = l.data.length / d.cornerPoints.length;
                return Array.from(l.data.subarray(c * w, c * w + w));
              }),
            );
          }
        });
        return out;
      };
      const before = byFacePoint(storedOf(state));

      const { result, next } = await apply(state, 'all');
      expect(result.ok, `Apply under ${JSON.stringify(pose.scale)}`).toBe(true);
      const after = storedOf(next);
      expect(after.cornerLayers.map((l) => [l.name, l.type])).toEqual([
        ['UVMap', 'float2'],
        ['UVMap.001', 'float2'],
        ['Color', 'float4'],
      ]);
      expect(byFacePoint(after), `layers under ${JSON.stringify(pose.scale)}`).toEqual(before);
    }
  });

  it('corner normals follow their faces under a rotation and a non-uniform scale', async () => {
    const { result, next } = await apply(
      build({ position: [0, 0, 0], rotation: [0, 0, 30], scale: [3, 1, 1] }, { turnZDegrees: 40 }),
      'all',
    );
    expect(result.ok).toBe(true);
    const d = storedOf(next);
    let start = 0;
    let worst = 1;
    for (const size of d.faceSizes) {
      const rim = [0, 1, 2].map((k) =>
        new Vector3().fromArray(d.points, d.cornerPoints[start + k] * 3),
      );
      const face = new Vector3()
        .subVectors(rim[1], rim[0])
        .cross(new Vector3().subVectors(rim[2], rim[0]))
        .normalize();
      for (let c = start; c < start + size; c++) {
        worst = Math.min(worst, new Vector3().fromArray(d.cornerNormals!, c * 3).dot(face));
      }
      start += size;
    }
    expect(worst).toBeGreaterThan(0.9999);
  });

  it('refuses by name when the mesh data is shared, and changes nothing', async () => {
    const state = build(POSE, { sharedAt: 'base' });
    const { result, next, calls } = await apply(state, 'all');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /shares its mesh data with 1 other consumer \(at "n_stored_data"\)/,
    );
    expect(calls).toHaveLength(0);
    expect(next).toBe(state);
  });

  // ── Operators on the stack: the Apply reaches the mesh data under them and leaves them alone ──

  it.each([
    [['ArrayModifier']],
    [['MaterialOverrideOp']],
    [['ArrayModifier', 'MaterialOverrideOp']],
  ])(
    'applies into the mesh data under %j: the operators stay wired, the material is untouched, nothing bakes',
    async (between) => {
      const state = build(POSE, { between });
      const opsBefore = between.map((_, i) => state.nodes[opId(i)]);
      const { result, next, cleared } = await apply(state, 'all');

      expect(result.ok).toBe(true);
      expect(Object.values(next.nodes).some((n) => n.type === 'BakedData')).toBe(false);
      // The stack is exactly as it was: same nodes, same params, same wiring, Object on top.
      between.forEach((_, i) => expect(next.nodes[opId(i)]).toEqual(opsBefore[i]));
      expect(next.nodes[OBJ].inputs.data).toEqual({
        node: opId(between.length - 1),
        socket: 'out',
      });
      expect(next.nodes[DATA].params.material).toEqual(MATERIAL);
      expect(next.nodes[OBJ].params).toMatchObject({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      // The pose reached the mesh data under the stack.
      const posedPoints = worldPoints(state);
      expectSameWorld(worldPoints(next), posedPoints);
      // The held edits dropped are the Object's and the MESH DATA's, not an operator's.
      expect(cleared.sort()).toEqual([DATA, OBJ].sort());
    },
  );

  it('refuses by name when a second Object wears a shared operator on the stack', async () => {
    const state = build(POSE, { between: ['ArrayModifier'], sharedAt: 'top' });
    const { result, next, calls } = await apply(state, 'all');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /shares its mesh data with 1 other consumer \(at "n_stored_op0"\)/,
    );
    expect(calls).toHaveLength(0);
    expect(next).toBe(state);
  });

  it('refuses by name when a second Object poses the mesh data under the stack', async () => {
    const state = build(POSE, { between: ['ArrayModifier'], sharedAt: 'base' });
    const { result, calls } = await apply(state, 'all');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/\(at "n_stored_data"\)/);
    expect(calls).toHaveLength(0);
  });

  it('refuses by name when a scale that stays on the Object is zero', async () => {
    const state = build({ position: [0, 0, 0], rotation: [0, 0, 30], scale: [0, 1, 1] });
    const { result, calls } = await apply(state, 'rotation');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/zero scale/);
    expect(calls).toHaveLength(0);
  });

  it('undo restores the original mesh data and pose', async () => {
    const state = build(POSE);
    const { calls } = await apply(state, 'all');
    let fwd = state;
    const inverses: Op[] = [];
    for (const op of calls[0]) {
      const r = applyOp(fwd, op);
      fwd = r.next;
      inverses.push(r.inverse);
    }
    let back = fwd;
    for (let i = inverses.length - 1; i >= 0; i--) back = applyOp(back, inverses[i]).next;
    expect(back.nodes[DATA].params.mesh).toEqual(state.nodes[DATA].params.mesh);
    expect(back.nodes[OBJ].params).toMatchObject(POSE);
  });

  it('never writes into the decoded arrays cached on the packed mesh it replaces (undo restores that object)', async () => {
    // Decoding is cached per packed OBJECT. Undo puts that same object back, so arrays written in
    // place would draw the posed mesh under unposed strings after Cmd+Z. A mirror, so the corner
    // reversal is exercised too.
    const state = build({ ...POSE, scale: [-2, 1, 0.5] });
    const shared = storedOf(state);
    const snapshot = {
      points: Array.from(shared.points),
      cornerPoints: Array.from(shared.cornerPoints),
      cornerNormals: Array.from(shared.cornerNormals!),
    };
    await apply(state, 'all');
    expect(Array.from(shared.points)).toEqual(snapshot.points);
    expect(Array.from(shared.cornerPoints)).toEqual(snapshot.cornerPoints);
    expect(Array.from(shared.cornerNormals!)).toEqual(snapshot.cornerNormals);
  });

  it('drops held edits on both halves and keeps the Object selected', async () => {
    const { cleared, selected } = await apply(build(POSE), 'all');
    expect(cleared.sort()).toEqual([DATA, OBJ].sort());
    expect(selected).toEqual([OBJ]);
  });

  it('is offered: canApplyTransform agrees with the dispatcher', () => {
    expect(canApplyTransform(build(POSE), OBJ)).toBe(true);
  });
  it('#1052 — a mesh with two material slots keeps each face on its slot, and both slots, through a mirroring Apply', async () => {
    const slotted = {
      ...cubeData(),
      faceLayers: [
        { name: 'material_index', type: 'int' as const, data: Int32Array.from([0, 1, 0, 1, 1, 0]) },
      ],
    };
    const red = { ...MATERIAL, base: { ...MATERIAL.base, color: '#ff0000' } };
    const blue = { ...MATERIAL, base: { ...MATERIAL.base, color: '#0000ff' } };
    const state = applyAll(build({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), [
      {
        type: 'setParam',
        nodeId: DATA,
        paramPath: 'mesh',
        value: packMeshData(slotted),
      },
      { type: 'setParam', nodeId: DATA, paramPath: 'materialSlots', value: [red, blue] },
      { type: 'setParam', nodeId: OBJ, paramPath: 'scale', value: [-2, 1, 1] },
    ]);
    const { result, next } = await apply(state, 'all');
    expect(result.ok).toBe(true);
    const params = next.nodes[DATA].params as { mesh: PackedMeshData; materialSlots?: unknown[] };
    const after = unpackMeshData(params.mesh);
    expect(after.faceLayers.map((l) => [l.name, Array.from(l.data)])).toEqual([
      ['material_index', [0, 1, 0, 1, 1, 0]],
    ]);
    expect(params.materialSlots).toEqual([red, blue]);
  });
});

describe('#1081 / #1098 — the animated guard asks what the Apply road it takes consumes', () => {
  // Two roads consume different things. The BAKE (a box or sphere) removes the whole data lane
  // and captures geometry and material from it, so a keyframe on ANY node of the lane is frozen.
  // Stored mesh data is applied INTO (#1077): only `mesh` on the base and the Object's pose are
  // written, and every operator, material and channel stays live. The guard used to ask the
  // Object and its first `data` hop for both — blind below the top of a stack on the bake road,
  // and refusing on the stored-mesh road over things it never reads. Measured over this whole
  // table before the fix: 8 of 24 bake cases baked silently, 4 stored-mesh cases refused.
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
    geometryRegistry.clear();
  });

  type Base = 'cube' | 'sphere' | 'stored';
  type Holder = 'object' | 'base' | 'op0' | 'op1';
  const STACKS: readonly (readonly string[])[] = [
    [],
    ['ArrayModifier'],
    ['MaterialOverrideOp'],
    ['ArrayModifier', 'MaterialOverrideOp'],
  ];

  function storedCube(): MeshGeometryData {
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    const faces = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [1, 2, 6, 5],
      [3, 0, 4, 7],
    ];
    return {
      points: Float32Array.from(corners.flat().map((v) => v * 0.5)),
      faceSizes: Uint32Array.from(faces.map((f) => f.length)),
      cornerPoints: Uint32Array.from(faces.flat()),
      cornerLayers: [
        {
          name: 'UVMap',
          type: 'float2' as const,
          data: Float32Array.from(faces.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1])),
        },
      ],
      cornerNormals: Float32Array.from(faces.flatMap(() => Array(4).fill([0, 0, 1]).flat())),
      faceLayers: [],
    };
  }

  /** An Object `o` over `base`, with `stack` spliced bottom-first as `op0`, `op1`. */
  function build(base: Base, stack: readonly string[]): { state: DagState; dataId: string } {
    let state: DagState;
    let dataId: string;
    if (base === 'cube') {
      const c = makeSplitCube(emptyDagState(), { objectId: 'o', size: [1, 1, 1] });
      state = c.state;
      dataId = c.dataId;
    } else if (base === 'sphere') {
      const c = makeSplitSphere(emptyDagState(), { objectId: 'o', radius: 1 });
      state = c.state;
      dataId = c.dataId;
    } else {
      dataId = 'o_data';
      state = applyAll(emptyDagState(), [
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'PolyMeshData',
          params: { mesh: packMeshData(storedCube()), material: gltfJsonMaterialToOpenpbr({}) },
        },
        { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: 'o', socket: 'data' },
        },
      ]);
    }
    if (stack.length === 0) return { state, dataId };
    const ops: Op[] = [
      {
        type: 'disconnect',
        from: { node: dataId, socket: 'out' },
        to: { node: 'o', socket: 'data' },
      },
    ];
    let below = dataId;
    stack.forEach((type, i) => {
      ops.push(
        { type: 'addNode', nodeId: `op${i}`, nodeType: type, params: {} },
        {
          type: 'connect',
          from: { node: below, socket: 'out' },
          to: { node: `op${i}`, socket: 'target' },
        },
      );
      below = `op${i}`;
    });
    ops.push({
      type: 'connect',
      from: { node: below, socket: 'out' },
      to: { node: 'o', socket: 'data' },
    });
    return { state: applyAll(state, ops), dataId };
  }

  /** A two-key channel on a param `holderId` really owns, typed for that param. */
  function keyframe(state: DagState, holderId: string, base: Base): DagState {
    const type = state.nodes[holderId].type;
    const [channel, paramPath, a, b]: [string, string, unknown, unknown] =
      type === 'Object'
        ? ['KeyframeChannelVec3', 'position', [0, 0, 0], [3, 0, 0]]
        : type === 'ArrayModifier'
          ? ['KeyframeChannelNumber', 'count', 2, 5]
          : type === 'MaterialOverrideOp'
            ? ['KeyframeChannelColor', 'color', '#ff0000', '#00ff00']
            : base === 'cube'
              ? ['KeyframeChannelVec3', 'size', [1, 1, 1], [3, 1, 1]]
              : base === 'sphere'
                ? ['KeyframeChannelNumber', 'radius', 0.5, 2]
                : ['KeyframeChannelColor', 'material.base.color', '#ff0000', '#00ff00'];
    return applyOp(state, {
      type: 'addNode',
      nodeId: 'kf',
      nodeType: channel,
      params: {
        name: paramPath,
        target: holderId,
        paramPath,
        keyframes: [
          { time: 0, value: a, easing: 'linear' },
          { time: 1, value: b, easing: 'linear' },
        ],
      },
    }).next;
  }

  /** The guard's answer, and what Apply then actually did — asked of the same state. */
  async function measure(base: Base, stack: readonly string[], holder: Holder | null) {
    const built = build(base, stack);
    const holderId = holder === 'object' ? 'o' : holder === 'base' ? built.dataId : holder;
    const state = holderId ? keyframe(built.state, holderId, base) : built.state;
    const guard = isApplySourceAnimated(state, 'o', 30);
    const dispatched: Op[] = [];
    const result = await dispatchApplyTransform('o', 'all', {
      state,
      storage: new MemoryStorage(),
      currentFrame: 30,
      dispatchAtomic: (ops) => {
        dispatched.push(...ops);
        return [];
      },
      setSelection: () => {},
      clearTransients: () => {},
    });
    const refusedAsAnimated = !result.ok && result.reason.includes('animated');
    return { guard, result, refusedAsAnimated, dispatched };
  }

  /** Every node that can hold a keyframe under `stack`: the Object, the base, each operator. */
  const holdersOf = (stack: readonly string[]): Holder[] => [
    'object',
    'base',
    ...stack.map((_, i) => `op${i}` as Holder),
  ];

  const bakeCells = (['cube', 'sphere'] as const).flatMap((base) =>
    STACKS.flatMap((stack) => holdersOf(stack).map((holder) => ({ base, stack, holder }))),
  );

  it('the table is the population it claims: 24 animated bake cells', () => {
    // 2 shapes × (Object + base on an empty stack, + one per operator on each of the others).
    expect(bakeCells).toHaveLength(24);
  });

  it.each(bakeCells)(
    'bake road — $base [$stack] keyframe on $holder: refused, nothing dispatched',
    async ({ base, stack, holder }) => {
      const m = await measure(base, stack, holder);
      expect(m.guard).toBe(true);
      expect(m.refusedAsAnimated).toBe(true);
      expect(m.dispatched).toEqual([]);
    },
  );

  it.each(
    (['cube', 'sphere'] as const).flatMap((base) => STACKS.map((stack) => ({ base, stack }))),
  )(
    'bake road — $base [$stack] with nothing animated still bakes (the widened guard is not blanket-true)',
    async ({ base, stack }) => {
      const m = await measure(base, stack, null);
      expect(m.guard).toBe(false);
      expect(m.result.ok).toBe(true);
    },
  );

  it.each(STACKS.map((stack) => ({ stack })))(
    'stored-mesh road — [$stack] keyframe on the Object pose: refused, because the pose is written',
    async ({ stack }) => {
      const m = await measure('stored', stack, 'object');
      expect(m.guard).toBe(true);
      expect(m.refusedAsAnimated).toBe(true);
      expect(m.dispatched).toEqual([]);
    },
  );

  const storedLiveCells = STACKS.flatMap((stack) =>
    holdersOf(stack)
      .filter((h) => h !== 'object')
      .map((holder) => ({ stack, holder })),
  );

  it.each(storedLiveCells)(
    'stored-mesh road — [$stack] keyframe on $holder: applied into the mesh, the channel left live',
    async ({ stack, holder }) => {
      const m = await measure('stored', stack, holder);
      expect(m.guard).toBe(false);
      expect(m.result.ok).toBe(true);
      // What this road consumes, exactly: the base's mesh and the Object's pose. The keyframed
      // node is none of them, which is why refusing on it froze nothing and only blocked Apply.
      expect(
        m.dispatched.map((op) =>
          op.type === 'setParam' ? `${op.nodeId}.${op.paramPath}` : op.type,
        ),
      ).toEqual(['o_data.mesh', 'o.position', 'o.rotation', 'o.scale']);
    },
  );
});

describe('#411 — the animated guard covers every param the bake consumes', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
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

describe('#1080 — a single-band Apply on the bake road keeps the world shape and the other bands', () => {
  // The bake baked only the applied band into the verts and then reset ALL THREE bands on the
  // Object, so Location, Rotation or Scale alone moved and reshaped the object (measured on every
  // partial mask over boxes and spheres: 18 of 18 cells off by 0.65 to 4.1 units). And a mirrored
  // pose baked in under an identity Object kept its mirrored winding, so every face drew
  // inside-out. The rule is the stored-mesh road's (#1077), with Blender as the reference: bake
  // `kept⁻¹ · full`, reset only the applied bands, and reverse winding when that matrix mirrors.
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
    geometryRegistry.clear();
  });

  // Mutable tuples, the shape the split-fixture options take.
  type Tuple3 = [number, number, number];
  type Pose = { position: Tuple3; rotation: Tuple3; scale: Tuple3 };
  const POSES: Record<string, Pose> = {
    // The issue's own pose.
    turned: { position: [1, 2, 3], rotation: [0, 0, 30], scale: [2, 1, 1] },
    // A rotation under a non-uniform scale that stays on the Object: baking the rotation alone
    // cannot keep this shape, only `kept⁻¹ · full` can.
    sheared: { position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 1, 0.5] },
    // A mirror: the winding has to follow the determinant of what is baked.
    mirrored: { position: [1, 0, 0], rotation: [0, 0, 30], scale: [-1, 1, 1] },
  };
  const MASKS = ['all', 'location', 'rotation', 'scale'] as const;
  const APPLIED: Record<(typeof MASKS)[number], readonly (keyof Pose)[]> = {
    all: ['position', 'rotation', 'scale'],
    location: ['position'],
    rotation: ['rotation'],
    scale: ['scale'],
  };
  const IDENTITY: Pose = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

  function poseMatrix(p: Pose): THREE.Matrix4 {
    const d = Math.PI / 180;
    return new THREE.Matrix4().compose(
      new Vector3(...p.position),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(p.rotation[0] * d, p.rotation[1] * d, p.rotation[2] * d, 'XYZ'),
      ),
      new Vector3(...p.scale),
    );
  }

  /** Each vertex as it is drawn: the geometry under the Object's pose. */
  function drawnPoints(geom: THREE.BufferGeometry, pose: Pose): Vector3[] {
    const m = poseMatrix(pose);
    const a = geom.getAttribute('position');
    return Array.from({ length: a.count }, (_, i) =>
      new Vector3().fromBufferAttribute(a, i).applyMatrix4(m),
    );
  }

  /**
   * Triangles that DRAW facing inward. three flips its front face while the Object's matrix
   * mirrors, so a triangle faces inward on screen when its winding in world space points inward
   * XOR the pose mirrors.
   */
  function drawnInward(geom: THREE.BufferGeometry, pose: Pose): number {
    const pts = drawnPoints(geom, pose);
    const centre = pts.reduce((s, p) => s.add(p), new Vector3()).divideScalar(pts.length);
    const mirrors = poseMatrix(pose).determinant() < 0;
    const index = geom.getIndex();
    const corners = index ? index.count : pts.length;
    let inward = 0;
    for (let i = 0; i + 2 < corners; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => pts[index ? index.getX(i + k) : i + k]);
      const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
      if (normal.lengthSq() < 1e-12) continue;
      const out = new Vector3().add(a).add(b).add(c).divideScalar(3).sub(centre);
      if (normal.dot(out) < 0 !== mirrors) inward++;
    }
    return inward;
  }

  async function bake(shape: 'cube' | 'sphere', pose: Pose, mask: (typeof MASKS)[number]) {
    const built =
      shape === 'cube'
        ? makeSplitCube(emptyDagState(), { objectId: 'o', size: [1, 1, 1], ...pose })
        : makeSplitSphere(emptyDagState(), {
            objectId: 'o',
            radius: 0.5,
            widthSegments: 12,
            heightSegments: 8,
            ...pose,
          });
    const source = resolveEvaluatedMesh(built.state, 'o', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    })!;
    const sourceGeom = geometryRegistry.getForRead(source.geometry)!;
    const storage = new MemoryStorage();
    const stateRef = { current: built.state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('o', mask, {
      state: built.state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      clearTransients: () => {},
    });
    const next = stateRef.current;
    const bakedData = result.ok ? dataHalfOf(next, 'o') : null;
    const ref = (
      bakedData?.params as
        | { geometry?: { descriptor: { hash: string; vertexCount: number } } }
        | undefined
    )?.geometry;
    const bakedGeom = ref
      ? await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount)
      : null;
    return { result, sourceGeom, bakedGeom, poseAfter: next.nodes.o?.params as Pose, next };
  }

  const cells = (['cube', 'sphere'] as const).flatMap((shape) =>
    Object.keys(POSES).flatMap((pose) => MASKS.map((mask) => ({ shape, pose, mask }))),
  );

  it.each(cells)(
    '$shape $pose Apply $mask: drawn verts unchanged, only the applied bands reset, no face inside-out',
    async ({ shape, pose, mask }) => {
      const before = POSES[pose];
      const m = await bake(shape, before, mask);
      expect(m.result.ok).toBe(true);
      expect(m.bakedGeom).not.toBeNull();

      // The pose: the applied bands are identity, every other band is exactly what it was.
      for (const band of ['position', 'rotation', 'scale'] as const) {
        const want = APPLIED[mask].includes(band) ? IDENTITY[band] : before[band];
        expect(m.poseAfter[band], band).toEqual(want);
      }

      // The shape: every vertex draws where it drew before (the bake is clone + matrix, so the
      // vertex order is the source's).
      const was = drawnPoints(m.sourceGeom, before);
      const is = drawnPoints(m.bakedGeom!, m.poseAfter);
      expect(is).toHaveLength(was.length);
      const worst = Math.max(...was.map((p, i) => p.distanceTo(is[i])));
      expect(worst).toBeLessThan(1e-4);

      // The faces: none draws inside-out, before or after.
      expect(drawnInward(m.sourceGeom, before)).toBe(0);
      expect(drawnInward(m.bakedGeom!, m.poseAfter)).toBe(0);
    },
  );

  /** The same Apply over an imported child, which bakes off the live clone — the second bake site. */
  async function bakeChild(pose: Pose, mask: (typeof MASKS)[number]) {
    let state = buildSceneScaffold();
    const sceneId = state.outputs.scene!.node;
    state = applyAll(state, [
      {
        type: 'addNode',
        nodeId: 'n_gltf',
        nodeType: 'GltfAsset',
        params: { assetRef: 'assets/textured.glb', nodeNameMap: { Cube: 'n_child' } },
      },
      {
        type: 'connect',
        from: { node: 'n_gltf', socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      },
      ...(importedChildOps('n_child', {
        assetRef: 'assets/textured.glb',
        childName: 'Cube',
        ...pose,
        overridden: { position: true, rotation: true, scale: true },
      }) as Op[]),
    ]);
    const clone = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = 'Cube';
    clone.add(mesh);
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_child', mask, {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      clearTransients: () => {},
      gltfClone: clone,
    });
    if (!result.ok) return { result, sourceGeom: mesh.geometry, bakedGeom: null, poseAfter: null };
    const bakedData = dataHalfOf(stateRef.current, result.bakedId);
    const ref = (
      bakedData!.params as { geometry: { descriptor: { hash: string; vertexCount: number } } }
    ).geometry;
    return {
      result,
      sourceGeom: mesh.geometry,
      bakedGeom: await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount),
      poseAfter: stateRef.current.nodes[result.bakedId].params as Pose,
    };
  }

  it.each(Object.keys(POSES).flatMap((pose) => MASKS.map((mask) => ({ pose, mask }))))(
    'imported child $pose Apply $mask: drawn verts unchanged, only the applied bands reset, no face inside-out',
    async ({ pose, mask }) => {
      const before = POSES[pose];
      const m = await bakeChild(before, mask);
      expect(m.result.ok).toBe(true);
      for (const band of ['position', 'rotation', 'scale'] as const) {
        const want = APPLIED[mask].includes(band) ? IDENTITY[band] : before[band];
        expect(m.poseAfter![band], band).toEqual(want);
      }
      const was = drawnPoints(m.sourceGeom, before);
      const is = drawnPoints(m.bakedGeom!, m.poseAfter!);
      const worst = Math.max(...was.map((p, i) => p.distanceTo(is[i])));
      expect(worst).toBeLessThan(1e-4);
      expect(drawnInward(m.bakedGeom!, m.poseAfter!)).toBe(0);
    },
  );

  it('refuses when a kept scale is zero — the rest of the pose cannot be taken back out', async () => {
    const m = await bake(
      'cube',
      { position: [1, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] },
      'location',
    );
    expect(m.result.ok).toBe(false);
    if (m.result.ok) return;
    expect(m.result.reason).toContain('zero scale');
  });
});

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
  for (const op of importedChildOps('n_child', {
    assetRef: ASSET_REF,
    childName: CHILD_NAME,
    scale: [2, 2, 2],
    overridden: { scale: true },
  })) {
    state = applyOp(state, op as Op).next;
  }
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
    // GltfChild removed; one baked PAIR added, the rich captured spec on the data half.
    expect(next.nodes['n_child']).toBeUndefined();
    const baked = next.nodes[result.bakedId];
    expect(baked.type).toBe('Object');
    expect(baked.params.scale).toEqual([1, 1, 1]);
    const bakedData = dataHalfOf(next, result.bakedId);
    expect(bakedData?.type).toBe('BakedData');
    const spec = bakedData!.params.material as {
      color: string;
      roughness: number;
      metalness: number;
    };
    expect(spec.color).toBe('#abcdef'); // captured from the live clone material
    expect(spec.roughness).toBeCloseTo(0.25, 5);
    expect(spec.metalness).toBeCloseTo(0.75, 5);

    // suppressedChildren appended on the owning asset (no double-render).
    expect(next.nodes['n_gltf'].params.suppressedChildren).toEqual([CHILD_NAME]);
    // selection moved to the baked node.
    expect(selected).toEqual([result.bakedId]);

    // SC-2 (resolver half) — the baked geometry carries the scale=2 (2×2×2 box).
    const ref = bakedData!.params.geometry as {
      descriptor: { hash: string; vertexCount: number };
    };
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
        loop: 'hold',
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

// #1108 — the baked Object used to land at the scene root carrying only the child's own pose, so
// everything the child drew under (the import Group, a wrapper, the glTF parent nodes inside the
// clone) was dropped and the mesh jumped by that whole chain. Blender keeps an applied child under
// its parent with the world shape unchanged, and so must this.
//
// BEFORE is the chain the renderer draws, composed by hand from `GroupR` (Translate(position)·R·S·
// Translate(-pivot)) · the wrapper · the clone's parent node · the child. AFTER is the production
// world resolver's matrix for the baked Object, times the baked vertices — so the two sides of the
// comparison are computed by different instruments.
describe('#1108 — an imported child baked by Apply stays under what it drew under', () => {
  type Pose = { position: Vec3; rotation: Vec3; scale: Vec3 };
  const CHILD_POSE: Pose = { position: [1, 0.5, 0], rotation: [0, 0, 30], scale: [2, 1, 1] };
  const IDENTITY_POSE: Pose = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const trs = (p: Pose) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(...p.position),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(p.rotation[0]),
          THREE.MathUtils.degToRad(p.rotation[1]),
          THREE.MathUtils.degToRad(p.rotation[2]),
          'XYZ',
        ),
      ),
      new THREE.Vector3(...p.scale),
    );

  interface Chain {
    group: Pose & { pivot: Vec3 };
    wrapper?: Pose;
    gltfParent: Pose;
  }
  const PARENT_NAME = 'Parent';
  const PARENT_ID = 'n_parent';

  const CHAINS: Record<string, Chain> = {
    'the import Group moved, turned and scaled about its pivot': {
      group: { position: [5, 1, 0], rotation: [0, 0, 45], scale: [2, 2, 2], pivot: [1, 0, 0] },
      gltfParent: IDENTITY_POSE,
    },
    'a glTF parent node inside the clone': {
      group: { ...IDENTITY_POSE, pivot: [0, 0, 0] },
      gltfParent: { position: [0, 3, 0], rotation: [-90, 0, 0], scale: [1, 1, 1] },
    },
    'a wrapper under a moved Group, over a non-uniformly scaled glTF parent (shear)': {
      group: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
      wrapper: { position: [0, 0, 2], rotation: [0, 30, 0], scale: [1, 1, 1] },
      gltfParent: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 3, 1] },
    },
    'a mirroring glTF parent': {
      group: { position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
      gltfParent: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [-1, 1, 1] },
    },
  };

  function chainState(c: Chain): DagState {
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'n_import', nodeType: 'Group', params: c.group },
      {
        type: 'connect',
        from: { node: 'n_import', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'addNode',
        nodeId: 'n_gltf',
        nodeType: 'GltfAsset',
        params: {
          assetRef: ASSET_REF,
          nodeNameMap: { [CHILD_NAME]: 'n_child', [PARENT_NAME]: PARENT_ID },
        },
      },
    ];
    if (c.wrapper) {
      ops.push(
        { type: 'addNode', nodeId: 'n_wrap', nodeType: 'Transform', params: c.wrapper },
        {
          type: 'connect',
          from: { node: 'n_gltf', socket: 'out' },
          to: { node: 'n_wrap', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'n_wrap', socket: 'out' },
          to: { node: 'n_import', socket: 'children' },
        },
      );
    } else {
      ops.push({
        type: 'connect',
        from: { node: 'n_gltf', socket: 'out' },
        to: { node: 'n_import', socket: 'children' },
      });
    }
    ops.push(
      ...(importedChildOps('n_child', {
        assetRef: ASSET_REF,
        childName: CHILD_NAME,
        ...CHILD_POSE,
        overridden: { position: true, rotation: true, scale: true },
      }) as Op[]),
    );
    return applyAll(buildSceneScaffold(), ops);
  }

  /** The live clone as the renderer holds it: clone root → glTF parent node → the posed child. */
  function chainClone(c: Chain): THREE.Group {
    const root = new THREE.Group();
    const parent = new THREE.Object3D();
    parent.name = PARENT_NAME;
    parent.applyMatrix4(trs(c.gltfParent));
    const child = fakeClone().getObjectByName(CHILD_NAME)!;
    child.applyMatrix4(trs(CHILD_POSE));
    root.add(parent);
    parent.add(child);
    return root;
  }

  function drawnChain(c: Chain): THREE.Matrix4 {
    const g = c.group;
    return trs(g)
      .multiply(new THREE.Matrix4().makeTranslation(-g.pivot[0], -g.pivot[1], -g.pivot[2]))
      .multiply(c.wrapper ? trs(c.wrapper) : new THREE.Matrix4())
      .multiply(trs(c.gltfParent))
      .multiply(trs(CHILD_POSE));
  }

  const worldPoints = (geom: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const a = geom.getAttribute('position');
    return Array.from({ length: a.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(m),
    );
  };

  /** Triangles that face inward as drawn: world winding, flipped when the world matrix mirrors. */
  const inwardFaces = (geom: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const p = worldPoints(geom, m);
    const centre = p.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(p.length);
    const index = geom.getIndex();
    const corners = index ? index.count : p.length;
    let inward = 0;
    for (let i = 0; i + 2 < corners; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => p[index ? index.getX(i + k) : i + k]);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const out = a.clone().add(b).add(c).divideScalar(3).sub(centre);
      if (n.dot(out) < 0 !== m.determinant() < 0) inward++;
    }
    return inward;
  };

  async function applyOnChain(c: Chain, mask: 'all' | 'location' | 'rotation' | 'scale') {
    const state = chainState(c);
    const clone = chainClone(c);
    const source = (clone.getObjectByName(CHILD_NAME) as THREE.Mesh).geometry;
    const before = worldPoints(source, drawnChain(c));
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_child', mask, {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      gltfClone: clone,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const next = stateRef.current;
    const { geometry: ref } = dataHalfOf(next, result.bakedId)!.params as {
      geometry: { descriptor: { hash: string; vertexCount: number } };
    };
    const baked = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    const world = resolveWorldTransform(next, result.bakedId, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    expect(world).not.toBeNull();
    const after = new THREE.Matrix4().fromArray(world!.matrix);
    return { next, bakedId: result.bakedId, before, baked, after };
  }

  const holdersOf = (state: DagState, id: string) =>
    Object.values(state.nodes)
      .filter((n) =>
        Object.values(n.inputs ?? {})
          .flat()
          .some((e) => (e as { node?: string } | undefined)?.node === id),
      )
      .map((n) => n.id);

  for (const [name, chain] of Object.entries(CHAINS)) {
    for (const mask of ['all', 'location', 'rotation', 'scale'] as const) {
      it(`${name} — Apply ${mask} keeps every drawn vertex where it was, under the import Group`, async () => {
        const { next, bakedId, before, baked, after } = await applyOnChain(chain, mask);
        expect(holdersOf(next, bakedId)).toEqual(['n_import']);
        const drawnAfter = worldPoints(baked, after);
        expect(drawnAfter).toHaveLength(before.length);
        const worst = Math.max(...before.map((v, i) => v.distanceTo(drawnAfter[i])));
        expect(worst).toBeLessThan(1e-6);
        expect(inwardFaces(baked, after)).toBe(0);
        if (mask === 'all') {
          expect(next.nodes[bakedId].params).toMatchObject({
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          });
        }
      });
    }
  }

  // What sits above the child is read at the current frame and is no longer above the bake, so an
  // animation there would stop at that frame (measured before the refusal: a clip track or a baked
  // channel on the glTF parent left the bake 4 units off the drawn mesh one second later). Each
  // ancestor is asked what the child is asked for itself. The holder is not: the bake stays under it.
  const MOVING_CHAIN =
    CHAINS['a wrapper under a moved Group, over a non-uniformly scaled glTF parent (shear)'];
  const vec3Channel = (
    target: string,
    paramPath: string,
    from: Vec3,
    to: Vec3,
    extra = {},
  ): Op => ({
    type: 'addNode',
    nodeId: 'n_moving',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'moving',
      target,
      paramPath,
      ...extra,
      keyframes: [
        { time: 0, value: from, easing: 'linear' },
        { time: 2, value: to, easing: 'linear' },
      ],
    },
  });
  const ANIMATED_ANCESTORS: Record<string, { ops: Op[]; names: string }> = {
    'a clip track on the glTF parent node': {
      names: PARENT_NAME,
      ops: [
        {
          type: 'addNode',
          nodeId: 'n_clip',
          nodeType: 'TransformClip',
          params: {
            name: 'walk',
            duration: 2,
            loop: 'hold',
            keyframes: [
              { targetNodeId: PARENT_NAME, time: 0, position: [0, 1, 0] },
              { targetNodeId: PARENT_NAME, time: 2, position: [4, 1, 0] },
            ],
          },
        },
        {
          type: 'connect',
          from: { node: 'n_clip', socket: 'out' },
          to: { node: 'n_gltf', socket: 'transformClip' },
        },
      ],
    },
    'a baked channel on the glTF parent node, which has no node of its own in the graph': {
      names: PARENT_NAME,
      ops: [vec3Channel(PARENT_ID, 'position', [0, 1, 0], [4, 1, 0], { childName: PARENT_NAME })],
    },
    'a keyframed wrapper between the import Group and the asset': {
      names: 'n_wrap',
      ops: [vec3Channel('n_wrap', 'position', [0, 0, 2], [4, 0, 2])],
    },
  };

  for (const [name, { ops, names }] of Object.entries(ANIMATED_ANCESTORS)) {
    it(`refuses, before writing anything, when ${name} animates`, async () => {
      const state = applyAll(chainState(MOVING_CHAIN), ops);
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
        gltfClone: chainClone(MOVING_CHAIN),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(`"${names}"`);
      expect(result.reason).toContain('animated');
      expect(dispatched).toBe(0);
      expect(writeSpy).not.toHaveBeenCalled();
    });
  }

  it('an animated import Group is not refused, and the bake keeps following it', async () => {
    const chain = MOVING_CHAIN;
    const state = applyAll(chainState(chain), [
      vec3Channel('n_import', 'position', chain.group.position, [6, 0, 0]),
    ]);
    const clone = chainClone(chain);
    const source = (clone.getObjectByName(CHILD_NAME) as THREE.Mesh).geometry;
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_child', 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      gltfClone: clone,
    });
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    const next = stateRef.current;
    expect(holdersOf(next, result.bakedId)).toEqual(['n_import']);
    const { geometry: ref } = dataHalfOf(next, result.bakedId)!.params as {
      geometry: { descriptor: { hash: string; vertexCount: number } };
    };
    const baked = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    // One second in, the Group is halfway along its keys; the chain draws under it there.
    const moved = { ...chain, group: { ...chain.group, position: [4, 0, 0] as Vec3 } };
    const before = worldPoints(source, drawnChain(moved));
    const world = resolveWorldTransform(next, result.bakedId, {
      time: { frame: 60, seconds: 1, normalized: 0 },
    });
    const drawnAfter = worldPoints(baked, new THREE.Matrix4().fromArray(world!.matrix));
    expect(Math.max(...before.map((v, i) => v.distanceTo(drawnAfter[i])))).toBeLessThan(1e-6);
  });

  it('a flat import bakes exactly as before: the child pose is kept verbatim, under the scene', async () => {
    const state = gltfChildState();
    const storage = new MemoryStorage();
    const stateRef = { current: state };
    const { fn } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform('n_child', 'location', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      gltfClone: fakeClone(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(holdersOf(stateRef.current, result.bakedId)).toEqual(['n_scene']);
    expect(stateRef.current.nodes[result.bakedId].params).toMatchObject({
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    });
  });
});

// #1119 — the baked store keeps position, normal, uv and index. A bake over anything more used to
// drop it with nothing said; both bake roads now refuse by name before they clone or write.
describe('#1119 — a bake refuses attributes the baked store cannot hold', () => {
  function withCornerLayers(geometry: THREE.BufferGeometry): void {
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3),
    );
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }

  it('names every attribute it would drop, and nothing for a geometry it holds', () => {
    const plain = new THREE.BoxGeometry(1, 1, 1);
    expect(unheldAttributesBakeRefusal('box', plain)).toBeNull();
    const layered = new THREE.BoxGeometry(1, 1, 1);
    withCornerLayers(layered);
    expect(unheldAttributesBakeRefusal('box', layered)).toContain('"box" carries color, uv1,');
    expect(unheldAttributesBakeRefusal('box', layered)).toContain('would drop them.');
    const one = new THREE.BoxGeometry(1, 1, 1);
    one.setAttribute('uv1', one.getAttribute('uv').clone());
    expect(unheldAttributesBakeRefusal('box', one)).toContain('carries uv1, which');
    expect(unheldAttributesBakeRefusal('box', one)).toContain('would drop it.');
  });

  it('an imported child drawn from the file refuses, writes nothing and dispatches nothing', async () => {
    const state = gltfChildState();
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    const clone = fakeClone();
    withCornerLayers((clone.getObjectByName(CHILD_NAME) as THREE.Mesh).geometry);
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
      gltfClone: clone,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('carries color, uv1,') });
    expect(dispatched).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('a mesh baked from the geometry registry refuses the same way', async () => {
    const state = buildSplitSphereState();
    const mesh = resolveEvaluatedMesh(state, PRIM_ID, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    // The registry hands every reader the SAME instance, so the bake reads the layers set here.
    withCornerLayers(geometryRegistry.getForRead(mesh!.geometry)!);
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    const stateRef = { current: state };
    const { fn, calls } = makeDispatch(stateRef);
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('carries color, uv1,') });
    expect(calls).toHaveLength(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('#1132 — a refused Apply writes nothing to storage', () => {
  async function applyRefused(
    selectedId: string,
    state: DagState,
    gltfClone?: THREE.Group,
  ): Promise<{
    result: Awaited<ReturnType<typeof dispatchApplyTransform>>;
    writes: number;
    dispatched: number;
  }> {
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    let dispatched = 0;
    const result = await dispatchApplyTransform(selectedId, 'all', {
      state,
      storage,
      currentFrame: 0,
      dispatchAtomic: () => {
        dispatched++;
        return [];
      },
      setSelection: () => {},
      ...(gltfClone ? { gltfClone } : {}),
    });
    return { result, writes: writeSpy.mock.calls.length, dispatched };
  }

  /** The next resolve of the registry-road sphere answers with `materials` in place of its own. */
  function resolveWithMaterials(materials: EvaluatedMesh['materials']): void {
    const real = vi.mocked(resolveEvaluatedMesh).getMockImplementation()!;
    vi.mocked(resolveEvaluatedMesh).mockImplementationOnce((state, id, ctx) => {
      const mesh = real(state, id, ctx);
      return mesh ? { ...mesh, materials } : mesh;
    });
  }

  it('the registry bake refuses two materials before it writes', async () => {
    const state = buildSplitSphereState();
    const two = evaluatedMeshFromMeshData(null, twoMaterialMeshData(), {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    }).materials;
    resolveWithMaterials(two);
    const { result, writes, dispatched } = await applyRefused(PRIM_ID, state);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('assigns 2 materials') });
    expect(dispatched).toBe(0);
    expect(writes).toBe(0);
  });

  it('the registry bake refuses a material owned by an imported asset before it writes', async () => {
    const state = buildSplitSphereState();
    const mesh = resolveEvaluatedMesh(state, PRIM_ID, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    })!;
    const cloneOwned = materialAssignmentOf(null, [null], {
      key: 'gltf|asset-a|Cube',
      descriptor: { kind: 'gltf', assetRef: 'asset-a', childName: 'Cube' },
    });
    expect(mesh.geometry.descriptor.kind).not.toBe('gltf');
    resolveWithMaterials(cloneOwned);
    const { result, writes, dispatched } = await applyRefused(PRIM_ID, state);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('owned by its imported asset'),
    });
    expect(dispatched).toBe(0);
    expect(writes).toBe(0);
  });

  it('the imported-child bake refuses a child with no material before it writes', async () => {
    const clone = fakeClone();
    (clone.getObjectByName(CHILD_NAME) as THREE.Mesh).material = [];
    const { result, writes, dispatched } = await applyRefused('n_child', gltfChildState(), clone);
    expect(result).toEqual({ ok: false, reason: `Apply: child "${CHILD_NAME}" has no material.` });
    expect(dispatched).toBe(0);
    expect(writes).toBe(0);
  });

  it('the positive control: the same child with its material writes and dispatches', async () => {
    const stateRef = { current: gltfChildState() };
    const { fn, calls } = makeDispatch(stateRef);
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');
    const result = await dispatchApplyTransform('n_child', 'all', {
      state: stateRef.current,
      storage,
      currentFrame: 0,
      dispatchAtomic: fn,
      setSelection: () => {},
      gltfClone: fakeClone(),
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(writeSpy).toHaveBeenCalled();
  });
});

describe('#1134 — a refusal names the object the way the outliner does', () => {
  it('quotes a renamed registry object by its name, not its id', async () => {
    let state = buildSplitSphereState();
    state = applyOp(state, { type: 'setMeta', nodeId: PRIM_ID, name: 'Hero' }).next;
    const mesh = resolveEvaluatedMesh(state, PRIM_ID, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    geometryRegistry
      .getForRead(mesh!.geometry)!
      .setAttribute('uv1', geometryRegistry.getForRead(mesh!.geometry)!.getAttribute('uv').clone());
    const result = await dispatchApplyTransform(PRIM_ID, 'all', {
      state,
      storage: new MemoryStorage(),
      currentFrame: 0,
      dispatchAtomic: () => [],
      setSelection: () => {},
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('"Hero" carries uv1') });
    expect(result.ok ? '' : result.reason).not.toContain(PRIM_ID);
  });

  it('quotes an imported child by the name it was imported with', async () => {
    const clone = fakeClone();
    const geometry = (clone.getObjectByName(CHILD_NAME) as THREE.Mesh).geometry;
    geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
    const result = await dispatchApplyTransform('n_child', 'all', {
      state: gltfChildState(),
      storage: new MemoryStorage(),
      currentFrame: 0,
      dispatchAtomic: () => [],
      setSelection: () => {},
      gltfClone: clone,
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining(`"${CHILD_NAME}" carries uv1`),
    });
    expect(result.ok ? '' : result.reason).not.toContain('n_child');
  });
});
