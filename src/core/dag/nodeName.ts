// nodeName — what a node calls ITSELF, and nothing else (#1122).
//
// Two questions share this answer. `nodeDisplayName` (app) asks "what does a surface show",
// and adds rungs that need other nodes (an imported child's name, then the id). `applyOp`
// (core) asks "what name does a follower copy", and must not reach into the app to find out.
// Keeping the node's own rungs here means both ask the SAME function, so a follower can
// never copy a name that no surface shows for its source.

import type { Node } from './types';

/**
 * The name a node carries itself, in `nodeDisplayName`'s order: a director's `meta.name`,
 * then the semantic `params.name` (Shot / AnimationClip / Character). Undefined when it
 * carries neither. Blank is returned as blank — the caller decides what blank means.
 */
export function ownName(node: Node): string | undefined {
  const params = node.params as Record<string, unknown> | undefined;
  const paramName = typeof params?.name === 'string' ? params.name : undefined;
  return node.meta?.name ?? paramName;
}

/** The name a follower copies from `source`, or undefined when there is nothing to copy. A
 *  blank name is not followed: it is the unnamed state, and copying it would erase a label. */
export function followableName(source: Node | undefined): string | undefined {
  const name = source ? ownName(source) : undefined;
  return name !== undefined && name.trim() !== '' ? name : undefined;
}
