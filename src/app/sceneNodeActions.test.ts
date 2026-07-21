import { describe, it, expect } from 'vitest';
import { buildDeleteNodesOps, buildDuplicateNodeOps } from './sceneNodeActions';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../core/dag';
import { buildAddModifierOps, findConsumer } from './operatorStack';
import { buildDefaultDagState } from '../core/project/default';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';

// #421 — the delete sweep now reads what each node type DECLARES (`idRefs`), so it
// needs the registry populated. Production gets this at boot (boot.ts:162); a unit
// test has to ask. Without it the sweep silently finds nothing — the same class of
// quiet failure this whole change is about.
registerAllNodes();

// Minimal fake DAG — the builders read only node.type / params / inputs and emit
// ops; they don't validate schema, so a plain object suffices for unit coverage.
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
      box: { id: 'box', type: 'BoxMesh', params: { size: [1, 1, 1] }, inputs: {} },
      grp: {
        id: 'grp',
        type: 'Group',
        params: { position: [5, 0, 0] },
        inputs: { children: [{ node: 'inner', socket: 'out' }] },
      },
      inner: { id: 'inner', type: 'BoxMesh', params: { size: [2, 2, 2] }, inputs: {} },
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
        box: { id: 'box', type: 'BoxMesh', params: { size: [1, 1, 1] }, inputs: {} },
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
          type: 'MirrorModifier',
          params: {},
          inputs: { target: { node: 'arr', socket: 'out' } },
        },
        arr: {
          id: 'arr',
          type: 'ArrayModifier',
          params: {},
          inputs: { target: { node: 'box', socket: 'out' } },
        },
        box: { id: 'box', type: 'BoxMesh', params: { size: [1, 1, 1] }, inputs: {} },
      },
      outputs: { scene: { node: 'scene' } },
    }) as unknown as DagState;

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
    expect(base.nodes[boxId]).toBeDefined();
    const add = buildAddModifierOps(base, boxId, 'ArrayModifier', { count: 3, offset: [2, 0, 0] });
    expect(add).not.toBeNull();
    let s = (add!.ops as Op[]).reduce((acc, op) => applyOp(acc, op).next, base);
    // Now scene → modifier → box. Delete the modifier through the generic path.
    const delOps = buildDeleteNodesOps(s, [add!.modifierId]);
    s = delOps.reduce((acc, op) => applyOp(acc, op).next, s);
    // The modifier is gone AND the box is back to being a direct scene child.
    expect(s.nodes[add!.modifierId]).toBeUndefined();
    expect(s.nodes[boxId]).toBeDefined();
    const consumer = findConsumer(s, boxId);
    expect(consumer?.socket).toBe('children'); // renderable again, not stranded
  });
});

describe('buildDuplicateNodeOps', () => {
  it('duplicates a leaf as a sibling right after the original', () => {
    const res = buildDuplicateNodeOps(fakeState(), 'box');
    expect(res?.newRootId).toBe('box_copy');
    expect(res?.ops).toEqual([
      { type: 'addNode', nodeId: 'box_copy', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
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
      { type: 'addNode', nodeId: 'inner_copy', nodeType: 'BoxMesh', params: { size: [2, 2, 2] } },
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
    const addOp = res.ops[0] as { params: { size: number[] } };
    addOp.params.size[0] = 99;
    expect((state.nodes.box.params as { size: number[] }).size[0]).toBe(1);
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
