// Mutator catalog — registerMutator, getMutator, listMutators.
//
// Mutators are registered at boot time alongside node types. Calling
// the same name twice throws (V14 non-redundancy is a code-review
// invariant, but accidental duplicate registration is mechanical).
//
// REF: P2.5.2 PLAN §5 Wave C; vyapti V14.

import type { MutatorDefinition } from './types';

const registry = new Map<string, MutatorDefinition>();

export function registerMutator<S>(def: MutatorDefinition<S>): void {
  if (registry.has(def.name)) {
    throw new Error(`Mutator already registered: ${def.name}`);
  }
  registry.set(def.name, def as unknown as MutatorDefinition);
}

export function getMutator(name: string): MutatorDefinition | undefined {
  return registry.get(name);
}

export function listMutators(): MutatorDefinition[] {
  return Array.from(registry.values());
}

/**
 * Full metadata for ONE mutator — the LLM-facing `agent.getMutator` view.
 * Drops handlers + zod internals — keeps name, description, contract, and a
 * canonical specExample the LLM copies before calling agent.proposePlan.
 * Without specExample the LLM has to guess field names from `description` and
 * burns rounds on gate-2 rejections (#23).
 */
export interface MutatorMetadata {
  name: string;
  description: string;
  contract: MutatorDefinition['contract'];
  /** Valid sample spec for agent.proposePlan. Every field name + type the LLM needs. */
  specExample: unknown;
}

/**
 * PICKER view: name + the first sentence of the description + the specExample.
 * Everything the model needs to choose a mutator AND construct a proposePlan
 * call — in ONE tool result, so the happy path stays two rounds (list → propose).
 *
 * Why this shape (#332). The old full list of all 26 mutators (name +
 * description + contract + specExample) was ~26 KB in a single tool result —
 * ~22% of the turn budget for one call, and the payload that tipped "point the
 * camera at the cube" over the cost guard. Measured breakdown: descriptions
 * ~9.5 KB, contract ~5.0 KB, specExample ~2.2 KB. So the two cuts are:
 *   - description → its FIRST SENTENCE (the "what it does" line, e.g. "Rotate
 *     one or more nodes by a delta in degrees…") — enough to pick a mutator.
 *   - contract → DROPPED from the model view. It is validation metadata the
 *     five gates consume; the model never passes it to proposePlan. It survives
 *     in `getMutatorMetadata` for when a gate rejects and the model wants to
 *     understand why.
 * specExample STAYS inline (it's small and it's exactly what the model copies —
 * #23). Deferring it to a second `getMutator` round was measured to cost MORE
 * than it saves: each extra round re-sends ~22 KB of fixed schema+prompt
 * overhead, dwarfing the ~2 KB of examples. So the list carries it and the
 * common path never needs a discovery round. Result: ~26 KB → ~7 KB, same
 * round count as before.
 */
export interface MutatorSummary {
  name: string;
  summary: string;
  /** Valid sample spec the model copies into agent.proposePlan (#23). */
  specExample: unknown;
}

/**
 * First sentence of `text` — everything up to the first period that is followed
 * by whitespace and a capital letter / digit (so "material.color", "e.g." and
 * "[x,y,z]." do not split it early). Falls back to the whole string when there
 * is no such boundary (a one-sentence description). DERIVED from the
 * description, never authored alongside it, so a summary can never drift from
 * the text it summarizes (the V101 projection rule, applied to prose).
 */
export function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.](?=\s+[A-Z0-9])/);
  return (m ? m[0] : text).trim();
}

export function listMutatorSummaries(): MutatorSummary[] {
  return listMutators().map((m) => ({
    name: m.name,
    summary: firstSentence(m.description),
    specExample: m.specExample,
  }));
}

export function getMutatorMetadata(name: string): MutatorMetadata | undefined {
  const m = getMutator(name);
  if (!m) return undefined;
  return {
    name: m.name,
    description: m.description,
    contract: m.contract,
    specExample: m.specExample,
  };
}

/** Test hook — resets the registry between suites. */
export function __resetMutatorRegistryForTests(): void {
  registry.clear();
}
