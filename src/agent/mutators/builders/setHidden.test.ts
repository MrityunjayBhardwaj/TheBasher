// #1445 — mutator.setHidden: the agent can hide and show again what the outliner's eye can.
//
// Every row runs the real five gates (`validatePlan`) on the product's default project, and the
// accepted rows carry the plan through the diff store's closure gate too, because a plan the
// tool accepts and the store refuses ends the turn `ok` with nothing on screen (#1400).

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../../core/dag';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { buildDefaultDagState } from '../../../core/project/default';
import { useDiffStore } from '../../diff';
import { validatePlan } from '../validate';
import type { MutatorValidationResult } from '../types';
import { hideRefusal } from '../../../app/sceneVisibility';
import { setHiddenMutator } from './setHidden';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const plan = (spec: unknown, state: DagState): MutatorValidationResult =>
  validatePlan(setHiddenMutator, setHiddenMutator.spec.parse(spec), state, 'test');

function okOps(r: MutatorValidationResult): Op[] {
  if (!r.ok) throw new Error(`expected ok, got gate ${r.gate}: ${r.reason}`);
  return r.ops;
}

/** Propose through the diff store under the mutator's own closure spec: the end-of-turn gate. */
function propose(spec: unknown, state: DagState, ops: Op[]): DagState {
  useDiffStore.getState().reset();
  const closure = setHiddenMutator.buildClosureSpec(setHiddenMutator.spec.parse(spec));
  return useDiffStore.getState().propose(state, ops, 'test', undefined, closure).forkState;
}

const hidden = (s: DagState, id: string) => s.nodes[id]?.meta?.hidden ?? false;

describe('#1445 — mutator.setHidden', () => {
  it('"hide the light": the light is hidden, and the store takes the plan', () => {
    const state = buildDefaultDagState();
    const spec = { targetSelectors: ['n_light'], hidden: true };
    const ops = okOps(plan(spec, state));
    expect(ops).toEqual([{ type: 'setHidden', nodeId: 'n_light', hidden: true }]);
    expect(hidden(propose(spec, state, ops), 'n_light')).toBe(true);
  });

  it('"show it again": hidden false clears the flag, through the same gates', () => {
    const state = applyOp(buildDefaultDagState(), {
      type: 'setHidden',
      nodeId: 'n_light',
      hidden: true,
    }).next;
    const spec = { targetSelectors: ['n_light'], hidden: false };
    const ops = okOps(plan(spec, state));
    expect(ops).toEqual([{ type: 'setHidden', nodeId: 'n_light', hidden: false }]);
    expect(hidden(propose(spec, state, ops), 'n_light')).toBe(false);
  });

  it('hides several at once, and a target already in the asked state emits nothing', () => {
    const state = applyOp(buildDefaultDagState(), {
      type: 'setHidden',
      nodeId: 'n_box',
      hidden: true,
    }).next;
    const ops = okOps(plan({ targetSelectors: ['n_box', 'n_light'], hidden: true }, state));
    expect(ops).toEqual([{ type: 'setHidden', nodeId: 'n_light', hidden: true }]);
  });

  it("refuses a camera with the outliner's own reason, and emits nothing", () => {
    const state = buildDefaultDagState();
    const r = plan({ targetSelectors: ['n_camera'], hidden: true }, state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(hideRefusal(state, 'n_camera'));
  });

  it('refuses a data node: the object that holds it is what can be hidden', () => {
    const state = buildDefaultDagState();
    const r = plan({ targetSelectors: ['n_light_data'], hidden: true }, state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a direct child or light of the scene/);
  });

  it('refuses a missing id by name', () => {
    const r = plan({ targetSelectors: ['nope'], hidden: true }, buildDefaultDagState());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/"nope"/);
  });

  it('accepts exactly what the outliner offers an eye on, over every node of the scene', () => {
    // The agent and the eye ask one predicate; this pins that the mutator adds no rule of its
    // own on top of it, on every node of the default project (the denominator rides along).
    const state = buildDefaultDagState();
    const ids = Object.keys(state.nodes);
    expect(ids.length).toBeGreaterThan(5);
    const accepted = ids.filter((id) => plan({ targetSelectors: [id], hidden: true }, state).ok);
    const offered = ids.filter((id) => hideRefusal(state, id) === null);
    expect(accepted).toEqual(offered);
    expect(offered).toEqual(expect.arrayContaining(['n_box', 'n_light']));
  });
});
