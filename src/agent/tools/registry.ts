// Tool registry — registerTool, getTool, listTools.
//
// Thread-safe (stateless map). Tools are registered at boot time alongside
// node types. The LLM session reads `listTools()` to build its tool schemas.
//
// REF: vyapti V7, THESIS.md §20.

import type { ToolDefinition } from './types';

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool already registered: ${def.name}`);
  }
  registry.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

/** Test hook — resets the registry between test suites. */
export function __resetToolRegistryForTests(): void {
  registry.clear();
}
