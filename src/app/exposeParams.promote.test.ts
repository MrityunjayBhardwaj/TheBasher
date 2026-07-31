// #394 P7a — a PROMOTED control is read back out of the graph, and 1:N is the shape.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────
//
// Nothing else watches promoted emission, and that is not an accident of coverage — it is
// structural. The byte-identical projection gate (§5 gate 1) filters the subject to
// `origin ∈ {poser, base}`, and a promoted row has no `origin` at all, so it is invisible
// there BY CONSTRUCTION. Shipping the arm without this file would repeat exactly what P6
// measured: a real gate, cited as coverage, blind on the one dimension being changed.
//
// So the properties are pinned here, and two of them are pinned as COUNTS with both
// answers present in the same file — a suite where one case expects 2 drives and another
// expects 1 cannot pass by producing a constant.
//
// ── THE MODEL BEING PINNED ──────────────────────────────────────────────────────────
//
// A control IS a promoted spare param plus N `ParamDriver`s pulling from it. There is no
// list of promoted refs anywhere; the row is derived from those two facts, which is the
// same choice the Controllers dock (#294) made and for the same reason — a second store
// of the same truth drifts.
//
// REF: src/app/exposeParams.ts (`promotedRowsFor`, `PromotedParam`), src/app/paramDrivers.ts
//      (`spareSourceOf` — the one spelling of the spare road), src/core/dag/types.ts
//      (`SpareParamSchema.home`); PLAN-3 §3.6 + §4 P7; #294, #394.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { SPLIT_KINDS, splitOps } from '../test-utils/splitKinds';
import { exposeParams, resolveExposedTarget, type PromotedParam } from './exposeParams';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function applyOps(state: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** A split cube: `obj` (pose) → `obj_data` (geometry + material). */
function splitCube(): DagState {
  return applyOps(
    emptyDagState(),
    splitOps('box', { objectId: 'obj' }, { data: SPLIT_KINDS.box.baseDataParams }) as Op[],
  );
}

/** Splice a data-lane operator on TOP of whatever currently feeds the Object. */
function spliceOp(state: DagState, opId: string, nodeType: string, params: object): DagState {
  const below = (state.nodes['obj']?.inputs as { data?: { node: string } } | undefined)?.data?.node;
  if (!below) throw new Error('fixture: the Object has no data producer to splice above');
  return applyOps(state, [
    { type: 'addNode', nodeId: opId, nodeType, params },
    {
      type: 'disconnect',
      from: { node: below, socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    },
    { type: 'connect', from: { node: below, socket: 'out' }, to: { node: opId, socket: 'target' } },
    { type: 'connect', from: { node: opId, socket: 'out' }, to: { node: 'obj', socket: 'data' } },
  ] as Op[]);
}

/** The control half of a promote: a spare param on `hostId`, flagged as an interface
 *  element and given a home. `promoted` defaults true because that is the case under
 *  test; the false case is asserted explicitly below. */
function putControl(
  state: DagState,
  hostId: string,
  key: string,
  opts: { promoted?: boolean; section?: string; order?: number; label?: string } = {},
): DagState {
  return applyOps(state, [
    {
      type: 'setSpareParam',
      nodeId: hostId,
      key,
      param: {
        type: 'float',
        value: 2,
        promoted: opts.promoted ?? true,
        ...(opts.section !== undefined
          ? {
              home: {
                section: opts.section,
                ...(opts.order !== undefined ? { order: opts.order } : {}),
                ...(opts.label !== undefined ? { label: opts.label } : {}),
              },
            }
          : {}),
      },
    },
  ] as Op[]);
}

/** The drive half: one `ParamDriver` pulling `(host, key)` onto `(target, paramPath)` —
 *  the exact node `buildBindDriverOps`' spare road mints. */
function drive(
  state: DagState,
  driverId: string,
  from: { host: string; key: string },
  to: { target: string; paramPath: string },
): DagState {
  return applyOps(state, [
    {
      type: 'addNode',
      nodeId: driverId,
      nodeType: 'ParamDriver',
      params: {
        target: to.target,
        paramPath: to.paramPath,
        blendMode: 'replace',
        order: 0,
        sourceSpare: { node: from.host, key: from.key },
      },
    },
  ] as Op[]);
}

const promotedRows = (state: DagState, selectedId: string): PromotedParam[] =>
  exposeParams(state, selectedId).filter((r): r is PromotedParam => r.kind === 'promoted');

/** A cube with an ArrayModifier in its lane and a control on the Object driving the
 *  modifier's `count`. The 1:1 case. */
function oneDrive(): DagState {
  let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
  state = putControl(state, 'obj', 'spread', { section: 'modifier' });
  return drive(
    state,
    'drv_count',
    { host: 'obj', key: 'spread' },
    { target: 'mod', paramPath: 'count' },
  );
}

/** …and the SAME control also driving the base data node's `size`. The 1:N case. */
function twoDrives(): DagState {
  return drive(
    oneDrive(),
    'drv_size',
    { host: 'obj', key: 'spread' },
    { target: 'obj_data', paramPath: 'size' },
  );
}

describe('#394 P7 — a promoted control is one row over N drives', () => {
  it('emits ONE row carrying the control and the param it drives', () => {
    const rows = promotedRows(oneDrive(), 'obj');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.controlNodeId).toBe('obj');
    expect(rows[0]!.controlPath).toBe('spread');
    // THE COUNT IS THE PROPERTY. Its companion is the 1:N case below, which expects 2 —
    // so an implementation that hardcoded either number fails the other.
    expect(rows[0]!.drives).toHaveLength(1);
    expect(rows[0]!.drives[0]).toEqual({
      nodeId: 'mod',
      paramPath: 'count',
      relPath: 'op0/count',
      driverId: 'drv_count',
    });
  });

  it('collapses N drives of ONE control into ONE row — 1:N is the shape, not an extension', () => {
    const rows = promotedRows(twoDrives(), 'obj');
    expect(rows, 'two drives of one spare are ONE interface element').toHaveLength(1);
    expect(rows[0]!.drives).toHaveLength(2);
    // Ordered by the chain-relative address, so the same chain instanced twice lists its
    // drives identically. `base/…` sorts before `op0/…`.
    expect(rows[0]!.drives.map((d) => d.relPath)).toEqual(['base/size', 'op0/count']);
    expect(rows[0]!.drives.map((d) => d.nodeId)).toEqual(['obj_data', 'mod']);
  });

  it('drops to ONE drive when one driver is unbound, and the other still follows', () => {
    // PLAN-3 §4 P7's named falsification, as a property: removing one driver must remove
    // exactly one drive. A control that collapsed to "driven / not driven" would show no
    // difference here.
    const state = applyOps(twoDrives(), [{ type: 'removeNode', nodeId: 'drv_size' }] as Op[]);
    const rows = promotedRows(state, 'obj');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.drives).toHaveLength(1);
    expect(rows[0]!.drives[0]!.paramPath).toBe('count');
  });

  it('emits NOTHING when the spare is not promoted — the flag IS the discriminator', () => {
    // The spare road also carries ordinary node-to-node drivers. Those are a relation
    // between two nodes, not an interface element of a third, and `promoted` is the
    // shipped answer to which is which (it is what the Controllers dock reads).
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = putControl(state, 'obj', 'spread', { promoted: false, section: 'modifier' });
    state = drive(
      state,
      'drv_count',
      { host: 'obj', key: 'spread' },
      { target: 'mod', paramPath: 'count' },
    );

    expect(promotedRows(state, 'obj')).toHaveLength(0);
    // VACUITY GUARD: the fixture is otherwise identical to the emitting one, so an
    // implementation that emitted nothing at all would fail the first case, not this one.
    expect(promotedRows(oneDrive(), 'obj')).toHaveLength(1);
  });

  it('emits NOTHING for a control whose drives all land outside the projected chain', () => {
    // The projection is per-selection. A control driving some other object is real, and
    // it is not this object's interface.
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'other', nodeType: 'Null', params: {} },
    ] as Op[]);
    state = putControl(state, 'obj', 'spread', { section: 'modifier' });
    state = drive(
      state,
      'drv_far',
      { host: 'obj', key: 'spread' },
      { target: 'other', paramPath: 'position' },
    );

    expect(promotedRows(state, 'obj')).toHaveLength(0);
  });
});

describe('#394 P7 — where a promoted control renders', () => {
  it('takes the home the promote declared', () => {
    const rows = promotedRows(oneDrive(), 'obj');
    expect(rows[0]!.home).toEqual({ section: 'modifier' });
  });

  it('carries order and label through when the promote declared them', () => {
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = putControl(state, 'obj', 'spread', { section: 'modifier', order: 3, label: 'Spread' });
    state = drive(
      state,
      'drv_count',
      { host: 'obj', key: 'spread' },
      { target: 'mod', paramPath: 'count' },
    );

    expect(promotedRows(state, 'obj')[0]!.home).toEqual({
      section: 'modifier',
      order: 3,
      label: 'Spread',
    });
  });

  it('degrades an UNKNOWN section to the unrouted bucket, and still emits the row', () => {
    // [[V145]], one layer out from `NodeDefinition.home`: decentralizing where a row lives
    // trades a compile-time impossibility for a typo, and the typo must degrade toward
    // VISIBILITY. Honouring a section nothing draws would take the control off screen —
    // the one outcome an interface element must not have.
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = putControl(state, 'obj', 'spread', { section: 'modofier' /* sic */ });
    state = drive(
      state,
      'drv_count',
      { host: 'obj', key: 'spread' },
      { target: 'mod', paramPath: 'count' },
    );

    const rows = promotedRows(state, 'obj');
    expect(rows, 'a bad home must not delete the control').toHaveLength(1);
    expect(rows[0]!.home.section).toBeNull();
  });

  it('degrades a home-less control the same way', () => {
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = putControl(state, 'obj', 'spread'); // no home at all — every pre-P7 spare
    state = drive(
      state,
      'drv_count',
      { host: 'obj', key: 'spread' },
      { target: 'mod', paramPath: 'count' },
    );

    expect(promotedRows(state, 'obj')[0]!.home.section).toBeNull();
  });
});

describe('#394 P7 — what a promoted control must NOT disturb', () => {
  it('leaves the derived rows byte-identical — same rows, same order', () => {
    // The whole reason the arm is additive. Measured as a set AND an order, against the
    // same chain without the promote.
    const before = exposeParams(spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 }), 'obj');
    const after = exposeParams(twoDrives(), 'obj');

    const derived = (rows: typeof before) =>
      rows
        .filter((r) => r.kind === 'derived')
        .map((r) => `${r.nodeId} | ${r.paramPath} | ${r.home.section ?? '(unrouted)'}`);

    // VACUITY GUARD: two empty lists are equal.
    expect(derived(before).length).toBeGreaterThan(0);
    expect(derived(after)).toEqual(derived(before));
    // …and the promote really did happen in the `after` world.
    expect(after.filter((r) => r.kind === 'promoted')).toHaveLength(1);
  });

  it('is never returned by the ownership query — a control is not a layer of the chain', () => {
    // [[V143]]'s rule at a second site: never redirect a write onto a different datum.
    // The control is deliberately NAMED for the param it drives, which is the shape that
    // would make a name-matching resolver hand it back.
    //
    // ⚠️ DECLARED: this case pins the BEHAVIOUR, and the behaviour is guaranteed by the
    // types before it reaches here — deleting the query's promoted skip is a compile
    // error, not a red test (falsified: TS2345 naming `PromotedParam`). Kept because a
    // future arm that DID carry a `paramPath` would make the runtime path reachable, and
    // then this is the case that speaks. Not kept under the impression that it is what
    // catches the bug today.
    let state = spliceOp(splitCube(), 'mod', 'ArrayModifier', { count: 2 });
    state = putControl(state, 'obj', 'count', { section: 'modifier' });
    state = drive(
      state,
      'drv_count',
      { host: 'obj', key: 'count' },
      { target: 'mod', paramPath: 'count' },
    );

    // The vacuity guard is the control's existence: it IS in the projection…
    expect(promotedRows(state, 'obj')).toHaveLength(1);
    // …and the answer is still the operator that actually owns the param.
    expect(resolveExposedTarget(state, 'obj', 'count')).toEqual({
      nodeId: 'mod',
      paramPath: 'count',
    });
  });

  it('addresses its drives by a chain-relative path that survives re-instantiation', () => {
    // `relPath` is what a template stores; ids are per-instance. Same chain, different
    // ids → identical addresses, with the ids asserted to actually differ.
    const build = (suffix: string): PromotedParam => {
      let state = applyOps(
        emptyDagState(),
        splitOps(
          'box',
          { objectId: `obj${suffix}` },
          { data: SPLIT_KINDS.box.baseDataParams },
        ) as Op[],
      );
      const below = (state.nodes[`obj${suffix}`]?.inputs as { data?: { node: string } })?.data
        ?.node;
      state = applyOps(state, [
        {
          type: 'addNode',
          nodeId: `mod${suffix}`,
          nodeType: 'ArrayModifier',
          params: { count: 2 },
        },
        {
          type: 'disconnect',
          from: { node: below!, socket: 'out' },
          to: { node: `obj${suffix}`, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: below!, socket: 'out' },
          to: { node: `mod${suffix}`, socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: `mod${suffix}`, socket: 'out' },
          to: { node: `obj${suffix}`, socket: 'data' },
        },
        {
          type: 'setSpareParam',
          nodeId: `obj${suffix}`,
          key: 'spread',
          param: { type: 'float', value: 2, promoted: true, home: { section: 'modifier' } },
        },
        {
          type: 'addNode',
          nodeId: `drv${suffix}`,
          nodeType: 'ParamDriver',
          params: {
            target: `mod${suffix}`,
            paramPath: 'count',
            blendMode: 'replace',
            order: 0,
            sourceSpare: { node: `obj${suffix}`, key: 'spread' },
          },
        },
      ] as Op[]);
      return promotedRows(state, `obj${suffix}`)[0]!;
    };

    const a = build('_a');
    const b = build('_b');
    expect(a.drives.map((d) => d.relPath)).toEqual(b.drives.map((d) => d.relPath));
    // The guard that makes the equality mean something: the instances ARE different.
    expect(b.drives.map((d) => d.nodeId)).not.toEqual(a.drives.map((d) => d.nodeId));
    expect(b.controlNodeId).not.toBe(a.controlNodeId);
  });
});
