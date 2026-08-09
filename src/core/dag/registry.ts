// Node-type registry. Agent-introspectable: every registered type's schema
// is reachable as JSON for tool-surface generation (P2.5).
//
// REF: THESIS.md §6 ("Eighty percent of Basher is node definitions"), §20
// (tool surface).

import type { NodeDefinition, NodeTypeId } from './types';

const registry = new Map<NodeTypeId, NodeDefinition>();

/**
 * Reject a degenerate accepted-type SET at the moment of registration (#614).
 *
 * `AcceptedTypeSet` already makes an empty or one-element set a compile error, so this
 * looks redundant and is not: EVERY synthetic definition in the suite reaches
 * `registerNodeType` through an `as never` cast, which erases the tuple constraint
 * entirely. The type covers the ~80 hand-written production declarations; this covers
 * everything the tests mint, which is where a malformed set is actually likely to appear.
 *
 * Distinctness is checked HERE and nowhere else, because it cannot be said in a type at
 * all. A duplicate is harmless to `inputAccepts` and shows up only in a rejection message
 * reading `Number|Number`, which is precisely the kind of defect that survives forever.
 *
 * Throwing at registration rather than gating in a test is deliberate: registration runs
 * once per type at boot, the author is present, and a node that cannot describe what it
 * accepts should not enter the registry at all.
 */
function assertInputDescriptors(def: NodeDefinition): void {
  for (const [socket, desc] of Object.entries(def.inputs)) {
    if (!Array.isArray(desc.type)) continue;
    const set = desc.type as readonly string[];
    if (set.length < 2) {
      throw new Error(
        `registerNodeType(${def.type}): input '${socket}' declares a set of ${set.length} ` +
          `type(s). A set needs at least two members — write \`type: '<T>'\` for a single type.`,
      );
    }
    const dupes = set.filter((t, i) => set.indexOf(t) !== i);
    if (dupes.length > 0) {
      throw new Error(
        `registerNodeType(${def.type}): input '${socket}' repeats ${[...new Set(dupes)].join(', ')} ` +
          `in its accepted-type set (${set.join('|')}).`,
      );
    }
  }
}

export function registerNodeType<P, O>(def: NodeDefinition<P, O>): void {
  if (registry.has(def.type)) {
    throw new Error(`Node type already registered: ${def.type}`);
  }
  assertInputDescriptors(def as unknown as NodeDefinition);
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
