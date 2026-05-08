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
 * Compact metadata view for the LLM-facing `agent.listMutators` tool.
 * Drops handlers + zod internals — keeps name, description, contract,
 * and a canonical specExample the LLM copies before calling
 * agent.proposePlan. Without specExample the LLM has to guess field
 * names from `description` and burns rounds on gate-2 rejections (#23).
 */
export interface MutatorMetadata {
  name: string;
  description: string;
  contract: MutatorDefinition['contract'];
  /** Valid sample spec for agent.proposePlan. Every field name + type the LLM needs. */
  specExample: unknown;
}

export function listMutatorMetadata(): MutatorMetadata[] {
  return listMutators().map((m) => ({
    name: m.name,
    description: m.description,
    contract: m.contract,
    specExample: m.specExample,
  }));
}

/** Test hook — resets the registry between suites. */
export function __resetMutatorRegistryForTests(): void {
  registry.clear();
}
