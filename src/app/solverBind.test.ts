// solverBind — the pure op-builders for authoring a Solver's `body` edge (Epic 2).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildSetSolverBodyOps, buildSpringOps } from './solverBind';
import { driverNodesForTarget } from './paramDrivers';

const SOLVER_ID = 'n_solver';
const MATH_ID = 'n_math';
const FIT_ID = 'n_fit';
const BOX_ID = 'n_box';
const CTL_ID = 'n_ctl';

/** A Solver + two candidate sub-network outputs (Math, Fit), nothing wired to `body`. */
function buildState(): DagState {
  let state = buildDefaultDagState();
  const add = (op: Op) => {
    state = applyOp(state, op).next;
  };
  add({ type: 'addNode', nodeId: SOLVER_ID, nodeType: 'Solver', params: { seedFrame: 0 } } as Op);
  add({ type: 'addNode', nodeId: MATH_ID, nodeType: 'Math', params: { op: 'add' } } as Op);
  add({ type: 'addNode', nodeId: FIT_ID, nodeType: 'Fit', params: {} } as Op);
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('buildSetSolverBodyOps', () => {
  const ref = (node: string) => ({ node, socket: 'out' });

  it('connects the sub-network output into an empty body', () => {
    const ops = buildSetSolverBodyOps(buildState(), SOLVER_ID, ref(MATH_ID));
    expect(ops).toEqual([
      {
        type: 'connect',
        from: { node: MATH_ID, socket: 'out' },
        to: { node: SOLVER_ID, socket: 'body' },
      },
    ]);
  });

  it('rewires body — disconnects the old edge, connects the new', () => {
    let state = buildState();
    state = applyOp(state, buildSetSolverBodyOps(state, SOLVER_ID, ref(MATH_ID))[0]).next;
    const ops = buildSetSolverBodyOps(state, SOLVER_ID, ref(FIT_ID));
    expect(ops).toEqual([
      {
        type: 'disconnect',
        from: { node: MATH_ID, socket: 'out' },
        to: { node: SOLVER_ID, socket: 'body' },
      },
      {
        type: 'connect',
        from: { node: FIT_ID, socket: 'out' },
        to: { node: SOLVER_ID, socket: 'body' },
      },
    ]);
  });

  it('clears body — disconnects the current edge', () => {
    let state = buildState();
    state = applyOp(state, buildSetSolverBodyOps(state, SOLVER_ID, ref(MATH_ID))[0]).next;
    expect(buildSetSolverBodyOps(state, SOLVER_ID, null)).toEqual([
      {
        type: 'disconnect',
        from: { node: MATH_ID, socket: 'out' },
        to: { node: SOLVER_ID, socket: 'body' },
      },
    ]);
  });

  it('is a no-op when the new ref already equals the current body edge', () => {
    let state = buildState();
    state = applyOp(state, buildSetSolverBodyOps(state, SOLVER_ID, ref(MATH_ID))[0]).next;
    expect(buildSetSolverBodyOps(state, SOLVER_ID, ref(MATH_ID))).toEqual([]);
  });

  it('is a no-op when clearing an already-empty body, or the solver is missing', () => {
    const state = buildState();
    expect(buildSetSolverBodyOps(state, SOLVER_ID, null)).toEqual([]);
    expect(buildSetSolverBodyOps(state, 'ghost', ref(MATH_ID))).toEqual([]);
  });
});

describe('buildSpringOps — the Spring preset (S, #300)', () => {
  /** Default project + a controller Null. */
  function withController(): DagState {
    return applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: CTL_ID,
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    } as Op).next;
  }

  it('builds an applyable sub-network: a 2-slot Solver + a vec driver on the target', () => {
    const state = withController();
    const res = buildSpringOps(state, {
      targetId: BOX_ID,
      controllerId: CTL_ID,
      idFor: (key) => `sp_${key}`,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    // The Solver has TWO body slots (position + velocity) + the vec live-input source.
    const solver = next.nodes['sp_solver'];
    expect((solver.inputs.bodies as unknown[]).length).toBe(2);
    expect(
      (solver.params as { sourceTransformVec?: { node?: string } }).sourceTransformVec?.node,
    ).toBe(CTL_ID);
    // The vec driver targets the box position, wired to the Solver's outVec.
    const driver = next.nodes['sp_driver'];
    expect((driver.params as { target?: string; paramPath?: string }).target).toBe(BOX_ID);
    expect(driver.inputs.inVec).toEqual({ node: 'sp_solver', socket: 'outVec' });
    expect(driverNodesForTarget(next.nodes, BOX_ID).map((d) => d.id)).toContain('sp_driver');
  });

  it('REJECTS a spring whose controller already reads back the target (cycle, G6)', () => {
    // Bind the controller's own position from the box first (box drives the Null), so a
    // spring box←Null would close box → Null → (driver) box.
    let state = withController();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_back',
      nodeType: 'ParamDriver',
      params: {
        target: CTL_ID,
        paramPath: 'position',
        blendMode: 'replace',
        order: 0,
        sourceTransformVec: { node: BOX_ID },
      },
    } as Op).next;
    const res = buildSpringOps(state, {
      targetId: BOX_ID,
      controllerId: CTL_ID,
      idFor: (key) => `sp_${key}`,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cycle/i);
  });

  it('rejects a missing target or controller', () => {
    const state = withController();
    expect(buildSpringOps(state, { targetId: '', controllerId: CTL_ID, idFor: (k) => k }).ok).toBe(
      false,
    );
  });
});
