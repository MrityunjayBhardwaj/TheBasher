// Five-gate Mutator validator.
//
// The structural correctness train sits here: every Mutator-mediated
// plan goes through these gates BEFORE the diff store sees ops, so
// failures land as structured tool results the LLM can react to —
// not as fork-time exceptions surfaced to the user.
//
// Each rejection carries TWO discriminators: a numeric `gate` (1-5,
// stable for backward compat) and a string `label` (stable across
// releases, unique per check — see types.ts).
//
// Runtime order (intentional — not 1→5):
//   1. contract_edges    (gate 1): contract.requiredEdges ⊆ buildClosureSpec output
//   2. expand closure
//   3. precondition      (gate 4): Mutator.preconditions() shape-only check
//   4. contract_scope    (gate 4): closure contains every required node type
//   5. build ops         (build exceptions → gate 5 'build_exception')
//   6. node_existence    (gate 1): per-op
//   7. param_schema      (gate 2): per-op setParam round-trip
//   8. closure_preservation (gate 3): per-op
//   9. adapter_fidelity  (gate 5): P7 stub, always passes
//
// Why not strict 1→5? Cheap structural checks (contract_edges) and
// shape preconditions run BEFORE build to fail fast. Per-op gates 1/2/3
// can only run on the produced ops, so they come after build.
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
  RejectionLabel,
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

  const closureSpec = mutator.buildClosureSpec(spec);

  // Gate 1 — contract_edges: the closure spec the Mutator declares must
  // cover every edge kind the contract advertised. Without this, a
  // contract that says "I walk parent" can be silently violated by a
  // buildClosureSpec that omits 'parent' — the closure scope is wrong
  // before any op is built.
  const speccedKinds = new Set(closureSpec.followedEdges);
  for (const required of mutator.contract.requiredEdges ?? []) {
    if (!speccedKinds.has(required)) {
      return rejection(
        mutator.name,
        1,
        'contract_edges',
        `Mutator contract requires edge kind "${required}" but buildClosureSpec ` +
          `did not include it (declared: [${[...speccedKinds].join(', ') || '<none>'}]).`,
      );
    }
  }

  const closure = expandClosure(closureSpec, state);

  // Gate 4 — precondition: shape-only check. Runs before build to fail
  // fast on obvious shape problems ("walkTo with no Navmesh") without
  // burning a build.
  const pc = mutator.preconditions(spec, closure, state);
  if (!pc.ok) {
    return rejection(mutator.name, 4, 'precondition', pc.reason);
  }

  // Gate 4 — contract_scope: if the contract demanded specific node types,
  // the closure must contain at least one of each. Runs before build so
  // error messages naming "missing Navmesh" land instead of generic
  // closure_preservation errors when the type itself is the problem.
  for (const requiredType of mutator.contract.requiredNodeTypes) {
    const found = [...closure.nodes].some(
      (id) => state.nodes[id] && state.nodes[id].type === requiredType,
    );
    if (!found) {
      return rejection(
        mutator.name,
        4,
        'contract_scope',
        `Mutator requires a node of type "${requiredType}" inside the closure; none found.`,
      );
    }
  }

  // Gate 5 — build_exception path: build() throws → structured rejection
  // rather than orchestrator crash (F8-aligned).
  let ops: Op[];
  try {
    ops = mutator.build(spec, closure, state);
  } catch (err) {
    return rejection(
      mutator.name,
      5,
      'build_exception',
      `Mutator build failed: ${(err as Error).message}`,
    );
  }

  // Gate 1 — node_existence: every op target either exists or was
  // introduced earlier in this plan via fresh addNode.
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
        'node_existence',
        `Op references node "${target}" that does not exist and is not introduced earlier in this plan.`,
      );
    }
  }

  // Gate 2 — param_schema: every setParam value parses against the
  // target's paramSchema after dotted-path application.
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
        'param_schema',
        `setParam target "${op.nodeId}" not in DAG (node_existence should have caught this).`,
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
        'param_schema',
        `setParam "${op.paramPath}" on ${op.nodeId} (${node.type}) failed schema validation: ${parse.error.message}`,
      );
    }
  }

  // Gate 3 — closure_preservation: every op target must lie inside the
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
      'closure_preservation',
      `Op targets node "${target}" outside the declared closure ` +
        `(roots: [${closureSpec.rootSelectors.join(', ')}]; ${closure.nodes.size} reachable).`,
    );
  }

  // Gate 5 — adapter_fidelity: stub today. Lights up at P7 (PlayCanvas
  // export) — Mutators that produce IR the adapter can't emit get
  // rejected here. No-op pass.

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
  label: RejectionLabel,
  reason: string,
): MutatorRejection {
  return { ok: false, mutator, gate, label, reason };
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
