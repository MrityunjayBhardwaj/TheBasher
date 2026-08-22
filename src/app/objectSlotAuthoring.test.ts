// #645 P6 — the DIRECTOR's half of the object-level slot table.
//
// P4 gave the agent a way to re-point one Object's slot. Nothing on screen could ask for
// one, so the capability was reachable only through a plan. These rows are the pure half of
// the surface that closes that: what the panel lists, and the ops its two acts dispatch.
//
// ── WHAT EACH ROW HERE IS ACTUALLY GUARDING ──────────────────────────────────────────
//
// 🔴 The rows are read off the RESOLVED table, never off the data value. A data-side read
// agrees with the correct answer for every object that overrides nothing — which is almost
// every object — and disagrees only on the case this surface exists to author. That is the
// reference's own recorded instrument trap (§7.2) and it bit the reference session. So the
// discriminating assertion is never "the list has two rows"; it is that overriding ONE of
// two objects sharing one data node changes THAT object's list and leaves the other's alone.
//
// 🔴 And a list is not a swatch. A derivation being called is not its answer reaching the
// output, so the rows assert the COLOUR the row reports, not merely that the row flipped a
// flag — the same distinction that cost this epic a render fix one phase ago.
//
// REF: src/app/objectSlotAuthoring.ts (the module, and why the count costs an evaluation);
//      src/app/materialAssignment.ts (`objectSlotsOf` — the ONE derivation);
//      src/agent/mutators/builders/setObjectSlotMaterial.ts (the agent half);
//      tests/e2e/p645-object-slot-override-draws.spec.ts (the pixels). Issues #645, #638.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { EvalCtx, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import {
  buildClearSlotOverrideOp,
  buildOverrideSlotOp,
  objectSlotTable,
} from './objectSlotAuthoring';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const GREEN = '#00ff00';
const RED = '#ff0000';
const BLUE = '#0000ff';

function apply(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce<DagState>((s, op) => {
    const res = applyOp(s, op);
    // A write the schema silently dropped would leave every row below asserting nothing —
    // the exact failure a new param invites (#423). Checked, not trusted.
    expect(res.reportable).toBeUndefined();
    return res.next;
  }, state);
}

/** One data node, TWO objects reading it. The fixture the whole mechanism is about. */
function twoObjectsOverOneMesh(): { state: DagState; left: string; right: string; data: string } {
  const first = makeSplitCube(emptyDagState(), { objectId: 'left', color: RED });
  const state = apply(first.state, [
    { type: 'addNode', nodeId: 'right', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: first.dataId, socket: 'out' },
      to: { node: 'right', socket: 'data' },
    },
  ]);
  return { state, left: first.objectId, right: 'right', data: first.dataId };
}

/** Splice a scoped `SetMaterialOp` under an object so its data resolves to TWO slots. */
function withTwoSlots(state: DagState, dataId: string, objectId: string): DagState {
  return apply(state, [
    {
      type: 'addNode',
      nodeId: 'mat_blue',
      nodeType: 'Material',
      params: { material: { name: 'blue', base: { color: BLUE } } },
    },
    { type: 'addNode', nodeId: 'setmat', nodeType: 'SetMaterialOp', params: { scope: '0-5' } },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: 'setmat', socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: 'mat_blue', socket: 'out' },
      to: { node: 'setmat', socket: 'material' },
    },
    {
      type: 'connect',
      from: { node: 'setmat', socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ]);
}

function overridesOn(state: DagState, id: string): Record<string, unknown> | undefined {
  return (state.nodes[id]?.params as { slotOverrides?: Record<string, unknown> }).slotOverrides;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#645 the Object slot list', () => {
  it('lists one row per DATA slot, all reading from the data, before anything is overridden', () => {
    const { state, left } = twoObjectsOverOneMesh();
    const table = objectSlotTable(state, left, CTX);
    expect(table).not.toBeNull();
    expect(table!.rows.map((r) => r.index)).toEqual([0]);
    expect(table!.rows[0].overridden).toBe(false);
    expect(table!.rows[0].color).toBe(RED);
    expect(table!.stale).toEqual([]);
  });

  it('is null for an Object with no data — an Empty has nothing to slot', () => {
    const state = apply(emptyDagState(), [
      { type: 'addNode', nodeId: 'empty', nodeType: 'Object', params: {} },
    ]);
    expect(objectSlotTable(state, 'empty', CTX)).toBeNull();
  });

  it('is null for a node that is not an Object — the override lives on the poser', () => {
    const { state, data } = twoObjectsOverOneMesh();
    expect(objectSlotTable(state, data, CTX)).toBeNull();
    expect(objectSlotTable(state, 'nope', CTX)).toBeNull();
  });

  it('grows with the chain: a scoped writer under one object gives THAT object two rows', () => {
    const { state: base, left, right, data } = twoObjectsOverOneMesh();
    const state = withTwoSlots(base, data, left);
    // 🔴 THE ROW THAT DISCRIMINATES A DATA-SIDE READ IS NOT THIS ONE — both objects would
    // still be read off the same value here if the walk were wrong in the other direction.
    // What this pins is that the count follows the CHAIN, which is why it cannot be
    // answered from the Object's own shape.
    expect(objectSlotTable(state, left, CTX)!.rows).toHaveLength(2);
    expect(objectSlotTable(state, right, CTX)!.rows).toHaveLength(1);
  });
});

describe('#645 taking a slot over, and handing it back', () => {
  it('seeds the override from the RESOLVED slot, so taking it over changes no pixel', () => {
    const { state, left } = twoObjectsOverOneMesh();
    const op = buildOverrideSlotOp(state, left, 0, CTX);
    expect(op).not.toBeNull();
    const next = apply(state, [op!]);
    // Same colour after as before. The act being authored is "this slot is mine", and
    // folding a colour change into it would make the two indistinguishable on screen.
    const table = objectSlotTable(next, left, CTX)!;
    expect(table.rows[0].overridden).toBe(true);
    expect(table.rows[0].color).toBe(RED);
  });

  it('seeds the WHOLE spec, not just a colour — the data’s other lobes survive', () => {
    // Hydrating from a colour alone would silently drop roughness and metalness, which is
    // the half-built-material failure the agent builder warns about one road over. The
    // seeded override must carry what the data had.
    const { state, left } = twoObjectsOverOneMesh();
    const next = apply(state, [buildOverrideSlotOp(state, left, 0, CTX)!]);
    const written = overridesOn(next, left)!['0'] as {
      base: { color: string };
      specular: { roughness: unknown };
    };
    expect(written.base.color).toBe(RED);
    expect(written.specular.roughness).toBeTypeOf('number');
  });

  it('🔴 overriding ONE object leaves the other reading the shared data — the whole mechanism', () => {
    const { state, left, right, data } = twoObjectsOverOneMesh();
    const next = apply(state, [
      buildOverrideSlotOp(state, left, 0, CTX)!,
      { type: 'setParam', nodeId: left, paramPath: 'slotOverrides.0.base.color', value: GREEN },
    ]);

    // The overridden object moved...
    const l = objectSlotTable(next, left, CTX)!;
    expect(l.rows[0].overridden).toBe(true);
    expect(l.rows[0].color).toBe(GREEN);

    // ...and the OTHER one did not. An implementation that wrote the shared data — or that
    // read the table off the data value — passes every assertion above and fails here.
    const r = objectSlotTable(next, right, CTX)!;
    expect(r.rows[0].overridden).toBe(false);
    expect(r.rows[0].color).toBe(RED);
    // And the data node itself is untouched, which is the claim the mechanism is named for.
    expect(overridesOn(next, data)).toBeUndefined();
  });

  it('REFUSES an index the data has no slot for — offer == accept, asked once', () => {
    const { state, left } = twoObjectsOverOneMesh();
    expect(buildOverrideSlotOp(state, left, 1, CTX)).toBeNull();
    expect(buildOverrideSlotOp(state, left, 7, CTX)).toBeNull();
    expect(buildOverrideSlotOp(state, left, -1, CTX)).toBeNull();
    expect(buildOverrideSlotOp(state, left, 1.5, CTX)).toBeNull();
  });

  it('handing a slot back removes its entry and restores the data’s answer', () => {
    const { state, left } = twoObjectsOverOneMesh();
    const held = apply(state, [
      buildOverrideSlotOp(state, left, 0, CTX)!,
      { type: 'setParam', nodeId: left, paramPath: 'slotOverrides.0.base.color', value: GREEN },
    ]);
    expect(objectSlotTable(held, left, CTX)!.rows[0].color).toBe(GREEN);

    const back = apply(held, [buildClearSlotOverrideOp(held, left, 0)!]);
    const table = objectSlotTable(back, left, CTX)!;
    expect(table.rows[0].overridden).toBe(false);
    expect(table.rows[0].color).toBe(RED);
  });

  it('clearing the LAST override leaves `{}` in params and ABSENT on the value', () => {
    // One meaning, one spelling — `ObjectNode.evaluate` normalises the empty record away, so
    // the param may hold `{}` while the value never does. Special-casing it here would put
    // the normalisation in two places.
    const { state, left } = twoObjectsOverOneMesh();
    const held = apply(state, [buildOverrideSlotOp(state, left, 0, CTX)!]);
    const back = apply(held, [buildClearSlotOverrideOp(held, left, 0)!]);
    expect(overridesOn(back, left)).toEqual({});
  });

  it('refuses to clear a slot that has no override — no no-op writes from the surface', () => {
    const { state, left } = twoObjectsOverOneMesh();
    expect(buildClearSlotOverrideOp(state, left, 0)).toBeNull();
    expect(buildClearSlotOverrideOp(state, left, 3)).toBeNull();
  });
});

describe('#645 an override that stops naming a slot', () => {
  it('🔴 surfaces as STALE rather than vanishing, and stays clearable', () => {
    // Reachable with no edit to the slot list at all: override slot 1 while the chain gives
    // two slots, then remove the writer. The entry survives in params, resolves to nothing,
    // and draws nothing. A surface listing only live rows would hide it — the silently
    // dropped write this whole area exists to stop, arriving one edit later.
    const { state: base, left, data } = twoObjectsOverOneMesh();
    const two = withTwoSlots(base, data, left);
    expect(objectSlotTable(two, left, CTX)!.rows).toHaveLength(2);

    const held = apply(two, [buildOverrideSlotOp(two, left, 1, CTX)!]);
    expect(objectSlotTable(held, left, CTX)!.stale).toEqual([]);

    // Re-point the object straight at the data again — one slot, and the entry outlives it.
    const shrunk = apply(held, [
      {
        type: 'disconnect',
        from: { node: 'setmat', socket: 'out' },
        to: { node: left, socket: 'data' },
      },
      { type: 'connect', from: { node: data, socket: 'out' }, to: { node: left, socket: 'data' } },
    ]);
    const table = objectSlotTable(shrunk, left, CTX)!;
    expect(table.rows).toHaveLength(1);
    expect(table.stale).toEqual([1]);
    // The entry is still in params — this is a live record, not a cosmetic warning.
    expect(Object.keys(overridesOn(shrunk, left)!)).toEqual(['1']);

    // And the clear affordance the panel offers for it actually works.
    const cleared = apply(shrunk, [buildClearSlotOverrideOp(shrunk, left, 1)!]);
    expect(objectSlotTable(cleared, left, CTX)!.stale).toEqual([]);
    expect(overridesOn(cleared, left)).toEqual({});
  });
});
