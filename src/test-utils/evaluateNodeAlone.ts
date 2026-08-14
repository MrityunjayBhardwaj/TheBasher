// evaluateNodeAlone — run ONE node through the REAL evaluator with its inputs injected.
//
// ── WHY THIS EXISTS (ns-2 step 5, #660) ───────────────────────────────────────────────
//
// A node test that calls `NodeDefinition.evaluate` directly is testing the node's WORK,
// which is usually what it wants. It is the wrong road for anything the machinery around
// the node decides — and as of step 5 the operator bypass is exactly that: a bypassed
// operator's `evaluate` is never called at all, so a direct call cannot observe the
// bypass and a test written that way would assert the opposite of what ships.
//
// Three per-operator tests were written that way, back when each operator honoured its
// own mute. They are repointed through here rather than deleted, because "a muted Array
// modifier is byte-identical to no modifier" is a true and load-bearing claim; what
// changed is that it is a claim about the SYSTEM, so it has to be asked of the system.
//
// The inputs are injected with the evaluator's own `overrides` seam, so a caller needs no
// upstream producer nodes and no registered type for the sources — which keeps a node
// test about its node instead of about whatever fixture graph was convenient.
//
// REF: src/core/dag/evaluator.ts (`overrides`, and the single bypass application site);
//      src/core/dag/chainBypass.ts; src/app/operatorBypassHonouring.gate.test.ts.

import { evaluate } from '../core/dag/evaluator';
import { requireNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';

/** A socket's injected value: one value, or a list for a list-cardinality socket. */
export type InjectedInputs = Record<string, unknown>;

/**
 * Evaluate a single node of `type` with `params`, feeding each named socket the given
 * value through the evaluator's injection seam. Returns what the graph would see.
 *
 * An array value is bound as a LIST socket (each element injected as its own producer),
 * matching how `ResolvedInputs` presents a list-cardinality input.
 */
export function evaluateNodeAlone(
  type: string,
  params: Record<string, unknown>,
  inputs: InjectedInputs = {},
): unknown {
  const bindings: Record<string, unknown> = {};
  const overrides = new Map<string, unknown>();
  for (const [socket, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      bindings[socket] = value.map((element, i) => {
        overrides.set(`${socket}_${i}`, element);
        return { node: `${socket}_${i}`, socket: 'out' };
      });
    } else {
      overrides.set(socket, value);
      bindings[socket] = { node: socket, socket: 'out' };
    }
  }
  const state = {
    nodes: {
      __subject: {
        id: '__subject',
        type,
        version: requireNodeType(type).version,
        params,
        inputs: bindings,
      },
    },
  } as unknown as DagState;
  return evaluate(state, '__subject', { overrides }).value;
}
