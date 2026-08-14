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

/**
 * Refuse a partial or unbacked chain declaration at the moment of registration (ns-2).
 *
 * ── WHY AT RUNTIME, WHEN THE FIELDS ARE ALREADY REQUIRED BY THE TYPE ──────────────────
 *
 * Measured, and it has bitten twice in two consecutive steps of one earlier wave: a
 * required parameter closes the omission only in PRODUCTION. `npm run typecheck` excludes
 * `*.test.ts`, vitest strips types without checking them, and every synthetic definition
 * in the suite reaches this function through an `as never` that erases the interface
 * entirely. So the ~80 hand-written declarations are covered by the type and everything
 * the tests mint — which is where a malformed declaration is actually likely to appear —
 * is covered by nothing at all unless it is refused here.
 *
 * ── THE SECOND REFUSAL IS THE ONE THAT MAKES `bypass.param` MEAN ANYTHING ─────────────
 *
 * A `passthrough` naming a param no schema declares is precisely the failure this phase
 * exists to end, one level up: a declaration that reads correctly and is honoured by
 * nobody, because the read of `params[name]` comes back `undefined` and `undefined` is
 * falsy, so the operator is simply never bypassed and nothing anywhere says so. Checking
 * the name against the schema at registration is what lets the single application site
 * downstream read the field as a CHECKED read rather than an unchecked cast.
 */
function assertChainDeclaration(def: NodeDefinition): void {
  const chain = def.chain;
  if (chain === undefined) return; // not an operator — the one legal way to say nothing

  const missing = (['input', 'scope', 'bypass', 'section'] as const).filter(
    (field) => chain[field] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `registerNodeType(${def.type}): chain declaration is missing ${missing.join(', ')}. ` +
        `A chain is optional to declare and TOTAL once declared — being an operator is one ` +
        `claim, not four independent ones.`,
    );
  }

  if (chain.bypass.kind !== 'passthrough') return;
  const param = chain.bypass.param;
  const shape = (def.paramSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== 'object') {
    throw new Error(
      `registerNodeType(${def.type}): chain.bypass names param '${param}', but this node's ` +
        `paramSchema is not an object schema, so nothing can carry it.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(shape, param)) {
    throw new Error(
      `registerNodeType(${def.type}): chain.bypass names param '${param}', which this node's ` +
        `paramSchema does not declare. A bypass reading an absent param reads undefined, ` +
        `which is falsy — the operator would simply never bypass, silently.`,
    );
  }
}

export function registerNodeType<P, O>(def: NodeDefinition<P, O>): void {
  if (registry.has(def.type)) {
    throw new Error(`Node type already registered: ${def.type}`);
  }
  assertInputDescriptors(def as unknown as NodeDefinition);
  assertChainDeclaration(def as unknown as NodeDefinition);
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
