// Five-gate Mutator validator.
//
// The structural correctness train sits here: every Mutator-mediated
// plan goes through these gates BEFORE the diff store sees ops, so
// failures land as structured tool results the LLM can react to —
// not as fork-time exceptions surfaced to the user.
//
//   Gate 1: every nodeId referenced by ops exists in the DAG, OR is a
//           fresh addNode introducing a new id (or a setParam/connect
//           against an id introduced earlier in the same plan).
//   Gate 2: every setParam value parses against the target node's
//           paramSchema (sub-paths supported by following dotted path
//           and replacing the leaf).
//   Gate 3: closure preservation (Wave A reuse). Every op targets a
//           node inside the Mutator's declared closure — vyapti V13.
//   Gate 4: Mutator preconditions — shape-only checks against the
//           expanded closure (P-5: not semantic state).
//   Gate 5: adapter-fidelity stub. Always passes today; lights up at
//           P7 (PlayCanvas export).
//
// REF: P2.5.2 PLAN §5 Wave C step 3; vyapti V13/V14.

import type { DagState } from '../../core/dag/state';
import type { Node, NodeId, Op } from '../../core/dag/types';
import { expandClosure, isFreshAddNode, opTargetNodeId } from '../closure/expand';
import { getNodeType } from '../../core/dag/registry';
import type {
  MutatorDefinition,
  MutatorPlan,
  MutatorRejection,
  MutatorValidationResult,
} from './types';

/**
 * Run all five gates against `mutator(spec)` evaluated on `state`.
 * Returns a structured plan or rejection — never throws on a gate
 * failure (gate 5 may catch unexpected build() exceptions).
 */
export function validatePlan<S>(
  mutator: MutatorDefinition<S>,
  spec: S,
  state: DagState,
  intent: string,
): MutatorValidationResult {
  // Spec shape is validated at the tool boundary via mutator.spec.parse.
  // Mutator builders here can assume `spec` is well-typed.

  // Expand the closure FIRST — preconditions + closure gate both consume it.
  const closureSpec = mutator.buildClosureSpec(spec);
  const closure = expandClosure(closureSpec, state);

  // Gate 4: preconditions. Run before build to fail fast on obvious
  // shape problems ("walkTo with no Navmesh") without burning a build.
  const pc = mutator.preconditions(spec, closure, state);
  if (!pc.ok) {
    return rejection(mutator.name, 4, pc.reason);
  }

  // Build the ops. Wrap in try/catch so a build() exception lands as a
  // gate-5 failure rather than crashing the orchestrator (F8-aligned).
  let ops: Op[];
  try {
    ops = mutator.build(spec, closure, state);
  } catch (err) {
    return rejection(
      mutator.name,
      5,
      `Mutator build failed: ${(err as Error).message}`,
    );
  }

  // Gate 1: node existence + fresh-introduction tracking.
  const introducedIds = new Set<NodeId>();
  for (const op of ops) {
    if (op.type === 'addNode' && isFreshAddNode(op, state)) {
      introducedIds.add(op.nodeId);
      continue;
    }
    const target = opTargetNodeId(op);
    if (target === null) continue;
    const exists = Object.prototype.hasOwnProperty.call(state.nodes, target);
    if (!exists && !introducedIds.has(target)) {
      return rejection(
        mutator.name,
        1,
        `Op references node "${target}" that does not exist and is not introduced earlier in this plan.`,
      );
    }
  }

  // Gate 2: setParam values match the target's paramSchema. Construct
  // a candidate params object by deep-setting the dotted path and
  // re-parsing through the node-type's schema.
  for (const op of ops) {
    if (op.type !== 'setParam') continue;
    if (introducedIds.has(op.nodeId)) {
      // Setting a param on a freshly-added node — the addNode params
      // were already validated by applyOp at fork time. Skip schema
      // round-trip here.
      continue;
    }
    const node = state.nodes[op.nodeId];
    if (!node) {
      return rejection(
        mutator.name,
        2,
        `setParam target "${op.nodeId}" not in DAG (gate 1 should have caught this).`,
      );
    }
    const def = getNodeType(node.type);
    if (!def) continue; // Unknown type — applyOp will reject; gate 2 has nothing to assert.
    const candidate = setDotted(node.params, op.paramPath, op.value);
    const parse = def.paramSchema.safeParse(candidate);
    if (!parse.success) {
      return rejection(
        mutator.name,
        2,
        `setParam "${op.paramPath}" on ${op.nodeId} (${node.type}) failed schema validation: ${parse.error.message}`,
      );
    }
  }

  // Gate 3: closure preservation. Every op target must lie inside the
  // Mutator-declared closure, OR be a fresh addNode, OR refer to an id
  // introduced earlier in this plan.
  for (const op of ops) {
    if (op.type === 'addNode' && introducedIds.has(op.nodeId)) continue;
    const target = opTargetNodeId(op);
    if (target === null) continue;
    if (closure.nodes.has(target)) continue;
    if (introducedIds.has(target)) continue;
    return rejection(
      mutator.name,
      3,
      `Op targets node "${target}" outside the declared closure ` +
        `(roots: [${closureSpec.rootSelectors.join(', ')}]; ${closure.nodes.size} reachable).`,
    );
  }

  // Gate 5: adapter fidelity. Stub today. Lights up at P7 — Mutators
  // that produce IR PlayCanvas can't emit get rejected here.
  // No-op pass.

  // Required-types check: if the contract demanded specific node types,
  // the closure must contain at least one of each. Done last so error
  // messages naming "missing Navmesh" land instead of generic gate-3
  // closure errors when the type itself is the problem.
  for (const requiredType of mutator.contract.requiredNodeTypes) {
    const found = [...closure.nodes].some(
      (id) => state.nodes[id] && state.nodes[id].type === requiredType,
    );
    if (!found) {
      return rejection(
        mutator.name,
        4,
        `Mutator requires a node of type "${requiredType}" inside the closure; none found.`,
      );
    }
  }

  const warnings: string[] = [];
  if (mutator.contract.lossy) {
    for (const lossy of mutator.contract.lossy) {
      warnings.push(`${lossy.kind}: ${lossy.reason}`);
    }
  }

  const plan: MutatorPlan = {
    ok: true,
    mutator: mutator.name,
    ops,
    closure,
    intent,
    warnings,
  };
  return plan;
}

function rejection(
  mutator: string,
  gate: 1 | 2 | 3 | 4 | 5,
  reason: string,
): MutatorRejection {
  return { ok: false, mutator, gate, reason };
}

/**
 * Deep-clone `obj` and set `path` (dotted) to `value`. Returns the new
 * object. Used by gate 2 to construct the post-setParam candidate
 * params for schema validation.
 */
function setDotted(obj: unknown, path: string, value: unknown): unknown {
  const keys = path.split('.');
  // Cheap deep clone for plain JSON. params shapes are JSON-serializable
  // — that's a documented v0.5 invariant via the Op store.
  const clone = obj === undefined ? {} : (JSON.parse(JSON.stringify(obj)) as unknown);
  let cursor = clone as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cursor[k];
    if (next === undefined || next === null || typeof next !== 'object') {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
  return clone;
}

/** Re-export for callers iterating closure node membership. */
export type { Node };
