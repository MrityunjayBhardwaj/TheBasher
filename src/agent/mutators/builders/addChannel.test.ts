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
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
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
    registerAllNodes();
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

  // #476 — a third case lived here: "CONTROL: a fused node that owns material keeps its own
  // id", built on a fused `SphereMesh`. Its SUBJECT was the fused node, so with that kind
  // retired it described no state the product can reach. Retargeting it onto a split pair
  // would have made it a copy of the first case above, green about a shape that is gone.
  // Deleted with its fixture rather than repaired. The two cases that remain still bracket
  // the routing from both sides: a data param moves, a transform param does not.
});

// ── #519 — the same question, one layer finer ──────────────────────────────────────
//
// The reach above resolves per param ROOT, which is sound while every superseding layer
// is wholesale. A material override operator authors a SPARSE per-field set, so with one
// forcing `color` in the lane the whole `material` root resolved to the layer BELOW the
// operator — the masked one. Reproduced before the fix on exactly this graph: the mutator
// returned ok, the channel was created on the base data node, and the composed material
// went on taking the colour from the operator above. Nothing thrown, nothing logged.
//
// The PATH is asserted alongside the target because the two layers spell the field
// differently: the base stores `material.base.color`, the operator the flat `color`. A
// correct target carrying the caller's path would name a param the operator does not have,
// which is a channel that evaluates against nothing.
describe('addChannel — a forcing material operator owns the field it supplies (#519)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  function withForcingOp(): { state: DagState; objectId: string; dataId: string; opId: string } {
    const {
      state: split,
      objectId,
      dataId,
    } = makeSplitCube(emptyDagState(), { objectId: 'n_cube' });
    const opId = 'n_ovr';
    const state = (
      [
        {
          type: 'addNode',
          nodeId: opId,
          nodeType: 'MaterialOverrideOp',
          params: { color: '#00ff88', overridden: { color: true } },
        },
        {
          type: 'disconnect',
          from: { node: dataId, socket: 'out' },
          to: { node: objectId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: opId, socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: opId, socket: 'out' },
          to: { node: objectId, socket: 'data' },
        },
      ] as Op[]
    ).reduce((s, op) => applyOp(s, op).next, split);
    return { state, objectId, dataId, opId };
  }

  it('targets the operator, in the operator’s own vocabulary', () => {
    const { state, objectId, dataId, opId } = withForcingOp();
    // Vacuity guard: the two candidate nodes are real and distinct.
    expect(opId).not.toBe(dataId);

    const plan = validatePlan(
      addChannelMutator,
      {
        target: objectId,
        paramPath: 'material.base.color',
        valueType: 'color',
        initialKeyframe: { time: 0, value: '#ff0000' },
      },
      state,
      'x',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    const params = (plan.ops[0] as { params: { target: string; paramPath: string } }).params;
    expect(params.target).toBe(opId);
    expect(params.paramPath).toBe('color');
  });

  it('CONTROL: the same cube with the operator MUTED keeps the channel on the base', () => {
    const { state: forced, objectId, dataId, opId } = withForcingOp();
    const state = applyOp(forced, {
      type: 'setParam',
      nodeId: opId,
      paramPath: 'muted',
      value: true,
    }).next;
    expect(
      channelTarget(state, {
        target: objectId,
        paramPath: 'material.base.color',
        valueType: 'color',
        initialKeyframe: { time: 0, value: '#ff0000' },
      }),
    ).toBe(dataId);
  });
});
