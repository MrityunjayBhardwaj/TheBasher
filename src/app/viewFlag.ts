// #1953 — the Nodes tab's view flag: which node's result the viewport shows (design board 8b).
//
// Houdini's display flag, Blender's "view this node": one node at a time is VIEWING. Flagging a
// node part-way up an object's data chain (its box, a bevel under its array) shows the object
// wearing THAT node's result instead of the chain's end; flagging the object end shows its final
// result, which is what the viewport draws anyway. Nothing about it is saved or undone: it is
// how the director is looking, not what the scene is.
//
// Which nodes carry a flag: an object end (a poser), and any node whose result some object wears
// through its data lane (`resolveStackObject`, the walk forward past the data-lane operators the
// stack panel uses). A constraint, an animation channel, the scene's outputs carry none: they have
// no result of their own to look at.
//
// `viewedState` is the whole viewport-side rule, kept pure so a test can evaluate it: the object
// that wears the flagged node reads its `data` straight from that node. The real graph is never
// touched.
//
// REF: src/app/operatorStack.ts (resolveStackObject); src/app/operatorChain.ts (isPoserNode).

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';
import { isPoserNode } from './operatorChain';
import { resolveStackObject } from './operatorStack';

/** Does `id` carry a view flag, and is it the object end (its final result) or a step on the way? */
export function viewFlagOf(state: DagState, id: NodeId): 'final' | 'step' | null {
  const node = state.nodes[id];
  if (!node) return null;
  if (isPoserNode(node)) return 'final';
  return resolveStackObject(state, id) !== null ? 'step' : null;
}

/** The object whose look the flag on `viewing` changes, or null when it changes none. */
export function viewedObjectOf(state: DagState, viewing: NodeId | null): NodeId | null {
  if (!viewing || viewFlagOf(state, viewing) !== 'step') return null;
  return resolveStackObject(state, viewing);
}

/** #1955 — the id of the stand-in that draws a viewed step in the viewport. */
export const VIEWING_SUFFIX = '~viewing';

/** The node a viewport pick on `id` means: a viewed step's stand-in picks its object. */
export function pickTargetOf(id: NodeId): NodeId {
  return id.endsWith(VIEWING_SUFFIX) ? id.slice(0, -VIEWING_SUFFIX.length) : id;
}

/**
 * The graph the viewport draws while `viewing` is flagged. Unchanged (the same object, so a memo
 * keyed on it stays put) for none, an object end, or a node no object wears.
 *
 * #1955 — the flag is a way of LOOKING, never part of the film (Houdini keeps its display flag
 * apart from what renders). The live three.js scene is one scene, drawn by the viewport and
 * captured by every output (the still and everything built on it, the animation export, the live
 * shot preview), and each output already draws with the render's own visibility
 * (`withRenderVisibility`). So the flag is expressed as visibility, Blender's two switches:
 *   - the object keeps its finished data and becomes render-only (`viewport: false`): every
 *     output still shows the finished result, with all its animation;
 *   - a stand-in (`<object>~viewing`, a copy of the object wearing the flagged step) is added
 *     beside it as viewport-only (`render: false`): the viewport shows the step.
 * A pick on the stand-in selects the object (`pickTargetOf`). The stand-in carries no animation
 * of its own: an animated object is looked at in its own pose, not followed through time.
 */
export function viewedState(state: DagState, viewing: NodeId | null): DagState {
  const objectId = viewedObjectOf(state, viewing);
  if (!objectId || !viewing) return state;
  const object = state.nodes[objectId];
  const standInId = `${objectId}${VIEWING_SUFFIX}`;
  const params = (object.params ?? {}) as Record<string, unknown>;
  const nodes: DagState['nodes'] = { ...state.nodes };
  nodes[objectId] = { ...object, params: { ...params, viewport: false } } as typeof object;
  nodes[standInId] = {
    ...object,
    id: standInId,
    params: { ...params, render: false },
    inputs: { ...object.inputs, data: { node: viewing, socket: 'out' } },
  } as typeof object;
  // Wherever the object is listed (the scene's or a group's children), the stand-in is too.
  for (const [id, node] of Object.entries(state.nodes)) {
    let inputs: Record<string, unknown> | null = null;
    for (const [socket, binding] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(binding)) continue;
      const at = binding.findIndex((r: { node?: string }) => r?.node === objectId);
      if (at < 0) continue;
      inputs ??= { ...node.inputs };
      inputs[socket] = [...binding, { ...binding[at], node: standInId }];
    }
    if (inputs) nodes[id] = { ...node, inputs } as typeof node;
  }
  return { ...state, nodes };
}
