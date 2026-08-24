// ns-2 step 6 — THE LANE, DERIVED ONCE. The standing measurement for that claim.
//
// ── WHY A CONSOLIDATION NEEDS DETECTORS AT ALL ────────────────────────────────────────
//
// Moving two identical derivations onto one implementation changes NO behaviour today, and
// the tier says so: 347 files / 4131 tests, green before and green after, byte for byte.
// A green like that licenses nothing — the same reading appeared when a whole read path was
// reverted (ns-1) and when a deleted bypass guard was restored (step 5). So the claim this
// step makes is not "the app still works". It is three separate things, each with its own
// row below:
//
//   1. there is exactly ONE site in the repo that derives a lane,
//   2. the derivation is TOTAL over the operators that exist and returns a NAMED answer for
//      operators that do not exist yet,
//   3. the two predicates that keep a list now ask the lane FIRST, and that conjunct is not
//      decorative.
//
// ── THE NUMBERS, MEASURED, WITH THEIR POPULATIONS ─────────────────────────────────────
//
// On the pre-step tree (`4fba3d5`), across 555 source files enumerated by the shared walk:
//   • lane-derivation SITES: 2, both in `src/app/operatorChain.ts` — `isDataLaneOperator`
//     and `isSceneLaneWrapper`, whose own comment described the second as "byte-identical
//     in shape to the first, one socket type up".
//   • files carrying both factors: 1. 🔴 THE FILE COUNT DOES NOT DISCRIMINATE — it is 1
//     before and 1 after. Only the SITE count moves (2 → 1), which is why this gate counts
//     sites and says so; a census in the wrong unit cannot decide anything.
//   • `src/app/modifierGeometry.ts` reads an output socket's type TWICE and is NOT a lane
//     derivation: it asks "does this node EMIT `ObjectData`?", a question about a PRODUCER,
//     with no spine factor at all. It is named below as the known non-member, so the
//     census's ability to tell the two questions apart is asserted rather than hoped for.
//   • 7 chain declarers, and all 7 land on a lane: `ObjectData` ×4, `SceneObject` ×2,
//     `Image` ×1. Nothing unreadable, nothing whose spine and `out` disagree.
//   • 21 socket types have exactly one `out` producer. (A research note said 20; re-measured
//     here from the live registry over the population "socket types appearing as the type of
//     an `out` socket". The four headline lanes it also stated — `ObjectData` 10,
//     `SceneObject` 9, `KeyframeChannel` 7, `Image` 7 — all reproduced exactly.)
//
// REF: src/core/dag/operatorLane.ts (the one implementation, and why it takes a definition);
//      src/app/operatorChain.ts (the four predicates that consume it);
//      src/core/dag/socketMembership.ts (the leaf property this one copies);
//      tools/gates/moduleShape.ts (`importsOf`); tools/gates/sourceFiles.ts (the walk);
//      src/app/operatorAddition.gate.test.ts (the blindness census `isModifierNode` belongs
//      to, and the reason it is the one predicate left alone here); issues #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerNodeType } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { operatorLaneOf } from '../core/dag/operatorLane';
import {
  MATERIAL_LANE_TYPES,
  isDataLaneOperator,
  isEffectNode,
  isMaterialLaneOperator,
  isModifierNode,
  isSceneLaneWrapper,
  operatorLane,
  operatorTypesInSection,
} from './operatorChain';
import { stripComments } from '../test-utils/sourceScan';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { importsOf } from '../../tools/gates/moduleShape';
import type { Node, OperatorSection, SocketTypeName } from '../core/dag/types';

/** A node instance, as every predicate here sees one: a type id and nothing else. */
function nodeOfType(type: string): Node {
  return { id: 'n_probe', type, params: {}, inputs: {} } as unknown as Node;
}

/** The lane of a registered type, by name — the registry road the predicates take. */
function laneOfType(type: string): SocketTypeName | null {
  return operatorLaneOf(getNodeType(type));
}

/** Every chain declarer in the LIVE registry, with the lane it derives to. */
function laneMap(): Record<string, SocketTypeName | 'NO LANE'> {
  const out: Record<string, SocketTypeName | 'NO LANE'> = {};
  for (const type of listNodeTypes()) {
    const def = getNodeType(type);
    if (!def?.chain) continue;
    out[type] = operatorLaneOf(def) ?? 'NO LANE';
  }
  return out;
}

/** The chain declarers standing on `lane`, sorted. */
function laneMembers(lane: SocketTypeName): string[] {
  return Object.entries(laneMap())
    .filter(([, l]) => l === lane)
    .map(([t]) => t)
    .sort();
}

/**
 * Register a synthetic chain operator carrying `type` in and out.
 *
 * Every field the registration refusals added in steps 4 and 5 is satisfied deliberately —
 * a total chain record, a spine that is a declared SINGLE input, a bypass naming a param
 * the schema declares as a boolean. A synthetic that tripped one of those would throw in
 * `beforeEach` and red every row in the file at once, which is a blast radius that says
 * nothing about any of them.
 */
function registerLaneOp(
  name: string,
  lane: SocketTypeName,
  out: SocketTypeName = lane,
  section: OperatorSection = 'none',
): void {
  registerNodeType({
    type: name,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ muted: z.boolean().default(false) }),
    inputs: { target: { type: lane, cardinality: 'single' } },
    outputs: { out: { type: out, cardinality: 'single' } },
    chain: {
      input: 'target',
      // ns-2 step 9b's SIXTH refusal: a `'source'`/`'target'` scope means the evaluator
      // resolves a component selection from the spine, so the spine must carry
      // `ObjectData` and nothing else. Derived from the lane rather than hardcoded,
      // because a synthetic that declared a scope it cannot have would throw in
      // `beforeEach` and red every row in the file at once — and because "components are a
      // property of mesh data" is the claim, not a property of this fixture.
      scope:
        lane === 'ObjectData'
          ? { kind: 'source', domain: 'face' }
          : { kind: 'unscoped', why: 'no-component-domain' },
      bypass: { kind: 'passthrough', param: 'muted' },
      section,
    },
    evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.target,
  } as never);
}

describe('ns-2 step 6 — the lane is derived, in one place, and it is total', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('THE INSTRUMENT CONTROL: the known member has a lane, and it is the right one', () => {
    // Required before any count below is worth reading. A derivation that cannot see the
    // operator that is demonstrably there is an instrument fault, not a finding — and a
    // pattern one field too tight returns a clean empty set that reads exactly like the
    // thesis ("operators declare no output type"), which is the expensive direction.
    expect(laneOfType('ArrayModifier')).toBe('ObjectData');
    expect(isDataLaneOperator(nodeOfType('ArrayModifier'))).toBe(true);
  });

  it('THE CENSUS: exactly ONE site in the repo derives a lane', () => {
    // The two factors. A lane needs BOTH: which socket is the spine, and what type comes
    // back out. A file reading only the second is asking about a producer.
    const OUTPUT_TYPE = /outputs\s*(?:\[[^\]]*\]|\.\w+)\s*\??\.\s*type/g;
    const SPINE = /chain\s*\??\.\s*input/;

    const files = sourceFiles();
    const derivers: { path: string; sites: number }[] = [];
    const producerReadersOnly: string[] = [];
    for (const [path, src] of files) {
      const stripped = stripComments(src);
      const sites = (stripped.match(OUTPUT_TYPE) ?? []).length;
      if (sites === 0) continue;
      if (SPINE.test(stripped)) derivers.push({ path, sites });
      else producerReadersOnly.push(path);
    }

    // Report the denominator beside the finding: a zero with no population behind it
    // cannot be told from a walk that never ran.
    expect(files.length).toBeGreaterThan(500);

    // 2 sites in `operatorChain.ts` before this step; 1 site in `operatorLane.ts` after.
    expect(derivers).toEqual([{ path: 'src/core/dag/operatorLane.ts', sites: 1 }]);

    // The known NON-member, named. If `modifierGeometry.ts` ever drops out of this list the
    // census has stopped discriminating between the two questions and the row above is
    // passing for the wrong reason.
    expect(producerReadersOnly).toContain('src/app/modifierGeometry.ts');
  });

  it('THE LEAF PROPERTY: the derivation drags nothing', () => {
    // Not asserted about the path — asserted about the imports, the same way
    // `socketMembership.ts` earns its own exemption. `./types` is erased by the compiler;
    // `./socketMembership` is the one value import, and its own import list is type-only,
    // so the whole emitted graph behind this module is two membership functions. Add a
    // third specifier here and this row is what says so.
    expect(importsOf('src/core/dag/operatorLane.ts')).toEqual(['./types', './socketMembership']);
    expect(importsOf('src/core/dag/socketMembership.ts')).toEqual(['./types']);
  });

  it('THE LANE MAP: all seven chain declarers land on a lane, none unreadable', () => {
    // Stated as a literal rather than derived a second way. Two derivations checked against
    // each other agree when BOTH are wrong; a literal is the row that cannot.
    expect(laneMap()).toEqual({
      ArrayModifier: 'ObjectData',
      ColorCorrect: 'Image',
      MaskModifier: 'ObjectData',
      MaterialOverride: 'SceneObject',
      MaterialOverrideOp: 'ObjectData',
      MirrorModifier: 'ObjectData',
      SetMaterialOp: 'ObjectData',
      Transform: 'SceneObject',
    });
    expect(Object.values(laneMap())).not.toContain('NO LANE');
  });

  it('THE LANE IS NOT THE SECTION: five on the data lane, three in the modifier set', () => {
    // The discrepancy is the finding, not a defect. The lane answers a question about SHAPE
    // ("does this kind of value flow through?") and every node with that shape has to be
    // walked past. Which STACK offers an operator is a different question with a different
    // answer, and deriving it from the lane would put a material operator in the modifier
    // menu. That split is `chain.section`'s job, one step later, which is why these are two
    // steps and not one.
    expect(laneMembers('ObjectData')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MaterialOverrideOp',
      'MirrorModifier',
      'SetMaterialOp',
    ]);
    expect(operatorTypesInSection('modifier')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
    ]);
    expect(laneMembers('SceneObject')).toEqual(['MaterialOverride', 'Transform']);
    expect(laneMembers('Image')).toEqual(['ColorCorrect']);
  });

  it('THE DERIVED SET FOLLOWS THE REGISTRY; THE HAND-MAINTAINED LIST DOES NOT', () => {
    // This is the row that separates a derivation from a snapshot. It also covers the boot
    // hazard: `registerAllNodes()` is a FUNCTION called at boot, so anything evaluated at
    // module scope would have read an empty registry and frozen an empty answer. The lane
    // is computed per call from a definition handed in, so there is no moment at which it
    // could have been captured early.
    registerLaneOp('Ns2SyntheticDataOp', 'ObjectData');

    expect(laneMembers('ObjectData')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MaterialOverrideOp',
      'MirrorModifier',
      'Ns2SyntheticDataOp',
      'SetMaterialOp',
    ]);
    expect(isDataLaneOperator(nodeOfType('Ns2SyntheticDataOp'))).toBe(true);

    // AND THE SECTION DERIVATION DID NOT MOVE — because the synthetic declares
    // `section: 'none'`. The two derivations read the same registry and answer different
    // questions, and this is where that is asserted rather than described: standing on the
    // data lane does not put an operator in the modifier stack, and step 7 kept it that way
    // when it retired the lists (a member joins a stack by declaring the section, never by
    // having the right sockets).
    expect(operatorTypesInSection('modifier')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
    ]);
    expect(isModifierNode(nodeOfType('Ns2SyntheticDataOp'))).toBe(false);
  });

  it('AN OPERATOR ON A LANE NOBODY HAS USED YET GETS A NAMED ANSWER, NOT undefined', () => {
    // The premise, measured on this tree: `Navmesh` is a socket type with exactly ONE `out`
    // producer and no chain declarer — one of twenty-one such types. A three-valued
    // `'data' | 'scene' | 'image'` enum would answer `undefined` for an operator standing
    // there, and an `undefined` is not a refusal: it is a node dropping silently out of
    // every walk that asks whether something stands between a consumer and its base. So the
    // answer is the socket type itself.
    const producers = listNodeTypes().filter(
      (t) => getNodeType(t)?.outputs?.out?.type === 'Navmesh',
    );
    expect(producers).toHaveLength(1);
    expect(producers).not.toContain('Ns2SyntheticExoticOp');

    registerLaneOp('Ns2SyntheticExoticOp', 'Navmesh');
    const node = nodeOfType('Ns2SyntheticExoticOp');

    expect(operatorLane(node)).toBe('Navmesh');
    expect(isDataLaneOperator(node)).toBe(false);
    expect(isSceneLaneWrapper(node)).toBe(false);
    expect(isEffectNode(node)).toBe(false);
  });

  it('A NODE WHOSE SPINE AND OUTPUT DISAGREE HAS NO LANE', () => {
    // A real thing to be able to build — a converter, not an operator. Nothing flows THROUGH
    // it, so no stack may walk down it. The agreement is checked rather than assumed from
    // `chain` merely being present, which is the difference between "declares a spine" and
    // "is an operator".
    registerLaneOp('Ns2SyntheticConverter', 'ObjectData', 'Image');
    const node = nodeOfType('Ns2SyntheticConverter');

    expect(operatorLane(node)).toBeNull();
    expect(isDataLaneOperator(node)).toBe(false);
    expect(isEffectNode(node)).toBe(false);
  });

  it('a node with no chain declaration has no lane', () => {
    // `Object` emits `SceneObject` and consumes `ObjectData`; it is a poser, not a wrapper.
    expect(operatorLane(nodeOfType('Object'))).toBeNull();
    expect(operatorLane(undefined)).toBeNull();
    expect(operatorLane(nodeOfType('NotARegisteredType'))).toBeNull();
  });
});

describe('ns-2 step 6/7 — the lane conjunct on the surviving list is real', () => {
  // These re-register a SHIPPED type name on the WRONG lane, which means the registry is
  // reset and NOT reseeded: `registerNodeType` refuses a duplicate, so the only way to ask
  // "what if this member left its lane?" is to be the one who registers it.
  //
  // 🔴 THE SECTION IS DELIBERATELY `'none'` HERE, and that is not a detail. Step 7 added a
  // registration refusal — an offered section must match the lane its stack carries — so a
  // synthetic that kept `section: 'material'` on the Image lane would now THROW instead of
  // registering, and this row would be measuring the refusal rather than the predicate. The
  // two are tested separately, and this is the seam where they would have silently merged.
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('a material operator that stops standing on the data lane stops being one', () => {
    // `MATERIAL_LANE_TYPES` is the ONE membership list step 7 left standing (its tuple
    // closes the ownership switch's `never`, which no runtime derivation can buy back). So
    // this conjunct still has a list to narrow, and still has to be shown to do work: the
    // name is in the tuple throughout, and the predicate says no anyway.
    registerLaneOp('SetMaterialOp', 'Image');

    expect((MATERIAL_LANE_TYPES as readonly string[]).includes('SetMaterialOp')).toBe(true);
    expect(operatorLane(nodeOfType('SetMaterialOp'))).toBe('Image');
    expect(isMaterialLaneOperator(nodeOfType('SetMaterialOp'))).toBe(false);
  });

  it('the positive control: on its own lane it still answers yes', () => {
    // Without this the row above passes just as well if the predicate were broken to return
    // false always.
    registerLaneOp('SetMaterialOp', 'ObjectData', 'ObjectData', 'material');

    expect(isMaterialLaneOperator(nodeOfType('SetMaterialOp'))).toBe(true);
  });

  it('an effect off the Image lane is REFUSED at registration, not quietly excluded', () => {
    // This is what `isEffectNode`'s lane conjunct became at step 7, and the move is the
    // point. `EFFECT_NODE_TYPES` is gone; membership is `chain.section` alone. Had the lane
    // check stayed a conjunct on the predicate, a mis-declared effect would drop silently
    // out of its own stack — the identical silent omission, one file over. As a refusal it
    // is impossible to register and the author is told which two declarations disagree.
    expect(() => registerLaneOp('ColorCorrect', 'ObjectData', 'ObjectData', 'effect')).toThrow(
      /chain.section is 'effect'.*lane is 'ObjectData'/s,
    );

    // And the honest positive control: on the Image lane the same declaration registers.
    registerLaneOp('ColorCorrect', 'Image', 'Image', 'effect');
    expect(isEffectNode(nodeOfType('ColorCorrect'))).toBe(true);
  });
});
