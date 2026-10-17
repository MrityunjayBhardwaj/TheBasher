// #1674 — one scene at a time: binding either output keeps the render output reading the scene
// output, so the viewport draws the scene the scene tree shows.

import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate } from '../core/dag/evaluator';
import { applyOp, applyOps } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { setOutputOps } from './outputBinding';
import { buildSceneTreeRows } from './sceneTreeWalk';

beforeAll(() => registerAllNodes());

const RENDER_PARAMS = { postFx: { tonemap: 'Linear', smaa: false }, width: 640, height: 480 };

/** The default project with a second, empty Scene. */
function withSecondScene(): DagState {
  return applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'n_scene_2',
    nodeType: 'Scene',
    params: {},
  }).next;
}

function bind(state: DagState, name: string, nodeId: string): DagState {
  const r = setOutputOps(state, name, nodeId);
  if (!r.ok) throw new Error(r.reason);
  return applyOps(state, r.ops).next;
}

/** How many children the scene the render output draws has. */
function drawnChildren(state: DagState): number {
  const value = evaluate(state, state.outputs.render.node, {
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
  } as never).value as { scene: { children: unknown[] } };
  return value.scene.children.length;
}

describe('#1674 — one scene at a time', () => {
  it('binding the scene output rewires the render output to it, in one undo', () => {
    const state = withSecondScene();
    expect(drawnChildren(state)).toBeGreaterThan(0);
    const r = setOutputOps(state, 'scene', 'n_scene_2');
    if (!r.ok) throw new Error(r.reason);
    const { next, applied } = applyOps(state, r.ops);
    expect(next.outputs.scene.node).toBe('n_scene_2');
    expect(next.nodes.n_render.inputs.scene).toEqual({ node: 'n_scene_2', socket: 'out' });
    // What the viewport draws is the scene the tree shows: the new one, which is empty.
    expect(buildSceneTreeRows(next)[0]?.nodeId).toBe('n_scene_2');
    expect(drawnChildren(next)).toBe(0);
    // The two ops are one edit: undoing it puts both back.
    const undone = applyOps(next, applied.map((a) => a.inverse).reverse()).next;
    expect(undone.outputs).toEqual(state.outputs);
    expect(undone.nodes.n_render).toEqual(state.nodes.n_render);
  });

  it('binding a render output that reads another scene brings that scene with it', () => {
    let state = withSecondScene();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_render_2',
      nodeType: 'RenderOutput',
      params: RENDER_PARAMS,
      inputs: { scene: { node: 'n_scene_2', socket: 'out' } },
    }).next;
    const next = bind(state, 'render', 'n_render_2');
    expect(next.outputs.render.node).toBe('n_render_2');
    expect(next.outputs.scene.node).toBe('n_scene_2');
  });

  it('binding a render output that reads no scene wires it to the scene the app shows', () => {
    const state = applyOp(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'n_render_2',
      nodeType: 'RenderOutput',
      params: RENDER_PARAMS,
    }).next;
    const next = bind(state, 'render', 'n_render_2');
    expect(next.nodes.n_render_2.inputs.scene).toEqual(state.outputs.scene);
    expect(next.outputs.scene).toEqual(state.outputs.scene);
    expect(drawnChildren(next)).toBe(drawnChildren(state));
  });

  it('a split left by a bare op is healed by binding the scene again, and nothing else is an edit', () => {
    const split = applyOp(withSecondScene(), {
      type: 'setOutput',
      name: 'scene',
      ref: { node: 'n_scene_2', socket: 'out' },
    }).next;
    expect(setOutputOps(split, 'scene', 'n_scene_2')).toEqual({
      ok: true,
      ops: [
        {
          type: 'connect',
          from: { node: 'n_scene_2', socket: 'out' },
          to: { node: 'n_render', socket: 'scene' },
          replace: true,
        },
      ],
    });
    const state = buildDefaultDagState();
    expect(setOutputOps(state, 'scene', 'n_scene')).toEqual({ ok: true, ops: [] });
    expect(setOutputOps(state, 'render', 'n_render')).toEqual({ ok: true, ops: [] });
  });
});
