// lagBind — the pure op-builders for a Lag node's transform-channel input (#297 S4).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildSetLagSourceOps } from './lagBind';
import type { DriverSource } from './driverBind';

const LAG_ID = 'n_lag';
const NULL_ID = 'n_null';

function stateWithLag(sourceTransform?: unknown): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: NULL_ID,
    nodeType: 'Null',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: LAG_ID,
    nodeType: 'Lag',
    params: sourceTransform ? { factor: 0.3, sourceTransform } : { factor: 0.3 },
  } as Op).next;
  return state;
}

const transformSource: DriverSource = {
  kind: 'transform',
  id: `xf:${NULL_ID}:tx`,
  label: 'ctl · tx',
  node: NULL_ID,
  channel: 'tx',
};

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('buildSetLagSourceOps', () => {
  it('sets the Lag’s transform source from a transform DriverSource', () => {
    const ops = buildSetLagSourceOps(stateWithLag(), LAG_ID, transformSource);
    expect(ops).toEqual([
      {
        type: 'setParam',
        nodeId: LAG_ID,
        paramPath: 'sourceTransform',
        value: { node: NULL_ID, channel: 'tx' },
      },
    ]);
  });

  it('clears the source (setParam undefined) when it was set', () => {
    const state = stateWithLag({ node: NULL_ID, channel: 'tx' });
    const ops = buildSetLagSourceOps(state, LAG_ID, null);
    expect(ops).toEqual([
      { type: 'setParam', nodeId: LAG_ID, paramPath: 'sourceTransform', value: undefined },
    ]);
  });

  it('clearing an already-empty source is a no-op (tidy undo history)', () => {
    expect(buildSetLagSourceOps(stateWithLag(), LAG_ID, null)).toEqual([]);
  });

  it('ignores a non-transform source (v1 trails only a controller channel)', () => {
    const spare: DriverSource = {
      kind: 'spare',
      id: 's',
      label: 'x',
      node: NULL_ID,
      key: 'k',
    };
    expect(buildSetLagSourceOps(stateWithLag(), LAG_ID, spare)).toEqual([]);
  });

  it('is a no-op for a missing node', () => {
    expect(buildSetLagSourceOps(stateWithLag(), 'nope', transformSource)).toEqual([]);
  });
});
