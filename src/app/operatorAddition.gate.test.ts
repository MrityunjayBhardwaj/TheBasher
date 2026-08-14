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
import { MODIFIER_NODE_TYPES } from './operatorChain';
import { arrayGeometryRef, boxGeometryRef } from './modifierGeometry';
import { readGeometry } from './geometryRegistry';
import { addModifierMutator } from '../agent/mutators/builders/addModifier';
import { stripComments } from '../test-utils/sourceScan';
import { sourceFiles } from '../../tools/gates/sourceFiles';
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

/** A file's contents, comment-stripped, from the one enumeration the repo's gates walk. */
function strippedSource(path: string): string | null {
  const entry = sourceFiles().find(([p]) => p === path);
  return entry ? stripComments(entry[1]) : null;
}

/**
 * The literal array body of `const <name> = [ … ];` in an already-stripped source.
 *
 * Returns `null` when the declaration cannot be found — the difference between "this menu
 * does not offer the operator" and "this probe is aimed at a block that no longer exists".
 */
function arrayLiteralBody(stripped: string | null, name: string): string | null {
  if (stripped === null) return null;
  const match = new RegExp(`const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(stripped);
  return match ? match[1] : null;
}

const SURFACES: readonly Surface[] = [
  {
    // A `ReadonlySet` of type strings. Nothing derives it and nothing checks it; a modifier
    // missing from it is not a modifier as far as the stack walker is concerned.
    name: 'MODIFIER_NODE_TYPES',
    knows: (c) => (MODIFIER_NODE_TYPES.size === 0 ? null : MODIFIER_NODE_TYPES.has(c.type)),
  },
  {
    // The "+ Add" menu. NOT exported, so this is a source census — hence the `null` arm,
    // which fires if the declaration is ever renamed or reshaped out from under the regex.
    name: 'ADDABLE (modifier)',
    knows: (c) => {
      const body = arrayLiteralBody(strippedSource('src/app/ModifierStackControls.tsx'), 'ADDABLE');
      return body === null ? null : body.includes(`'${c.type}'`);
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
    // The build switch. Probed through the registry's own read door with a handle whose
    // DESCRIPTOR carries the new kind while `ref.kind` stays a kind that already exists —
    // because the two loud sites next door (`GeometryRef['kind']` and `availabilityOf`, both
    // closed by a `never`) are compile errors, so the honest isolation of the silent one is
    // an author who did the loud sites and forgot this one.
    name: 'buildFromDescriptor',
    knows: (c) => readGeometry(c.geometry).status === 'ok',
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
  geometry: {
    key: `${PROBE_DESCRIPTOR_KIND}|probe`,
    kind: 'array',
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

  it('THE PIN: adding one geometry operator is invisible to exactly four surfaces', () => {
    // The phase's first exit clause is that this array becomes empty. Until then it is the
    // measurement, and it RATCHETS: it opened at five and each closed row leaves it, so the
    // list is the phase's progress rather than a description of it.
    //
    // FIVE -> FOUR, at step 4: `the bypass declaration` left. Being an operator is now one
    // declaration carrying four fields instead of four things to remember separately, and
    // registration refuses a chain record that omits any of them — so an operator that
    // forgot its bypass has no constructor. That is why this row cannot come back by
    // someone simply not noticing; it can only come back by deleting a refusal.
    expect(surfacesBlindTo(PROBE).blind).toEqual([
      'MODIFIER_NODE_TYPES',
      'ADDABLE (modifier)',
      'ModifierType (agent enum)',
      'buildFromDescriptor',
    ]);
  });

  it('the build switch refuses SILENTLY — null, no throw, no warning', () => {
    // This is what makes the row above a blindness rather than a bug report. The registry
    // has a refusal vocabulary (`faceCountMismatch`, `groupsRefusal`) and warns through it;
    // an unknown descriptor kind reaches none of it. The renderer gets no geometry and
    // nothing anywhere says why.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = readGeometry(PROBE.geometry);
      expect(result.status).toBe('none');
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
