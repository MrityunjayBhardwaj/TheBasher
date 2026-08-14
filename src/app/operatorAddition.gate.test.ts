// ns-2 step 1 — THE COST CURVE, PINNED: which surfaces are BLIND to a new geometry operator.
//
// ── WHY A GATE AND NOT A NUMBER IN A DOCUMENT ─────────────────────────────────────────
//
// `CONTRACT-CENSUS.md` measured that adding one geometry modifier touches FOURTEEN sites,
// of which FIVE fail silently: the author forgets one, every test stays green, and the
// operator is simply absent from a menu, from the agent's vocabulary, or from the build
// switch. Nine of the fourteen are loud (a `never` dispatch, a compile error, an exact-set
// gate). The five below are the ones nothing says anything about.
//
// A number in a document decays the moment the code moves. This file makes the number a
// standing measurement: it MINTS an operator that nobody has registered anywhere else and
// asks each surface whether it knows about it. On the pre-work tree the answer is the five
// names below. The phase's first exit clause is that this list becomes EMPTY — so the same
// function that records today's blindness is the one that will have to return `[]`, and it
// cannot be satisfied by editing a sentence.
//
// ── WHY MINT AN OPERATOR RATHER THAN COUNT THE POPULATION ─────────────────────────────
//
// Every operator that exists today is present at every one of these surfaces — they were
// added by hand, one by one, and the hand did not slip. A census over the population
// therefore reports a clean, closed, entirely consistent set and shows nothing at all.
// The defect is only visible to a member that was never hand-added, which is why the
// subject here is constructed rather than searched for (the same reason `twoMaterialMesh`
// exists: the discriminator is minted, never found).
//
// ── WHY EVERY PROBE HAS AN `unreadable` ANSWER ────────────────────────────────────────
//
// Two of these surfaces are unexported module constants, so reaching them means either a
// source census or a behavioural back door. Both can fail SILENTLY in the direction that
// agrees with the thesis: a regex that no longer matches the block it was written for
// reports "the type is absent", which is exactly what a real blindness looks like. So a
// probe returns `null` when it could not read its own subject, `unreadable` is reported
// beside `blind`, and the pin below requires it to be EMPTY before any count is believed.
// The known-member control does the other half: `ArrayModifier` must come back blind at
// NOTHING. A probe that cannot see the operator that is demonstrably there is an
// instrument fault, not a finding.
//
// REF: `.anvi/…/phases/ns-2-component-groups/PLAN.md` §8 step 1 + §2 clause 1;
//      `CONTRACT-CENSUS.md` §3 #3 (the 14-site cost curve, 5 silent);
//      src/app/operatorChain.ts (`MODIFIER_NODE_TYPES`);
//      src/app/ModifierStackControls.tsx (`ADDABLE`);
//      src/agent/mutators/builders/addModifier.ts (`ModifierType`);
//      src/app/geometryRegistry.ts (`buildFromDescriptor`);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #607, #660.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, getNodeType, registerNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { isModifierNode, operatorTypesInSection } from './operatorChain';
import { addableOperators } from './operatorMenu';
import { arrayGeometryRef, boxGeometryRef } from './modifierGeometry';
import { readGeometry } from './geometryRegistry';
import { addModifierMutator } from '../agent/mutators/builders/addModifier';
import type { GeometryRef } from '../nodes/types';

/** The node type minted for this gate. Registered by `beforeEach`, nowhere else. */
const PROBE_TYPE = 'Ns2ProbeModifier';

/** The geometry-descriptor discriminator that operator would build. */
const PROBE_DESCRIPTOR_KIND = 'ns2probe';

/**
 * An operator, as the five surfaces below see it: a registered node TYPE plus the geometry
 * HANDLE its `evaluate` would hand back.
 */
interface OperatorCandidate {
  readonly type: string;
  readonly geometry: GeometryRef;
}

/**
 * One surface a new operator has to be taught about.
 *
 * `knows` answers about the CANDIDATE, never about the population — and returns `null` when
 * the probe could not read its own subject, which is a different answer from "no".
 */
interface Surface {
  readonly name: string;
  knows(candidate: OperatorCandidate): boolean | null;
}

const SURFACES: readonly Surface[] = [
  {
    // WAS a `ReadonlySet` of type strings that nothing derived and nothing checked, so a
    // modifier missing from it was not a modifier as far as the stack walker was concerned.
    // ns-2 step 7 DELETED it: membership is `chain.section`, read from the operator's own
    // declaration. The surface still exists — something still has to answer "is this a
    // modifier?" — but it can no longer disagree with the operator about it.
    name: 'the modifier membership set',
    knows: (c) => {
      // 🔴 ASKED THROUGH `isModifierNode`, THE PREDICATE THE STACK WALKERS ACTUALLY CALL —
      // not through `operatorTypesInSection` directly. The first version of this row asked
      // the derivation, and a perturbation caught it: restoring a hand-maintained list
      // BEHIND the predicate left this census, and every other gate, entirely green. The
      // set was only ever a backing store for the predicate, so the predicate is the
      // surface; probing the derivation instead measures the wrong side of the very
      // substitution the row exists to detect.
      const readable = operatorTypesInSection('modifier');
      if (readable.length === 0) return null;
      return isModifierNode({ id: 'n_probe', type: c.type, params: {}, inputs: {} } as never);
    },
  },
  {
    // The "+ Add" menu. Asked through the panel's OWN road (`addableOperators`) rather than
    // by censusing a literal, because there is no longer a literal to census — step 7 split
    // the menu into derived membership plus a label map, and only the labels are written
    // down. An empty label map is passed deliberately: labels change the WORDING of an
    // entry and can never remove one, which is the property that made the split worth
    // making, and it is asserted directly in `operatorMembership.gate.test.ts`.
    name: 'the modifier "+ Add" menu',
    knows: (c) => {
      const offered = addableOperators('modifier', {});
      return offered.length === 0 ? null : offered.some((o) => o.type === c.type);
    },
  },
  {
    // The agent's vocabulary — a `z.enum` closed over the two modifiers that exist. Asked
    // BEHAVIOURALLY through the mutator's own spec schema rather than by reading the enum
    // literal, so the probe cannot drift from what the agent road will actually accept.
    name: 'ModifierType (agent enum)',
    knows: (c) => {
      const parsed = addModifierMutator.spec.safeParse({ target: 'n_probe', modifierType: c.type });
      return parsed.success;
    },
  },
  {
    // The build switch — the SECOND row this phase has closed, and like the bypass row the
    // question changed when it closed (step 8b).
    //
    // Before: an if-chain whose terminal `return null` served two unrelated populations. For
    // `gltf`/`baked` the null is the declared answer; for a kind nobody taught it about, the
    // same null meant "no idea what this is". An author could add a union arm, satisfy the
    // two dispatches that refuse to compile, and leave this one returning null forever — the
    // renderer drawing nothing, and nothing anywhere saying why.
    //
    // Now it is a `switch` closed by a `never`, so a seventh descriptor kind is a compile
    // error here as well, and the cast-built stand-in below is refused BY NAME. The row's
    // subject was never "can it build an unknown kind" — it cannot, and should not — it was
    // whether the author is TOLD. So that is what the probe asks.
    //
    // ⚠️ THIS PROBE USED TO SET A SECOND, DISAGREEING `ref.kind`, and the note here used to
    // count TWO loud sites next door. Both were true of the pre-D8 handle, which carried its
    // kind twice; step 8 removed the outer field, so the probe has nothing left to disagree
    // with and the loud sites are counted honestly.
    name: 'buildFromDescriptor',
    // "Handles it, OR names its refusal." Both halves are needed and neither alone is the
    // row: a surface that builds the candidate has nothing to tell the author, and one that
    // cannot build it discharges the same duty by saying so with the kind in the message.
    // Silence is the only failing answer, which is what this row was named for. The instrument
    // control below takes the first half and the probe takes the second, so a regression to
    // the if-chain reds this row through the probe while the control stays green.
    knows: (c) => readGeometry(c.geometry).status === 'ok' || refusesByName(c),
  },
  {
    // The bypass — and this row is the first one the phase has CLOSED, so what it asks
    // changed with it (step 4).
    //
    // Before: there was no declaration of a bypass anywhere in the category. Each operator
    // spelled `muted` into its own param schema and `operatorStack` read it back through a
    // cast that could not tell "declared and set false" from "never declared at all", so
    // the honest probe was "does this node's schema happen to carry the field?".
    //
    // Now the chain record carries a `bypass`, it is refused at registration if absent, and
    // the `passthrough` arm is refused unless the schema really declares a boolean of the
    // name it gives. So the question is no longer whether an author remembered a field — it
    // is whether the operator declared one, and a registered operator that did not declare
    // one has no constructor. The probe asks the real question; the answer being
    // structurally unable to come back `false` is the row closing, not the probe going soft.
    name: 'the bypass declaration',
    knows: (c) => {
      const def = getNodeType(c.type);
      if (!def) return null;
      // Not an operator at all — a different answer from "an operator with no bypass".
      if (!def.chain) return null;
      return def.chain.bypass !== undefined;
    },
  },
];

/**
 * Does the registry NAME its refusal when handed a descriptor kind it has no arm for?
 *
 * Captured rather than asserted here, because this is a probe and not a test: it answers the
 * silence question for the census above, and the census is what decides. A `null` would mean
 * the probe could not read its own subject; there is no such case here, since the read door
 * always returns and the spy always installs.
 */
function refusesByName(candidate: OperatorCandidate): boolean {
  const said: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    said.push(args.map(String).join(' '));
  });
  try {
    readGeometry(candidate.geometry);
  } finally {
    spy.mockRestore();
  }
  // BY NAME, not merely loudly: a message that does not carry the offending kind sends the
  // author back to a bisect, which is most of what the silence cost in the first place.
  return said.some((line) => line.includes(PROBE_DESCRIPTOR_KIND));
}

/** Which surfaces do not know about `candidate`, and which could not be read at all. */
function surfacesBlindTo(candidate: OperatorCandidate): {
  blind: string[];
  unreadable: string[];
} {
  const blind: string[] = [];
  const unreadable: string[] = [];
  for (const surface of SURFACES) {
    const answer = surface.knows(candidate);
    if (answer === null) unreadable.push(surface.name);
    else if (!answer) blind.push(surface.name);
  }
  return { blind, unreadable };
}

/** `ArrayModifier` — the known member. Every surface must know it, or the probe is broken. */
const KNOWN_MEMBER: OperatorCandidate = {
  type: 'ArrayModifier',
  geometry: arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 2, [2, 0, 0]),
};

/** The minted operator. Its handle names a descriptor kind `buildFromDescriptor` has no arm for. */
const PROBE: OperatorCandidate = {
  type: PROBE_TYPE,
  // 🔴 THIS FIXTURE USED TO CARRY `kind: 'array'` BESIDE THE PROBE DESCRIPTOR, and that is
  // worth recording because the fixture was itself an instance of the defect step 8 removed:
  // a handle whose two kind fields DISAGREED, constructible only through the cast on the
  // next line. It made `availabilityOf` answer for `array` while the build switch fell
  // through on `ns2probe`. D8 deleted the outer field, so the disagreement has no
  // constructor and the probe can no longer say two things about itself.
  geometry: {
    key: `${PROBE_DESCRIPTOR_KIND}|probe`,
    descriptor: { kind: PROBE_DESCRIPTOR_KIND },
  } as unknown as GeometryRef,
};

/**
 * Register the minted operator: a well-formed geometry modifier that declares its chain
 * spine and its inspector home, and is absent from every hand-maintained list.
 *
 * It deliberately does NOT declare `muted` — that is not an omission in the fixture, it is
 * the fifth blindness. Nothing in the repo requires an operator to declare a bypass, so an
 * operator that forgets one is exactly what a real new modifier looks like.
 */
function registerProbeOperator(): void {
  registerNodeType({
    type: PROBE_TYPE,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({
      turns: z.number().int().min(1).default(2),
      muted: z.boolean().default(false),
    }),
    inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
    outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
    chain: {
      input: 'target',
      scope: { kind: 'source' },
      bypass: { kind: 'passthrough', param: 'muted' },
      section: 'modifier',
    },
    inspectorSections: ['modifier'],
    home: { turns: 'modifier', muted: 'modifier' },
    evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.target,
  } as never);
}

describe('ns-2 step 1 — the surfaces a new geometry operator is invisible to', () => {
  beforeEach(() => {
    // `__resetRegistryForTests` CLEARS; the reseed is what puts the 80 production types
    // back. Without it the probe would be measured against an empty registry, where every
    // surface is trivially blind to everything.
    __resetRegistryForTests();
    __reseedAllNodesForTests();
    registerProbeOperator();
  });

  it('THE INSTRUMENT CONTROL: every surface knows the operator that is demonstrably there', () => {
    // If this ever reports a blind surface for `ArrayModifier`, the finding is about the
    // probe. Read the file before reading the count.
    expect(surfacesBlindTo(KNOWN_MEMBER)).toEqual({ blind: [], unreadable: [] });
  });

  it('THE INSTRUMENT CONTROL: every probe could read its own subject', () => {
    // Required to be empty BEFORE the blindness list below is worth reading — a probe that
    // reaches through a name it guessed reports a clean zero, and a false zero that agrees
    // with the thesis is the expensive kind.
    expect(surfacesBlindTo(PROBE).unreadable).toEqual([]);
  });

  it('THE PIN: adding one geometry operator is invisible to exactly two surfaces', () => {
    // The phase's first exit clause is that this array becomes empty. Until then it is the
    // measurement, and it RATCHETS: it opened at five and each closed row leaves it, so the
    // list is the phase's progress rather than a description of it.
    //
    // FIVE -> FOUR, at step 4: `the bypass declaration` left. Being an operator became one
    // declaration carrying four fields instead of four things to remember separately, and
    // registration refuses a chain record that omits any of them — so an operator that
    // forgot its bypass has no constructor.
    //
    // FOUR -> TWO, at step 7. Both remaining spellings of MEMBERSHIP left together, and
    // they had to: `MODIFIER_NODE_TYPES` and the "+ Add" menu are now the same declaration
    // read twice, so the state each row described — a registered geometry operator absent
    // from the set, or absent from the menu — has no constructor either. Membership is
    // `chain.section`, and an operator that declares no section is not an operator of that
    // stack rather than a forgotten one.
    //
    // TWO -> ONE, at step 8b. `buildFromDescriptor` was an if-chain whose terminal `return
    // null` could not tell a DECLARED null (`gltf`/`baked`, built elsewhere on purpose) from
    // "no idea what this is". It is now a `switch` closed by a `never`, so the state this row
    // described — an author adds a descriptor kind, this file says nothing, the renderer
    // draws nothing — has no constructor: the union arm does not compile until it is taught.
    //
    // 🔴 THE ONE THAT REMAINS IS HONEST, NOT PENDING. The agent enum is a `z.enum` whose
    // literal tuple is what lets the mutator narrow per modifier type; deriving it yields
    // `string` and kills that narrowing, so it is KEPT and cross-checked exactly against the
    // derived set (with a minted liar) instead. A cross-check is LOUD IN CI, which is a real
    // improvement — and it is still not the same thing as unconstructible, so the row stays
    // here rather than being retired on the strength of a gate existing somewhere else.
    expect(surfacesBlindTo(PROBE).blind).toEqual(['ModifierType (agent enum)']);
  });

  it('the build switch refuses BY NAME — the silence this row was named for is gone', () => {
    // The registry has a refusal vocabulary — `faceCountMismatch` and `groupsRefusal`, both
    // named, both spoken through the console. Until step 8b an unknown descriptor kind
    // reached none of it: the renderer got no geometry and nothing anywhere said why. It now
    // reaches that vocabulary, at a higher severity than its two neighbours on purpose —
    // they report DATA disagreeing with data, which a scene can cause, while this reports a
    // union that grew past its own switch, which only this file can cause.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    let result;
    try {
      result = readGeometry(PROBE.geometry);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    // BY NAME is the whole claim: a bare "something went wrong" would leave the author where
    // the silence left them. The offending kind has to be IN the message.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(PROBE_DESCRIPTOR_KIND);
    // It refuses without pretending to be a data disagreement — the two warn-level refusals
    // are about the index and the face count, and neither applies to a kind nobody built.
    expect(warn).not.toHaveBeenCalled();

    // 🔴 WHAT STEP 8b DOES NOT CLOSE, RECORDED HERE RATHER THAN LEFT TO BE REDISCOVERED.
    // The read still comes back with an out-of-vocabulary `undefined` status, and that is a
    // DIFFERENT fall-through in the same file, one function upstream: `availabilityOf` and
    // `readGeometry` each close on a `never` whose runtime arm returns the value it could not
    // classify. Step 8 surfaced it (the status used to read `'none'`, but only because the
    // pre-D8 fixture could lie about its kind). Closing it changes a read door's contract on
    // the render path, which is not this step's to change — filed as #675, not absorbed.
    expect(result.status).toBeUndefined();
    expect(['ok', 'elsewhere', 'pending', 'none']).not.toContain(result.status);
  });
});
