// newComposition — create a Composition node and make it the active comp
// (Compositor spine 1c). Mirrors importMediaClip's discipline: a pure op-builder
// (`buildNewCompositionOps`) plus a thin action (`createNewComposition`) that
// dispatches ONE atomic op through the DAG store (V1) and updates the active-comp
// UI projection.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.1; vyapti V1 (one op path) + V34 (data in the
//      DAG) + V8 (active-comp is a UI projection); sibling: importMediaClip.

import type { NodeId, Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { useCompositionStore } from '../stores/compositionStore';

/** Build the op adding a Composition node. Pure — the caller supplies the fresh
 *  `nodeId` and resolved `name` so the op is deterministic + unit-testable. The
 *  Composition schema defaults size/fps/duration/background, so only `name` is
 *  set here; the inspector edits the rest. */
export function buildNewCompositionOps(nodeId: NodeId, name: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId,
      nodeType: 'Composition',
      params: { name },
    },
  ];
}

/** A unique "Composition N" name given the names already in use. */
export function uniqueCompositionName(usedNames: Iterable<string>): string {
  const used = new Set(usedNames);
  let n = 1;
  while (used.has(`Composition ${n}`)) n++;
  return `Composition ${n}`;
}

function nextFreshId(base: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Create a new Composition node, dispatch it, and select it as the active comp.
 *  Returns the new node id. */
export function createNewComposition(): NodeId {
  const dag = useDagStore.getState();
  const nodes = Object.values(dag.state.nodes);
  const usedNames = nodes
    .filter((node) => node.type === 'Composition')
    .map((node) => String((node.params as { name?: unknown }).name ?? ''));
  const name = uniqueCompositionName(usedNames);
  const nodeId = nextFreshId('comp', new Set(Object.keys(dag.state.nodes)));

  dag.dispatchAtomic(buildNewCompositionOps(nodeId, name), 'user', `new composition: ${name}`);
  useCompositionStore.getState().setActiveComposition(nodeId);
  return nodeId;
}
