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
import * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import { applyOp, emptyDagState, __resetRegistryForTests } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import * as geometryRegistry from '../geometryRegistry';
import { readBakedGeometry } from '../asset/bakedGeometryStore';
import { dispatchApplyTransform } from './dispatchApplyTransform';
import { makeSplitCube } from '../../test-utils/splitCube';

const PRIM_ID = 'n_prim';

// #365 Phase 5a (Slice 2) — the fused box value kind is retired, so the last FUSED primitive
// that still bakes is the SphereMesh. These tests exercise the fused-primitive → BakedMesh
// Apply MECHANISM (bbox bake, consumer rewire, OPFS ordering, animated-reject) on a sphere of
// radius 0.5 — whose bounding box is 1×1×1, identical to the old unit box, so the bbox
// assertions are unchanged. Apply on a split cube (Object) is a documented gap (a bake path
// for a posed Object+BoxData is a follow-up); the rejection is pinned by its own test below.
function buildFusedSphereState(): DagState {
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
  add({
    type: 'addNode',
    nodeId: PRIM_ID,
    nodeType: 'SphereMesh',
    // radius 0.5 → a 1×1×1 bounding box, identical to the retired unit box, so the bbox-bake
    // assertions carry over verbatim.
    params: {
      radius: 0.5,
      widthSegments: 16,
      heightSegments: 16,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      material: { name: 'default', base: { color: '#5af07a' } },
    },
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
    from: { node: PRIM_ID, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
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
    let state = buildFusedSphereState();
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

    // The original Box is gone; exactly one BakedMesh exists.
    const next = stateRef.current;
    expect(next.nodes[PRIM_ID]).toBeUndefined();
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
    const state = buildFusedSphereState();
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
    // The Scene's children no longer reference the Box; they reference the baked id.
    const refsBox = Object.values(next.nodes).some((n) =>
      Object.values(n.inputs).some((b) =>
        (Array.isArray(b) ? b : [b]).some((r) => r.node === PRIM_ID),
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

  it('#259/H140: rewires a SINGLE-cardinality consumer socket (a modifier target) without rolling back', async () => {
    // The box feeds TWO consumers of different cardinality at once: Scene.children
    // (LIST) and an ArrayModifier's `target` (SINGLE). Before the fix, the single
    // socket's connect-before-disconnect threw ("bound producer is <baked>, not
    // n_box") and rolled back the whole atomic composite → Apply silently no-op'd.
    let state = buildFusedSphereState();
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
    expect(next.nodes[PRIM_ID]).toBeUndefined(); // box baked away
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
    expect(back.nodes[PRIM_ID]).toBeDefined();
    expect((back.nodes['n_mod'].inputs.target as { node: string }).node).toBe(PRIM_ID);
  });

  it('awaits the OPFS write BEFORE the Op composite (reload-safe ordering)', async () => {
    const state = buildFusedSphereState();
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
    let state = buildFusedSphereState();
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
    let state = buildFusedSphereState();
    // A second sphere with the SAME params shares the registry geometry key with PRIM_ID.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_sphere2',
      nodeType: 'SphereMesh',
      params: { radius: 0.5, widthSegments: 16, heightSegments: 16 },
    }).next;

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

  it('a split cube (Object) rejects Apply — the documented Slice-2 gap (no bake path yet)', async () => {
    // #365 Phase 5a (Slice 2): a cube is an Object → BoxData split, NOT a bakeable fused
    // primitive. Apply on it must reject cleanly and leave the DAG byte-unchanged until an
    // Object+BoxData bake path lands (a tracked follow-up).
    let state = buildFusedSphereState();
    const cube = makeSplitCube(state, {
      objectId: 'n_cube',
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
    expect(result.ok).toBe(false); // not a bakeable mesh
    expect(calls).toHaveLength(0); // DAG byte-unchanged
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
  let state = buildFusedSphereState();
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
