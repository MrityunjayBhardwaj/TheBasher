// #1448 — which nodes can be hidden, asked in ONE place.
//
// #1503 moved visibility off `meta.hidden` into the `viewport` and `render` params, which only
// the types in `VISIBILITY_TYPES` carry (`collections.ts`). The eye and every drawer honour
// them through `hiddenNodes`, on a collection and on every scene object (`collectableNodes`):
// the scene's children at any depth, its lights, the rig band's lights and the cameras. A flag
// set anywhere else would change nothing in the picture.
//
// The outliner's eye and the agent's hide verb (#1445) both ask this, so neither can offer
// to hide what the other refuses, and neither can report a hide the picture does not show.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';
import { collectableNodes, VISIBILITY_TYPES } from './collections';

/**
 * Why `nodeId` cannot be hidden, or null when hiding it removes it from the picture.
 * `collectable` is `collectableNodes(state)`, passed in by a caller that asks for many rows.
 */
export function hideRefusal(
  state: DagState,
  nodeId: string,
  collectable: ReadonlySet<NodeId> = collectableNodes(state),
): string | null {
  const node = state.nodes[nodeId];
  if (!node) return `"${nodeId}" is not in the scene graph.`;
  if (!VISIBILITY_TYPES.has(node.type))
    return (
      `"${nodeId}" (${node.type}) carries no visibility of its own; only objects, groups and ` +
      'collections can be hidden. Hide the object that holds it.'
    );
  if (node.type !== 'Collection' && !collectable.has(nodeId))
    return `"${nodeId}" (${node.type}) is not in the scene, so hiding it would change nothing.`;
  return null;
}

export function isHideable(state: DagState, nodeId: string): boolean {
  return hideRefusal(state, nodeId) === null;
}
