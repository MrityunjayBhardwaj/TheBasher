// chainBypass — THE ONE PLACE THE OPERATOR BYPASS IS READ (ns-2 step 5, #660).
//
// ── WHAT THIS REPLACES ────────────────────────────────────────────────────────────────
//
// The stack mute ([[V58]]) was honoured in seven independent places: five per-operator
// `evaluate` guards, one unchecked cast in the stack walker, and one typed read in the
// material-ownership walker. Seven copies of one rule is seven chances to disagree, and
// they already did — the five guards tested the param for TRUTHINESS while the two
// walkers tested it for `=== true`, so a param holding anything truthy-but-not-true would
// have bypassed at evaluate and not bypassed in the panel. Nothing made that
// discoverable, because zod parses the field to a real boolean and the disagreement has
// no reachable input today. It is the class of defect this phase exists to end: a rule
// spelled per member, where the copies drift silently and the drift is only reachable
// after some unrelated change makes it reachable.
//
// ── `3 → 1`, NEVER `3 → 0` ────────────────────────────────────────────────────────────
//
// This module still reads `node.params`, which is `unknown` — so a cast survives, and
// claiming the casts went to zero would be false. What changed is that the read is
// CHECKED rather than guessed, in three specific ways, all of them enforced at
// registration rather than believed:
//
//   1. the field NAME comes from `chain.bypass.param`, not from a literal, so an operator
//      spelling its mute differently is read correctly instead of silently never bypassing;
//   2. `registerNodeType` refuses a declaration whose named param the schema does not
//      declare, and refuses one whose named param is not a BOOLEAN — which is what makes
//      the strict `=== true` below safe rather than a second guess;
//   3. `registerNodeType` refuses a chain whose spine does not name a declared input of
//      single cardinality — which is what makes "hand back the value on the spine" a
//      well-defined operation rather than one that would hand back an array.
//
// Without (2) and (3) the read would still be a guess wearing a declaration's clothes.
// They are the difference between one checked read and one surviving cast.
//
// ── WHY THE APPLICATION SITE IS UPSTREAM OF `evaluate`, NOT INSIDE IT ─────────────────
//
// Being bypassable is true of the operator CATEGORY, not of any member, so it belongs to
// the machinery that runs operators rather than to each operator's body. After this step
// an operator's `evaluate` is its WORK and nothing else: it does not know it can be
// muted, and flipping the bypass param changes nothing about what it computes. The
// evaluator decides whether to call it at all.
//
// That is a real behavioural boundary and it has one consequence worth naming: anything
// calling a `NodeDefinition.evaluate` DIRECTLY gets the operator's work, bypass ignored.
// Two such callers exist and both are the channel lane, whose node types declare no chain
// at all, so neither can reach an operator — pinned by name in
// `src/app/operatorBypassHonouring.gate.test.ts` so a third one cannot appear quietly.
//
// REF: src/core/dag/types.ts (`ChainDeclaration`, `BypassKind` — the declaration);
//      src/core/dag/registry.ts (`assertChainDeclaration` — the three refusals);
//      src/core/dag/evaluator.ts (the single application);
//      src/nodes/channelModifiers.ts:39-52 (the working counter-example, one lane over);
//      src/app/operatorBypassHonouring.gate.test.ts (the detector); vyapti V58; issue #660.

import type { NodeDefinition, SocketId } from './types';

/** Just the part of a definition this module reads — so a caller need not hold the rest. */
type ChainCarrier = Pick<NodeDefinition, 'chain'>;

/**
 * The spine socket whose value should be handed back INSTEAD of running `evaluate`, or
 * `null` when this node is not bypassed (including when it is not an operator at all).
 *
 * Returning the socket rather than a boolean is deliberate: the caller then has no way to
 * decide that a bypass means something other than "the value that arrived on the spine",
 * and no non-null assertion is needed to find out which socket that was.
 */
export function bypassSpineOf(def: ChainCarrier, params: unknown): SocketId | null {
  const chain = def.chain;
  if (chain === undefined) return null; // not an operator
  const bypass = chain.bypass;
  if (bypass.kind === 'none') return null; // a DECLARED "nothing to bypass"
  if (params === null || typeof params !== 'object') return null;
  // Strict, not truthy. The two walkers already read it this way; the five guards did
  // not, and the schema is refused at registration unless it declares a boolean here, so
  // strict is the reading that cannot be surprised.
  return (params as Record<string, unknown>)[bypass.param] === true ? chain.input : null;
}

/** Whether this node is currently bypassed. The boolean face of {@link bypassSpineOf}. */
export function isBypassed(def: ChainCarrier, params: unknown): boolean {
  return bypassSpineOf(def, params) !== null;
}

/**
 * The param an operator's bypass is stored under, or `null` when it declares none.
 *
 * For the AUTHORING side — a toggle has to write the field back, and the param path it
 * writes must come from the same declaration the read comes from, or the two drift.
 */
export function bypassParamOf(def: ChainCarrier): string | null {
  const bypass = def.chain?.bypass;
  return bypass !== undefined && bypass.kind === 'passthrough' ? bypass.param : null;
}
