// #394 P7b — promoting a row builds a control, and joining one builds only a drive.
//
// Two properties that a test over the resulting ROWS would not separate, so they are
// asserted on the OPS:
//
//  1. A NEW control writes a spare AND a driver; joining an EXISTING one writes only the
//     driver. Same visible outcome in the projection (one control, two drives), opposite
//     op chains — and the difference is what makes 1:N authoring non-destructive: joining
//     must not rewrite the control's value, type or home.
//
//  2. The control's numeric type is READ FROM THE SCHEMA. The tempting implementation
//     infers it from the current value, which agrees with the schema most of the time and
//     is wrong exactly where it matters. Both directions are pinned against real
//     registered node types, so a zod upgrade that broke the introspection fails by name
//     instead of quietly answering 'float' for everything.
//
// REF: src/app/promoteParam.ts; src/app/exposeParams.ts (`promotedRowsFor` — the read
//      side); src/app/driverBind.ts (`buildBindDriverOps`); PLAN-3 §3.6 + §4 P7; #394.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { SPLIT_KINDS, splitOps } from '../test-utils/splitKinds';
import { buildPromoteParamOps, resolveControlHost, spareTypeForParam } from './promoteParam';
import { exposeParams, type PromotedParam } from './exposeParams';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function applyOps(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** A split cube with an ArrayModifier and a material override op in its data lane, plus a
 *  `ctl` Null standing in for the controller a real promote mints. Two operators so the
 *  fixture carries both a declared-int param (`mod.count`) and declared-float ones
 *  (`ovr.roughness`, `ovr.metalness`) — the pair the type rule is about. */
function cubeWithLane(): DagState {
  // A real Scene output, because minting a controller goes through the same builder the
  // Add menu uses and that builder wires into `scene.children`.
  const seeded = applyOps(emptyDagState(), [
    { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} },
  ] as Op[]);
  const split = applyOps(
    { ...seeded, outputs: { scene: { node: 'n_scene', socket: 'out' as const } } },
    splitOps('box', { objectId: 'obj' }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
  );
  const splice = (state: DagState, id: string, type: string, params: object): DagState => {
    const below = (state.nodes['obj']?.inputs as { data?: { node: string } } | undefined)?.data
      ?.node;
    return applyOps(state, [
      { type: 'addNode', nodeId: id, nodeType: type, params },
      {
        type: 'disconnect',
        from: { node: below!, socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: below!, socket: 'out' },
        to: { node: id, socket: 'target' },
      },
      { type: 'connect', from: { node: id, socket: 'out' }, to: { node: 'obj', socket: 'data' } },
    ] as Op[]);
  };
  let state = splice(split, 'mod', 'ArrayModifier', { count: 2 });
  state = splice(state, 'ovr', 'MaterialOverrideOp', { roughness: 0.25 });
  return applyOps(state, [
    { type: 'addNode', nodeId: 'ctl', nodeType: 'Null', params: {} },
  ] as Op[]);
}

const promote = (state: DagState, over: Partial<Parameters<typeof buildPromoteParamOps>[1]> = {}) =>
  buildPromoteParamOps(state, {
    target: { nodeId: 'mod', paramPath: 'count' },
    control: { kind: 'existing', nodeId: 'ctl' },
    controlPath: 'spread',
    home: { section: 'modifier' },
    driverId: 'drv1',
    ...over,
  });

const promotedRows = (state: DagState, id: string): PromotedParam[] =>
  exposeParams(state, id).filter((r): r is PromotedParam => r.kind === 'promoted');

describe('#394 P7 — building a promote', () => {
  it('writes the control AND the drive, and the control seeds from the live value', () => {
    const state = cubeWithLane();
    const res = promote(state);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // THE COUNT IS THE PROPERTY, and its companion is the join case below, which expects 1.
    expect(res.ops).toHaveLength(2);
    expect(res.ops[0]).toEqual({
      type: 'setSpareParam',
      nodeId: 'ctl',
      key: 'spread',
      // Seeded from `count`, which the fixture set to 2 — so promoting changes the
      // interface and not the scene: the driver replaces the param with what it held.
      param: { type: 'int', value: 2, promoted: true, home: { section: 'modifier' } },
    });
    expect(res.ops[1]).toMatchObject({ type: 'addNode', nodeId: 'drv1', nodeType: 'ParamDriver' });
  });

  it('round-trips: applying the ops yields exactly the row the projection describes', () => {
    // The two halves of the stage, joined. A builder that wrote a shape the reader did not
    // recognise would pass every op-shape assertion above and produce no control at all.
    const res = promote(cubeWithLane());
    if (!res.ok) throw new Error(res.reason);
    const rows = promotedRows(applyOps(cubeWithLane(), res.ops), 'obj');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.controlNodeId).toBe('ctl');
    expect(rows[0]!.controlPath).toBe('spread');
    expect(rows[0]!.home.section).toBe('modifier');
    expect(rows[0]!.drives).toHaveLength(1);
    expect(rows[0]!.drives[0]!.nodeId).toBe('mod');
  });

  it('joining an existing control writes ONLY the drive — 1:N must not rewrite the knob', () => {
    // Two FLOAT params, and that pairing is forced rather than chosen — see the
    // mixed-type case below.
    const rough = { nodeId: 'ovr', paramPath: 'roughness' };
    const first = promote(cubeWithLane(), { target: rough, controlPath: 'shine' });
    if (!first.ok) throw new Error(first.reason);
    let state = applyOps(cubeWithLane(), first.ops);
    // …the user then moves the knob. A second promote onto it must not undo that.
    state = applyOps(state, [
      {
        type: 'setSpareParam',
        nodeId: 'ctl',
        key: 'shine',
        param: { type: 'float', value: 0.7, promoted: true, home: { section: 'material' } },
      },
    ] as Op[]);

    const second = promote(state, {
      target: { nodeId: 'ovr', paramPath: 'metalness' },
      controlPath: 'shine',
      driverId: 'drv2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ops, 'joining adds a driver and nothing else').toHaveLength(1);
    expect(second.ops[0]).toMatchObject({ type: 'addNode', nodeId: 'drv2' });

    // …and the authored value survived, which is the point of the shorter chain.
    const after = applyOps(state, second.ops);
    expect(after.nodes['ctl']?.spare?.['shine']?.value).toBe(0.7);
    expect(promotedRows(after, 'obj')[0]!.drives).toHaveLength(2);
  });

  it('refuses to join params of DIFFERENT numeric types onto one control', () => {
    // ⚠️ A DECLARED LIMIT THIS TEST EXISTS TO RECORD, not a property being celebrated.
    // PLAN-3 §4 P7's own demo pairs a modifier's `count` (declared int) with an override
    // op's `roughness` (declared float) on one control — and this refuses exactly that.
    // A float knob over a 0..1 range cannot also step an integer count, and coercing
    // either way makes one of the two drives lie about its own steps.
    //
    // Widening it means the control carrying a per-drive conversion, which is a real
    // feature (Houdini's promoted parms have expressions on the receiving side) and not
    // this stage's. Refused loudly beats silently truncating.
    const first = promote(cubeWithLane(), { controlPath: 'spread' }); // mod.count → int
    if (!first.ok) throw new Error(first.reason);
    const state = applyOps(cubeWithLane(), first.ops);

    const second = promote(state, {
      target: { nodeId: 'ovr', paramPath: 'roughness' },
      controlPath: 'spread',
      driverId: 'drv2',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('int');
  });

  it('refuses a param the driver rail cannot drive, and says why', () => {
    // [[V38]] — a user-triggered action that cannot work surfaces its outcome. Silently
    // binding a numeric knob to a colour would be the worse failure: the op chain would
    // apply, undo would record it, and nothing would move.
    const state = cubeWithLane();
    const res = promote(state, { target: { nodeId: 'obj_data', paramPath: 'material' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('material');
  });

  it('refuses to take over a spare that is not a control', () => {
    let state = cubeWithLane();
    state = applyOps(state, [
      {
        type: 'setSpareParam',
        nodeId: 'ctl',
        key: 'spread',
        param: { type: 'float', value: 1, promoted: false },
      },
    ] as Op[]);
    const res = promote(state);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('not a control');
  });

  it('refuses to join a control of the wrong numeric type', () => {
    let state = cubeWithLane();
    state = applyOps(state, [
      {
        type: 'setSpareParam',
        nodeId: 'ctl',
        key: 'spread',
        param: { type: 'float', value: 1, promoted: true, home: { section: 'modifier' } },
      },
    ] as Op[]);
    // `count` is a declared int; joining a float control would give it steps it does not have.
    const res = promote(state);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('float');
  });
});

describe('#394 P7 — where the control node comes from', () => {
  it('mints a Null through the shipped primitive builder, wired into the scene', () => {
    // Not hand-rolled here: scene membership has one authority, so a controller lands in
    // the outliner and is grabbable exactly like any other object.
    const state = cubeWithLane();
    const res = promote(state, { control: { kind: 'new', name: 'Cube Controls' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const applied = applyOps(state, res.ops);
    expect(applied.nodes[res.controlNodeId]?.type).toBe('Null');
    expect(applied.nodes[res.controlNodeId]?.meta?.name).toBe('Cube Controls');
    // …in the scene, not floating.
    const sceneId = state.outputs.scene!.node;
    const children = applied.nodes[sceneId]?.inputs?.['children'];
    const ids = (Array.isArray(children) ? children : [children]).map(
      (r) => (r as { node?: string } | undefined)?.node,
    );
    expect(ids).toContain(res.controlNodeId);
    // …and the control it hosts is the one the projection reports.
    expect(promotedRows(applied, 'obj')[0]!.controlNodeId).toBe(res.controlNodeId);
  });

  it('refuses to host the control on the OBJECT, because the cycle guard does', () => {
    // MEASURED, and it is the reason the controller is its own node. The Object sits
    // downstream of its whole data lane, so `target ← driver ← obj → … → target` closes.
    // Pinned as a test rather than left as a comment: if the guard is ever loosened
    // (#294's spare hop is an over-approximation), this reddens and says so.
    const res = promote(cubeWithLane(), { control: { kind: 'existing', nodeId: 'obj' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('cycle');
  });

  it('derives the controller to reuse from the graph — no stored link', () => {
    const state = cubeWithLane();
    // Nothing promoted yet ⇒ nothing to join, so the caller knows to mint.
    expect(resolveControlHost(state, 'obj')).toBeNull();

    const first = promote(state, { control: { kind: 'new' } });
    if (!first.ok) throw new Error(first.reason);
    const applied = applyOps(state, first.ops);
    expect(resolveControlHost(applied, 'obj')).toBe(first.controlNodeId);
  });
});

describe('#394 P7 — the control type is read from the schema, not from the value', () => {
  it('answers int for a declared int and float for a declared float — on real node types', () => {
    // THE SELF-VALIDATING PAIR. Both answers are asserted against registered nodes, so an
    // implementation that lost the ability to see int-ness (a zod upgrade changing the
    // internals this reads) fails the first rather than silently agreeing with the second.
    expect(spareTypeForParam('ArrayModifier', 'count')).toBe('int');
    expect(spareTypeForParam('MaterialOverrideOp', 'roughness')).toBe('float');
  });

  it('would disagree with a value-based guess, which is why it is a schema read', () => {
    // THE DISCRIMINATING CASE, and it exists in the shipped schema rather than being
    // invented for the test: `MaterialOverrideOp.metalness` is a declared FLOAT whose
    // default is 0 — a whole number. `Number.isInteger(value)` calls it an int and hands
    // the user a knob that steps by 1 over a 0..1 range, which is the whole range gone.
    const state = applyOps(cubeWithLane(), [
      { type: 'addNode', nodeId: 'ovr2', nodeType: 'MaterialOverrideOp', params: {} },
    ] as Op[]);
    const metalness = (state.nodes['ovr2']?.params as { metalness?: unknown })?.metalness;
    expect(Number.isInteger(metalness), 'the fixture must exercise the disagreement').toBe(true);
    expect(spareTypeForParam('MaterialOverrideOp', 'metalness')).toBe('float');
  });

  it('refuses a dotted path, a non-numeric param, and an unknown type', () => {
    expect(spareTypeForParam('MaterialOverrideOp', 'material.base.color')).toBeNull();
    expect(spareTypeForParam('ArrayModifier', 'offset'), 'a Vec3 tuple is not a scalar').toBeNull();
    expect(spareTypeForParam('MaterialOverrideOp', 'color')).toBeNull();
    expect(spareTypeForParam('NoSuchNodeType', 'count')).toBeNull();
  });
});
