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

/**
 * The graph the viewport draws while `viewing` is flagged: unchanged for none, an object end or a
 * node no object wears; else the object that wears it reads its `data` from it directly. Returns
 * the same object when nothing changes, so a memo keyed on it stays put.
 */
export function viewedState(state: DagState, viewing: NodeId | null): DagState {
  const objectId = viewedObjectOf(state, viewing);
  if (!objectId || !viewing) return state;
  const object = state.nodes[objectId];
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [objectId]: {
        ...object,
        inputs: { ...object.inputs, data: { node: viewing, socket: 'out' } },
      },
    },
  };
}
