// #1189 — a write refused because it aimed at the wrong half of a split object names the
// half that owns the param, on the road that reaches a reader (the diff: DiffBar + the
// model's no-op report). The op is still refused — the reach is explicit only (promote).

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, emptyDagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCube } from '../../test-utils/splitCube';
import { badgeLabel } from '../../app/badges';
import { createFork } from './forkedDag';
import { renderNoOpReport } from '../orchestrator';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function cube() {
  return makeSplitCube(emptyDagState(), { objectId: 'n_box', size: [1, 1, 1] }).state;
}

describe('#1189 — a refused wrong-half write names the owner', () => {
  it('a data param on the Object names its data node — and changes nothing', () => {
    const s = cube();
    const { fork, reportable } = createFork(s, [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'size', value: [2, 2, 2] },
    ]);
    expect(reportable[0]?.owner).toBe('n_box_data');
    // Refused, not forwarded: the data node's size is untouched.
    expect((fork.nodes.n_box_data.params as { size: number[] }).size).toEqual([1, 1, 1]);
  });

  it('a nested data path names the owner of its root', () => {
    const { reportable } = createFork(cube(), [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'material.base.color', value: '#ff0000' },
    ]);
    expect(reportable[0]?.owner).toBe('n_box_data');
  });

  it('a param nothing owns names no owner', () => {
    const { reportable } = createFork(cube(), [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'siez', value: [2, 2, 2] },
    ]);
    expect(reportable[0]?.badge).toBe('stripped-write');
    expect(reportable[0]?.owner).toBeUndefined();
  });

  it('a wrong leaf on the node that owns the root names no owner (it IS the owner)', () => {
    const { reportable } = createFork(cube(), [
      { type: 'setParam', nodeId: 'n_box_data', paramPath: 'material.nonexistent', value: 1 },
    ]);
    expect(reportable[0]?.badge).toBe('stripped-write');
    expect(reportable[0]?.owner).toBeUndefined();
  });

  it('the director and the model both read where it lives', () => {
    const { reportable } = createFork(cube(), [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'size', value: [2, 2, 2] },
    ]);
    const r = reportable[0]!;
    expect(badgeLabel(r.badge, r)).toBe(
      'Ignored size on n_box — Object has no such parameter; it lives on n_box_data (changed nothing)',
    );
    expect(renderNoOpReport(reportable)).toContain('it lives on n_box_data');
  });
});
