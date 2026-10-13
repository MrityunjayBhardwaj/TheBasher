import { describe, it, expect } from 'vitest';
import { buildDeleteNodesOps, buildDuplicateNodeOps } from './sceneNodeActions';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp, emptyDagState } from '../core/dag';
import { danglingIdRefs } from '../core/dag/idRefSweep';
import { evaluate } from '../core/dag/evaluator';
import { buildAddModifierOps, findConsumer, resolveStackBase } from './operatorStack';
import { useDagStore } from '../core/dag/store';
import { subnetworkOf } from '../core/dag/subnetworks';
import { buildSpringOps, type SpringNodeKey } from './solverBind';
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

  it('clones a ParamDriver, re-pointing target and rewiring its wired source shared', () => {
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
    const res = buildDuplicateNodeOps(state, 'box')!;
    const clone = addNodeOf(res, 'ParamDriver');
    expect(clone).toBeDefined();
    expect(clone!.params.target).toBe('box_copy');
    // its wired compute source stays shared with the original (not cloned).
    const wire = res.ops.find(
      (o) =>
        o.type === 'connect' &&
        (o as { to: { node: string; socket: string } }).to.node === clone!.nodeId &&
        (o as { to: { socket: string } }).to.socket === 'in',
    ) as { from: { node: string } } | undefined;
    expect(wire?.from.node).toBe('cmp');
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
  const sceneChildren = (s: DagState) =>
    ((s.nodes.n_scene.inputs.children ?? []) as { node: string }[]).map((r) => r.node);

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

  it('a Group holding that Object takes the whole stack with it', () => {
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
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'G', socket: 'children' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    const after = commit(grouped, ['G']);
    for (const id of ['G', 'n_box', 'n_box_data', ...mods]) expect(after.nodes[id]).toBeUndefined();
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
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'G', socket: 'children' },
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
    expect(removed(['G', 'n_box'])).toEqual(['G', 'n_box', 'n_box_data']);
    expect(removed(['n_box', 'G'])).toEqual(['G', 'n_box', 'n_box_data']);
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
    const built = buildSpringOps(s, {
      targetId: 'n_box',
      controllerId: 'ctl',
      idFor: (k: SpringNodeKey) => `sp_${k}`,
    });
    if (!built.ok) throw new Error(built.reason);
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
      // #1623 — undoing THIS delete is refused today: the node is added back before anything
      // inside reads it, so for one step it counts as outside its own sub-network. Pinned here
      // so the day that is fixed this line goes red and the undo is asserted like every other.
      expect(() => useDagStore.getState().undo()).toThrow(/inside the sub-network/);
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
          from: { node: `o${i}`, socket: 'out' },
          to: { node: 'G', socket: 'children' },
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
    const ops = buildDeleteNodesOps(counted, ['G']);
    expect(ops.filter((op) => op.type === 'removeNode')).toHaveLength(1 + 2 * count);
    return walks;
  };

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
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'G', socket: 'children' },
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
    expect(s.nodes.G.inputs.children).toEqual([{ node: 'n_box', socket: 'out' }]);
    expect(s.nodes[coll].inputs.members).toEqual([{ node: 'n_box', socket: 'out' }]);
  });

  it('deleting the group takes the child and its data, and the collection stops listing it', () => {
    const { s, coll } = grouped();
    const after = commit(s, ['G']);
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
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'G2', socket: 'children' },
        },
      ] as Op[]
    ).reduce((acc, op) => applyOp(acc, op).next, s);
    const after = commit(two, ['G']);
    expect(after.nodes.n_box).toBeDefined();
    expect(after.nodes.G2.inputs.children).toEqual([{ node: 'n_box', socket: 'out' }]);
  });
});
