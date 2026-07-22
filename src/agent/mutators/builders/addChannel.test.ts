// #450 — the agent's addChannel must target the node that OWNS the param. On a
// split object a data param (material/size) lives on the linked data node, and
// the render overlay only collects channels whose target is that data node — a
// channel left on the Object animates in the inspector read but never paints.
// A transform param stays on the Object; a fused node owns its params itself.
//
// Every assertion is falsifiable: revert the resolveDataParamOwner reach in
// build() and the material case drops from the BoxData id back to the Object id.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../../core/dag';
import { __reseedAllNodesForTests } from '../../../nodes/registerAll';
import { makeSplitCube } from '../../../test-utils/splitCube';
import { addChannelMutator, type AddChannelSpec } from './addChannel';
import { validatePlan } from '../validate';

function channelTarget(state: DagState, spec: AddChannelSpec): string {
  const plan = validatePlan(addChannelMutator, spec, state, 'x');
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.reason);
  const op = plan.ops[0];
  expect(op.type).toBe('addNode');
  return (op as { params: { target: string } }).params.target;
}

describe('addChannel — data-param channel targets the owning half (#450)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('routes a split cube material channel to the BoxData, not the Object', () => {
    const { state, objectId, dataId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const target = channelTarget(state, {
      target: objectId, // what `identify` hands the agent as "the cube"
      paramPath: 'material.base.color',
      valueType: 'color',
      initialKeyframe: { time: 0, value: '#ff0000' },
    });
    // The render overlay only collects channels whose target is the data node.
    expect(target).toBe(dataId);
    expect(target).not.toBe(objectId);
  });

  it('CONTROL: a transform channel stays on the Object', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const target = channelTarget(state, {
      target: objectId,
      paramPath: 'position',
      valueType: 'vec3',
      initialKeyframe: { time: 0, value: [1, 2, 3] },
    });
    expect(target).toBe(objectId);
  });

  it('CONTROL: a fused node that owns material keeps its own id', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_sphere',
      nodeType: 'SphereMesh',
      params: {},
    }).next;
    const target = channelTarget(state, {
      target: 'n_sphere',
      paramPath: 'material.base.color',
      valueType: 'color',
      initialKeyframe: { time: 0, value: '#00ff00' },
    });
    expect(target).toBe('n_sphere');
  });
});
