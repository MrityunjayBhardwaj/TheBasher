// operatorLane — the LANE an operator stands on, derived, in one place (ns-2 step 6).
//
// ── WHAT A LANE IS, AND WHY IT IS A DERIVATION RATHER THAN A LIST ─────────────────────
//
// An operator is a node that takes a value on its declared chain spine and hands the SAME
// kind of value back on `out`. The type that flows through is its LANE. Geometry modifiers
// stand on `ObjectData`; `Transform` and `MaterialOverride` stand on `SceneObject`;
// `ColorCorrect` stands on `Image`. Nothing multiplies the two declarations that say so —
// `chain.input` and the output socket's type — so until this file existed the lane was
// re-derived by hand wherever it was needed, and `operatorChain.ts` carried TWO copies of
// it, byte-identical in shape and one socket type apart. Its own comment said as much:
// *"Byte-identical in shape to isDataLaneOperator, one socket type up."* A duplication a
// comment apologises for is a duplication waiting for a third copy.
//
// ── WHY IT RETURNS THE TYPE BY NAME AND NEVER A THREE-VALUED ENUM ─────────────────────
//
// The tempting shape is `'data' | 'scene' | 'image'`, because those are the three lanes
// that have operators today. It is the wrong shape, and the registry says why: measured on
// this tree, TWENTY-ONE socket types have exactly one producer each (`Navmesh`, `Track`,
// `Prompt`, `WalkPath`…). The day any of them grows a second producer and someone writes
// an operator between them, that operator HAS a lane — and a three-valued enum would
// answer `undefined` for it. An `undefined` here is not a refusal; it is a node quietly
// dropping out of every walk that asks "is something standing between me and my base?".
// That is the silent-site shape this phase exists to end, so the answer is the socket type
// itself and the function is TOTAL over chain declarers: measured, 7 of 7 land on a lane,
// none unreadable, none disagreeing.
//
// ── WHY THE LANE IS NOT THE SECTION ───────────────────────────────────────────────────
//
// The `ObjectData` lane has FOUR members (`ArrayModifier`, `MirrorModifier`,
// `SetMaterialOp`, `MaterialOverrideOp`) while `MODIFIER_NODE_TYPES` has two. That is not a
// discrepancy to be fixed here — it is the point. The lane answers "does this kind of value
// flow through this node", which is a question about SHAPE, and every node with that shape
// must be walked past whether or not it reshapes geometry. Which STACK offers an operator
// is a different question with a different answer (`chain.section`), and folding the two
// would put a material operator in the modifier menu. Deriving the split from the lane
// would not retire a silent site, it would move one.
//
// ── WHY THIS FILE HAS THE PROPERTY IT HAS ─────────────────────────────────────────────
//
// It takes a `NodeDefinition` rather than a node id, so it never imports the registry. Its
// only value import is `socketMembership`, which by its own header's argument drags
// nothing — so this module's whole emitted dependency graph is two membership functions.
// That is `socketMembership.ts`'s property, held for the same reason: a module a browser
// run can reach without pulling the DAG's zod schemas in behind it. Taking the definition
// as an argument also makes the derivation LAZY by construction — there is no module-scope
// read of a registry that `registerAllNodes()` has not filled yet.
//
// REF: src/core/dag/socketMembership.ts (the property, and why it is derived not granted);
//      src/core/dag/types.ts (`ChainDeclaration` — `input` is the first factor);
//      src/app/operatorChain.ts (the four predicates that consume this);
//      src/app/operatorLane.gate.test.ts (the standing measurement); issues #607, #660.

import type { NodeDefinition, SocketTypeName } from './types';
import { inputAccepts } from './socketMembership';

/** The output socket every chain node hands its result back on. */
const OUT = 'out';

/**
 * The socket type flowing through `def`'s chain — its LANE — or `null` if `def` is not an
 * operator at all.
 *
 * `null` has exactly three causes and they are deliberately not distinguished, because
 * every caller asks the same yes/no question of a specific lane: the definition is absent;
 * it declares no `chain`, so it is not a chain node; or its spine and its `out` disagree
 * about the type, so nothing flows THROUGH it and it is a converter rather than an
 * operator. A node in the third case is a real thing to be able to build — that is why the
 * agreement is checked rather than assumed from `chain` being present.
 *
 * Read through `inputAccepts`, never `spine.type ===`: an input socket may declare a SET
 * of accepted types, and the direct comparison still compiles while reading false for
 * every set-valued socket (`types.ts` states that hazard at the declaration).
 */
export function operatorLaneOf(def: NodeDefinition | undefined): SocketTypeName | null {
  if (!def?.chain) return null;
  const spine = def.inputs[def.chain.input];
  const out = def.outputs[OUT]?.type;
  if (!spine || out === undefined) return null;
  return inputAccepts(spine, out) ? out : null;
}
