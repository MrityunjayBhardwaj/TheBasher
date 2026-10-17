// #1550 — mutator.setOutput: the agent rebinds the render output; undo restores the old one.
//
// Rows run the real gates (`validatePlan`), then carry the plan through the diff store's closure
// gate and the dag store, because a plan the tool accepts and the store refuses ends the turn
// `ok` with nothing done (#1400).

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../../core/dag';
import type { DagState } from '../../../core/dag/state';
import { useDagStore } from '../../../core/dag/store';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { buildDefaultDagState } from '../../../core/project/default';
import { useDiffStore } from '../../diff';
import { validatePlan } from '../validate';
import type { MutatorValidationResult } from '../types';
import { setOutputMutator } from './setOutput';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const plan = (spec: unknown, state: DagState): MutatorValidationResult =>
  validatePlan(setOutputMutator, setOutputMutator.spec.parse(spec), state, 'test');

function withSecondRender(): DagState {
  return applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'n_render_2',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'Linear', smaa: false }, width: 640, height: 480 },
    inputs: { scene: { node: 'n_scene', socket: 'out' } },
  }).next;
}

describe('#1550 — mutator.setOutput', () => {
  it('"render from the second output": the store takes it, and one undo puts the old one back', () => {
    const state = withSecondRender();
    const spec = { output: 'render', targetSelectors: ['n_render_2'] };
    const r = plan(spec, state);
    if (!r.ok) throw new Error(`gate ${r.gate}: ${r.reason}`);
    expect(r.ops).toEqual<Op[]>([
      { type: 'setOutput', name: 'render', ref: { node: 'n_render_2', socket: 'out' } },
    ]);
    useDiffStore.getState().reset();
    const closure = setOutputMutator.buildClosureSpec(setOutputMutator.spec.parse(spec));
    const fork = useDiffStore
      .getState()
      .propose(state, r.ops, 'test', undefined, closure).forkState;
    expect(fork.outputs.render.node).toBe('n_render_2');

    const store = useDagStore.getState();
    store.reset();
    store.hydrate(state);
    useDagStore.getState().dispatchAtomic(r.ops, 'agent', 'render from n_render_2');
    expect(useDagStore.getState().state.outputs.render.node).toBe('n_render_2');
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.outputs).toEqual(state.outputs);
  });

  it('"show the second scene": the render output is rewired too, and one undo puts both back', () => {
    // #1674 — the rewire lands on the render output, which the new scene is not yet wired to, so
    // the closure gate has to reach it.
    const state = applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'n_scene_2',
      nodeType: 'Scene',
      params: {},
    }).next;
    const spec = { output: 'scene', targetSelectors: ['n_scene_2'] };
    const r = plan(spec, state);
    if (!r.ok) throw new Error(`gate ${r.gate}: ${r.reason}`);
    expect(r.ops.map((op) => op.type)).toEqual(['setOutput', 'connect']);
    useDiffStore.getState().reset();
    const closure = setOutputMutator.buildClosureSpec(setOutputMutator.spec.parse(spec));
    const fork = useDiffStore
      .getState()
      .propose(state, r.ops, 'test', undefined, closure).forkState;
    expect(fork.nodes.n_render.inputs.scene).toEqual({ node: 'n_scene_2', socket: 'out' });

    const store = useDagStore.getState();
    store.reset();
    store.hydrate(state);
    useDagStore.getState().dispatchAtomic(r.ops, 'agent', 'show n_scene_2');
    expect(useDagStore.getState().state.outputs.scene.node).toBe('n_scene_2');
    expect(useDagStore.getState().state.nodes.n_render.inputs.scene).toEqual({
      node: 'n_scene_2',
      socket: 'out',
    });
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.outputs).toEqual(state.outputs);
    expect(useDagStore.getState().state.nodes.n_render).toEqual(state.nodes.n_render);
  });

  it('refuses a node of the wrong kind, in words, before any op', () => {
    const r = plan({ output: 'render', targetSelectors: ['n_scene'] }, withSecondRender());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/takes a RenderOutput node/);
  });

  it('asking for what is already bound is not an edit', () => {
    const r = plan({ output: 'scene', targetSelectors: ['n_scene'] }, buildDefaultDagState());
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops).toEqual([]);
  });
});
