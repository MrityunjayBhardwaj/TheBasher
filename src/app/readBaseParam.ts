// readBaseParam — the base (pre-overlay) value of a target param, resolving the
// fixed-schema params AND the spare-param collection with a defined precedence
// (#293, Inc 2 — the Open Q flagged in Inc 0 self-review).
//
// PRECEDENCE (settled): a REAL fixed-schema param wins over a spare param of the
// same name. The fixed `paramSchema` is authoritative (a typo'd real key is still
// stripped — V89); the spare bag is the escape hatch and CANNOT shadow a real
// param. This mirrors Houdini (you cannot add a spare parm with an existing parm's
// name) and V78 ("the types converge, the rule does not loosen"). The Inc-3
// setSpareParam UI enforces the disjointness at authoring time (rejects a colliding
// name); this resolver is the read-side backstop.
//
// This is the base the overlay fold (channels / drivers) composes onto — for a
// Replace overlay the base is irrelevant, but a Combine overlay (or an
// un-overlaid read) needs it, and a spare-param target must resolve to its spare
// value, not `undefined`.
//
// REF: src/nodes/overlayChannels.ts (readAt, the dotted-path reader); vyapti V89
//      (spare params); src/app/resolveEvaluatedParam.ts; issue #293.

import { readAt } from '../nodes/overlayChannels';
import type { Node } from '../core/dag/types';

/** The base value of `paramPath` on `node`: fixed params first (dotted path via
 *  `readAt`), then the spare-param bag by flat name. `undefined` when neither has
 *  it (the caller then falls through to its own default / null contract). */
export function readBaseParam(node: Node | undefined, paramPath: string): unknown {
  if (!node) return undefined;
  const fromParams = readAt((node.params ?? {}) as Record<string, unknown>, paramPath);
  if (fromParams !== undefined) return fromParams;
  return node.spare?.[paramPath]?.value;
}
