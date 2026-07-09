// controllersDock — the pure aggregator behind the scene-wide Controllers dock
// (#294, Epic 1 Inc 3, decision D-3). Scans every node's spare bag for params marked
// `promoted === true` and flattens them into an ordered, editable row list. The dock
// pane is a pure V34 view over this: it renders each row and edits the value back
// through the existing `setSpareParam` op — there is NO second store of promoted refs.
//
// A "Controller" is therefore not a privileged node type (F2): it is any node that
// exposes ≥1 promoted spare param. The aggregator is intentionally params/spare-only
// (no state, no evaluator) so it is trivially unit-testable and cheap to recompute.
//
// REF: src/core/dag/types.ts (SpareParam.promoted); src/app/SpareParamControls.tsx
//      (the inspector authoring twin); decision D-3; issue #294.

import type { SpareParam } from '../core/dag/types';

export interface PromotedControl {
  /** The node that owns the promoted spare param. */
  nodeId: string;
  /** Display name for the node (meta.name ?? id). */
  nodeName: string;
  /** The spare-param key. */
  key: string;
  /** The spare param itself ({ type, value, promoted }). */
  param: SpareParam;
}

interface NodeLike {
  readonly id: string;
  readonly meta?: { name?: string } | undefined;
  readonly spare?: Readonly<Record<string, SpareParam>> | undefined;
}

/**
 * Every promoted spare param across all nodes, flattened into dock rows. Ordered by
 * node display name then spare key so the cockpit is stable across unrelated edits
 * (no jitter when an unrelated node is added). A node with no promoted spare
 * contributes nothing.
 */
export function collectPromotedControls(
  nodes: Readonly<Record<string, NodeLike>>,
): PromotedControl[] {
  const out: PromotedControl[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.spare) continue;
    const nodeName = node.meta?.name?.trim() || node.id;
    for (const [key, param] of Object.entries(node.spare)) {
      if (param?.promoted !== true) continue;
      out.push({ nodeId: node.id, nodeName, key, param });
    }
  }
  out.sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.key.localeCompare(b.key));
  return out;
}
