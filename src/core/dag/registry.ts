// Node-type registry. Agent-introspectable: every registered type's schema
// is reachable as JSON for tool-surface generation (P2.5).
//
// REF: THESIS.md §6 ("Eighty percent of Basher is node definitions"), §20
// (tool surface).

import type { NodeDefinition, NodeTypeId } from './types';

const registry = new Map<NodeTypeId, NodeDefinition>();

export function registerNodeType<P, O>(def: NodeDefinition<P, O>): void {
  if (registry.has(def.type)) {
    throw new Error(`Node type already registered: ${def.type}`);
  }
  registry.set(def.type, def as unknown as NodeDefinition);
}

export function getNodeType(type: NodeTypeId): NodeDefinition | undefined {
  return registry.get(type);
}

export function requireNodeType(type: NodeTypeId): NodeDefinition {
  const def = registry.get(type);
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return def;
}

export function listNodeTypes(): NodeTypeId[] {
  return [...registry.keys()].sort();
}

export function snapshotRegistry(): Record<NodeTypeId, NodeDefinition> {
  return Object.fromEntries(registry);
}

/** Test-only: clear and re-seed the registry. Never call from app code. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
