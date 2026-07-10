// solverBind — the pure op-builders for authoring a Solver's `body` edge (Epic 2).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildSetSolverBodyOps } from './solverBind';

const SOLVER_ID = 'n_solver';
const MATH_ID = 'n_math';
const FIT_ID = 'n_fit';

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
