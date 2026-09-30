// #353 — mutator.constrain / mutator.unconstrain: the constraint family's verbs.
//
// Every row runs the real five gates (`validatePlan`) on the product's default project, and
// the rows that matter carry the plan through the diff store's closure gate too, because a
// plan the tool accepts and the store refuses is the #1400 shape: `ok` to the model, nothing
// on screen.

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../../core/dag';
import { getNodeType } from '../../../core/dag/registry';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { buildDefaultDagState } from '../../../core/project/default';
import { buildAddPrimitiveOps } from '../../../app/addPrimitives';
import { ADDABLE_CONSTRAINTS } from '../../../app/constraintStack';
import { useDiffStore } from '../../diff';
import { validatePlan } from '../validate';
import type { MutatorDefinition, MutatorValidationResult } from '../types';
import { ConstraintType, constrainMutator, unconstrainMutator } from './constrain';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: Op[]): DagState => ops.reduce((a, op) => applyOp(a, op).next, s);

/** The default project plus one Curve object; returns the curve's Object id. */
function withCurve(): { state: DagState; curve: string } {
  const base = buildDefaultDagState();
  const built = buildAddPrimitiveOps(base, 'Curve', [0, 0, 3])!;
  const state = apply(base, built.ops);
  const curve = Object.keys(state.nodes).find(
    (id) => !base.nodes[id] && state.nodes[id].type === 'Object',
  )!;
  return { state, curve };
}

/** A TrackTo on the camera, already aiming at `aimNode`. */
function withAim(state: DagState, id: string, aimNode: string, mute = false): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'TrackTo',
    params: { target: 'n_camera', aimNode, mute },
  }).next;
}

function plan<S>(m: MutatorDefinition<S>, spec: unknown, state: DagState): MutatorValidationResult {
  return validatePlan(m, m.spec.parse(spec), state, 'test');
}

function okOps(r: MutatorValidationResult): Op[] {
  if (!r.ok) throw new Error(`expected ok, got gate ${r.gate}: ${r.reason}`);
  return r.ops;
}

/** Propose through the diff store under the mutator's own closure spec — the end-of-turn gate. */
function propose<S>(m: MutatorDefinition<S>, spec: unknown, state: DagState, ops: Op[]): DagState {
  useDiffStore.getState().reset();
  const closure = m.buildClosureSpec(m.spec.parse(spec));
  return useDiffStore.getState().propose(state, ops, 'test', undefined, closure).forkState;
}

describe('#353 — the kind axis is the "+ Add" list, not a copy of it', () => {
  it('THE DERIVATION PIN: constrain accepts exactly the ADDABLE_CONSTRAINTS types', () => {
    const accepted = [...ConstraintType.options].sort();
    expect(accepted).toEqual(ADDABLE_CONSTRAINTS.map((c) => c.type).sort());
  });

  it("each kind's pointer is a real param of its node type", () => {
    for (const c of ADDABLE_CONSTRAINTS) {
      const def = getNodeType(c.type);
      expect(def, c.type).toBeDefined();
      const parsed = def!.paramSchema.parse({}) as Record<string, unknown>;
      expect(Object.keys(parsed), `${c.type}.${c.pointer}`).toContain(c.pointer);
    }
  });
});

describe('#353 — mutator.constrain', () => {
  it('"point the camera at the cube": one TrackTo, aimed, on top of the stack — and the store takes it', () => {
    const state = buildDefaultDagState();
    const spec = { target: 'n_camera', type: 'TrackTo', to: 'n_box' };
    const ops = okOps(plan(constrainMutator, spec, state));
    expect(ops).toEqual([
      {
        type: 'addNode',
        nodeId: 'n_camera_trackto_1',
        nodeType: 'TrackTo',
        params: { target: 'n_camera', order: 0, aimNode: 'n_box' },
      },
    ]);
    const fork = propose(constrainMutator, spec, state, ops);
    expect(fork.nodes.n_camera_trackto_1.params).toMatchObject({ aimNode: 'n_box' });
  });

  it('"make the camera follow the path": a FollowPath riding the EXISTING curve', () => {
    const { state, curve } = withCurve();
    const spec = { target: 'n_camera', type: 'FollowPath', to: curve };
    const ops = okOps(plan(constrainMutator, spec, state));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'addNode',
      nodeType: 'FollowPath',
      params: { target: 'n_camera', curve },
    });
    // No new path is minted — that is camera.trajectory's job, not this one's.
    expect(ops.some((o) => o.type === 'addNode' && o.nodeType === 'CurveData')).toBe(false);
    propose(constrainMutator, spec, state, ops);
  });

  it('asking again RE-POINTS the live constraint of that type; it does not stack a second', () => {
    const state = withAim(buildDefaultDagState(), 'aim1', 'n_light');
    const spec = { target: 'n_camera', type: 'TrackTo', to: 'n_box' };
    const ops = okOps(plan(constrainMutator, spec, state));
    expect(ops).toEqual([
      { type: 'setParam', nodeId: 'aim1', paramPath: 'aimNode', value: 'n_box' },
    ]);
    // The existing constraint is in the declared closure (id-ref from the target), so the
    // store admits a write to a node the plan did not create.
    const fork = propose(constrainMutator, spec, state, ops);
    expect(fork.nodes.aim1.params).toMatchObject({ aimNode: 'n_box' });
  });

  it('a MUTED constraint is not reused — re-pointing it would change nothing on screen', () => {
    const state = withAim(buildDefaultDagState(), 'aim_off', 'n_light', true);
    const ops = okOps(
      plan(constrainMutator, { target: 'n_camera', type: 'TrackTo', to: 'n_box' }, state),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'addNode', nodeType: 'TrackTo' });
  });

  describe('refuses what would draw nothing, with the reason', () => {
    const refusal = (spec: unknown, state = buildDefaultDagState()) => {
      const r = plan(constrainMutator, spec, state);
      if (r.ok) throw new Error('expected a refusal');
      return r;
    };

    it('a target that is not in the DAG', () => {
      expect(refusal({ target: 'n_nope', type: 'TrackTo', to: 'n_box' }).reason).toMatch(
        /not in DAG/,
      );
    });

    it('a target the resolver does not place', () => {
      // TimeSource is in the DAG and placed nowhere.
      expect(refusal({ target: 'n_time', type: 'TrackTo', to: 'n_box' }).reason).toMatch(
        /not placed in the scene/,
      );
    });

    it('a pointee that is not in the DAG', () => {
      expect(refusal({ target: 'n_camera', type: 'TrackTo', to: 'n_nope' }).reason).toMatch(
        /not in DAG/,
      );
    });

    it('an aim at something with no place in the scene (it would aim at the origin)', () => {
      expect(refusal({ target: 'n_camera', type: 'TrackTo', to: 'n_time' }).reason).toMatch(
        /no place in the scene/,
      );
    });

    it('a FollowPath onto something that is not a curve (it would contribute nothing)', () => {
      expect(refusal({ target: 'n_camera', type: 'FollowPath', to: 'n_box' }).reason).toMatch(
        /not a path/,
      );
    });

    it('an object constrained to itself', () => {
      expect(refusal({ target: 'n_box', type: 'TrackTo', to: 'n_box' }).reason).toMatch(/itself/);
    });
  });
});

describe('#353 — mutator.unconstrain', () => {
  it('removes every constraint of the type on the target, muted ones too, and the store takes it', () => {
    let state = withAim(buildDefaultDagState(), 'aim1', 'n_box');
    state = withAim(state, 'aim_off', 'n_light', true);
    const spec = { target: 'n_camera', type: 'TrackTo' };
    const ops = okOps(plan(unconstrainMutator, spec, state));
    expect(ops.map((o) => (o.type === 'removeNode' ? o.nodeId : o.type)).sort()).toEqual([
      'aim1',
      'aim_off',
    ]);
    const fork = propose(unconstrainMutator, spec, state, ops);
    expect(fork.nodes.aim1).toBeUndefined();
    expect(fork.nodes.aim_off).toBeUndefined();
  });

  it('with no type, removes every kind — and leaves another object’s constraints alone', () => {
    const { state: s0, curve } = withCurve();
    let state = withAim(s0, 'aim1', 'n_box');
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ride',
      nodeType: 'FollowPath',
      params: { target: 'n_camera', curve },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'light_aim',
      nodeType: 'TrackTo',
      params: { target: 'n_light', aimNode: 'n_box' },
    }).next;
    const ops = okOps(plan(unconstrainMutator, { target: 'n_camera' }, state));
    expect(ops.map((o) => (o.type === 'removeNode' ? o.nodeId : o.type)).sort()).toEqual([
      'aim1',
      'ride',
    ]);
  });

  it('refuses when there is nothing to remove, instead of proposing an empty plan', () => {
    const r = plan(
      unconstrainMutator,
      { target: 'n_camera', type: 'TrackTo' },
      buildDefaultDagState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no TrackTo to remove/);
  });
});
