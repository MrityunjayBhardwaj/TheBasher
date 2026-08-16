// Node-type registry. Agent-introspectable: every registered type's schema
// is reachable as JSON for tool-surface generation (P2.5).
//
// REF: THESIS.md §6 ("Eighty percent of Basher is node definitions"), §20
// (tool surface).

import type {
  InputDescriptor,
  NodeDefinition,
  NodeTypeId,
  OperatorSection,
  SocketTypeName,
} from './types';
import { operatorLaneOf } from './operatorLane';
import { acceptedTypes } from './socketMembership';

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
/**
 * The LANE each offered stack runs on. `'none'` is absent deliberately: it means no stack
 * offers this operator, which constrains nothing about the type flowing through it — the
 * two scene-lane wrappers declare it and stand on `SceneObject`, and a future unoffered
 * operator could stand anywhere. Constraining `'none'` would be inventing a rule to make a
 * table look complete.
 */
const SECTION_LANE: Readonly<Partial<Record<OperatorSection, SocketTypeName>>> = {
  modifier: 'ObjectData',
  material: 'ObjectData',
  effect: 'Image',
};

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

  // THE THIRD REFUSAL (ns-2 step 5) — the spine must name a declared input of SINGLE
  // cardinality. A bypass hands back "the value that arrived on the spine", so a spine
  // naming a socket the node does not declare has no value to hand back, and one of list
  // cardinality would hand back an ARRAY where the output socket promises one value. Both
  // are silent: the first passes `undefined` downstream, the second a shape nothing
  // branches on. This is the precondition the single application site rests on, so it is
  // enforced here rather than assumed there.
  const spine = (def.inputs as Record<string, { cardinality?: string } | undefined> | undefined)?.[
    chain.input
  ];
  if (spine === undefined) {
    throw new Error(
      `registerNodeType(${def.type}): chain.input names socket '${chain.input}', which this ` +
        `node does not declare as an input. A stack walking that spine finds nothing.`,
    );
  }
  if (spine.cardinality !== 'single') {
    throw new Error(
      `registerNodeType(${def.type}): chain.input names socket '${chain.input}', which has ` +
        `'${spine.cardinality}' cardinality. A spine carries ONE value — it is what a bypass ` +
        `hands back and what a stack walks down — so it cannot be a list socket.`,
    );
  }

  // THE SIXTH REFUSAL (ns-2 step 9b) — a SCOPED spine must carry `ObjectData`, and only
  // `ObjectData`.
  //
  // The evaluator resolves a component selection from the spine value and hands it to
  // `evaluate`, and the resolver takes an `ObjectData` because components are a property of
  // mesh data. That is a premise the hand-off rests on, so it is enforced where the author
  // is present rather than asserted by a cast at the single call site ([[V201]]: enforce the
  // READER's premises at registration).
  //
  // Membership is not enough — a UNION socket accepting `ObjectData | Image` would satisfy
  // "accepts ObjectData" and still deliver an `Image` at runtime, which is the silent half.
  // The declaration has to be exact. Scene- and image-lane operators are unaffected: their
  // honest answer is `scope: {kind:'unscoped', why:'no-component-domain'}`, which is the
  // member that exists for precisely this.
  if (chain.scope.kind === 'source' || chain.scope.kind === 'target') {
    const spineDesc = (def.inputs as Record<string, InputDescriptor | undefined> | undefined)?.[
      chain.input
    ];
    const accepted = spineDesc === undefined ? [] : acceptedTypes(spineDesc);
    if (accepted.length !== 1 || accepted[0] !== 'ObjectData') {
      throw new Error(
        `registerNodeType(${def.type}): chain.scope is '${chain.scope.kind}', so the evaluator ` +
          `resolves a component selection from the spine — but spine socket '${chain.input}' ` +
          `accepts ${accepted.join('|')}, not ObjectData alone. Components are a property of ` +
          `mesh DATA; declare scope {kind:'unscoped', why:'no-component-domain'} if this ` +
          `operator's spine carries something else.`,
      );
    }
  }

  // THE FIFTH REFUSAL (ns-2 step 7) — an offered SECTION must match the operator's LANE.
  //
  // This is what lets `section` be the SOLE membership claim. Step 7 deletes
  // `MODIFIER_NODE_TYPES`, `EFFECT_NODE_TYPES` and both "+ Add" menus and derives all four
  // from this one field, so the field now decides which stack offers an operator — and a
  // stack that offers a member it cannot actually carry is the lying label this project has
  // paid for three times. `EFFECT_NODE_TYPES`'s own comment already asserted the rule in
  // prose (*"a typed `target: Image` / `out: Image` operator"*); nothing enforced it.
  //
  // 🔴 IT IS A REFUSAL AND NOT A CONJUNCT ON THE PREDICATE, AND THAT IS THE WHOLE POINT.
  // Writing `section === 'effect' && lane === 'Image'` into `isEffectNode` would make a
  // mis-declared operator fall silently out of its own stack — the same silent omission,
  // moved one file over, which is exactly what disqualified deriving membership from
  // `inspectorSections`. Refused here, the author is told at the one moment they are
  // present, and every reader downstream may trust the field alone.
  const expectedLane = SECTION_LANE[chain.section];
  if (expectedLane !== undefined) {
    const lane = operatorLaneOf(def);
    if (lane !== expectedLane) {
      throw new Error(
        `registerNodeType(${def.type}): chain.section is '${chain.section}', which is offered ` +
          `by a stack that carries '${expectedLane}', but this operator's lane is ` +
          `${lane === null ? 'undefined (its spine and its `out` socket disagree)' : `'${lane}'`}. ` +
          `A stack cannot offer a member it cannot carry — declare the matching sockets, or ` +
          `declare section 'none' if no stack should offer it.`,
      );
    }
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
  // AND IT MUST BE A BOOLEAN (ns-2 step 5). Step 4 checked only that the NAME exists,
  // while step 5's single application site reads it strictly (`=== true`) — so a param
  // declared under the right name holding, say, a string would type-check, register
  // cleanly, and never bypass. The same silent failure the name check closed, one field
  // over. Asked BEHAVIOURALLY rather than by reading zod's internals, which are a private
  // shape that changes between versions: does this field accept both booleans and reject
  // something that is not one?
  const field = shape[param] as { safeParse?: (v: unknown) => { success: boolean } } | undefined;
  const boolean =
    typeof field?.safeParse === 'function' &&
    field.safeParse(true).success &&
    field.safeParse(false).success &&
    !field.safeParse('not-a-boolean').success;
  if (!boolean) {
    throw new Error(
      `registerNodeType(${def.type}): chain.bypass names param '${param}', which this node's ` +
        `paramSchema does not declare as a boolean. The bypass is read strictly, so a ` +
        `non-boolean param would register cleanly and never bypass, silently.`,
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
