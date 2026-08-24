// ns-2 step 7 — MEMBERSHIP IS THE DECLARATION. The standing measurement for what that cost
// and what it did not close.
//
// ── WHAT CHANGED ──────────────────────────────────────────────────────────────────────
//
// Which stack offers an operator was spelled SEVEN times: `MODIFIER_NODE_TYPES`, the
// modifier "+ Add" menu, the agent's `ModifierType` enum, `MATERIAL_LANE_TYPES`, the
// material "+ Add" menu, `EFFECT_NODE_TYPES`, and `ALL` in `registerAll.ts`. Four pairs of
// those agreed only because both halves were typed by the same hand on the same afternoon,
// and nothing anywhere compared them. Four are now gone, derived from `chain.section`.
//
// ── WHAT COULD NOT BE DERIVED, AND WHY THAT IS A TYPE-SYSTEM FACT ─────────────────────
//
// Two lists survive for the SAME structural reason, one level apart: both feed a
// compile-time check that a runtime derivation cannot buy back.
//   • `ModifierType` is a `z.enum`, and `z.enum` needs a LITERAL tuple to produce a literal
//     union. `addModifier`'s `specParams` narrows on `spec.modifierType === 'ArrayModifier'`
//     to keep Array's params off a Mirror node. Derive it and that narrowing collapses to
//     `string`.
//   • `MATERIAL_LANE_TYPES` defines `MaterialLaneType`, and `resolveMaterialFieldOwner`'s
//     per-field ownership switch closes on a `never` over it — the only structural defence
//     against a new material operator shipping with a write road still aimed at the layer
//     below it.
// So neither is retired. Both are PINNED: each must set-equal the registry-derived set
// exactly, and each pin ships with a minted liar proving the cross-check can fail. A list
// that cannot be derived gets a gate; it does not get trust.
//
// ⚠️ THE ARITHMETIC, SPELLED OUT — because "four are gone" and "two survive" do not add up
// to seven, and the merge-gate review had to re-derive the missing one. SEVEN → THREE. The
// third survivor is `ALL` in `registerAll.ts`, and it is not defended above because it is
// not a membership spelling at all: it is the registry's own input, the list every derived
// answer is derived FROM. A thing cannot be derived from itself. The two defended above are
// the two that stayed despite being derivable in principle.
//
// ── THE ONE THING THIS STEP DID NOT CLOSE, SAID HERE RATHER THAN GLOSSED ──────────────
//
// A cross-check is loud in CI. It is NOT the same as unconstructible: a new modifier absent
// from the agent enum still registers, still renders, and is still unreachable to the agent
// until someone runs the suite. `operatorAddition.gate.test.ts` therefore still names that
// surface as blind, and the phase's exit clause reads 4 → 2, not 4 → 1. Recording the
// smaller number would have been the covered-but-unhonoured claim this epic has already
// paid for three times.
//
// REF: src/app/operatorChain.ts (`operatorTypesInSection`, `MATERIAL_LANE_TYPES`);
//      src/core/dag/registry.ts (`assertChainDeclaration` — the section/lane refusal);
//      src/app/operatorMenu.ts (membership derived, wording and order written down);
//      src/agent/mutators/builders/addModifier.ts (`ModifierType`);
//      src/app/operatorAddition.gate.test.ts (the blindness pin this step moves 4 → 2);
//      issues #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, listNodeTypes, registerNodeType } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { MATERIAL_LANE_TYPES, isModifierNode, operatorTypesInSection } from './operatorChain';
import { addableOperators, fallbackOperatorLabel } from './operatorMenu';
import { addModifierMutator } from '../agent/mutators/builders/addModifier';
import type { OperatorSection, SocketTypeName } from '../core/dag/types';

/** The types the agent's `modifierType` field actually accepts, asked BEHAVIOURALLY. */
function agentModifierEnum(): string[] {
  const candidates = [...operatorTypesInSection('modifier'), 'Ns2LiarModifier'];
  return candidates
    .filter((t) => addModifierMutator.spec.safeParse({ target: 'n', modifierType: t }).success)
    .sort();
}

/** Register a synthetic operator on `lane`, declaring `section`. */
function registerOp(name: string, section: OperatorSection, lane: SocketTypeName): void {
  registerNodeType({
    type: name,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ muted: z.boolean().default(false) }),
    inputs: { target: { type: lane, cardinality: 'single' } },
    outputs: { out: { type: lane, cardinality: 'single' } },
    chain: {
      input: 'target',
      // ns-2 step 9b's SIXTH refusal — derived from the lane, see `operatorLane.gate.test.ts`.
      scope:
        lane === 'ObjectData'
          ? { kind: 'source' }
          : { kind: 'unscoped', why: 'no-component-domain' },
      bypass: { kind: 'passthrough', param: 'muted' },
      section,
    },
    evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.target,
  } as never);
}

describe('ns-2 step 7 — membership is derived from the declaration', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('THE INSTRUMENT CONTROL: the derivation sees the operators that are demonstrably there', () => {
    // Before any assertion about what is MISSING from a set is worth reading. A section
    // pattern one field too tight returns an empty set, and an empty set reads exactly like
    // "this stack has no members", which agrees with nothing and alarms nobody.
    expect(operatorTypesInSection('modifier')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
    ]);
    expect(operatorTypesInSection('material')).toEqual(['MaterialOverrideOp', 'SetMaterialOp']);
    expect(operatorTypesInSection('effect')).toEqual(['ColorCorrect']);
    expect(operatorTypesInSection('none')).toEqual(['MaterialOverride', 'Transform']);
  });

  it('A NEW OPERATOR JOINS ITS STACK BY DECLARING, AND NOTHING ELSE', () => {
    // The whole step in one row. `Ns2SyntheticModifier` is registered and named nowhere
    // else in the repo — no set, no menu, no enum — and both the membership answer and the
    // menu offer it. Before step 7 this required three edits in three files, each of which
    // failed silently on its own.
    registerOp('Ns2SyntheticModifier', 'modifier', 'ObjectData');

    expect(operatorTypesInSection('modifier')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
      'Ns2SyntheticModifier',
    ]);
    expect(addableOperators('modifier', { ArrayModifier: 'Array' }).map((o) => o.type)).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
      'Ns2SyntheticModifier',
    ]);
  });

  it('THE PREDICATE AND THE SET ARE ONE DERIVATION, ON A MEMBER NEITHER WAS TOLD ABOUT', () => {
    // `isModifierNode` is what every stack walker calls; `operatorTypesInSection` is what
    // the menu and the agent's precondition call. They were the SAME hand-maintained set
    // before step 7 and they are the same declaration after it — but nothing said so, and a
    // perturbation proved it: putting a literal list back behind the predicate alone left
    // the whole suite green. A synthetic neither of them can have been told about is what
    // separates "both derive" from "both happen to agree on today's two members".
    registerOp('Ns2AgreementProbe', 'modifier', 'ObjectData');
    const node = { id: 'n', type: 'Ns2AgreementProbe', params: {}, inputs: {} } as never;

    expect(isModifierNode(node)).toBe(true);
    expect(operatorTypesInSection('modifier')).toContain('Ns2AgreementProbe');

    // And they agree over the whole registry, in both directions.
    const bySet = operatorTypesInSection('modifier');
    const byPredicate = listNodeTypes().filter((t) =>
      isModifierNode({ id: 'n', type: t, params: {}, inputs: {} } as never),
    );
    expect(byPredicate).toEqual(bySet);
  });

  it('A LABEL MAP CHANGES WORDING AND ORDER, NEVER MEMBERSHIP', () => {
    // The property the menu split rests on, asserted rather than assumed — the blindness
    // census leans on it when it probes the menu with an EMPTY label map.
    const derived = operatorTypesInSection('material');
    for (const labels of [
      {},
      { SetMaterialOp: 'Set Material' },
      { MaterialOverrideOp: 'Override', SetMaterialOp: 'Set Material' },
      { NotARegisteredType: 'Nonsense' },
    ]) {
      expect(
        addableOperators('material', labels)
          .map((o) => o.type)
          .sort(),
      ).toEqual(derived);
    }

    // Order comes from the map, because composition order is not alphabetical and no
    // registry knows it: SET replaces the material flowing through, OVERRIDE authors over it.
    expect(
      addableOperators('material', {
        SetMaterialOp: 'Set Material',
        MaterialOverrideOp: 'Override',
      }),
    ).toEqual([
      { type: 'SetMaterialOp', label: 'Set Material' },
      { type: 'MaterialOverrideOp', label: 'Override' },
    ]);

    // An unlabelled member is VISIBLE, not missing — the asymmetry that makes forgetting a
    // label cheap and forgetting membership impossible.
    expect(addableOperators('material', {})).toEqual([
      { type: 'MaterialOverrideOp', label: 'Material Override' },
      { type: 'SetMaterialOp', label: 'Set Material' },
    ]);
    // …and it is why the labels are still written down: one of those two is wrong.
    expect(fallbackOperatorLabel('MaterialOverrideOp')).toBe('Material Override');
  });

  it('M5 — READ BEFORE BOOT AND IT THROWS BY NAME, RATHER THAN ANSWERING EMPTY', () => {
    // `registerAllNodes()` is a FUNCTION called at boot. A derivation evaluated at module
    // scope would see an empty registry and freeze an empty answer: a menu offering nothing
    // and an agent vocabulary naming nothing, both silent, both indistinguishable from a
    // section that genuinely has no members. The refusal is what makes the two different.
    __resetRegistryForTests();
    expect(() => operatorTypesInSection('modifier')).toThrow(/EMPTY registry/);
    expect(() => addableOperators('modifier', {})).toThrow(/EMPTY registry/);
  });
});

describe('ns-2 step 7 — the two lists that stay are pinned, and the pins can fail', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('the agent enum set-equals the derived modifier set', () => {
    expect(agentModifierEnum()).toEqual(operatorTypesInSection('modifier'));
  });

  it('THE MINTED LIAR: a modifier the agent enum does not name reds the cross-check', () => {
    // Without this the row above passes on a repo where BOTH sides were forgotten together —
    // a consistency check between two spellings detects drift and never omission by both.
    registerOp('Ns2LiarModifier', 'modifier', 'ObjectData');

    expect(operatorTypesInSection('modifier')).toContain('Ns2LiarModifier');
    expect(agentModifierEnum()).not.toContain('Ns2LiarModifier');
    expect(agentModifierEnum()).not.toEqual(operatorTypesInSection('modifier'));
  });

  it('MATERIAL_LANE_TYPES set-equals the derived material set', () => {
    expect([...MATERIAL_LANE_TYPES].sort()).toEqual(operatorTypesInSection('material'));
  });

  it('THE MINTED LIAR: a material operator the tuple does not name reds the cross-check', () => {
    registerOp('Ns2LiarMaterialOp', 'material', 'ObjectData');

    expect(operatorTypesInSection('material')).toContain('Ns2LiarMaterialOp');
    expect([...MATERIAL_LANE_TYPES]).not.toContain('Ns2LiarMaterialOp');
    expect([...MATERIAL_LANE_TYPES].sort()).not.toEqual(operatorTypesInSection('material'));
  });
});

describe('ns-2 step 7 — an offered section must match the lane its stack carries', () => {
  // The refusal that lets `section` be the SOLE membership claim. Without it, deleting
  // `EFFECT_NODE_TYPES` would have left "which stack offers this" answerable by a
  // declaration that contradicts the operator's own sockets — a stack offering a member it
  // cannot carry, which is the lying label with a one-commit fuse.
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('refuses each offered section on the wrong lane, naming BOTH declarations', () => {
    expect(() => registerOp('Ns2BadModifier', 'modifier', 'Image')).toThrow(
      /chain.section is 'modifier'.*carries 'ObjectData'.*lane is 'Image'/s,
    );
    expect(() => registerOp('Ns2BadMaterial', 'material', 'SceneObject')).toThrow(
      /chain.section is 'material'.*lane is 'SceneObject'/s,
    );
    expect(() => registerOp('Ns2BadEffect', 'effect', 'ObjectData')).toThrow(
      /chain.section is 'effect'.*carries 'Image'.*lane is 'ObjectData'/s,
    );
  });

  it("'none' constrains NO lane — it is a real answer, not a filler", () => {
    // The two scene-lane wrappers declare it and stand on `SceneObject`; a future unoffered
    // operator could stand anywhere. Constraining `'none'` would be inventing a rule to make
    // a table look complete, and it would forbid exactly the operators nobody offers.
    registerOp('Ns2UnofferedScene', 'none', 'SceneObject');
    registerOp('Ns2UnofferedExotic', 'none', 'Navmesh');

    expect(operatorTypesInSection('none')).toEqual(['Ns2UnofferedExotic', 'Ns2UnofferedScene']);
  });

  it('the positive control: every shipped operator satisfies the refusal', () => {
    // The seven production declarations are what the rule was derived FROM, so they must
    // pass it — otherwise the rule is a claim about a population it does not fit.
    expect(() => registerAllNodes()).not.toThrow();
  });
});
