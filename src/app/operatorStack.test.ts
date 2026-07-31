// operatorStack — the OperatorStack wiring helper (epic #201, #209, V58). Proves
// the stack-as-sub-chain contract: add inserts a modifier at the TOP (re-wires
// base→mod→consumer); the stack enumerates bottom→top; remove splices the chain
// closed; mute toggles the bypass param; reorder swaps adjacent modifiers by pure
// re-wiring. All over the real DAG (applyOp), starting from the default split Box.
//
// #415 MOVED THE STACK ONTO THE DATA LANE, and this file had to be re-aimed twice over
// because it had conflated two nodes that are now distinct:
//
//   before:  n_box (Object) ──▶ mod ──▶ Scene.children
//   after:   n_box_data ──▶ mod ──▶ n_box (Object) ──▶ Scene.children
//
//   1. THE BASE IS THE DATA NODE. Every `findConsumer(state, BOX)` here meant "the edge
//      the stack splices into", and that edge now leaves the DATA node. It is resolved
//      through `resolveStackBase` rather than hardcoded, so these cases also pin the
//      production path the panel takes from a selected Object down to its data.
//
//   2. THE OBJECT'S EDGE TO THE SCENE IS NOW AN INVARIANT — which is exactly the shape
//      that goes vacuous if you are not watching for it ([[H218]]). Pre-flip, `n_box →
//      Scene.children` was the edge that MOVED when a modifier was added, so asserting
//      it proved the splice happened. Post-flip it never moves at all: the Object stays
//      the scene object no matter how many operators sit on its data. So it is asserted
//      here DELIBERATELY and by name, as an invariant across add/remove/reorder, rather
//      than left in place looking like the check it used to be.
//
// REF: src/app/operatorStack.ts; src/nodes/ArrayModifier.ts; vyapti V58; issue #415.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import {
  buildAddModifierOps,
  buildMoveModifierOps,
  buildRemoveModifierOps,
  buildToggleModifierMuteOp,
  enumerateMaterialStack,
  enumerateModifierStack,
  findConsumer,
  resolveStackBase,
  resolveStackObject,
} from './operatorStack';

/** The OBJECT — what a user selects, and what stays the scene object throughout. */
const BOX = 'n_box';
/** The mesh DATA — where the stack actually lives after #415. */
const BOX_DATA = 'n_box_data';

function applyOps(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** Add a modifier the way the panel does: from the SELECTED node, through
 *  `resolveStackBase`. Passing the base directly would skip the one step #415 changed. */
function addMod(
  state: DagState,
  selected: string,
  params: Record<string, unknown> = {},
): { state: DagState; id: string } {
  const res = buildAddModifierOps(state, resolveStackBase(state, selected), 'ArrayModifier', {
    count: 3,
    offset: [2, 0, 0],
    ...params,
  });
  expect(res).not.toBeNull();
  return { state: applyOps(state, res!.ops), id: res!.modifierId };
}

/** The Object's edge into the scene — an INVARIANT post-#415, asserted by name so it
 *  cannot be mistaken for the moving part it used to be. */
function sceneEdgeOf(state: DagState) {
  return findConsumer(state, BOX);
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('operatorStack', () => {
  it('a fresh mesh has an empty stack', () => {
    const state = buildDefaultDagState();
    expect(enumerateModifierStack(state, BOX_DATA)).toEqual([]);
  });

  // #415 POSSESSION — the base of a selected Object's stack is the DATA it poses, not
  // the Object. Stated once, up front, because every case below routes through it: if
  // this hop were wrong they would all fail for the same reason and none would say why.
  it('the stack base of a selected Object is its data node (the data lane)', () => {
    const state = buildDefaultDagState();
    expect(resolveStackBase(state, BOX)).toBe(BOX_DATA);
    // …and from a data node or a modifier it is still itself / the chain bottom.
    expect(resolveStackBase(state, BOX_DATA)).toBe(BOX_DATA);
    const { state: withMod, id } = addMod(state, BOX);
    expect(resolveStackBase(withMod, id)).toBe(BOX_DATA);
  });

  it('add inserts a modifier BETWEEN the data and the Object that poses it', () => {
    const state0 = buildDefaultDagState();
    // The DATA feeds the Object's `data` socket before any modifier — that is the edge
    // the stack splices into now.
    const before = findConsumer(state0, BOX_DATA);
    expect(before).toEqual({ node: BOX, socket: 'data' });
    const sceneEdge = sceneEdgeOf(state0);
    expect(sceneEdge?.socket).toBe('children');

    const { state, id } = addMod(state0, BOX);
    // The data now feeds the modifier's target; the modifier feeds the Object's data.
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: id, socket: 'target' });
    expect(findConsumer(state, id)).toEqual(before);
    // INVARIANT (H218): the Object's edge to the scene did NOT move. Pre-#415 this was
    // the edge that got re-routed; now it is the thing that must not.
    expect(sceneEdgeOf(state)).toEqual(sceneEdge);

    const stack = enumerateModifierStack(state, BOX_DATA);
    expect(stack.map((m) => m.nodeId)).toEqual([id]);
    expect(stack[0].type).toBe('ArrayModifier');
    expect(stack[0].muted).toBe(false);
  });

  it('a second add stacks on TOP (base → m1 → m2 → consumer), bottom-to-top order', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumerBefore = findConsumer(state, m1); // m1 → the Object's `data`
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;

    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m1, m2]);
    // m1 now feeds m2; m2 feeds the original consumer (the Object's `data`).
    expect(findConsumer(state, m1)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumerBefore);
    // …and two operators deep, the Object is still the scene object (H218 invariant).
    expect(sceneEdgeOf(state)?.socket).toBe('children');
  });

  it('remove splices the chain closed (base → m2 → consumer)', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumer = findConsumer(state, m1);
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;

    // Remove the BOTTOM modifier (m1) — the base should re-wire straight to m2.
    const ops = buildRemoveModifierOps(state, m1);
    expect(ops).not.toBeNull();
    state = applyOps(state, ops!);

    expect(state.nodes[m1]).toBeUndefined(); // gone
    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m2]);
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumer);
  });

  it('removing the only modifier re-wires the base straight back to its consumer', () => {
    const state0 = buildDefaultDagState();
    const consumer = findConsumer(state0, BOX_DATA); // the data → Object.data edge
    const { state: s1, id } = addMod(state0, BOX);
    const s2 = applyOps(s1, buildRemoveModifierOps(s1, id)!);
    expect(enumerateModifierStack(s2, BOX_DATA)).toEqual([]);
    expect(findConsumer(s2, BOX_DATA)).toEqual(consumer); // back to the original edge
  });

  it('mute toggles the bypass param (keyframeable setParam)', () => {
    const { state, id } = addMod(buildDefaultDagState(), BOX);
    const op = buildToggleModifierMuteOp(state, id);
    expect(op).toMatchObject({ type: 'setParam', nodeId: id, paramPath: 'muted', value: true });
    const s2 = applyOp(state, op!).next;
    expect(enumerateModifierStack(s2, BOX_DATA)[0].muted).toBe(true);
    // toggling again clears it
    expect(buildToggleModifierMuteOp(s2, id)).toMatchObject({ value: false });
  });

  it('reorder swaps two adjacent modifiers by pure re-wiring (base → m2 → m1 → consumer)', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumer = findConsumer(state, m1);
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;
    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m1, m2]);

    // Move m1 UP (toward the consumer) — it swaps with m2.
    const ops = buildMoveModifierOps(state, m1, 'up');
    expect(ops).not.toBeNull();
    state = applyOps(state, ops!);

    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m2, m1]);
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual({ node: m1, socket: 'target' });
    expect(findConsumer(state, m1)).toEqual(consumer);
  });

  it('reorder past the end is a no-op (null)', () => {
    const { state, id } = addMod(buildDefaultDagState(), BOX);
    expect(buildMoveModifierOps(state, id, 'up')).toBeNull(); // only one — can't go up
    expect(buildMoveModifierOps(state, id, 'down')).toBeNull(); // nor down
  });

  it('the builders reject a non-modifier node', () => {
    const state = buildDefaultDagState();
    expect(buildRemoveModifierOps(state, BOX)).toBeNull();
    expect(buildToggleModifierMuteOp(state, BOX)).toBeNull();
    expect(buildMoveModifierOps(state, BOX, 'up')).toBeNull();
  });

  // #498 — the ACCEPT half. Before this, adding a modifier to a camera SUCCEEDED: an
  // ArrayModifier was minted and spliced into `CameraData → ArrayModifier → Object.data`,
  // inert but real and persistable. The refusal lives in the builder rather than the panel
  // because the agent's addModifier op goes through the same builder, so gating the panel
  // alone would have left the agent able to mint exactly the same graph.
  describe('#498 the builder refuses data that cannot be reshaped', () => {
    it('refuses a camera and a light, and still accepts the cube (the positive control)', () => {
      const state = buildDefaultDagState();

      // The control FIRST, and it is load-bearing: a uniform null across subject and
      // control would mean the gate refuses everything, which reads exactly like a
      // working refusal until you check the one case that must still pass.
      expect(
        buildAddModifierOps(state, resolveStackBase(state, BOX), 'ArrayModifier', {
          count: 3,
          offset: [2, 0, 0],
        }),
        'the cube must still accept a modifier',
      ).not.toBeNull();

      for (const objectId of ['n_camera', 'n_light']) {
        expect(
          buildAddModifierOps(state, resolveStackBase(state, objectId), 'ArrayModifier', {
            count: 3,
            offset: [2, 0, 0],
          }),
          `${objectId} must be refused`,
        ).toBeNull();
      }
    });

    it('refuses through the DATA node too, not just the Object the user selects', () => {
      // resolveStackBase hops Object → data, so the panel passes the data node. Asserting
      // both entry points stops a future caller that already holds the data id from
      // slipping past the gate.
      const state = buildDefaultDagState();
      expect(buildAddModifierOps(state, 'n_camera_data', 'ArrayModifier', {})).toBeNull();
      expect(buildAddModifierOps(state, 'n_light_data', 'ArrayModifier', {})).toBeNull();
    });

    it('leaves the graph untouched when it refuses', () => {
      // The refusal must be a non-event, not a partial write. Node count is the cheapest
      // honest witness that nothing was minted.
      const state = buildDefaultDagState();
      const before = Object.keys(state.nodes).length;
      expect(
        buildAddModifierOps(state, resolveStackBase(state, 'n_camera'), 'ArrayModifier', {}),
      ).toBeNull();
      expect(Object.keys(state.nodes).length).toBe(before);
    });
  });

  // #517 — THE TWO SHAPE QUESTIONS, asked with a NON-MODIFIER operator in the lane.
  //
  // #394 S3c registered material operators: `ObjectData → ObjectData`, so they stand in
  // the data lane exactly like a modifier does, and they are DELIBERATELY not members of
  // MODIFIER_NODE_TYPES (a material operator reshapes no geometry, so it must not appear
  // in the modifier section's offer list). That split is what these cases exist for.
  //
  // Two of this module's questions are about SHAPE — "what stands between the Object and
  // its base data?" (resolveStackBase) and "walk past the chain to the Object that wears
  // the result" (resolveStackObject) — and both must walk past ANY data-lane operator.
  // The rest are about MEMBERSHIP ("what does the modifier section manage?") and stay
  // curated. Asked with the curated set, the two shape walks stop one hop short, and the
  // failure is quiet: the geometry renders correctly the whole time.
  describe('#517 a non-modifier operator in the lane is walked past, not stopped at', () => {
    /** Splice a material operator between the DATA and the Object — the graph S3c mints,
     *  built by hand because no UI road creates one yet (which is why this was latent). */
    function withMaterialOp(state: DagState): { state: DagState; opId: string } {
      const opId = 'ovr';
      let s = applyOp(state, {
        type: 'addNode',
        nodeId: opId,
        nodeType: 'MaterialOverrideOp',
        params: { color: '#00ff88', overridden: { color: true } },
      }).next;
      s = applyOp(s, {
        type: 'disconnect',
        from: { node: BOX_DATA, socket: 'out' },
        to: { node: BOX, socket: 'data' },
      }).next;
      s = applyOp(s, {
        type: 'connect',
        from: { node: BOX_DATA, socket: 'out' },
        to: { node: opId, socket: 'target' },
      }).next;
      s = applyOp(s, {
        type: 'connect',
        from: { node: opId, socket: 'out' },
        to: { node: BOX, socket: 'data' },
      }).next;
      return { state: s, opId };
    }

    it('the stack base of a selected Object is still the DATA node', () => {
      const { state } = withMaterialOp(buildDefaultDagState());
      // The Object's `data` input now names the material operator, so a walk that only
      // steps past curated modifiers stops there and reports the OPERATOR as the base.
      expect(resolveStackBase(state, BOX)).toBe(BOX_DATA);
    });

    it('the modifier stack is still empty and still addable through the operator', () => {
      const { state: state0, opId } = withMaterialOp(buildDefaultDagState());
      const base = resolveStackBase(state0, BOX);
      expect(enumerateModifierStack(state0, base)).toEqual([]);

      // The modifier goes into the MODIFIER stack — below the material operator, which is
      // the order both references resolve in (materials after modifiers). So the splice
      // lands between the data and the operator, and the operator keeps feeding the Object.
      const { state, id } = addMod(state0, BOX);
      expect(findConsumer(state, BOX_DATA)).toEqual({ node: id, socket: 'target' });
      expect(findConsumer(state, id)).toEqual({ node: opId, socket: 'target' });
      expect(findConsumer(state, opId)).toEqual({ node: BOX, socket: 'data' });
      expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([id]);
      // INVARIANT (H218), unchanged by the operator: the Object stays the scene object.
      expect(sceneEdgeOf(state)?.socket).toBe('children');
    });

    it('the Object wearing a modified result is found THROUGH the operator', () => {
      // The inverse walk — the gizmo's and the read road's question. A material operator
      // above the modifier is neither a modifier nor a poser, so a curated walk falls off
      // the end and answers "nothing wears this", which reads as a dangling chain.
      const { state } = withMaterialOp(buildDefaultDagState());
      const { state: withMod, id } = addMod(state, BOX);
      expect(resolveStackObject(withMod, id)).toBe(BOX);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
// #526 — ONE PHYSICAL LANE, TWO STACKS
// ────────────────────────────────────────────────────────────────────────────────────
//
// Geometry modifiers and material operators are both `ObjectData → ObjectData` wired
// through `target`, so they interleave in ONE chain while the panel draws them as two
// stacks. The walk used to treat "not my kind" as "end of stack", which on a shared lane
// meant a material operator below a modifier made the Modifiers section render EMPTY
// while the modifier was still cooking — and, more quietly, made "+ Add" splice the new
// modifier in BELOW the existing one.
//
// THE VACUITY GUARD: every case here asserts against a lane that genuinely contains BOTH
// kinds, and the single-kind control is kept beside it. A build where the material
// operator silently failed to wire would degrade to the control and pass, so the
// interleaved fixture is checked for the foreign node's presence before it is trusted.

describe('#526 — a shared data lane: each stack sees its own kind and passes the other', () => {
  /**
   * `n_box_data → MaterialOverrideOp → ArrayModifier → n_box`, wired EXPLICITLY.
   *
   * 🔑 NOT built through `+ Add`, and that is the point. `buildAddModifierOps` takes its
   * insertion point from the very walk these cases test, so a fixture built with it is
   * rebuilt into a DIFFERENT lane the moment the walk is perturbed — and then the case
   * passes against the broken build while describing a shape that is not the one it
   * names. Measured: with the pass-through removed, the `+ Add` version of this fixture
   * quietly produced `data → mod → ovr` (the modifier BELOW) and stayed green. Explicit
   * wiring plus the shape assertion is what makes these cases able to fail.
   */
  function interleaved(): { state: DagState; modId: string } {
    let state = buildDefaultDagState();
    const base = resolveStackBase(state, BOX);
    const consumer = findConsumer(state, base)!;
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'ovr', nodeType: 'MaterialOverrideOp', params: {} },
      { type: 'addNode', nodeId: 'mod', nodeType: 'ArrayModifier', params: { count: 3 } },
      { type: 'disconnect', from: { node: base, socket: 'out' }, to: consumer },
      {
        type: 'connect',
        from: { node: base, socket: 'out' },
        to: { node: 'ovr', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'ovr', socket: 'out' },
        to: { node: 'mod', socket: 'target' },
      },
      { type: 'connect', from: { node: 'mod', socket: 'out' }, to: consumer },
    ] as Op[]);
    // THE SHAPE, asserted rather than assumed: the material operator is BELOW the
    // modifier. Without this the cases below cannot tell this lane from its mirror.
    expect(findConsumer(state, base)!.node).toBe('ovr');
    expect(findConsumer(state, 'ovr')!.node).toBe('mod');
    return { state, modId: 'mod' };
  }

  it('enumerates a modifier sitting ABOVE a material operator', () => {
    const { state, modId } = interleaved();
    expect(enumerateModifierStack(state, BOX_DATA).map((e) => e.nodeId)).toEqual([modId]);
  });

  it('enumerates the material operator BELOW it, from the same base', () => {
    const { state } = interleaved();
    expect(enumerateMaterialStack(state, BOX_DATA).map((e) => e.nodeId)).toEqual(['ovr']);
  });

  it('CONTROL: a lane with only one kind is unchanged', () => {
    let state = buildDefaultDagState();
    const { state: withMod, id } = addMod(state, BOX);
    state = withMod;
    expect(enumerateModifierStack(state, BOX_DATA).map((e) => e.nodeId)).toEqual([id]);
    expect(enumerateMaterialStack(state, BOX_DATA)).toEqual([]);
  });

  it('adds a second modifier ON TOP of the first, not below the material operator', () => {
    // The quiet half of the defect: the insertion point came from the same broken walk,
    // so the new modifier landed at the BOTTOM of the lane and composed in the wrong
    // order — with nothing refusing and nothing warning.
    const { state, modId } = interleaved();
    const res = buildAddModifierOps(state, resolveStackBase(state, BOX), 'MirrorModifier');
    const next = applyOps(state, res!.ops);
    expect(enumerateModifierStack(next, BOX_DATA).map((e) => e.nodeId)).toEqual([
      modId,
      res!.modifierId,
    ]);
  });

  it('REFUSES to reorder across a foreign operator rather than splicing a phantom edge', () => {
    // Two modifiers with the material operator BETWEEN them. The swap is a three-edge
    // rewire that assumes `lower.out → upper.target` exists; here it does not. Refusing
    // is the honest answer — reordering across a foreign operator is its own feature.
    let state = buildDefaultDagState();
    const { state: s1, id: lower } = addMod(state, BOX);
    state = s1;
    // Wired by hand, because `+ Add` deliberately CANNOT build this shape — it places a
    // new modifier directly above the top of the MODIFIER stack, so the two stay
    // adjacent. The non-adjacent lane is reachable by other roads (loading a project,
    // the agent, a future reorder), which is why the refusal has to exist.
    const consumer = findConsumer(state, lower)!;
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'ovr', nodeType: 'MaterialOverrideOp', params: {} },
      { type: 'addNode', nodeId: 'upper', nodeType: 'MirrorModifier', params: {} },
      { type: 'disconnect', from: { node: lower, socket: 'out' }, to: consumer },
      {
        type: 'connect',
        from: { node: lower, socket: 'out' },
        to: { node: 'ovr', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'ovr', socket: 'out' },
        to: { node: 'upper', socket: 'target' },
      },
      { type: 'connect', from: { node: 'upper', socket: 'out' }, to: consumer },
    ] as Op[]);
    const upper = 'upper';

    // the fixture really is non-adjacent: both modifiers are in the stack, `ovr` between
    expect(enumerateModifierStack(state, BOX_DATA).map((e) => e.nodeId)).toEqual([lower, upper]);
    expect(findConsumer(state, lower)!.node).toBe('ovr');

    expect(buildMoveModifierOps(state, upper, 'down')).toBeNull();
    expect(buildMoveModifierOps(state, lower, 'up')).toBeNull();
  });

  it('CONTROL: reorder still works when the two ARE adjacent', () => {
    // Without this the refusal above could be "move is broken" rather than "move refuses
    // exactly the case it cannot express".
    let state = buildDefaultDagState();
    const { state: s1, id: lower } = addMod(state, BOX);
    const { state: s2, id: upper } = addMod(s1, BOX);
    state = s2;
    expect(findConsumer(state, lower)!.node).toBe(upper);
    const ops = buildMoveModifierOps(state, upper, 'down');
    expect(ops).not.toBeNull();
    expect(enumerateModifierStack(applyOps(state, ops!), BOX_DATA).map((e) => e.nodeId)).toEqual([
      upper,
      lower,
    ]);
  });
});
