// testNode — build a fixture node whose TYPE cannot be one the registry does not have.
//
// WHY (#622, closing the residue #594 left). The retirement gate is a grep, and a grep
// matches spellings. It shipped watching one construction position; a second turned up
// months later; widening for that immediately exposed a third. Each round was cheap and
// the pattern is unmistakable — a syntax census cannot converge on a semantic property.
// After #594 the gate watches three positions and the residue measures EMPTY, but empty
// by inspection is not the same as empty by construction, and nothing stops the fourth.
//
// The property that actually matters is not "the source text does not contain a relic
// name". It is "this fixture builds a node the product can build". That is a question
// about the REGISTRY, and asking the registry is blind to spelling by construction: it
// does not care whether the type arrived as a literal, a variable, a template string or
// a computed name.
//
// WHY HAND-BUILT FIXTURES ARE THE ONES THAT ROT. A fixture that goes through `addNode`
// already fails loudly on a retired type, because the op path calls `requireNodeType`.
// The ones that do not are hand-built `DagState` literals and small local helpers — and
// their defining property is precisely that they never touch the registry. That is why
// DELETING a relic definition does not break them: they keep asserting, green, about a
// shape the product can no longer build. This builder puts the registry back in the path
// without making the fixture go through an op.
//
// SCOPE, stated because the honest boundary is narrower than "all fixtures":
//
//   - This is a NODE-SIDE unit-tier instrument. The six `tests/e2e/nla-*.spec.ts` specs
//     have the same `(id, type, params)` helper shape and are deliberately NOT migrated:
//     importing the registry into a Playwright spec drags the whole DAG module graph into
//     every browser run, which is the trade `src/test-utils/splitKinds.ts` refuses in its
//     own header for the same reason. Those stay covered by the grep gate.
//   - Raw `DagState` object literals elsewhere are likewise untouched. Measured while
//     writing this: 83 test files carry a node-fixture shape, 12 of them behind a local
//     `(id, type)` helper. Migrating the other 71 would be a large mechanical sweep for a
//     property none of them violates today, so the road is lazy — new fixtures use this,
//     and existing ones convert when they are touched for other reasons.
//
// The result is a guarantee that is partial by construction rather than by accident, with
// the boundary written down. The grep gate still covers what this does not.
//
// REF: src/test-utils/retiredKinds.gate.test.ts (the grep half, and its blind-spot
//      section); src/core/dag/registry.ts (`getNodeType` — the closed table); issues
//      #622, #594.

import { getNodeType, snapshotRegistry } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import type { Node } from '../core/dag/types';

/** Assert `type` is a node type the product can actually build. Throws otherwise.
 *
 *  Registration is ensured here rather than required of the caller: `registerAllNodes`
 *  is idempotent by design (it skips types already present, for HMR), so calling it is
 *  cheap and removes an ordering trap where a fixture built before the suite's own
 *  registration would validate against an empty table and pass for the wrong reason. */
export function assertLiveNodeType(type: string): void {
  registerAllNodes();
  if (getNodeType(type)) return;
  const known = Object.keys(snapshotRegistry()).sort();
  throw new Error(
    `testNode: '${type}' is not a registered node type, so the product cannot build it.\n` +
      `A fixture asserting on it would stay green while measuring a shape no user can ` +
      `create — which is what retiring a kind is supposed to make impossible.\n` +
      `If '${type}' was just retired, retarget this fixture onto the live kind that ` +
      `replaced it. If the relic genuinely IS the subject (a migration ladder building ` +
      `its pre-migration shape), build a raw literal instead and list the file in the ` +
      `retirement gate's RELIC_IS_THE_SUBJECT.\n` +
      `${known.length} registered types.`,
  );
}

export interface TestNodeParts {
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/**
 * A fixture node of a type the registry has. The shape matches what a hand-built
 * `DagState` literal produces, so this is a drop-in for the local helpers it replaces —
 * the only difference is that an unbuildable type throws here instead of asserting
 * quietly forever.
 */
export function testNode(id: string, type: string, parts: TestNodeParts = {}): Node {
  assertLiveNodeType(type);
  return {
    id,
    type,
    params: parts.params ?? {},
    inputs: parts.inputs ?? {},
  } as unknown as Node;
}

/**
 * An id-keyed map of fixture nodes, the shape most `DagState`-literal fixtures want.
 * Each tuple is `[id, type]` or `[id, type, parts]`.
 */
export function testNodes(
  ...defs: ReadonlyArray<readonly [string, string] | readonly [string, string, TestNodeParts]>
): Record<string, Node> {
  const out: Record<string, Node> = {};
  for (const [id, type, parts] of defs) out[id] = testNode(id, type, parts);
  return out;
}
