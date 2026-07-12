// ConstraintStackControls — the CONSTRAINT stack (relational CHOP) binding of the
// shared stack panel (#312). This is the "why is there no Constraints tab?" answer:
// there is one now, and Track-To / Follow-Path / Copy-Location are MEMBERS of it
// rather than each getting a bespoke dropdown of its own.
//
// Same rows as the Modifiers panel (OperatorStackRows) — the presentation is the real
// overlap. What differs, and stays here:
//   - enumeration : constraintStackEntries — an edge-LESS set sharing a `target`,
//                   ordered by an `order` field (NOT a wired sub-chain).
//   - op-builders : constraintStack.ts — add/move/remove are `target`/`order` writes.
// Clicking a row selects that constraint so its params (aim target, up, aim point)
// edit in the same section's ParamRows below — exactly the modifier-stack idiom.
//
// REF: src/app/OperatorStackRows.tsx (the shared rows); src/app/constraintStack.ts
//      (the builders); src/app/nodeConstraints.ts (the fold these rows describe);
//      docs/RELATIONAL-OPERATORS-DESIGN.md §8.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { OperatorStackRows } from './OperatorStackRows';
import {
  ADDABLE_CONSTRAINTS,
  buildAddConstraintOps,
  buildMoveConstraintOps,
  buildRemoveConstraintOps,
  buildToggleConstraintMuteOp,
  constraintStackEntries,
} from './constraintStack';
import { isRelationalPoseNode } from './nodeConstraints';

/** The object a constraint row belongs to. Select the constrained OBJECT and you see
 *  its stack; select a CONSTRAINT in that stack and you still see the same stack (its
 *  own `target`) — the modifier panel's resolveStackBase behaviour, but for an
 *  edge-less operator the "base" is simply the node named by `target`. */
function resolveConstraintTarget(
  state: ReturnType<typeof useDagStore.getState>['state'],
  nodeId: string,
): string {
  const node = state.nodes[nodeId];
  if (node && isRelationalPoseNode(node)) {
    const t = (node.params as { target?: unknown }).target;
    if (typeof t === 'string' && t && state.nodes[t]) return t;
  }
  return nodeId;
}

export function ConstraintStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  const target = resolveConstraintTarget(state, nodeId);
  const entries = constraintStackEntries(state, target);

  function onAdd(type: string) {
    const res = buildAddConstraintOps(useDagStore.getState().state, target, type);
    if (res) useDagStore.getState().dispatchAtomic(res.ops, 'user', 'add constraint');
  }
  function onMute(id: string) {
    const op = buildToggleConstraintMuteOp(useDagStore.getState().state, id);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle constraint mute');
  }
  function onMove(id: string, dir: 'up' | 'down') {
    const ops = buildMoveConstraintOps(useDagStore.getState().state, id, dir);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder constraint');
  }
  function onRemove(id: string) {
    const ops = buildRemoveConstraintOps(useDagStore.getState().state, id);
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'remove constraint');
      if (selectedNodeId === id) select(target); // don't strand the selection on a deleted node
    }
  }

  return (
    <OperatorStackRows
      testIdPrefix="constraint"
      entries={entries}
      addable={ADDABLE_CONSTRAINTS}
      selectedNodeId={selectedNodeId}
      emptyLabel="No constraints."
      onSelect={select}
      onMute={onMute}
      onMove={onMove}
      onRemove={onRemove}
      onAdd={onAdd}
    />
  );
}
