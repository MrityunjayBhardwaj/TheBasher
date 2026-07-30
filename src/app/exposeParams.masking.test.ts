// #394 P4 — masking is a LABEL, and it is computed ONCE PER CHAIN.
//
// Two independent properties, and the second is the one that needs a counter rather than
// an assertion about values:
//
//  1. WHAT is masked. A later layer that supplies a field is named on the row that also
//     holds it, per FIELD — because a sparse override can supply exactly one channel of a
//     material that renders as eleven widgets.
//
//  2. HOW OFTEN the question is asked. `resolveMaterialFieldOwners` EVALUATES (it has to
//     know which source maps defend a channel), and the evaluator hashes params before
//     its cache lookup — the shape behind the measured ~458ms inspector edit lag. Asked
//     once per ROW, as the obvious implementation would, it evaluates once per widget.
//     So the count is pinned directly: ONE call per projection, and ZERO when nothing in
//     the chain can mask. A test that only checked the labels would pass just as happily
//     against the slow version.
//
// REF: src/app/exposeParams.ts (`withMaterialMasking`), src/app/resolveMaterialFieldOwner.ts
//      (`resolveMaterialFieldOwners` — one walk, all six fields); PLAN-3 §4 P4; #394, #518.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { SPLIT_KINDS, splitOps } from '../test-utils/splitKinds';

/** Counts real calls without replacing the implementation — the answers must stay true.
 *
 *  The counter validates ITSELF: one case below expects exactly 1 and another expects
 *  exactly 0, so a spy that never intercepted (the usual way a module mock silently does
 *  nothing) fails one of them rather than passing both. A single `toBe(1)` would not have
 *  that property. */
const calls = { owners: 0 };
vi.mock('./resolveMaterialFieldOwner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolveMaterialFieldOwner')>();
  return {
    ...actual,
    resolveMaterialFieldOwners: (...args: Parameters<typeof actual.resolveMaterialFieldOwners>) => {
      calls.owners += 1;
      return actual.resolveMaterialFieldOwners(...args);
    },
  };
});

const { exposeParams } = await import('./exposeParams');

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  calls.owners = 0;
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

/** …with a material override operator spliced into its data lane. */
function withOverrideOp(state: DagState, opId = 'ovr'): DagState {
  return applyOps(state, [
    { type: 'addNode', nodeId: opId, nodeType: 'MaterialOverrideOp', params: {} },
    {
      type: 'disconnect',
      from: { node: 'obj_data', socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'obj_data', socket: 'out' },
      to: { node: opId, socket: 'target' },
    },
    { type: 'connect', from: { node: opId, socket: 'out' }, to: { node: 'obj', socket: 'data' } },
  ] as Op[]);
}

const rowFor = (rows: ReturnType<typeof exposeParams>, nodeId: string, paramPath: string) =>
  rows.find((r) => r.nodeId === nodeId && r.paramPath === paramPath);

describe('#394 P4 — what a later layer masks', () => {
  it('names the operator on the BASE material row, per field and by IR path', () => {
    const rows = exposeParams(withOverrideOp(splitCube()), 'obj');
    const base = rowFor(rows, 'obj_data', 'material');
    expect(base, 'the base data node must still contribute its material row').toBeTruthy();

    // Per FIELD and in the IR vocabulary — the row is a container of channels, so a
    // boolean on the row would be wrong at both ends.
    expect(base!.maskedBy?.['material.specular.roughness']?.nodeId).toBe('ovr');
    expect(base!.maskedBy?.['material.base.color']?.nodeId).toBe('ovr');
    // …and the label is the operator's display name, which is what the mark shows.
    expect(base!.maskedBy?.['material.base.color']?.label).toBeTruthy();
  });

  it('does NOT mark the operator’s own rows — it is the authority, not the masked layer', () => {
    const rows = exposeParams(withOverrideOp(splitCube()), 'obj');
    const opRow = rowFor(rows, 'ovr', 'roughness');
    expect(opRow, 'the operator must contribute its own rows').toBeTruthy();
    expect(opRow!.maskedBy).toBeUndefined();
  });

  it('marks the base when a linked Material node supersedes the socket — no operator needed', () => {
    // A socket SUPERSEDES the param it shares a name with, so the data node's own
    // material is not what the viewport draws. This shape needs no operator at all, which
    // makes it the common case rather than the exotic one.
    const state = applyOps(splitCube(), [
      { type: 'addNode', nodeId: 'mat', nodeType: 'Material', params: {} },
      {
        type: 'connect',
        from: { node: 'mat', socket: 'out' },
        to: { node: 'obj_data', socket: 'material' },
      },
    ] as Op[]);
    const rows = exposeParams(state, 'obj');
    expect(rowFor(rows, 'obj_data', 'material')!.maskedBy?.['material.base.color']?.nodeId).toBe(
      'mat',
    );
    // The Material node's own row is the authority, so it carries no mark.
    expect(rowFor(rows, 'mat', 'material')!.maskedBy).toBeUndefined();
  });

  it('marks nothing on a plain split pair', () => {
    const rows = exposeParams(splitCube(), 'obj');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.maskedBy === undefined)).toBe(true);
  });
});

describe('#394 P4 — masking is asked ONCE PER CHAIN, never once per row', () => {
  it('asks exactly once for a chain that can mask, however many rows it has', () => {
    const state = withOverrideOp(splitCube());
    const rows = exposeParams(state, 'obj');

    // The vacuity guard: there must be enough rows that a per-row implementation would
    // be visibly different from a per-chain one.
    expect(rows.length).toBeGreaterThan(5);
    expect(calls.owners).toBe(1);
  });

  it('does not ask AT ALL when nothing in the chain can mask', () => {
    // Every object in the default project is this shape, so the guard in front of the
    // walk is what keeps the common case free.
    exposeParams(splitCube(), 'obj');
    expect(calls.owners).toBe(0);
  });

  it('still asks only once with two operators stacked', () => {
    let state = withOverrideOp(splitCube(), 'ovr1');
    state = applyOps(state, [
      { type: 'addNode', nodeId: 'ovr2', nodeType: 'MaterialOverrideOp', params: {} },
      {
        type: 'disconnect',
        from: { node: 'ovr1', socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: 'ovr1', socket: 'out' },
        to: { node: 'ovr2', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'ovr2', socket: 'out' },
        to: { node: 'obj', socket: 'data' },
      },
    ] as Op[]);
    calls.owners = 0;

    const rows = exposeParams(state, 'obj');
    expect(rows.filter((r) => r.origin === 'operator').length).toBeGreaterThan(10);
    expect(calls.owners).toBe(1);
  });
});
