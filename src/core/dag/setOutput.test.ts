// #1550 — `setOutput`: which node the app draws and renders is changed by an operation.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../project/default';
import { composeProject, loadProject, saveProject } from '../project/io';
import { MemoryStorage } from '../storage/MemoryStorage';
import { applyOp, applyOps, OpError } from './ops';
import type { DagState } from './state';
import { OpSchema } from './types';

beforeAll(() => registerAllNodes());

/** The default project with a second render output, on the same scene. */
function withSecondRender(): DagState {
  return applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'n_render_2',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'Linear', smaa: false }, width: 640, height: 480 },
    inputs: { scene: { node: 'n_scene', socket: 'out' } },
  }).next;
}

const rebind = {
  type: 'setOutput',
  name: 'render',
  ref: { node: 'n_render_2', socket: 'out' },
} as const;

describe('#1550 — setOutput', () => {
  it('rebinds the render output, and its inverse binds the old one back', () => {
    const state = withSecondRender();
    const { next, inverse } = applyOp(state, rebind);
    expect(next.outputs.render).toEqual({ node: 'n_render_2', socket: 'out' });
    expect(next.outputs.scene).toEqual(state.outputs.scene);
    expect(next.nodes).toBe(state.nodes);
    expect(inverse).toEqual({
      type: 'setOutput',
      name: 'render',
      ref: { node: 'n_render', socket: 'out' },
    });
    expect(applyOp(next, OpSchema.parse(inverse)).next.outputs).toEqual(state.outputs);
  });

  it('binding a name that was unbound undoes to unbound', () => {
    const state = withSecondRender();
    const { render: _r, ...rest } = state.outputs;
    void _r;
    const unbound = { ...state, outputs: rest };
    const { next, inverse } = applyOp(unbound, rebind);
    expect(inverse).toEqual({ type: 'setOutput', name: 'render', ref: null });
    expect(applyOp(next, inverse).next.outputs).toEqual(rest);
  });

  it('binding what is already bound changes nothing', () => {
    const state = buildDefaultDagState();
    const same = {
      type: 'setOutput',
      name: 'render',
      ref: { node: 'n_render', socket: 'out' },
    } as const;
    expect(applyOp(state, same).next).toBe(state);
  });

  it('refuses an output the app does not have, a socket of the wrong type, and a missing node', () => {
    const state = withSecondRender();
    const bad = [
      [
        { type: 'setOutput', name: 'preview', ref: { node: 'n_render_2', socket: 'out' } },
        /no output 'preview'/,
      ],
      [
        { type: 'setOutput', name: 'render', ref: { node: 'n_scene', socket: 'out' } },
        /takes a RenderOutput/,
      ],
      [
        { type: 'setOutput', name: 'scene', ref: { node: 'n_render_2', socket: 'out' } },
        /takes a Scene/,
      ],
      [
        { type: 'setOutput', name: 'render', ref: { node: 'n_render_2', socket: 'nope' } },
        /no output 'nope'/,
      ],
      [{ type: 'setOutput', name: 'render', ref: { node: 'n_gone', socket: 'out' } }, /n_gone/],
    ] as const;
    for (const [op, why] of bad) {
      // A missing node is `getNode`'s refusal, as it is for every op that names one.
      if (op.ref.node !== 'n_gone') expect(() => applyOp(state, op)).toThrow(OpError);
      expect(() => applyOp(state, op)).toThrow(why);
    }
  });

  it('a node bound as an output can be deleted once the output is rebound, in one batch', () => {
    const state = withSecondRender();
    expect(() => applyOp(state, { type: 'removeNode', nodeId: 'n_render' })).toThrow(
      /bound as output 'render'/,
    );
    const next = applyOps(state, [rebind, { type: 'removeNode', nodeId: 'n_render' }]).next;
    expect(next.nodes.n_render).toBeUndefined();
    expect(next.outputs.render.node).toBe('n_render_2');
  });

  it('a saved project keeps the binding', async () => {
    const state = applyOp(withSecondRender(), rebind).next;
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state }));
    const loaded = await loadProject(storage, 'p');
    expect(loaded.state.outputs.render).toEqual({ node: 'n_render_2', socket: 'out' });
  });
});
