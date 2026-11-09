import { describe, it, expect } from 'vitest';
import {
  buildDeleteNodesOps,
  buildDuplicateNodesOps,
  planDeleteNodes,
  withHierarchy,
  type DuplicateOptions,
} from './sceneNodeActions';
import { resolveWorldTransform } from './resolveWorldTransform';
import { validatePlan } from '../agent/mutators/validate';
import { deleteNodeMutator } from '../agent/mutators/builders/deleteNode';
import { isInScene } from './sceneMembership';
import { parentIdsOf } from './sceneHierarchy';
import { moveNotices } from './keepPlaceReparent';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp, emptyDagState } from '../core/dag';
import { danglingIdRefs } from '../core/dag/idRefSweep';
import { evaluate } from '../core/dag/evaluator';
import { attachOp, worldParentOf } from '../core/dag/worldChildren';
import { childIdsOf } from './sceneHierarchy';
import { buildAddModifierOps, findConsumer, resolveStackBase } from './operatorStack';
import { useDagStore } from '../core/dag/store';
import { subnetworkOf, subnetworkViolations } from '../core/dag/subnetworks';
import type { SpringNodeKey } from './solverBind';
import { rawSpringOps } from '../test-utils/rawSpring';
import { buildRemoveDriverOps } from './driverStack';
import { buildUnbindDriverOps } from './driverBind';
import { buildNewMaterialOps } from './materialLink';
import { membershipOps, newCollectionOps } from './collections';
import { wrapInRig } from './animate/wrapInRig';
import { buildDefaultDagState } from '../core/project/default';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import type { MeshDataValue } from '../nodes/types';

// #421 — the delete sweep now reads what each node type DECLARES (`idRefs`), so it
// needs the registry populated. Production gets this at boot (boot.ts:162); a unit
// test has to ask. Without it the sweep silently finds nothing — the same class of
// quiet failure this whole change is about.
registerAllNodes();

/** One root through the real builder, in the `{ ops, newRootId }` shape these cases read. */
function buildDuplicateNodeOps(
  state: DagState,
  rootId: string,
  options?: DuplicateOptions,
): { ops: Op[]; newRootId: string } | null {
  const res = buildDuplicateNodesOps(state, [rootId], options);
  return res ? { ops: res.ops, newRootId: res.newRootIds[0] } : null;
}

// Minimal fake DAG — the builders read only node.type / params / inputs and emit
// ops; they don't validate schema, so a plain object suffices for unit coverage.
//
// #476 — the leaves are bare `Object`s carrying a transform, not fused meshes. They stand in
// for "a scene child the children-walk has to copy or delete", and giving them a data half
// would only restate what the dedicated split cases below already assert (the orphaned-BoxData
// sweep and the independent-clone case each build their own real pair).
function fakeState(): DagState {
  return {
    nodes: {
      scene: {
        id: 'scene',
        type: 'Scene',
        params: {},
        inputs: {
          children: [
            { node: 'box', socket: 'out' },
            { node: 'grp', socket: 'out' },
          ],
        },
      },
      box: { id: 'box', type: 'Object', params: { position: [0, 0, 0] }, inputs: {} },
      grp: {
        id: 'grp',
        type: 'Group',
        params: { position: [5, 0, 0] },
        inputs: { children: [{ node: 'inner', socket: 'out' }] },
      },
      inner: { id: 'inner', type: 'Object', params: { position: [0, 2, 0] }, inputs: {} },
    },
    outputs: { scene: { node: 'scene' } },
  } as unknown as DagState;
}

// A fake DAG with a free-floating KeyframeChannel targeting `box` via
// params.target (V57) — an input to nothing, reached outside the edge graph.
function animatedState(): DagState {
  const s = fakeState();
  (s.nodes as Record<string, unknown>).ch = {
    id: 'ch',
    type: 'KeyframeChannelVec3',
    params: {
      target: 'box',
      paramPath: 'position',
      keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
    },
    inputs: {},
  };
  return s;
}

describe('buildDeleteNodesOps', () => {
  it('disconnects every consumer edge before removing the node', () => {
    const ops = buildDeleteNodesOps(fakeState(), ['box']);
    expect(ops).toEqual([
      {
        type: 'disconnect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
      { type: 'removeNode', nodeId: 'box' },
    ]);
  });

  it('#365 also removes a split Object’s orphaned BoxData', () => {
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'obj', socket: 'out' }] },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: { id: 'data', type: 'BoxData', params: { size: [1, 1, 1] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    const ops = buildDeleteNodesOps(state, ['obj']);
    // The Object is removed AND its now-orphaned BoxData too (no save bloat).
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'obj' });
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'data' });
    // Order: the data node's removeNode comes AFTER the Object's (its only consumer
    // must be gone first, else removeNode refuses).
    const idxObj = ops.findIndex((o) => o.type === 'removeNode' && o.nodeId === 'obj');
    const idxData = ops.findIndex((o) => o.type === 'removeNode' && o.nodeId === 'data');
    expect(idxData).toBeGreaterThan(idxObj);
  });

  it('#365 KEEPS a shared BoxData when a sibling Object still points at it', () => {
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: {
            children: [
              { node: 'objA', socket: 'out' },
              { node: 'objB', socket: 'out' },
            ],
          },
        },
        objA: {
          id: 'objA',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        objB: {
          id: 'objB',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: { id: 'data', type: 'BoxData', params: { size: [1, 1, 1] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    const ops = buildDeleteNodesOps(state, ['objA']);
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'objA' });
    // objB still consumes `data` → it must survive (fan-out, not orphaned).
    expect(ops.some((o) => o.type === 'removeNode' && o.nodeId === 'data')).toBe(false);
  });

  it('#365 also removes a channel targeting the GC’d BoxData (animated split cube)', () => {
    // A migrated animated cube: the size channel targets the BoxData (data-param
    // channels retarget to the data node). Deleting the Object GC's the BoxData —
    // the channel must be swept with it, else it orphans pointing at a dead id.
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'obj', socket: 'out' }] },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: { id: 'data', type: 'BoxData', params: { size: [1, 1, 1] }, inputs: {} },
        ch: {
          id: 'ch',
          type: 'KeyframeChannelVec3',
          params: { target: 'data', paramPath: 'size', keyframes: [] },
          inputs: {},
        },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    const removed = buildDeleteNodesOps(state, ['obj'])
      .filter((o) => o.type === 'removeNode')
      .map((o) => (o as { nodeId: string }).nodeId);
    expect(removed).toContain('obj');
    expect(removed).toContain('data');
    expect(removed, 'the size channel targeting the BoxData is swept too').toContain('ch');
  });

  it('[[H136]] also removes a free-floating channel targeting the deleted node', () => {
    const ops = buildDeleteNodesOps(animatedState(), ['box']);
    // channel `ch` targets `box` via params.target (no edge) — must be removed too.
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'ch' });
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'box' });
    // it has no consumer edge, so no disconnect op is emitted for it.
    expect(
      ops
        .filter((o) => o.type === 'disconnect')
        .some((o) => (o as { from: { node: string } }).from.node === 'ch'),
    ).toBe(false);
  });
});

// ── #432 — splice deleted WRAPPER nodes out (scene → wrapper → subject). ────────
// A wrapper consumes its subject through a `target` edge and re-exposes it via
// `out`. Deleting one plainly strands the subject (invisible, in-file). The subject
// must survive and reconnect to whatever consumed the wrapper. Sibling of
// operatorStack's buildRemoveOperatorOps (the modifier-stack ✕); this is the generic
// delete path (outliner / agent / raw exec).
describe('buildDeleteNodesOps — #432 wrapper splice-out', () => {
  // A single wrapper on the edge chain: scene → tr → box.
  const wrappedState = (wrapperType: string): DagState =>
    ({
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'tr', socket: 'out' }] },
        },
        tr: {
          id: 'tr',
          type: wrapperType,
          params: {},
          inputs: { target: { node: 'box', socket: 'out' } },
        },
        box: { id: 'box', type: 'Object', params: { position: [0, 0, 0] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    }) as unknown as DagState;

  it('reconnects the wrapped subject to the wrapper’s consumer, and does NOT delete it', () => {
    const ops = buildDeleteNodesOps(wrappedState('Transform'), ['tr']);
    // the subject re-enters the scene where the wrapper was.
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'scene', socket: 'children' },
    });
    expect(ops).toContainEqual({ type: 'removeNode', nodeId: 'tr' });
    // the wrapped mesh survives — deleting a modifier keeps the object (Blender X).
    expect(ops.some((o) => o.type === 'removeNode' && o.nodeId === 'box')).toBe(false);
  });

  it('applies to every wrapper type (schema-derived, not a hardcoded list)', () => {
    // MaterialOverride / modifiers share the target→out shape; each must splice.
    for (const t of ['MaterialOverride', 'ArrayModifier', 'MirrorModifier']) {
      const ops = buildDeleteNodesOps(wrappedState(t), ['tr']);
      expect(ops, `${t} should splice its subject back to the consumer`).toContainEqual({
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      });
    }
  });

  // scene → mir → arr → box.
  const stackState = (): DagState =>
    ({
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'mir', socket: 'out' }] },
        },
        mir: {
          id: 'mir',
          type: 'MaterialOverride',
          params: {},
          inputs: { target: { node: 'arr', socket: 'out' } },
        },
        arr: {
          id: 'arr',
          type: 'Transform',
          params: {},
          inputs: { target: { node: 'box', socket: 'out' } },
        },
        box: { id: 'box', type: 'Object', params: { position: [0, 0, 0] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    }) as unknown as DagState;

  // #415 — THE WRAPPER TYPES HERE WERE RETYPED, and only the types. The subject is the
  // GENERIC splice-out (`isTargetWrapperNode` is derived from the registry: a `target`
  // input plus an `out` output), never anything specific to modifiers. The chain used to
  // be `box → ArrayModifier → MirrorModifier → scene`, which the data-lane flip made
  // impossible to build — a modifier's `target` takes `ObjectData` now, so a fixture
  // wiring a SceneObject into it describes a graph the app would refuse. Transform and
  // MaterialOverride are the SceneObject wrappers that still chain exactly this way, so
  // the invariant is unchanged and the fixture stops describing an impossible topology.
  // (The fused `BoxMesh` leaf is separate, pre-existing debt — #476.)
  it('deleting the MIDDLE of a stack splices the base up to the surviving wrapper', () => {
    const ops = buildDeleteNodesOps(stackState(), ['arr']);
    // box takes arr's place in mir's target slot.
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'mir', socket: 'target' },
    });
    expect(ops.some((o) => o.type === 'removeNode' && o.nodeId === 'box')).toBe(false);
  });

  it('deleting the WHOLE stack walks up past the deleted wrappers to the surviving consumer', () => {
    const ops = buildDeleteNodesOps(stackState(), ['mir', 'arr']);
    // survivingConsumerAbove hops arr→mir(deleted)→scene: box reconnects to the scene.
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: 'box', socket: 'out' },
      to: { node: 'scene', socket: 'children' },
    });
    // both wrappers gone, the base survives.
    const removed = ops
      .filter((o) => o.type === 'removeNode')
      .map((o) => (o as { nodeId: string }).nodeId);
    expect(removed).toContain('mir');
    expect(removed).toContain('arr');
    expect(removed).not.toContain('box');
  });

  it('emits NO splice when the subject is being deleted too', () => {
    // delete both the wrapper and the mesh it wraps → nothing to keep alive.
    const ops = buildDeleteNodesOps(wrappedState('Transform'), ['tr', 'box']);
    expect(ops.some((o) => o.type === 'connect')).toBe(false);
    const removed = ops
      .filter((o) => o.type === 'removeNode')
      .map((o) => (o as { nodeId: string }).nodeId);
    expect(removed).toContain('tr');
    expect(removed).toContain('box');
  });

  it('a non-wrapper delete emits no splice connect (control)', () => {
    // box is a plain mesh (no `target` input) → isTargetWrapperNode is false.
    const ops = buildDeleteNodesOps(wrappedState('Transform'), ['box']);
    // deleting the leaf strands the wrapper above, but that is NOT a splice case —
    // the wrapper is not being deleted, so no spurious reconnect is emitted.
    expect(ops.some((o) => o.type === 'connect')).toBe(false);
  });

  it('OBSERVED end-to-end: removing a real modifier keeps the mesh in the scene', () => {
    // Schema-valid, folded through the real op layer (fake fixtures skip schema).
    // The default box is the split-native Object `n_box` (posed over a BoxData).
    const base = buildDefaultDagState();
    const boxId = 'n_box';
    const boxDataId = 'n_box_data'; // #415 — the stack lives on the data lane
    expect(base.nodes[boxId]).toBeDefined();
    expect(base.nodes[boxDataId]).toBeDefined();
    const add = buildAddModifierOps(base, resolveStackBase(base, boxId), 'ArrayModifier', {
      count: 3,
      offset: [2, 0, 0],
    });
    expect(add).not.toBeNull();
    let s = (add!.ops as Op[]).reduce((acc, op) => applyOp(acc, op).next, base);
    // Now data → modifier → object → scene. Delete the modifier through the generic path.
    const delOps = buildDeleteNodesOps(s, [add!.modifierId]);
    s = delOps.reduce((acc, op) => applyOp(acc, op).next, s);
    expect(s.nodes[add!.modifierId]).toBeUndefined();
    expect(s.nodes[boxId]).toBeDefined();
    // #415 — RE-AIMED, because the old assertion goes VACUOUS here. It checked that the
    // box was "a direct scene child again" — true only because the modifier used to
    // stand between the box and the scene. Post-flip the Object feeds the scene the
    // whole time, so that check passes even with the splice removed entirely. The edge
    // that genuinely has to be re-joined is data → Object.data. → [[H218]]
    expect(findConsumer(s, boxDataId)).toEqual({ node: boxId, socket: 'data' });
    // Kept as a genuine invariant now rather than as the moving part it used to be.
    expect(findConsumer(s, boxId)?.socket).toBe('children'); // renderable, not stranded
  });
});

describe('buildDuplicateNodeOps', () => {
  it('duplicates a leaf as a sibling right after the original', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'box');
    expect(res?.newRootId).toBe('box_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'box_copy', nodeType: 'Object', params: { position: [0, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'box_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 1,
      },
      // An unnamed object's copy takes the word for its kind (#1518).
      { type: 'setMeta', nodeId: 'box_copy', name: 'Object' },
    ]);
  });

  it('deep-copies a Group subtree, re-wiring internal edges to the clones', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'grp');
    expect(res?.newRootId).toBe('grp_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'grp_copy', nodeType: 'Group', params: { position: [5, 0, 0] } },
      {
        type: 'addNode',
        nodeId: 'inner_copy',
        nodeType: 'Object',
        params: { position: [0, 2, 0] },
      },
      // internal edge points at the CLONE child, not the original.
      {
        type: 'connect',
        from: { node: 'inner_copy', socket: 'out' },
        to: { node: 'grp_copy', socket: 'children' },
        index: 0,
      },
      // new root wired after the original (grp was index 1 → copy at 2).
      {
        type: 'connect',
        from: { node: 'grp_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 2,
      },
      { type: 'setMeta', nodeId: 'grp_copy', name: 'Empty' },
      { type: 'setMeta', nodeId: 'inner_copy', name: 'Object' },
    ]);
  });

  it('deep-copies a split Object: the clone gets its OWN, independent BoxData (#365)', () => {
    // A split Object owns its geometry/material through `data`. Duplicating it must
    // clone the BoxData too and point clone.data at the clone — NOT the original
    // (which would be a linked copy: recolour one, both change). Blender Shift+D.
    const state = {
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'obj', socket: 'out' }] },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: { position: [0, 0, 0] },
          inputs: { data: { node: 'data', socket: 'out' } },
        },
        data: {
          id: 'data',
          type: 'BoxData',
          params: { size: [1, 1, 1], material: { base: { color: '#ff0000' } } },
          inputs: {},
        },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;

    const res = buildDuplicateNodeOps(state, 'obj')!;
    expect(res.newRootId).toBe('obj_copy');
    expect(res.ops).toEqual([
      { type: 'addNode', nodeId: 'obj_copy', nodeType: 'Object', params: { position: [0, 0, 0] } },
      {
        type: 'addNode',
        nodeId: 'data_copy',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: { base: { color: '#ff0000' } } },
      },
      // clone.data → the CLONED BoxData, not the original 'data' (independence).
      {
        type: 'connect',
        from: { node: 'data_copy', socket: 'out' },
        to: { node: 'obj_copy', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'obj_copy', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
        index: 1,
      },
      { type: 'setMeta', nodeId: 'obj_copy', name: 'Cube' },
    ]);
  });

  it('[[H136]] clones a free-floating channel re-targeted to the duplicate', () => {
    const res = buildDuplicateNodeOps(animatedState(), 'box')!;
    const chAdd = res.ops.find(
      (o) => o.type === 'addNode' && (o as { nodeType: string }).nodeType === 'KeyframeChannelVec3',
    ) as { nodeId: string; params: { target: string; paramPath: string } } | undefined;
    expect(chAdd).toBeDefined();
    // the clone points at the duplicate, not the original.
    expect(chAdd!.params.target).toBe('box_copy');
    expect(chAdd!.params.paramPath).toBe('position');
    // the clone gets a fresh id.
    expect(chAdd!.nodeId).not.toBe('ch');
  });

  it('deep-copies the cloned channel params (mutating the clone op does not touch the source)', () => {
    const state = animatedState();
    const res = buildDuplicateNodeOps(state, 'box')!;
    const chAdd = res.ops.find(
      (o) => o.type === 'addNode' && (o as { nodeType: string }).nodeType === 'KeyframeChannelVec3',
    ) as { params: { keyframes: { value: number[] }[] } };
    chAdd.params.keyframes[0].value[0] = 99;
    expect(
      (state.nodes.ch.params as { keyframes: { value: number[] }[] }).keyframes[0].value[0],
    ).toBe(0);
  });

  it('returns null for a node that is not wired into the scene', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).box;
    expect(buildDuplicateNodeOps(state, 'box')).toBeNull();
  });

  it('cloned params are a deep copy (mutating the clone op does not touch the source)', () => {
    const state = fakeState();
    const res = buildDuplicateNodeOps(state, 'box')!;
    const addOp = res.ops[0] as { params: { position: number[] } };
    addOp.params.position[0] = 99;
    expect((state.nodes.box.params as { position: number[] }).position[0]).toBe(0);
  });

  // ── #434: duplicate now clones the WHOLE id-reference universe, not just channels ──

  const addNodeOf = (ops: ReturnType<typeof buildDuplicateNodeOps>, nodeType: string) =>
    (ops as { ops: unknown[] }).ops.find(
      (o) =>
        (o as { type: string; nodeType?: string }).type === 'addNode' &&
        (o as { nodeType?: string }).nodeType === nodeType,
    ) as { nodeId: string; params: Record<string, unknown> } | undefined;

  it('clones a Track-To constraint, re-pointing target to the clone and sharing the aim', () => {
    // aimNode is an argument ref → the copy must aim at the SAME external null, not a
    // clone of it. target is subject → it must follow to the duplicate.
    const state = fakeState();
    (state.nodes as Record<string, unknown>).aimNull = {
      id: 'aimNull',
      type: 'Null',
      params: { position: [9, 9, 9] },
      inputs: {},
    };
    (state.nodes as Record<string, unknown>).tt = {
      id: 'tt',
      type: 'TrackTo',
      params: { target: 'box', aimNode: 'aimNull', up: [0, 1, 0] },
      inputs: {},
    };
    const res = buildDuplicateNodeOps(state, 'box')!;
    const clone = addNodeOf(res, 'TrackTo');
    expect(clone).toBeDefined();
    expect(clone!.nodeId).not.toBe('tt');
    expect(clone!.params.target).toBe('box_copy'); // subject → clone
    expect(clone!.params.aimNode).toBe('aimNull'); // argument → shared original
  });

  // A driver on `box` reading one Math node by wire.
  const drivenState = () => {
    const state = fakeState();
    (state.nodes as Record<string, unknown>).cmp = {
      id: 'cmp',
      type: 'Math',
      params: {},
      inputs: {},
    };
    (state.nodes as Record<string, unknown>).drv = {
      id: 'drv',
      type: 'ParamDriver',
      params: { target: 'box', paramPath: 'position' },
      inputs: { in: { node: 'cmp', socket: 'out' } },
    };
    return state;
  };
  const sourceOf = (res: NonNullable<ReturnType<typeof buildDuplicateNodeOps>>, driverId: string) =>
    (
      res.ops.find(
        (o) =>
          o.type === 'connect' &&
          (o as { to: { node: string; socket: string } }).to.node === driverId &&
          (o as { to: { socket: string } }).to.socket === 'in',
      ) as { from: { node: string } } | undefined
    )?.from.node;

  it('clones a ParamDriver, re-pointing target, and copies the source it owns (#1561)', () => {
    // A driver owns its `in` wire, so a deep duplicate gives the copy its own source: changing
    // the copy's must not change the original's. It stayed shared until #1561.
    const res = buildDuplicateNodeOps(drivenState(), 'box')!;
    const clone = addNodeOf(res, 'ParamDriver');
    expect(clone).toBeDefined();
    expect(clone!.params.target).toBe('box_copy');
    expect(sourceOf(res, clone!.nodeId)).toBe('cmp_copy');
    expect(addNodeOf(res, 'Math')?.nodeId).toBe('cmp_copy');
  });

  it('a LINKED duplicate copies the driver and shares its source (#1561)', () => {
    const res = buildDuplicateNodeOps(drivenState(), 'box', { linked: true })!;
    const clone = addNodeOf(res, 'ParamDriver');
    expect(clone!.params.target).toBe('box_copy');
    expect(sourceOf(res, clone!.nodeId)).toBe('cmp');
    expect(addNodeOf(res, 'Math')).toBeUndefined();
  });

  it('clears the nested source id only, preserving the sibling channel', () => {
    // sourceTransform is {node, channel}; remap must keep `channel` when it lands on
    // the shared controller (the H177-shaped trap: don't clobber siblings).
    const state = fakeState();
    (state.nodes as Record<string, unknown>).ctrl = {
      id: 'ctrl',
      type: 'Null',
      params: { position: [3, 3, 3] },
      inputs: {},
    };
    (state.nodes as Record<string, unknown>).drv = {
      id: 'drv',
      type: 'ParamDriver',
      params: {
        target: 'box',
        paramPath: 'intensity',
        sourceTransform: { node: 'ctrl', channel: 'ty' },
      },
      inputs: {},
    };
    const res = buildDuplicateNodeOps(state, 'box')!;
    const clone = addNodeOf(res, 'ParamDriver');
    expect(clone!.params.sourceTransform as { node: string; channel: string }).toEqual({
      node: 'ctrl', // shared controller (argument), not cloned
      channel: 'ty', // sibling survived the remap
    });
  });

  it('clones an NLA strip and appends the clone to the same track', () => {
    // A strip is inert unless a Track lists it — the clone must join the original's
    // track, sharing the (reusable) Action.
    const state = fakeState();
    (state.nodes as Record<string, unknown>).act = {
      id: 'act',
      type: 'Action',
      params: { name: 'wave', channels: [] },
      inputs: {},
    };
    (state.nodes as Record<string, unknown>).strip = {
      id: 'strip',
      type: 'Strip',
      params: { target: 'box', action: 'act', start: 7 },
      inputs: {},
    };
    (state.nodes as Record<string, unknown>).trk = {
      id: 'trk',
      type: 'Track',
      params: { strips: ['strip'], order: 0 },
      inputs: {},
    };
    const res = buildDuplicateNodeOps(state, 'box')!;
    const clone = addNodeOf(res, 'Strip');
    expect(clone!.params.target).toBe('box_copy'); // subject → clone
    expect(clone!.params.action).toBe('act'); // shared Action (argument), not cloned
    // the track now lists both the original strip and the clone.
    const setStrips = res.ops.find(
      (o) => o.type === 'setParam' && (o as { nodeId: string }).nodeId === 'trk',
    ) as { value: string[] } | undefined;
    expect(setStrips?.value).toEqual(['strip', clone!.nodeId]);
    // and the shared Action is NOT cloned.
    expect(addNodeOf(res, 'Action')).toBeUndefined();
  });

  it('does NOT clone a constraint that merely AIMS AT the duplicated object', () => {
    // argument-only referrer: a TrackTo on some OTHER object aiming at `box`. The
    // constraint belongs to that other object; duplicating box must leave it alone.
    const state = fakeState();
    (state.nodes as Record<string, unknown>).tt = {
      id: 'tt',
      type: 'TrackTo',
      params: { target: 'inner', aimNode: 'box', up: [0, 1, 0] },
      inputs: {},
    };
    const res = buildDuplicateNodeOps(state, 'box')!;
    expect(addNodeOf(res, 'TrackTo')).toBeUndefined();
  });
});

// ─── #394 S4 — SHARE-ON-DUPLICATE, THE GATE (D5) ─────────────────────────────────
//
// The claim: duplicating an Object whose data links a Material node leaves the MATERIAL
// SHARED while the data node itself is deep-copied. That is Blender's Shift+D — the mesh
// datablock is copied, the material datablock keeps its user count and gains one.
//
// ⚠️ THE PLAN ASKED FOR THE WRONG GATE, AND MEASURING IT IS WHY THIS BLOCK LOOKS
// DIFFERENT. PLAN S4 says "assert `followedEdges` does not include 'material'". Two
// measurements at head say that assertion could never fail and would not pin this
// anyway:
//   1. 'material' is not a member of `EdgeKind` (closure/types.ts:22-41), so
//      `followedEdges: ['material']` is a COMPILE error. A runtime assertion that it is
//      absent is satisfied by the type system before it runs — a gate that cannot go red.
//   2. The duplicate mutator follows 'children', which walks producers under ANY socket,
//      so the Material node IS inside the closure regardless. Closure membership is a
//      PERMISSION scope, not the sharing rule — and it must include the Material, or the
//      re-point `connect` the builder emits would be rejected as out-of-scope.
//
// What actually decides sharing is `OWNED_SOCKETS` (sceneNodeActions.ts:209): the walk
// deep-copies through 'children'/'target'/'data' and RE-POINTS every other input at the
// original. 'material' is absent from that list, which is the whole mechanism. So this
// gate pins the observable consequence of that absence rather than the absence itself.
//
// AND IT ASSERTS THE EVALUATED MATERIAL, NEVER THE OPS. An op-shaped assertion ("a
// connect to 'm' was emitted") passes against a build where the clone's binding appended
// instead of replaced, or where the socket read the wrong entry — the exact defect the
// material picker shipped a fix for. The vacuity guard is the same one materialSocket.ts
// uses: the Material node and the data node's own param carry DIFFERENT colours, so a
// clone that lost its edge would read the param's colour rather than merely matching.
describe('#394 S4 — a duplicated Object SHARES its Material node', () => {
  const LINKED = '#c81e5a';
  const INLINE = '#1e9ac8';

  function linkedScene(): DagState {
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} },
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'Material',
        params: { material: { name: 'shared', base: { color: LINKED } } },
      },
      {
        type: 'addNode',
        nodeId: 'data',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: { name: 'inline', base: { color: INLINE } } },
      },
      { type: 'addNode', nodeId: 'obj', nodeType: 'Object', params: { position: [0, 0, 0] } },
      {
        type: 'connect',
        from: { node: 'data', socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'obj', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'm', socket: 'out' },
        to: { node: 'data', socket: 'material' },
      },
    ];
    let state = emptyDagState();
    for (const op of ops) state = applyOp(state, op).next;
    return state;
  }

  function duplicated(): DagState {
    const state = linkedScene();
    const res = buildDuplicateNodeOps(state, 'obj')!;
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    return next;
  }

  const colorOf = (state: DagState, id: string) =>
    (evaluate(state, id).value as MeshDataValue).material!.base.color;

  it('clones the data node but NOT the Material — the user count grows, the datablock does not', () => {
    const before = linkedScene();
    const after = duplicated();

    const materialsBefore = Object.values(before.nodes).filter((n) => n.type === 'Material');
    const materialsAfter = Object.values(after.nodes).filter((n) => n.type === 'Material');
    // Guard the guard: a fixture with no Material at all would satisfy "count unchanged".
    expect(materialsBefore).toHaveLength(1);
    expect(materialsAfter).toHaveLength(1);

    // …while the DATA node genuinely was deep-copied (the 'data' socket IS owned). Without
    // this half, "nothing was cloned at all" would also pass the assertion above.
    const dataNodes = Object.values(after.nodes).filter((n) => n.type === 'BoxData');
    expect(dataNodes).toHaveLength(2);

    // Both data nodes point at the SAME Material node id — sharing stated structurally.
    expect(after.nodes.data_copy.inputs.material).toEqual([{ node: 'm', socket: 'out' }]);
  });

  it('OBSERVED ON THE EVALUATED MATERIAL: both read the linked colour, not the param colour', () => {
    const after = duplicated();
    // If the clone had lost its material edge it would fall through to its own copied
    // param and read INLINE. Distinct colours are what make that failure visible instead
    // of merely equal.
    expect(colorOf(after, 'data')).toBe(LINKED);
    expect(colorOf(after, 'data_copy')).toBe(LINKED);
    expect(colorOf(after, 'data_copy')).not.toBe(INLINE);
  });

  it('THE PAYOFF: editing the shared Material once moves BOTH the original and the clone', () => {
    const after = duplicated();
    const EDITED = '#00ff44';
    const edited = applyOp(after, {
      type: 'setParam',
      nodeId: 'm',
      paramPath: 'material.base.color',
      value: EDITED,
    }).next;

    expect(colorOf(edited, 'data')).toBe(EDITED);
    expect(colorOf(edited, 'data_copy')).toBe(EDITED);
    // Non-vacuous: the edit really did change something (both were LINKED before).
    expect(EDITED).not.toBe(LINKED);
  });
});

// #1553 — a name follower is a relationship like a channel's target, so the delete door clears
// it. Before, the follower kept `nameFrom` pointing at a node that was gone.
describe('buildDeleteNodesOps — a node following a deleted node’s name (#1553)', () => {
  const scene = (): DagState =>
    (
      [
        { type: 'addNode', nodeId: 'src', nodeType: 'Math', params: {} },
        { type: 'addNode', nodeId: 'named', nodeType: 'Math', params: {} },
        { type: 'setMeta', nodeId: 'src', name: 'walk' },
        { type: 'setMeta', nodeId: 'named', name: 'stale', nameFrom: 'src' },
        { type: 'addNode', nodeId: 'other', nodeType: 'Math', params: {} },
      ] as Op[]
    ).reduce((state, op) => applyOp(state, op).next, emptyDagState());

  it('the follower keeps the name it had and stops following', () => {
    const before = scene();
    expect(before.nodes.named.meta).toEqual({ name: 'walk', nameFrom: 'src' });
    const after = buildDeleteNodesOps(before, ['src']).reduce(
      (state, op) => applyOp(state, op).next,
      before,
    );
    expect(after.nodes.src).toBeUndefined();
    expect(after.nodes.named.meta).toEqual({ name: 'walk' });
    expect(danglingIdRefs(after.nodes)).toEqual([]);
  });

  it('CONTROL: deleting an unrelated node leaves the link alone', () => {
    const before = scene();
    const after = buildDeleteNodesOps(before, ['other']).reduce(
      (state, op) => applyOp(state, op).next,
      before,
    );
    expect(after.nodes.named.meta).toEqual({ name: 'walk', nameFrom: 'src' });
  });
});

describe('buildDeleteNodesOps — an Object that carries a modifier stack (#1620)', () => {
  // Schema-valid and folded through the real store, because the failure was a REFUSAL at the
  // commit: the ops looked plausible and the store threw on one of them.
  const withStack = (count: number) => {
    let s = buildDefaultDagState();
    const mods: string[] = [];
    for (let i = 0; i < count; i++) {
      const add = buildAddModifierOps(s, resolveStackBase(s, 'n_box'), 'ArrayModifier', {})!;
      s = (add.ops as Op[]).reduce((acc, op) => applyOp(acc, op).next, s);
      mods.push(add.modifierId);
    }
    return { s, mods };
  };
  const commit = (s: DagState, ids: string[]) => {
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, ids), 'user', 'delete');
    return useDagStore.getState().state;
  };
  // The scene's children beside the default sun's aim empty (#1765), which these leave alone.
  const sceneChildren = (s: DagState) =>
    ((s.nodes.n_scene.inputs.children ?? []) as { node: string }[])
      .map((r) => r.node)
      .filter((id) => id !== 'n_light_target');

  it('CONTROL: the plain cube deletes with its data', () => {
    const after = commit(buildDefaultDagState(), ['n_box']);
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes.n_box_data).toBeUndefined();
  });

  it.each([1, 2, 3])('deletes the Object, all %i modifier(s) and the base data', (count) => {
    const { s, mods } = withStack(count);
    const after = commit(s, ['n_box']);
    for (const id of ['n_box', 'n_box_data', ...mods]) expect(after.nodes[id]).toBeUndefined();
    expect(sceneChildren(after)).not.toContain('n_box');
    // One undo step brings every node and wire back.
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('a Group deleted with that Object takes the whole stack with it', () => {
    const { s, mods } = withStack(2);
    const grouped = (
      [
        { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'G', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'G', socket: 'world' },
          to: { node: 'n_box', socket: 'parent' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    const after = commit(grouped, ['G', 'n_box']);
    for (const id of ['G', 'n_box', 'n_box_data', ...mods]) expect(after.nodes[id]).toBeUndefined();
    // #1517 — the Group alone hands the Object up, and the stack stays under it.
    const kept = commit(grouped, ['G']);
    expect(kept.nodes.G).toBeUndefined();
    expect(kept.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
    for (const id of ['n_box', 'n_box_data', ...mods]) expect(kept.nodes[id]).toBeDefined();
  });

  // Two Objects reading ONE stack (a linked duplicate, built by hand).
  const shared = () => {
    const { s, mods } = withStack(2);
    const top = (s.nodes.n_box.inputs.data as { node: string }).node;
    const state = (
      [
        { type: 'addNode', nodeId: 'twin', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: top, socket: 'out' },
          to: { node: 'twin', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'twin', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    return { state, mods, top };
  };

  it('a stack two Objects share stays when one of them is deleted', () => {
    const { state, mods, top } = shared();
    const after = commit(state, ['n_box']);
    expect(after.nodes.n_box).toBeUndefined();
    for (const id of ['n_box_data', ...mods]) expect(after.nodes[id]).toBeDefined();
    expect(after.nodes.twin.inputs.data).toEqual({ node: top, socket: 'out' });
  });

  it('the Object and its top modifier named together take the rest of the stack too', () => {
    const { s, mods } = withStack(2);
    const top = (s.nodes.n_box.inputs.data as { node: string }).node;
    const after = commit(s, ['n_box', top]);
    for (const id of ['n_box', 'n_box_data', ...mods]) expect(after.nodes[id]).toBeUndefined();
  });

  it('a shared top modifier deleted with ONE of its Objects is spliced into the Object that stays', () => {
    const { state, mods, top } = shared();
    const below = (state.nodes[top].inputs.target as { node: string }).node;
    const after = commit(state, ['n_box', top]);
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes[top]).toBeUndefined();
    expect(mods).toContain(below);
    expect(after.nodes.twin.inputs.data).toEqual({ node: below, socket: 'out' });
    expect(after.nodes.n_box_data).toBeDefined();
  });

  it('a deleted Object ends the splice: data something else still reads is never offered to the scene', () => {
    // `twin` reads the LOWER modifier directly, so it survives the delete of the cube and its
    // top modifier. The top modifier's only reader is the deleted cube, and what read the cube
    // is the scene, which takes scene objects and not the data the stack carries.
    const { s, mods } = withStack(2);
    const top = (s.nodes.n_box.inputs.data as { node: string }).node;
    const below = (s.nodes[top].inputs.target as { node: string }).node;
    const state = (
      [
        { type: 'addNode', nodeId: 'twin', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: below, socket: 'out' },
          to: { node: 'twin', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'twin', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    const after = commit(state, ['n_box', top]);
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes[top]).toBeUndefined();
    expect(mods).toContain(below);
    expect(after.nodes.twin.inputs.data).toEqual({ node: below, socket: 'out' });
    expect(sceneChildren(after)).toEqual(['twin']);
  });

  it('CONTROL: a modifier deleted on its own keeps the Object and the mesh', () => {
    const { s, mods } = withStack(2);
    const after = commit(s, [mods[0]]);
    expect(after.nodes[mods[0]]).toBeUndefined();
    expect(after.nodes.n_box).toBeDefined();
    expect(after.nodes.n_box_data).toBeDefined();
    expect(after.nodes[mods[1]]).toBeDefined();
  });
});

describe('buildDeleteNodesOps — the order the ids arrive in (#1621)', () => {
  const grouped = () =>
    (
      [
        { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'G', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'G', socket: 'world' },
          to: { node: 'n_box', socket: 'parent' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, buildDefaultDagState());

  it.each([
    [['G', 'n_box']], // CONTROL: parent first always worked
    [['n_box', 'G']],
    [['n_box', 'n_box_data']], // CONTROL: the Object before its data always worked
    [['n_box_data', 'n_box']],
    [['n_box_data', 'n_box', 'G']],
  ])('deletes %j whatever the order', (ids) => {
    const s = grouped();
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, ids), 'user', 'delete');
    const after = useDagStore.getState().state;
    for (const id of ['G', 'n_box', 'n_box_data']) {
      if (ids.includes(id) || id !== 'G') expect(after.nodes[id]).toBeUndefined();
    }
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('keeps the given order when it was already safe', () => {
    const s = grouped();
    const removed = (ids: string[]) =>
      buildDeleteNodesOps(s, ids)
        .filter((op) => op.type === 'removeNode')
        .map((op) => (op as { nodeId: string }).nodeId);
    // #1824 — the cube reads the group's world through its parent input, so the cube goes first:
    // the given order is kept when it is that one, and put right when it is not.
    expect(removed(['n_box', 'G'])).toEqual(['n_box', 'G', 'n_box_data']);
    expect(removed(['G', 'n_box'])).toEqual(['n_box', 'G', 'n_box_data']);
  });
});

describe('buildDeleteNodesOps — what a deleted node takes with it (#1560)', () => {
  // Every case is committed through the real store, and names both what must go and what must stay.
  const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
    ({ type: 'addNode', nodeId, nodeType, params }) as Op;
  const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
    ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
  const fold = (s: DagState, ops: readonly Op[]) =>
    ops.reduce((acc, op) => applyOp(acc, op).next, s);
  const commit = (s: DagState, ids: string[]) => {
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, ids), 'user', 'delete');
    const after = useDagStore.getState().state;
    // One undo step puts every node and wire back.
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
    return after;
  };
  const gone = (after: DagState, ids: readonly string[]) =>
    ids.filter((id) => after.nodes[id] !== undefined);
  const kept = (after: DagState, ids: readonly string[]) =>
    ids.filter((id) => after.nodes[id] === undefined);

  // A cube sprung to a Null: driver ← Solver ← a nine-node sub-network.
  const sprung = () => {
    const s = fold(buildDefaultDagState(), [
      node('ctl', 'Null'),
      wire('ctl', 'n_scene', 'children'),
    ]);
    const built = {
      ops: rawSpringOps(s, {
        targetId: 'n_box',
        controllerId: 'ctl',
        idFor: (k: SpringNodeKey) => `sp_${k}`,
      }),
    };
    return fold(s, built.ops);
  };
  const INSIDE = ['sp_in', 'sp_pp', 'sp_pv', 'sp_e', 'sp_ke', 'sp_cv', 'sp_acc', 'sp_nv', 'sp_np'];

  describe('a sub-network goes with its owner', () => {
    it('the fixture is a Solver owning nine nodes', () => {
      expect([...subnetworkOf(sprung(), 'sp_solver')].sort()).toEqual([...INSIDE].sort());
    });

    it('deleting the Solver takes its sub-network and leaves the driver and the cube', () => {
      const after = commit(sprung(), ['sp_solver']);
      expect(gone(after, ['sp_solver', ...INSIDE])).toEqual([]);
      expect(kept(after, ['sp_driver', 'n_box', 'ctl'])).toEqual([]);
    });

    it('deleting the sprung cube takes the driver, then the Solver, then its sub-network', () => {
      const after = commit(sprung(), ['n_box']);
      expect(gone(after, ['n_box', 'n_box_data', 'sp_driver', 'sp_solver', ...INSIDE])).toEqual([]);
      expect(kept(after, ['ctl'])).toEqual([]);
    });

    it('removing the driver (the inspector ✕ and Unbind) takes the Solver it alone read', () => {
      for (const ops of [
        buildRemoveDriverOps(sprung(), 'sp_driver')!,
        buildUnbindDriverOps(sprung(), 'n_box', 'position'),
      ]) {
        const s = sprung();
        useDagStore.getState().hydrate(s);
        useDagStore.getState().dispatchAtomic(ops, 'user', 'remove driver');
        const after = useDagStore.getState().state;
        expect(gone(after, ['sp_driver', 'sp_solver', ...INSIDE])).toEqual([]);
        expect(kept(after, ['n_box', 'ctl'])).toEqual([]);
      }
    });

    it('CONTROL: a Solver a second driver still reads stays, with its sub-network', () => {
      const s = fold(sprung(), [
        node('other', 'ParamDriver', { target: 'ctl', paramPath: 'scale' }),
        wire('sp_solver', 'other', 'in', 'outVec'),
      ]);
      const after = commit(s, ['sp_driver']);
      expect(gone(after, ['sp_driver'])).toEqual([]);
      expect(kept(after, ['sp_solver', 'other', ...INSIDE])).toEqual([]);
    });

    it('a node deleted INSIDE takes the leaf only it read, and nothing else', () => {
      const s = sprung();
      useDagStore.getState().hydrate(s);
      useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, ['sp_e']), 'user', 'delete');
      const after = useDagStore.getState().state;
      expect(gone(after, ['sp_e', 'sp_in'])).toEqual([]);
      expect(kept(after, ['sp_solver', 'sp_pp', 'sp_ke', 'sp_np'])).toEqual([]);
      // #1623 — the node comes back with its input wires one operation before the wire that
      // puts it back inside; the batch is judged on where it ends, so the undo goes through.
      useDagStore.getState().undo();
      expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
    });

    it('#1623: every single node inside the Solver deletes and undoes back to the same graph', () => {
      const s = sprung();
      const inside = Object.keys(s.nodes).filter((id) => INSIDE.includes(id));
      expect(inside.length).toBe(INSIDE.length);
      for (const id of inside) {
        useDagStore.getState().hydrate(s);
        useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, [id]), 'user', 'delete');
        expect(useDagStore.getState().state.nodes[id]).toBeUndefined();
        useDagStore.getState().undo();
        expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
      }
    });
  });

  describe('a driver owns its source', () => {
    const driven = (extra: Op[] = []) =>
      fold(buildDefaultDagState(), [
        node('k', 'Math', {}),
        node('k0', 'Math', {}),
        wire('k0', 'k', 'a'),
        node('drv', 'ParamDriver', { target: 'n_box', paramPath: 'position.0' }),
        wire('k', 'drv', 'in'),
        ...extra,
      ]);

    it('deleting the cube takes the compute chain only its driver read', () => {
      const after = commit(driven(), ['n_box']);
      expect(gone(after, ['n_box', 'drv', 'k', 'k0'])).toEqual([]);
    });

    it('CONTROL: a source a driver on another object still reads stays', () => {
      const after = commit(
        driven([
          node('drv2', 'ParamDriver', { target: 'n_light', paramPath: 'position.0' }),
          wire('k', 'drv2', 'in'),
        ]),
        ['n_box'],
      );
      expect(gone(after, ['n_box', 'drv'])).toEqual([]);
      expect(kept(after, ['k', 'k0', 'drv2'])).toEqual([]);
    });

    it('a source another driver names by reference (its spare param) stays, and the reference holds', () => {
      const s = fold(driven(), [
        {
          type: 'setSpareParam',
          nodeId: 'k',
          param: { key: 'gain', type: 'float', value: 2 },
        } as unknown as Op,
        node('drv2', 'ParamDriver', {
          target: 'n_light',
          paramPath: 'position.0',
          sourceSpare: { node: 'k', key: 'gain' },
        }),
      ]);
      const after = commit(s, ['n_box']);
      expect(gone(after, ['n_box', 'drv'])).toEqual([]);
      expect(kept(after, ['k', 'drv2'])).toEqual([]);
      expect((after.nodes.drv2.params as { sourceSpare: { node: string } }).sourceSpare.node).toBe(
        'k',
      );
    });
  });

  // An armature Object over three pose layers: Skeleton.pose → L1 → L2 → L3 → ARM.pose.
  const BONES = [
    { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'lower', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];
  const layer = (id: string, bone: string, mode?: string) =>
    node(id, 'PoseLayer', {
      name: id,
      ...(mode ? { mode } : {}),
      members: [{ bone, rotationMode: 'XYZ', rotation: [0, 10, 0] }],
    });
  const armature = () =>
    fold(buildDefaultDagState(), [
      node('n_skel', 'Skeleton', { bones: BONES }),
      layer('L1', 'lower'),
      wire('n_skel', 'L1', 'pose', 'pose'),
      layer('L2', 'lower', 'additive'),
      wire('L1', 'L2', 'pose'),
      layer('L3', 'upper', 'additive'),
      wire('L2', 'L3', 'pose'),
      node('ARM', 'Object'),
      wire('L3', 'ARM', 'pose'),
      wire('n_skel', 'ARM', 'data'),
      wire('ARM', 'n_scene', 'children'),
    ]);
  const rigged = () => {
    const s = armature();
    const w = wrapInRig(s, {
      object: 'ARM',
      rigId: 'RIG',
      inputId: 'RIG_in',
      layers: ['L2', 'L3'],
    } as never);
    if (!w.ok) throw new Error(w.reason);
    return fold(s, w.ops);
  };

  describe('the pose stack under an armature Object', () => {
    it('deleting the Object takes the skeleton and every layer', () => {
      const after = commit(armature(), ['ARM']);
      expect(gone(after, ['ARM', 'n_skel', 'L1', 'L2', 'L3'])).toEqual([]);
    });

    it('with the layers in a Rig, the Rig and its input go too', () => {
      const s = rigged();
      expect([...subnetworkOf(s, 'RIG')].sort()).toEqual(['L2', 'L3', 'RIG_in']);
      const after = commit(s, ['ARM']);
      expect(gone(after, ['ARM', 'n_skel', 'L1', 'L2', 'L3', 'RIG', 'RIG_in'])).toEqual([]);
    });

    it('CONTROL: a pose stack a second Object reads stays when one of them is deleted', () => {
      const s = fold(armature(), [
        node('TWIN', 'Object'),
        wire('L3', 'TWIN', 'pose'),
        wire('n_skel', 'TWIN', 'data'),
        wire('TWIN', 'n_scene', 'children'),
      ]);
      const after = commit(s, ['ARM']);
      expect(gone(after, ['ARM'])).toEqual([]);
      expect(kept(after, ['n_skel', 'L1', 'L2', 'L3', 'TWIN'])).toEqual([]);
      expect(after.nodes.TWIN.inputs.pose).toEqual({ node: 'L3', socket: 'out' });
    });

    it('a layer deleted from the middle is spliced out: the stack stays whole', () => {
      const after = commit(armature(), ['L2']);
      expect(gone(after, ['L2'])).toEqual([]);
      expect(kept(after, ['L1', 'L3', 'ARM', 'n_skel'])).toEqual([]);
      expect(after.nodes.L3.inputs.pose).toEqual({ node: 'L1', socket: 'out' });
      expect(after.nodes.ARM.inputs.pose).toEqual({ node: 'L3', socket: 'out' });
    });

    it('the top layer deleted hands the Object the layer below', () => {
      const after = commit(armature(), ['L3']);
      expect(after.nodes.ARM.inputs.pose).toEqual({ node: 'L2', socket: 'out' });
    });

    it('a deleted Rig takes the layers inside it and hands the Object the pose it read', () => {
      const after = commit(rigged(), ['RIG']);
      expect(gone(after, ['RIG', 'RIG_in', 'L2', 'L3'])).toEqual([]);
      expect(kept(after, ['L1', 'ARM', 'n_skel'])).toEqual([]);
      expect(after.nodes.ARM.inputs.pose).toEqual({ node: 'L1', socket: 'out' });
    });

    it('a layer deleted inside a Rig is spliced out inside it', () => {
      const after = commit(rigged(), ['L3']);
      expect(gone(after, ['L3'])).toEqual([]);
      expect(after.nodes.RIG.inputs.body).toEqual({ node: 'L2', socket: 'out' });
      expect(after.nodes.L2.inputs.pose).toEqual({ node: 'RIG_in', socket: 'out' });
    });

    it('#1623: every single node inside a Rig deletes and undoes back to the same graph', () => {
      const s = rigged();
      const inside = [...subnetworkOf(s, 'RIG')].sort();
      expect(inside).toEqual(['L2', 'L3', 'RIG_in']);
      for (const id of inside) {
        useDagStore.getState().hydrate(s);
        useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, [id]), 'user', 'delete');
        expect(useDagStore.getState().state.nodes[id]).toBeUndefined();
        useDagStore.getState().undo();
        expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
      }
    });
  });

  describe('what a delete leaves alone', () => {
    it('a Material stays when the last cube using it is deleted', () => {
      const made = buildNewMaterialOps(buildDefaultDagState(), 'n_box_data', 'MAT')!;
      const after = commit(fold(buildDefaultDagState(), made.ops), ['n_box']);
      expect(gone(after, ['n_box', 'n_box_data'])).toEqual([]);
      expect(kept(after, ['MAT'])).toEqual([]);
    });

    it('an Action stays when the object its strip was placed on is deleted', () => {
      const s = fold(buildDefaultDagState(), [
        node('act', 'Action', { name: 'wave', channels: [] }),
        node('strip', 'Strip', { target: 'n_box', action: 'act', start: 7 }),
        node('trk', 'Track', { strips: ['strip'], order: 0 }),
      ]);
      const after = commit(s, ['n_box']);
      expect(gone(after, ['n_box', 'strip'])).toEqual([]);
      expect(kept(after, ['act', 'trk'])).toEqual([]);
    });
  });
});

describe('buildDeleteNodesOps — the cost does not grow with what is deleted (#1629)', () => {
  // Counted, not timed: how many times the builder enumerates the whole node table. It used to
  // do so once per deleted node, twice over (4.3 s for a group of 2,000 cubes).
  const groupOf = (count: number): DagState => {
    const data = buildDefaultDagState().nodes.n_box_data.params;
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'G', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ];
    for (let i = 0; i < count; i++) {
      ops.push(
        { type: 'addNode', nodeId: `d${i}`, nodeType: 'BoxData', params: structuredClone(data) },
        { type: 'addNode', nodeId: `o${i}`, nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: `d${i}`, socket: 'out' },
          to: { node: `o${i}`, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'G', socket: 'world' },
          to: { node: `o${i}`, socket: 'parent' },
        },
        // #1823 — each a member of the scene's own list, as the doors that make one link it.
        {
          type: 'connect',
          from: { node: `o${i}`, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      );
    }
    return ops.reduce((acc, op) => applyOp(acc, op).next, buildDefaultDagState());
  };
  const walksToDelete = (count: number) => {
    const s = groupOf(count);
    let walks = 0;
    const counted = {
      ...s,
      nodes: new Proxy(s.nodes, {
        ownKeys(target) {
          walks++;
          return Reflect.ownKeys(target);
        },
      }),
    } as DagState;
    const ops = buildDeleteNodesOps(counted, [
      'G',
      ...Array.from({ length: count }, (_, i) => `o${i}`),
    ]);
    expect(ops.filter((op) => op.type === 'removeNode')).toHaveLength(1 + 2 * count);
    return walks;
  };
  // #1517 — and handing them up instead costs no more: one solve per holder, not per child.
  const walksToHandUp = (count: number) => {
    const s = groupOf(count);
    let walks = 0;
    const counted = {
      ...s,
      nodes: new Proxy(s.nodes, {
        ownKeys(target) {
          walks++;
          return Reflect.ownKeys(target);
        },
      }),
    } as DagState;
    const ops = buildDeleteNodesOps(counted, ['G']);
    expect(ops.filter((op) => op.type === 'removeNode')).toEqual([
      { type: 'removeNode', nodeId: 'G' },
    ]);
    // #1823 — each child is listed by the scene already, so handing it up cuts its parent input and
    // adds nothing.
    expect(ops.filter((op) => op.type === 'connect')).toHaveLength(0);
    expect(ops.filter((op) => op.type === 'disconnect' && op.to.socket === 'parent')).toHaveLength(
      count,
    );
    return walks;
  };

  it('handing up 200 children enumerates the graph as often as handing up 20', () => {
    expect(walksToHandUp(200)).toBe(walksToHandUp(20));
  });

  it('…and so does handing them to a parent other than the scene, solved once per parent', () => {
    const under = (count: number) => {
      const s = (
        [
          { type: 'addNode', nodeId: 'H', nodeType: 'Group', params: { position: [1, 0, 0] } },
          {
            type: 'connect',
            from: { node: 'H', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: 'H', socket: 'world' },
            to: { node: 'G', socket: 'parent' },
          },
        ] as Op[]
      ).reduce((acc, op) => applyOp(acc, op).next, groupOf(count));
      let walks = 0;
      const counted = {
        ...s,
        nodes: new Proxy(s.nodes, {
          ownKeys(target) {
            walks++;
            return Reflect.ownKeys(target);
          },
        }),
      } as DagState;
      expect(buildDeleteNodesOps(counted, ['G']).filter((o) => o.type === 'connect')).toHaveLength(
        count,
      );
      return walks;
    };
    expect(under(200)).toBe(under(20));
  });

  it('a group of 200 enumerates the graph as often as a group of 20', () => {
    const small = walksToDelete(20);
    expect(small).toBeGreaterThan(0); // the counter sees the builder at all
    expect(walksToDelete(200)).toBe(small);
  });
});

describe('buildDeleteNodesOps — a collection never keeps a deleted group’s child (#1628)', () => {
  const grouped = () => {
    let s = (
      [
        { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'G', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'G', socket: 'world' },
          to: { node: 'n_box', socket: 'parent' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, buildDefaultDagState());
    s = newCollectionOps(s, null)!.ops.reduce((acc, op) => applyOp(acc, op).next, s);
    const coll = Object.keys(s.nodes).find((id) => s.nodes[id].type === 'Collection')!;
    s = membershipOps(coll, ['n_box']).reduce((acc, op) => applyOp(acc, op).next, s);
    return { s, coll };
  };
  const commit = (s: DagState, ids: string[]) => {
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(buildDeleteNodesOps(s, ids), 'user', 'delete');
    return useDagStore.getState().state;
  };

  it('the fixture: the cube is under the group AND in the collection', () => {
    const { s, coll } = grouped();
    expect(childIdsOf(s, 'G')).toEqual(['n_box']);
    expect(s.nodes[coll].inputs.members).toEqual([{ node: 'n_box', socket: 'out' }]);
  });

  it('deleting the group hands the child up, and the collection keeps listing it', () => {
    const { s, coll } = grouped();
    const after = commit(s, ['G']);
    expect(after.nodes.G).toBeUndefined();
    expect(after.nodes.n_box).toBeDefined();
    expect(after.nodes.n_box_data).toBeDefined();
    expect(after.nodes[coll].inputs.members).toEqual([{ node: 'n_box', socket: 'out' }]);
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('deleting the group AND the child takes its data, and the collection stops listing it', () => {
    const { s, coll } = grouped();
    const after = commit(s, ['G', 'n_box']);
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes.n_box_data).toBeUndefined();
    expect(after.nodes[coll]).toBeDefined();
    expect(after.nodes[coll].inputs.members ?? []).toEqual([]);
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('CONTROL: a child a second group still holds stays', () => {
    const { s } = grouped();
    const two = (
      [
        { type: 'addNode', nodeId: 'G2', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'G2', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'G2', socket: 'world' },
          to: { node: 'n_box', socket: 'parent' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    const after = commit(two, ['G']);
    expect(after.nodes.n_box).toBeDefined();
    expect(childIdsOf(after, 'G2')).toEqual(['n_box']);
  });
});

describe('buildDuplicateNodeOps — an original read on a single socket (#1630)', () => {
  const duplicated = (id: string) => {
    const s = buildDefaultDagState();
    const res = buildDuplicateNodeOps(s, id);
    if (!res) return { s, after: null, res };
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(res.ops, 'user', 'duplicate');
    return { s, after: useDagStore.getState().state, res };
  };

  it('the fixture: the default scene reads its camera on a single socket', () => {
    expect(buildDefaultDagState().nodes.n_scene.inputs.camera).toEqual({
      node: 'n_camera',
      socket: 'out',
    });
  });

  it('duplicating the scene camera leaves the scene on the original and adds a second camera', () => {
    const { after, res } = duplicated('n_camera');
    expect(after!.nodes.n_scene.inputs.camera).toEqual({ node: 'n_camera', socket: 'out' });
    const copy = after!.nodes[res!.newRootId];
    expect(copy.type).toBe('Object');
    const copyData = (copy.inputs.data as { node: string }).node;
    expect(copyData).not.toBe('n_camera_data');
    expect(after!.nodes[copyData].type).toBe('CameraData');
  });

  it('CONTROL: a cube and a light are still copied in right after the original', () => {
    expect(duplicated('n_box').after!.nodes.n_scene.inputs.children).toEqual([
      { node: 'n_box', socket: 'out' },
      { node: 'n_box_copy', socket: 'out' },
      // The default sun's aim empty (#1765), after the copy.
      { node: 'n_light_target', socket: 'out' },
    ]);
    expect(duplicated('n_light').after!.nodes.n_scene.inputs.lights).toEqual([
      { node: 'n_light', socket: 'out' },
      { node: 'n_light_copy', socket: 'out' },
    ]);
  });

  it('a data node, read on its Object’s single socket, has nothing to be duplicated as', () => {
    expect(buildDuplicateNodeOps(buildDefaultDagState(), 'n_box_data')).toBeNull();
  });
});

describe('buildDuplicateNodesOps — one duplicate rule, deep and linked (#1561)', () => {
  const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
    ({ type: 'addNode', nodeId, nodeType, params }) as Op;
  const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
    ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
  const fold = (s: DagState, ops: readonly Op[]) =>
    ops.reduce((acc, op) => applyOp(acc, op).next, s);
  // Committed through the real store, so a copy the one-owner rule refuses fails here.
  const commit = (s: DagState, ids: string[], linked = false) => {
    const res = buildDuplicateNodesOps(s, ids, { linked });
    if (!res) throw new Error('nothing to duplicate');
    useDagStore.getState().hydrate(s);
    useDagStore.getState().dispatchAtomic(res.ops, 'user', 'duplicate');
    const after = useDagStore.getState().state;
    expect(subnetworkViolations(after)).toEqual([]);
    expect(danglingIdRefs(after.nodes)).toEqual([]);
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
    return { after, roots: res.newRootIds };
  };
  const added = (s: DagState, after: DagState) =>
    Object.keys(after.nodes)
      .filter((id) => !s.nodes[id])
      .sort();
  // The scene's children beside the default sun's aim empty (#1765), which these leave alone.
  const children = (s: DagState) =>
    ((s.nodes.n_scene.inputs.children ?? []) as { node: string }[])
      .map((r) => r.node)
      .filter((id) => id !== 'n_light_target');

  const stacked = () => {
    let s = buildDefaultDagState();
    for (const type of ['ArrayModifier', 'MirrorModifier']) {
      s = fold(s, buildAddModifierOps(s, resolveStackBase(s, 'n_box'), type, {})!.ops as Op[]);
    }
    return s;
  };
  const sprung = () => {
    const s = fold(buildDefaultDagState(), [
      node('ctl', 'Null'),
      wire('ctl', 'n_scene', 'children'),
    ]);
    const built = {
      ops: rawSpringOps(s, {
        targetId: 'n_box',
        controllerId: 'ctl',
        idFor: (k: SpringNodeKey) => `sp_${k}`,
      }),
    };
    return fold(s, built.ops);
  };
  const BONES = [
    { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'lower', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];
  const layer = (id: string, bone: string, mode?: string) =>
    node(id, 'PoseLayer', {
      name: id,
      ...(mode ? { mode } : {}),
      members: [{ bone, rotationMode: 'XYZ', rotation: [0, 10, 0] }],
    });
  const armature = (rig: boolean) => {
    let s = fold(buildDefaultDagState(), [
      node('n_skel', 'Skeleton', { bones: BONES }),
      layer('L1', 'lower'),
      wire('n_skel', 'L1', 'pose', 'pose'),
      layer('L2', 'lower', 'additive'),
      wire('L1', 'L2', 'pose'),
      layer('L3', 'upper', 'additive'),
      wire('L2', 'L3', 'pose'),
      node('ARM', 'Object'),
      wire('L3', 'ARM', 'pose'),
      wire('n_skel', 'ARM', 'data'),
      wire('ARM', 'n_scene', 'children'),
    ]);
    if (rig) {
      const w = wrapInRig(s, {
        object: 'ARM',
        rigId: 'RIG',
        inputId: 'RIG_in',
        layers: ['L2', 'L3'],
      } as never);
      if (!w.ok) throw new Error(w.reason);
      s = fold(s, w.ops);
    }
    return s;
  };

  describe('deep (Shift+D) copies what the original owns', () => {
    it('CONTROL: a plain cube gets its own data and nothing else', () => {
      const s = buildDefaultDagState();
      const { after } = commit(s, ['n_box']);
      expect(added(s, after)).toEqual(['n_box_copy', 'n_box_data_copy']);
    });

    it('the whole modifier stack and the base data', () => {
      const s = stacked();
      const { after } = commit(s, ['n_box']);
      expect(added(s, after)).toHaveLength(4);
      const top = (after.nodes.n_box_copy.inputs.data as { node: string }).node;
      expect(top).not.toBe((s.nodes.n_box.inputs.data as { node: string }).node);
      expect(s.nodes[top]).toBeUndefined();
    });

    it('the pose stack under an armature Object, so posing the copy cannot pose the original', () => {
      const s = armature(false);
      const { after } = commit(s, ['ARM']);
      expect(added(s, after)).toEqual(['ARM_copy', 'L1_copy', 'L2_copy', 'L3_copy', 'n_skel_copy']);
      expect(after.nodes.ARM_copy.inputs.pose).toEqual({ node: 'L3_copy', socket: 'out' });
      expect(after.nodes.L1_copy.inputs.pose).toEqual({ node: 'n_skel_copy', socket: 'pose' });
      expect(after.nodes.ARM.inputs.pose).toEqual({ node: 'L3', socket: 'out' });
    });

    it('a Rig and everything inside it, as a second sub-network with its own owner', () => {
      const s = armature(true);
      const { after } = commit(s, ['ARM']);
      expect(after.nodes.ARM_copy.inputs.pose).toEqual({ node: 'RIG_copy', socket: 'out' });
      expect([...subnetworkOf(after, 'RIG_copy')].sort()).toEqual([
        'L2_copy',
        'L3_copy',
        'RIG_in_copy',
      ]);
      expect([...subnetworkOf(after, 'RIG')].sort()).toEqual(['L2', 'L3', 'RIG_in']);
    });

    it('a node inside a sub-network that no owning wire reaches is copied with it', () => {
      // Inside this Rig, `PS` reads `SK2` on a socket that owns nothing, so the ownership walk
      // stops at `PS`. `SK2` is inside the sub-network all the same, and a copy of the Rig that
      // left it shared would have two owners reading it, which the store refuses.
      const s = fold(armature(false), [
        node('SK2', 'Skeleton', { bones: BONES }),
        node('PS', 'PosedSkeleton', {}),
        wire('SK2', 'PS', 'skeleton'),
        node('RIG', 'Rig'),
        wire('L3', 'RIG', 'pose'),
        wire('PS', 'RIG', 'body'),
        {
          type: 'connect',
          from: { node: 'RIG', socket: 'out' },
          to: { node: 'ARM', socket: 'pose' },
          replace: true,
        } as Op,
      ]);
      expect([...subnetworkOf(s, 'RIG')].sort()).toEqual(['PS', 'SK2']);
      const { after } = commit(s, ['ARM']);
      expect([...subnetworkOf(after, 'RIG_copy')].sort()).toEqual(['PS_copy', 'SK2_copy']);
      expect(after.nodes.PS_copy.inputs.skeleton).toEqual({ node: 'SK2_copy', socket: 'out' });
    });

    it('a spring: the copy gets its own driver, Solver and sub-network, on the same controller', () => {
      const s = sprung();
      const { after } = commit(s, ['n_box']);
      expect(added(s, after)).toHaveLength(2 + 1 + 1 + 9);
      expect(after.nodes.sp_driver_copy.inputs.in).toEqual({
        node: 'sp_solver_copy',
        socket: 'outVec',
      });
      expect(after.nodes.sp_driver.inputs.in).toEqual({ node: 'sp_solver', socket: 'outVec' });
      expect([...subnetworkOf(after, 'sp_solver_copy')]).toHaveLength(9);
      // The controller is an ARGUMENT of the Solver: the copy reads the one Null too.
      expect(JSON.stringify(s.nodes.sp_solver.params)).toContain('"ctl"');
      expect(JSON.stringify(after.nodes.sp_solver_copy.params)).toContain('"ctl"');
      expect(after.nodes.ctl_copy).toBeUndefined();
    });

    it('a sidecar of something a sidecar owns is copied too (a channel on a driver’s source)', () => {
      const s = fold(buildDefaultDagState(), [
        node('k', 'Math', {}),
        node('drv', 'ParamDriver', { target: 'n_box', paramPath: 'position.0' }),
        wire('k', 'drv', 'in'),
        node('kch', 'KeyframeChannelNumber', {
          target: 'k',
          paramPath: 'b',
          keyframes: [{ time: 0, value: 1, easing: 'linear' }],
        }),
      ]);
      const { after } = commit(s, ['n_box']);
      expect(added(s, after)).toEqual([
        'drv_copy',
        'k_copy',
        'kch_copy',
        'n_box_copy',
        'n_box_data_copy',
      ]);
      expect((after.nodes.kch_copy.params as { target: string }).target).toBe('k_copy');
    });

    it('a Rig or a Solver on its own has no sibling position, so there is nothing to duplicate', () => {
      expect(buildDuplicateNodesOps(armature(true), ['RIG'])).toBeNull();
      expect(buildDuplicateNodesOps(sprung(), ['sp_solver'])).toBeNull();
    });
  });

  describe('linked (Alt+D) shares what the original reads', () => {
    it('a cube: one new Object reading the SAME stack', () => {
      const s = stacked();
      const { after } = commit(s, ['n_box'], true);
      expect(added(s, after)).toEqual(['n_box_copy']);
      expect(after.nodes.n_box_copy.inputs.data).toEqual(s.nodes.n_box.inputs.data);
      expect(children(after)).toEqual(['n_box', 'n_box_copy']);
    });

    it('deleting one of the two keeps the shared stack; deleting both takes it', () => {
      const { after } = commit(stacked(), ['n_box'], true);
      const top = (after.nodes.n_box.inputs.data as { node: string }).node;
      const one = fold(after, buildDeleteNodesOps(after, ['n_box']));
      expect(one.nodes[top]).toBeDefined();
      expect(one.nodes.n_box_data).toBeDefined();
      const both = fold(after, buildDeleteNodesOps(after, ['n_box', 'n_box_copy']));
      expect(both.nodes[top]).toBeUndefined();
      expect(both.nodes.n_box_data).toBeUndefined();
    });

    it('Shift+D on a linked copy gives it its own data again', () => {
      const { after } = commit(stacked(), ['n_box'], true);
      const deep = commit(after, ['n_box_copy']);
      const copy = deep.after.nodes[deep.roots[0]];
      expect(copy.inputs.data).not.toEqual(after.nodes.n_box.inputs.data);
    });

    it('an armature Object: the pose stack and the skeleton stay shared', () => {
      const s = armature(true);
      const { after } = commit(s, ['ARM'], true);
      expect(added(s, after)).toEqual(['ARM_copy']);
      expect(after.nodes.ARM_copy.inputs.pose).toEqual(s.nodes.ARM.inputs.pose);
      expect(after.nodes.ARM_copy.inputs.data).toEqual(s.nodes.ARM.inputs.data);
    });

    it('its own channels all the same: a keyframe channel on the Object is copied', () => {
      const s = fold(buildDefaultDagState(), [
        node('ch', 'KeyframeChannelVec3', {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
        }),
      ]);
      const { after } = commit(s, ['n_box'], true);
      expect(added(s, after)).toEqual(['ch_copy', 'n_box_copy']);
      expect((after.nodes.ch_copy.params as { target: string }).target).toBe('n_box_copy');
    });

    it('a group: its children are copied, each reading its original’s data', () => {
      const s = fold(buildDefaultDagState(), [
        node('G', 'Group'),
        wire('G', 'n_scene', 'children'),
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        } as Op,
        wire('G', 'n_box', 'parent', 'world'),
      ]);
      const { after } = commit(s, ['G'], true);
      expect(added(s, after)).toEqual(['G_copy', 'n_box_copy']);
      expect(childIdsOf(after, 'G_copy')).toEqual(['n_box_copy']);
      expect(after.nodes.n_box_copy.inputs.data).toEqual({ node: 'n_box_data', socket: 'out' });
    });
  });

  describe('several roots in one call', () => {
    // Two cubes; a Track-To on A aims at B, a second one aims at the light (outside).
    const pair = () =>
      fold(buildDefaultDagState(), [
        node(
          'b_data',
          'BoxData',
          structuredClone(buildDefaultDagState().nodes.n_box_data.params) as Record<
            string,
            unknown
          >,
        ),
        node('B', 'Object'),
        wire('b_data', 'B', 'data'),
        wire('B', 'n_scene', 'children'),
        node('aimB', 'TrackTo', { target: 'n_box', aimNode: 'B' }),
        node('aimOut', 'TrackTo', { target: 'n_box', aimNode: 'n_light' }),
      ]);

    it('a reference between two copied nodes lands on the copies; one to outside stays outside', () => {
      const { after } = commit(pair(), ['n_box', 'B']);
      expect(after.nodes.aimB_copy.params).toMatchObject({
        target: 'n_box_copy',
        aimNode: 'B_copy',
      });
      expect(after.nodes.aimOut_copy.params).toMatchObject({
        target: 'n_box_copy',
        aimNode: 'n_light',
      });
    });

    it('CONTROL: copied alone, the same reference keeps aiming at the original', () => {
      const { after } = commit(pair(), ['n_box']);
      expect(after.nodes.aimB_copy.params).toMatchObject({ target: 'n_box_copy', aimNode: 'B' });
    });

    it('each copy goes in right after its own original, whatever order they were asked in', () => {
      for (const ids of [
        ['n_box', 'B'],
        ['B', 'n_box'],
      ]) {
        const { after, roots } = commit(pair(), ids);
        expect(children(after)).toEqual(['n_box', 'n_box_copy', 'B', 'B_copy']);
        expect(roots).toEqual(ids.map((id) => `${id}_copy`));
      }
    });

    it('a root inside another root is copied once, as part of it', () => {
      const s = fold(buildDefaultDagState(), [
        node('G', 'Group'),
        wire('G', 'n_scene', 'children'),
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        } as Op,
        wire('G', 'n_box', 'parent', 'world'),
      ]);
      const { after, roots } = commit(s, ['n_box', 'G']);
      expect(roots).toEqual(['G_copy']);
      expect(added(s, after)).toEqual(['G_copy', 'n_box_copy', 'n_box_data_copy']);
      expect(childIdsOf(after, 'G')).toEqual(['n_box']);
    });

    it('the same id asked twice is one copy, wired in once', () => {
      const s = buildDefaultDagState();
      const { after, roots } = commit(s, ['n_box', 'n_box']);
      expect(added(s, after)).toEqual(['n_box_copy', 'n_box_data_copy']);
      expect(children(after)).toEqual(['n_box', 'n_box_copy']);
      expect(roots).toEqual(['n_box_copy']);
    });
  });

  describe('names', () => {
    const named = () =>
      fold(buildDefaultDagState(), [
        { type: 'setMeta', nodeId: 'n_box', name: 'Hero' } as Op,
        node('src', 'Object'),
        wire('src', 'n_scene', 'children'),
        { type: 'setMeta', nodeId: 'src', name: 'Walk' } as Op,
        { type: 'setMeta', nodeId: 'n_light', name: 'Walk', nameFrom: 'src' } as Op,
      ]);

    it('a named original gives its copy the next free number, and the next copy the one after', () => {
      const first = commit(named(), ['n_box']).after;
      expect(first.nodes.n_box_copy.meta).toEqual({ name: 'Hero.001' });
      expect(first.nodes.n_box.meta).toEqual({ name: 'Hero' });
      const second = commit(first, ['n_box_copy']);
      expect(second.after.nodes[second.roots[0]].meta).toEqual({ name: 'Hero.002' });
    });

    it('#1518 — an unnamed object gives its copy the word for its kind, and its data no name', () => {
      const base = buildDefaultDagState();
      const { after } = commit(base, ['n_box']);
      expect(after.nodes.n_box_copy.meta?.name).toMatch(/^Cube(\.\d{3})?$/);
      const data = (after.nodes.n_box_copy.inputs.data as { node: string }).node;
      expect(after.nodes[data].meta?.name).toBeUndefined();
      expect(after.nodes.n_box.meta).toEqual(base.nodes.n_box.meta);
    });

    it('a follower copied alone keeps following the node its original followed', () => {
      const { after } = commit(named(), ['n_light']);
      expect(after.nodes.n_light_copy.meta).toEqual({ name: 'Walk', nameFrom: 'src' });
    });

    it('a follower copied WITH its source follows the copy of the source, by its new name', () => {
      const { after } = commit(named(), ['n_light', 'src']);
      expect(after.nodes.src_copy.meta).toEqual({ name: 'Walk.001' });
      expect(after.nodes.n_light_copy.meta).toEqual({ name: 'Walk.001', nameFrom: 'src_copy' });
      expect(after.nodes.n_light.meta).toEqual({ name: 'Walk', nameFrom: 'src' });
    });
  });

  it('a collection listing the original is not where the copy is wired in', () => {
    // The collection is read BEFORE the scene when readers are listed in graph order here.
    let s = fold(buildDefaultDagState(), [
      node('P', 'Object'),
      {
        type: 'disconnect',
        from: { node: 'n_box', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      } as Op,
    ]);
    s = fold(s, newCollectionOps(s, null)!.ops);
    const coll = Object.keys(s.nodes).find((id) => s.nodes[id].type === 'Collection')!;
    s = fold(s, [
      ...membershipOps(coll, ['n_box']),
      node('late', 'Group'),
      wire('late', 'n_scene', 'children'),
      wire('late', 'n_box', 'parent', 'world'),
    ]);
    const { after } = commit(s, ['n_box']);
    expect(childIdsOf(after, 'late')).toEqual(['n_box', 'n_box_copy']);
    expect((after.nodes[coll].inputs.members as { node: string }[]).map((r) => r.node)).toEqual([
      'n_box',
      'n_box_copy',
    ]);
  });
});

describe('withHierarchy — Delete Hierarchy takes what is below the target', () => {
  const held = (id: string, type: string, children: string[] = []) => ({
    id,
    type,
    params: {},
    inputs: children.length ? { children: children.map((node) => ({ node, socket: 'out' })) } : {},
  });
  const tree = (extra: Record<string, unknown> = {}): DagState =>
    ({
      nodes: {
        scene: held('scene', 'Scene', ['root', 'other']),
        root: held('root', 'Group', ['kid']),
        kid: held('kid', 'Group', ['grand']),
        grand: held('grand', 'Group'),
        other: held('other', 'Group'),
        ...extra,
      },
      outputs: { scene: { node: 'scene' } },
    }) as unknown as DagState;

  // Measured in Blender 5.1.1, `outliner.delete(hierarchy=True)` on Root: Root, Kid and Grand go
  // (Grand was in another collection), Other stays.
  it('takes every level below the target and nothing beside it', () => {
    expect(withHierarchy(tree(), ['root']).sort()).toEqual(['grand', 'kid', 'root']);
  });

  it('a target with nothing below it adds nothing, so the menu does not offer it', () => {
    expect(withHierarchy(tree(), ['other'])).toEqual(['other']);
  });

  it('a collection listing a child does not keep it: membership is not a parent', () => {
    const s = tree({
      coll: {
        ...held('coll', 'Collection'),
        inputs: { members: [{ node: 'kid', socket: 'out' }] },
      },
    });
    expect(withHierarchy(s, ['root']).sort()).toEqual(['grand', 'kid', 'root']);
  });

  // #1824 — a two-parent child as the conversion can leave one: hung from `root` by its parent
  // input and still wired into `kid`'s list. `kid` hangs from `root` by its parent input, so it
  // goes too, and the child with it, whichever of the two the walk meets first.
  it('a child whose second holder hangs by its parent input below the target goes with it', () => {
    const s = {
      nodes: {
        scene: held('scene', 'Scene', ['root']),
        root: held('root', 'Group'),
        twice: {
          ...held('twice', 'Group'),
          inputs: { parent: { node: 'root', socket: 'world' } },
        },
        kid: {
          ...held('kid', 'Group', ['twice']),
          inputs: {
            children: [{ node: 'twice', socket: 'out' }],
            parent: { node: 'root', socket: 'world' },
          },
        },
      },
      outputs: { scene: { node: 'scene' } },
    } as unknown as DagState;
    expect(withHierarchy(s, ['root']).sort()).toEqual(['kid', 'root', 'twice']);
  });

  it('a child a surviving parent also holds stays', () => {
    const s = tree();
    (s.nodes.other.inputs as Record<string, unknown>).children = [{ node: 'grand', socket: 'out' }];
    expect(withHierarchy(s, ['root']).sort()).toEqual(['kid', 'root']);
    // Both of its parents going, it goes.
    expect(withHierarchy(s, ['root', 'other']).sort()).toEqual(['grand', 'kid', 'other', 'root']);
  });
});

describe('buildDeleteNodesOps — #1673 a group holding a skinned character', () => {
  // As every skinned import stands it: scene → Armature group → { skeleton Object, mesh
  // Object }, the mesh Object's data an Armature modifier over the mesh, posed by the
  // skeleton Object.
  const skinnedState = (): DagState =>
    ({
      nodes: {
        scene: {
          id: 'scene',
          type: 'Scene',
          params: {},
          inputs: { children: [{ node: 'grp', socket: 'out' }] },
        },
        grp: {
          id: 'grp',
          type: 'Group',
          params: {},
          inputs: {
            children: [
              { node: 'skel', socket: 'out' },
              { node: 'obj', socket: 'out' },
            ],
          },
        },
        // The skeleton Object as an import stands it: its data the Skeleton, its pose a
        // PoseLayer over that Skeleton's rest pose.
        skel: {
          id: 'skel',
          type: 'Object',
          params: {},
          inputs: {
            data: { node: 'skelData', socket: 'out' },
            pose: { node: 'pl', socket: 'out' },
          },
        },
        skelData: { id: 'skelData', type: 'Skeleton', params: {}, inputs: {} },
        pl: {
          id: 'pl',
          type: 'PoseLayer',
          params: {},
          inputs: { pose: { node: 'skelData', socket: 'pose' } },
        },
        obj: {
          id: 'obj',
          type: 'Object',
          params: {},
          inputs: { data: { node: 'mod', socket: 'out' } },
        },
        mod: {
          id: 'mod',
          type: 'ArmatureModifier',
          params: {},
          inputs: {
            target: { node: 'mesh', socket: 'out' },
            armature: { node: 'skel', socket: 'out' },
          },
        },
        mesh: { id: 'mesh', type: 'PolyMeshData', params: {}, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    }) as unknown as DagState;

  const removedBy = (ops: Op[]) =>
    ops.filter((o) => o.type === 'removeNode').map((o) => (o as { nodeId: string }).nodeId);

  // #1517 — the group alone no longer takes them: its two objects are handed up as they stand.
  it('the group alone hands both objects up, and takes nothing of theirs', () => {
    const ops = buildDeleteNodesOps(skinnedState(), ['grp']);
    expect(removedBy(ops)).toEqual(['grp']);
    const s = ops.reduce((acc, op) => applyOp(acc, op).next, skinnedState());
    expect(s.nodes.scene.inputs.children).toEqual([
      { node: 'skel', socket: 'out' },
      { node: 'obj', socket: 'out' },
    ]);
  });

  it('Delete Hierarchy on the group takes the whole character', () => {
    const s = skinnedState();
    const ops = buildDeleteNodesOps(s, withHierarchy(s, ['grp']));
    expect(removedBy(ops).sort()).toEqual(['grp', 'mesh', 'mod', 'obj', 'pl', 'skel', 'skelData']);
  });

  it('deletes the whole character — group, both objects, the modifier, the mesh, the skeleton and its pose — and wires nothing', () => {
    const ops = buildDeleteNodesOps(skinnedState(), ['grp', 'skel', 'obj']);
    expect(removedBy(ops).sort()).toEqual(['grp', 'mesh', 'mod', 'obj', 'pl', 'skel', 'skelData']);
    // The bug: the deleted modifier was "spliced" out by wiring its mesh into the scene.
    expect(ops.some((o) => o.type === 'connect')).toBe(false);
  });

  it('the batch applies: every node is gone and the scene holds nothing', () => {
    const ops = buildDeleteNodesOps(skinnedState(), ['grp', 'skel', 'obj']);
    const s = ops.reduce((acc, op) => applyOp(acc, op).next, skinnedState());
    expect(Object.keys(s.nodes)).toEqual(['scene']);
    expect(s.nodes.scene.inputs.children ?? []).toEqual([]);
  });

  it('KEEPS a mesh another surviving object still uses, and does not wire it into the scene', () => {
    const s = skinnedState();
    (s.nodes as Record<string, unknown>).other = {
      id: 'other',
      type: 'Object',
      params: {},
      inputs: { data: { node: 'mesh', socket: 'out' } },
    };
    (s.nodes.scene.inputs.children as unknown[]).push({ node: 'other', socket: 'out' });
    const ops = buildDeleteNodesOps(s, ['grp', 'skel', 'obj']);
    expect(removedBy(ops)).not.toContain('mesh');
    expect(ops.some((o) => o.type === 'connect')).toBe(false);
  });

  it('KEEPS a skeleton a surviving modifier still poses with', () => {
    const s = skinnedState();
    const N = s.nodes as Record<string, unknown>;
    N.mesh2 = { id: 'mesh2', type: 'PolyMeshData', params: {}, inputs: {} };
    N.mod2 = {
      id: 'mod2',
      type: 'ArmatureModifier',
      params: {},
      inputs: {
        target: { node: 'mesh2', socket: 'out' },
        armature: { node: 'skel', socket: 'out' },
      },
    };
    N.obj2 = {
      id: 'obj2',
      type: 'Object',
      params: {},
      inputs: { data: { node: 'mod2', socket: 'out' } },
    };
    (s.nodes.scene.inputs.children as unknown[]).push({ node: 'obj2', socket: 'out' });
    const ops = buildDeleteNodesOps(s, ['grp', 'obj']);
    expect(removedBy(ops)).not.toContain('skel');
    expect(removedBy(ops)).toEqual(expect.arrayContaining(['grp', 'obj', 'mod', 'mesh']));
  });

  it('deleting ONLY the modifier still splices the mesh back into its surviving object (control)', () => {
    const ops = buildDeleteNodesOps(skinnedState(), ['mod']);
    expect(removedBy(ops)).toEqual(['mod']);
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: 'mesh', socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    });
  });
});

describe('buildDeleteNodesOps — a deleted parent hands its children up (#1517)', () => {
  const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const conn = (from: string, to: string): Op => ({
    type: 'connect',
    from: { node: from, socket: 'out' },
    to: { node: to, socket: 'children' },
  });
  const disc = (from: string, to: string): Op => ({
    type: 'disconnect',
    from: { node: from, socket: 'out' },
    to: { node: to, socket: 'children' },
  });
  const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
    type: 'setParam',
    nodeId,
    paramPath,
    value,
  });
  const group = (id: string, parent: string, pos: number[], rot: number[], scl = 2): Op[] => [
    { type: 'addNode', nodeId: id, nodeType: 'Group', params: {} },
    conn(id, parent),
    set(id, 'position', pos),
    set(id, 'rotation', rot),
    set(id, 'scale', [scl, scl, scl]),
  ];
  // #1824 — a hang under a group or object goes through its child's parent input when it has one
  // (a Transform has none and stays wired). #1823 — and a node hung that way stays (or becomes) a
  // member of the scene's own list, as every door that makes an object links it: parenting is not
  // membership, so the fixtures' "take it out of the scene, hang it" keeps it in the scene.
  const apply = (s: DagState, ops: readonly Op[]) =>
    ops.reduce((acc, op) => {
      if (op.type !== 'connect' || op.to.socket !== 'children' || op.to.node === 'n_scene') {
        return applyOp(acc, op).next;
      }
      const hang = attachOp(acc, op.from.node, op.to.node, 'children');
      let next = applyOp(acc, hang).next;
      const listed = ((next.nodes.n_scene.inputs.children ?? []) as { node: string }[]).some(
        (r) => r.node === op.from.node,
      );
      if (hang.type === 'connect' && hang.to.socket === 'parent' && !listed) {
        next = applyOp(next, {
          type: 'connect',
          from: { node: op.from.node, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        }).next;
      }
      return next;
    }, s);
  /** scene → OUTER → INNER → the cube, each turned and offset. */
  const nested = (): DagState =>
    apply(buildDefaultDagState(), [
      ...group('OUTER', 'n_scene', [5, 1, 0], [0, 30, 0]),
      ...group('INNER', 'OUTER', [0, 2, 1], [20, 0, 0]),
      disc('n_box', 'n_scene'),
      conn('n_box', 'INNER'),
      set('n_box', 'position', [1, 1, 1]),
      set('n_box', 'rotation', [0, 0, 45]),
    ]);
  const world = (s: DagState, id: string) => resolveWorldTransform(s, id, CTX)!.matrix;
  const commit = (s: DagState, ids: string[], children: 'place' | 'values' = 'place') => {
    useDagStore.getState().hydrate(s);
    const plan = planDeleteNodes(s, ids, { ctx: CTX, children });
    if (!plan.ok) throw new Error(plan.reason);
    useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'delete');
    return useDagStore.getState().state;
  };
  const expectSameWorld = (a: number[], b: number[]) =>
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 5));

  it('the fixture draws the cube well away from its own values', () => {
    const s = nested();
    expect(Math.abs(world(s, 'n_box')[12] - 1)).toBeGreaterThan(1);
  });

  it('a child goes to the group’s parent, stays in the scene, and stays where it is drawn', () => {
    const s = nested();
    const before = world(s, 'n_box');
    const after = commit(s, ['INNER']);
    expect(after.nodes.INNER).toBeUndefined();
    expect(after.nodes.n_box).toBeDefined();
    expect(childIdsOf(after, 'OUTER')).toEqual(['n_box']);
    expect(isInScene(after, 'n_box')).toBe(true);
    expectSameWorld(before, world(after, 'n_box'));
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('a group at the top hands its children to the scene', () => {
    const s = nested();
    const before = { inner: world(s, 'INNER'), box: world(s, 'n_box') };
    const after = commit(s, ['OUTER']);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'INNER', socket: 'out' });
    expect(childIdsOf(after, 'INNER')).toEqual(['n_box']);
    expectSameWorld(before.inner, world(after, 'INNER'));
    expectSameWorld(before.box, world(after, 'n_box'));
  });

  it('children pass up past EVERY deleted ancestor, in whichever order they are picked', () => {
    for (const ids of [
      ['OUTER', 'INNER'],
      ['INNER', 'OUTER'],
    ]) {
      const s = nested();
      const before = world(s, 'n_box');
      const after = commit(s, ids);
      expect(after.nodes.OUTER).toBeUndefined();
      expect(after.nodes.INNER).toBeUndefined();
      expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
      expect(isInScene(after, 'n_box')).toBe(true);
      expectSameWorld(before, world(after, 'n_box'));
    }
  });

  it('the group and its children picked together all go, data and all', () => {
    const s = nested();
    const after = commit(s, ['OUTER', 'INNER', 'n_box']);
    for (const id of ['OUTER', 'INNER', 'n_box', 'n_box_data'])
      expect(after.nodes[id]).toBeUndefined();
    expect(after.nodes.n_scene.inputs.children ?? []).not.toContainEqual({
      node: 'n_box',
      socket: 'out',
    });
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });

  it('a deleted mesh Object hands its children up as a Group does (#1152)', () => {
    const s = apply(buildDefaultDagState(), [
      set('n_box', 'position', [3, 0, 0]),
      { type: 'addNode', nodeId: 'kid', nodeType: 'Object', params: { position: [0, 2, 0] } },
      conn('kid', 'n_box'),
    ]);
    const before = world(s, 'kid');
    const after = commit(s, ['n_box']);
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes.n_box_data).toBeUndefined();
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'kid', socket: 'out' });
    expectSameWorld(before, world(after, 'kid'));
  });

  it('nothing is left unreachable: #431’s protection, measured across the whole graph', () => {
    const s = nested();
    const after = commit(s, ['INNER']);
    // Every Object the scene held before it still holds, bar the one deleted.
    for (const id of Object.keys(s.nodes)) {
      if (id === 'INNER' || !isInScene(s, id)) continue;
      expect([id, isInScene(after, id)]).toEqual([id, true]);
    }
  });

  it('a keyed child is handed up with its keys and its values as they are, and named', () => {
    const s = apply(nested(), [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [1, 1, 1], easing: 'linear' }],
        },
      },
    ]);
    const plan = planDeleteNodes(s, ['INNER'], { ctx: CTX });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.unkept).toEqual([{ childId: 'n_box', driven: 'animated' }]);
    expect(moveNotices(s, plan).join()).toMatch(/Delete moved "n_box" \(animated\)/);

    const after = apply(s, plan.ops);
    expect(isInScene(after, 'n_box')).toBe(true);
    expect(after.nodes.n_box.params.position).toEqual(s.nodes.n_box.params.position);
    expect(after.nodes.ch.params.keyframes).toEqual(s.nodes.ch.params.keyframes);
    // The agent's door reads the same plan, so it does not throw.
    expect(() => buildDeleteNodesOps(s, ['INNER'])).not.toThrow();
    // Deleted together nothing moves, so there is nothing to say.
    const both = planDeleteNodes(s, ['INNER', 'n_box'], { ctx: CTX });
    if (!both.ok) throw new Error(both.reason);
    expect(both.unkept).toEqual([]);
  });

  it('CONTROL: a keyed child whose parent adds nothing does not move, so nothing is said', () => {
    const s = apply(nested(), [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [1, 1, 1], easing: 'linear' }],
        },
      },
      set('INNER', 'position', [0, 0, 0]),
      set('INNER', 'rotation', [0, 0, 0]),
      set('INNER', 'scale', [1, 1, 1]),
    ]);
    const plan = planDeleteNodes(s, ['INNER'], { ctx: CTX });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.unkept).toEqual([]);
  });

  // #1861 — Alt+Delete: the children hang where plain Delete hangs them, keeping their own values.
  const paramsOf = (st: DagState, id: string) => st.nodes[id].params as Record<string, unknown>;
  it('Alt+Delete hands the child up with its own values unchanged, so it lands at them', () => {
    const s = nested();
    const own = ['position', 'rotation', 'scale'].map((k) => paramsOf(s, 'n_box')[k]);
    const plan = planDeleteNodes(s, ['INNER'], { ctx: CTX, children: 'values' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.ops.some((op) => op.type === 'setParam' && op.nodeId === 'n_box')).toBe(false);
    const after = commit(s, ['INNER'], 'values');
    expect(after.nodes.INNER).toBeUndefined();
    expect(childIdsOf(after, 'OUTER')).toEqual(['n_box']);
    expect(isInScene(after, 'n_box')).toBe(true);
    expect(['position', 'rotation', 'scale'].map((k) => paramsOf(after, 'n_box')[k])).toEqual(own);
    // It lands at its values under OUTER, which is not where INNER drew it.
    const moved = world(after, 'n_box').map((v, i) => Math.abs(v - world(s, 'n_box')[i]));
    expect(Math.max(...moved)).toBeGreaterThan(0.5);
  });

  it('CONTROL: plain Delete on the same fixture keeps the child where it was drawn', () => {
    const s = nested();
    expectSameWorld(world(s, 'n_box'), world(commit(s, ['INNER']), 'n_box'));
  });

  it('Alt+Delete moves a keyed child with its keys and values, and has nothing to report', () => {
    const s = apply(nested(), [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [1, 1, 1], easing: 'linear' }],
        },
      },
    ]);
    const plan = planDeleteNodes(s, ['INNER'], { ctx: CTX, children: 'values' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.unkept).toEqual([]);
    expect(moveNotices(s, plan)).toEqual([]);
    const after = apply(s, plan.ops);
    expect(paramsOf(after, 'ch').keyframes).toEqual(paramsOf(s, 'ch').keyframes);
    expect(paramsOf(after, 'n_box').position).toEqual(paramsOf(s, 'n_box').position);
  });

  // scene → (holder) → T → cube: a Transform wrapper holds one child, on its chain socket.
  const wrapped = (outer: 'G-over-T' | 'T-over-G'): DagState => {
    const t: Op = {
      type: 'addNode',
      nodeId: 'T',
      nodeType: 'Transform',
      params: { position: [0, 4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const onT = (id: string): Op => ({
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'T', socket: 'target' },
    });
    if (outer === 'G-over-T')
      return apply(buildDefaultDagState(), [
        ...group('G', 'n_scene', [1, 0, 0], [0, 0, 0], 1),
        t,
        conn('T', 'G'),
        disc('n_box', 'n_scene'),
        onT('n_box'),
      ]);
    return apply(buildDefaultDagState(), [
      { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
      set('G', 'position', [1, 0, 0]),
      t,
      conn('T', 'n_scene'),
      onT('G'),
      disc('n_box', 'n_scene'),
      conn('n_box', 'G'),
    ]);
  };

  it('a wrapper deleted with its group leaves nothing stranded', () => {
    const s = wrapped('G-over-T');
    const after = commit(s, ['G', 'T']);
    expect(after.nodes.G).toBeUndefined();
    expect(after.nodes.T).toBeUndefined();
    // Named together, the wrapper takes its stack, as it did before #1517: gone, not unreachable.
    expect(after.nodes.n_box).toBeUndefined();
    expect(after.nodes.n_box_data).toBeUndefined();
  });

  it('a group alone hands its wrapper up, with the cube still inside it', () => {
    const s = wrapped('G-over-T');
    const before = world(s, 'n_box');
    const after = commit(s, ['G']);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'T', socket: 'out' });
    expect(after.nodes.T.inputs.target).toEqual({ node: 'n_box', socket: 'out' });
    expect(isInScene(after, 'n_box')).toBe(true);
    expectSameWorld(before, world(after, 'n_box'));
  });

  it('a group inside a wrapper hands its child past the wrapper, which holds one thing', () => {
    const s = wrapped('T-over-G');
    const before = world(s, 'n_box');
    const after = commit(s, ['G']);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
    expect(isInScene(after, 'n_box')).toBe(true);
    expectSameWorld(before, world(after, 'n_box'));
  });

  it('the agent’s door passes every gate, and hands the child up the same way', () => {
    const s = nested();
    const before = world(s, 'n_box');
    const result = validatePlan(deleteNodeMutator, { targetSelectors: ['INNER'] }, s, 'del');
    if (!result.ok) throw new Error(JSON.stringify(result));
    const after = apply(s, result.ops);
    expect(childIdsOf(after, 'OUTER')).toEqual(['n_box']);
    expectSameWorld(before, world(after, 'n_box'));
  });

  it('a shear is reported on the plan, and the delete still goes', () => {
    const s = apply(nested(), [set('INNER', 'scale', [3, 1, 1])]);
    const plan = planDeleteNodes(s, ['INNER'], { ctx: CTX });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.residuals.map((r) => r.childId)).toEqual(['n_box']);
  });
});

// #1824 — a child hung by its own parent input (the parent's world wired into it) is handed up on
// delete like a wired one. The delete cuts every wire out of the deleted node, the child's parent
// input among them, so a child nothing hands up would drop out of the scene.
describe('buildDeleteNodesOps — a parent hands up the children hung by their parent input (#1824)', () => {
  const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const apply = (s: DagState, ops: readonly Op[]) =>
    ops.reduce((acc, op) => applyOp(acc, op).next, s);
  const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
    type: 'setParam',
    nodeId,
    paramPath,
    value,
  });
  const hang = (child: string, parent: string): Op => ({
    type: 'connect',
    from: { node: parent, socket: 'world' },
    to: { node: child, socket: 'parent' },
  });
  /** scene → OUTER (wired) → INNER (parent input) → the cube (parent input), each turned; all three
   *  members of the scene's own list (#1823: the cube is not taken out of it to be hung). */
  const nested = (): DagState =>
    apply(buildDefaultDagState(), [
      { type: 'addNode', nodeId: 'OUTER', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'OUTER', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      set('OUTER', 'position', [5, 1, 0]),
      set('OUTER', 'rotation', [0, 30, 0]),
      { type: 'addNode', nodeId: 'INNER', nodeType: 'Group', params: {} },
      hang('INNER', 'OUTER'),
      // #1823 — made, so a member of the scene's own list; hanging it is not membership.
      {
        type: 'connect',
        from: { node: 'INNER', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      set('INNER', 'position', [0, 2, 1]),
      set('INNER', 'rotation', [20, 0, 0]),
      hang('n_box', 'INNER'),
      set('n_box', 'position', [1, 1, 1]),
      set('n_box', 'rotation', [0, 0, 45]),
    ]);
  const world = (s: DagState, id: string) => resolveWorldTransform(s, id, CTX)!.matrix;
  const commit = (s: DagState, ids: string[], children: 'place' | 'values' = 'place') => {
    useDagStore.getState().hydrate(s);
    const plan = planDeleteNodes(s, ids, { ctx: CTX, children });
    if (!plan.ok) throw new Error(plan.reason);
    useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'delete');
    return useDagStore.getState().state;
  };
  const expectSameWorld = (a: number[], b: number[]) =>
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 5));

  it('the fixture hangs the cube by parent inputs, drawn well away from its own values', () => {
    const s = nested();
    expect(worldParentOf(s, 'n_box')).toBe('INNER');
    expect(isInScene(s, 'n_box')).toBe(true);
    expect(Math.abs(world(s, 'n_box')[12] - 1)).toBeGreaterThan(1);
  });

  it('the cube goes to the group’s parent by its parent input, in the scene and in place', () => {
    const s = nested();
    const before = world(s, 'n_box');
    const after = commit(s, ['INNER']);
    expect(after.nodes.INNER).toBeUndefined();
    expect(worldParentOf(after, 'n_box')).toBe('OUTER');
    expect(after.nodes.OUTER.inputs.children ?? []).toEqual([]);
    expect(isInScene(after, 'n_box')).toBe(true);
    expectSameWorld(before, world(after, 'n_box'));
  });

  it('a group at the top hands its child to the scene’s list, its parent input cleared', () => {
    const s = nested();
    const before = { inner: world(s, 'INNER'), box: world(s, 'n_box') };
    const after = commit(s, ['OUTER']);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'INNER', socket: 'out' });
    expect(after.nodes.INNER.inputs.parent).toBeUndefined();
    expect(worldParentOf(after, 'n_box')).toBe('INNER');
    expectSameWorld(before.inner, world(after, 'INNER'));
    expectSameWorld(before.box, world(after, 'n_box'));
  });

  it('children pass up past every deleted ancestor', () => {
    const s = nested();
    const before = world(s, 'n_box');
    const after = commit(s, ['OUTER', 'INNER']);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
    expect(after.nodes.n_box.inputs.parent).toBeUndefined();
    expectSameWorld(before, world(after, 'n_box'));
  });
});

// #1824 — Duplicate copies what hangs from a parent by its own parent input, and a copy of such a
// child hangs from the same parent, as Blender's Shift+D keeps a duplicate's parent.
describe('buildDuplicateNodesOps — children hung by their parent input (#1824)', () => {
  const apply = (s: DagState, ops: readonly Op[]) =>
    ops.reduce((acc, op) => applyOp(acc, op).next, s);
  /** scene → G (wired) → n_box (its parent input reads G's world), still a member (#1823). */
  const hung = (): DagState =>
    apply(buildDefaultDagState(), [
      { type: 'addNode', nodeId: 'G', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'G', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'G', socket: 'world' },
        to: { node: 'n_box', socket: 'parent' },
      },
    ]);

  it('a copy of the child hangs from the same parent, and both are in the scene', () => {
    const s = hung();
    const dup = buildDuplicateNodeOps(s, 'n_box');
    expect(dup).not.toBeNull();
    const after = apply(s, dup!.ops);
    expect(worldParentOf(after, dup!.newRootId)).toBe('G');
    expect([...childIdsOf(after, 'G')].sort()).toEqual(['n_box', dup!.newRootId].sort());
    expect(isInScene(after, dup!.newRootId)).toBe(true);
    // #1823 — the copy is listed where the original is (Blender's Shift+D links a duplicate into
    // the original's collections), once, and its parent is still its parent input alone.
    const listed = (id: string) =>
      ((after.nodes.n_scene.inputs.children ?? []) as { node: string }[]).filter(
        (r) => r.node === id,
      ).length;
    expect(listed(dup!.newRootId)).toBe(listed('n_box'));
    expect(parentIdsOf(after, dup!.newRootId)).toEqual(['G']);
  });

  for (const linked of [false, true]) {
    it(`a ${linked ? 'linked' : 'deep'} copy of the group holds a copy of the child`, () => {
      const s = hung();
      const dup = buildDuplicateNodeOps(s, 'G', { linked });
      expect(dup).not.toBeNull();
      const after = apply(s, dup!.ops);
      const kids = childIdsOf(after, dup!.newRootId);
      expect(kids).toHaveLength(1);
      expect(kids[0]).not.toBe('n_box');
      expect(after.nodes[kids[0]].type).toBe('Object');
      expect(isInScene(after, kids[0])).toBe(true);
      // The original keeps its own child.
      expect(childIdsOf(after, 'G')).toEqual(['n_box']);
    });
  }
});
