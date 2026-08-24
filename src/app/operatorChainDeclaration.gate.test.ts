// ns-2 step 4 — THE OPERATOR BASE: everything true of an operator BECAUSE it is one,
// declared once, censused exactly, and refused at registration when it is partial.
//
// ── WHAT THIS STEP ACTUALLY CHANGES ───────────────────────────────────────────────────
//
// `chainInput` was one true statement about the category with nothing beside it, so every
// OTHER cross-cutting property went on being spelled per member: the bypass in 19
// independent schema declarations across two vocabularies, membership in seven
// hand-maintained lists, stack section nowhere at all. Widening the field to a record does
// not by itself fix any of those — steps 5 to 7 do. What it fixes is the SHAPE of the next
// property's arrival: `scope`, the thing this phase exists to add, lands as a field on a
// record every operator already fills in, rather than as an eighth thing to remember.
//
// ── WHY THE CENSUSES ARE EXACT SETS AND NOT COUNTS ────────────────────────────────────
//
// A count is satisfied by the wrong members. These are the sets a later step DERIVES the
// stacks from, so a declaration that is merely plausible — a scene-lane wrapper labelled
// `material` because it has something to do with materials — would produce a stack
// offering three members where it has two, and would do it quietly, one commit after the
// label was written. The exact sets are what make such a label fail on the day it is
// typed instead of on the day something reads it.
//
// ── THE ONE EMPTY SET, ASSERTED AS EMPTY ──────────────────────────────────────────────
//
// `scope: unscoped, why: 'declined'` is the escape hatch: "this operator COULD be scoped
// and is not, yet". Today nothing uses it and the census says so exactly. An escape hatch
// nobody can see the size of is how a temporary exemption becomes permanent, so the empty
// set is asserted rather than left to be discovered later by counting.
//
// REF: `.anvi/…/phases/ns-2-component-groups/PLAN.md` §8 step 4 + §5 D0/D1/D6;
//      src/core/dag/types.ts (`ChainDeclaration`, `ScopeKind`, `BypassKind`);
//      src/core/dag/registry.ts (the two refusals);
//      src/app/chainSpine.test.ts (the minted `cutter` discriminator this rests on);
//      tools/gates/sourceFiles.ts; issues #396, #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  __resetRegistryForTests,
  getNodeType,
  listNodeTypes,
  registerNodeType,
} from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { hashValue } from '../core/dag/hash';
import { stripComments } from '../test-utils/sourceScan';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import type { ChainDeclaration } from '../core/dag/types';

/** Every registered type declaring a chain, with its declaration. */
function operators(): [string, ChainDeclaration][] {
  return listNodeTypes()
    .map((type) => [type, getNodeType(type)?.chain] as [string, ChainDeclaration | undefined])
    .filter((entry): entry is [string, ChainDeclaration] => entry[1] !== undefined)
    .sort();
}

/** The operators whose declaration satisfies `pred`, by name. */
function where(pred: (chain: ChainDeclaration) => boolean): string[] {
  return operators()
    .filter(([, chain]) => pred(chain))
    .map(([type]) => type)
    .sort();
}

/** A minimal well-formed operator definition, for the refusal controls to break one field of. */
function probeDef(chain: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'TmpChainProbe',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ muted: z.boolean().default(false) }),
    inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
    outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
    chain,
    evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.target,
    ...overrides,
  };
}

describe('ns-2 step 4 — being an operator is ONE declaration', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('all eight operators declare a TOTAL chain — no partial operator exists', () => {
    expect(operators().map(([type]) => type)).toEqual([
      'ArrayModifier', // data lane — geometry
      'ColorCorrect', // effect lane
      'MaskModifier', // data lane — geometry (#668/#671, the first that REMOVES faces)
      'MaterialOverride', // scene lane
      'MaterialOverrideOp', // data lane — material
      'MirrorModifier', // data lane — geometry
      'SetMaterialOp', // data lane — material
      'Transform', // scene lane
    ]);

    for (const [type, chain] of operators()) {
      for (const field of ['input', 'scope', 'bypass', 'section'] as const) {
        expect(chain[field], `${type}.chain.${field}`).toBeDefined();
      }
    }
  });

  it('SCOPE is declared per operator, and the escape hatch is EMPTY again', () => {
    // Generators: the selection names what they GENERATE FROM.
    expect(where((c) => c.scope.kind === 'source')).toEqual(['ArrayModifier', 'MirrorModifier']);
    // Writers: the selection names what RECEIVES the write.
    expect(where((c) => c.scope.kind === 'target')).toEqual([
      // #668 — survival IS the write. The selection names the faces the mask acts on, and
      // nothing is merged back, which is what separates it from the two generators above.
      'MaskModifier',
      'MaterialOverrideOp',
      'SetMaterialOp',
    ]);
    // Not a choice: the spine value has no components at all.
    expect(
      where((c) => c.scope.kind === 'unscoped' && c.scope.why === 'no-component-domain'),
    ).toEqual(['ColorCorrect', 'MaterialOverride', 'Transform']);

    // 🔴 THIS ASSERTED THE EMPTY SET UNTIL ns-2 STEP 17, AND THE ROW DID EXACTLY WHAT IT
    // WAS WRITTEN FOR. `declined` means "could be scoped, is not, YET", and the comment
    // here said: *the day one appears, this reds and somebody has to say so out loud in
    // the diff.* Step 17's honouring cross-check found `MaterialOverrideOp` declaring
    // `target` and emitting byte-identical output for a total selection and for half the
    // faces — a lying label, shipped. Re-declaring it truthfully is what put it here.
    //
    // ⚠️ SO THE EMPTY SET WAS NEVER EVIDENCE OF ANYTHING. It was empty because the
    // operator that belonged in it had declared something else, which is precisely the
    // failure an exact census of the empty set cannot see on its own — it needs the
    // honouring check beside it. Both are now asserted, and they are what disagree when a
    // declaration drifts from behaviour again.
    //
    // ✅ #682 LANDED AND THIS IS EMPTY AGAIN — with the `target` set above regaining its
    // second member, exactly the pair this comment predicted. The round trip is the thing
    // worth keeping: an empty `declined` set now means something it did not mean the first
    // time, because the honouring check ran beside it on the way out AND on the way back.
    // An empty set is only evidence when something else would have been non-empty had the
    // claim been false.
    expect(where((c) => c.scope.kind === 'unscoped' && c.scope.why === 'declined')).toEqual([]);
  });

  it('BYPASS is declared, and `none` is an ANSWER rather than an omission', () => {
    expect(where((c) => c.bypass.kind === 'none')).toEqual(['MaterialOverride', 'Transform']);

    // Every passthrough names a param its own schema really declares — which is what the
    // registration refusal enforces, asserted here so the enforcement has a witness.
    for (const [type, chain] of operators()) {
      if (chain.bypass.kind !== 'passthrough') continue;
      const shape = (
        getNodeType(type)?.paramSchema as unknown as { shape?: Record<string, unknown> }
      ).shape;
      expect(shape, `${type} paramSchema shape`).toBeDefined();
      expect(Object.keys(shape ?? {}), `${type} declares ${chain.bypass.param}`).toContain(
        chain.bypass.param,
      );
    }
  });

  it('SECTION is declared, and the two nodes in no stack are the two with nothing to bypass', () => {
    expect(where((c) => c.section === 'modifier')).toEqual([
      'ArrayModifier',
      'MaskModifier',
      'MirrorModifier',
    ]);
    expect(where((c) => c.section === 'material')).toEqual(['MaterialOverrideOp', 'SetMaterialOp']);
    expect(where((c) => c.section === 'effect')).toEqual(['ColorCorrect']);
    expect(where((c) => c.section === 'none')).toEqual(['MaterialOverride', 'Transform']);

    // THE SYMMETRY IS THE EVIDENCE THE BOUNDARY IS DRAWN RIGHT, and it is worth asserting
    // rather than admiring: the operators that belong to no offered stack are exactly the
    // operators that have nothing to bypass. Two independently-declared fields agreeing
    // member for member is a much stronger signal than either alone — and if a later
    // declaration breaks the agreement, that is a real question, not a formatting slip.
    expect(where((c) => c.section === 'none')).toEqual(where((c) => c.bypass.kind === 'none'));
  });

  it('REFUSAL 1: a partial chain declaration is refused at registration, by name', () => {
    // The type already requires all four. It is refused at runtime as well because every
    // synthetic definition in this suite registers through an `as never`, typecheck skips
    // test files, and vitest checks no types — so without this, the tier that mints the
    // most declarations is the tier nothing checks.
    expect(() =>
      registerNodeType(
        probeDef({
          input: 'target',
          bypass: { kind: 'passthrough', param: 'muted' },
          section: 'modifier',
        }) as never,
      ),
    ).toThrow(/missing scope/);

    expect(() =>
      registerNodeType(probeDef({ input: 'target', scope: { kind: 'source' } }) as never),
    ).toThrow(/missing bypass, section/);
  });

  it('REFUSAL 2: a bypass naming a param the schema does not declare is refused, by name', () => {
    // The failure this closes is the phase's own defect one level up: a declaration that
    // reads correctly and is honoured by nobody. Reading an absent param yields `undefined`,
    // `undefined` is falsy, so the operator would simply never bypass and nothing would say
    // so — the exact shape of a label that passes every behavioural test.
    expect(() =>
      registerNodeType(
        probeDef({
          input: 'target',
          scope: { kind: 'source' },
          bypass: { kind: 'passthrough', param: 'bypassed' },
          section: 'modifier',
        }) as never,
      ),
    ).toThrow(/names param 'bypassed', which this node's paramSchema does not declare/);
  });

  // ── ns-2 step 5 ADDED TWO MORE, and both back the single application site ──────────
  //
  // Step 5 moved the bypass out of the five operators and into the evaluator, which reads
  // `params[chain.bypass.param]` strictly and hands back `resolved[chain.input]`. Those two
  // lines rest on two properties step 4 asserted in prose and did not enforce. Enforcing
  // them here is what makes the surviving read a CHECKED read rather than one more guess.

  it('REFUSAL 3: a spine that is not a declared SINGLE input is refused, by name', () => {
    // A bypass hands back "the value that arrived on the spine". A spine naming a socket
    // the node does not declare has no value to hand back, and a LIST socket would hand
    // back an array where the output promises one value — a shape nothing downstream
    // branches on, so it would travel a long way before anyone noticed.
    expect(() =>
      registerNodeType(
        probeDef({
          input: 'nonesuch',
          scope: { kind: 'source' },
          bypass: { kind: 'passthrough', param: 'muted' },
          section: 'modifier',
        }) as never,
      ),
    ).toThrow(/names socket 'nonesuch', which this node does not declare as an input/);

    expect(() =>
      registerNodeType(
        probeDef(
          {
            input: 'target',
            scope: { kind: 'source' },
            bypass: { kind: 'passthrough', param: 'muted' },
            section: 'modifier',
          },
          { inputs: { target: { type: 'ObjectData', cardinality: 'list' } } },
        ) as never,
      ),
    ).toThrow(/which has 'list' cardinality/);
  });

  it('REFUSAL 4: a bypass naming a NON-BOOLEAN param is refused, by name', () => {
    // Step 4's refusal 2 checked only that the name EXISTS. A param declared under the
    // right name holding something other than a boolean would type-check, register
    // cleanly, and never bypass — because the application site reads it strictly. That is
    // the same silent failure refusal 2 closed, one field over, and it was reachable until
    // this line existed.
    //
    // Asked BEHAVIOURALLY — does the field accept both booleans and reject a non-boolean —
    // rather than by reading zod's internals, which are private and change between
    // versions. A `.default(false)` wraps the boolean schema, so a typeName check would
    // have to know that; `safeParse` does not care.
    expect(() =>
      registerNodeType(
        probeDef(
          {
            input: 'target',
            scope: { kind: 'source' },
            bypass: { kind: 'passthrough', param: 'muted' },
            section: 'modifier',
          },
          { paramSchema: z.object({ muted: z.number().default(0) }) },
        ) as never,
      ),
    ).toThrow(/does not declare as a boolean/);

    // THE CONTROL: the same probe with a real boolean registers. Without this row the
    // assertion above would pass on a refusal that rejected every declaration.
    expect(() =>
      registerNodeType(
        probeDef({
          input: 'target',
          scope: { kind: 'source' },
          bypass: { kind: 'passthrough', param: 'muted' },
          section: 'modifier',
        }) as never,
      ),
    ).not.toThrow();
  });

  it('ONE spelling: `chainInput` survives only in prose about what it was', () => {
    // A consolidation that leaves the old spelling beside the new one has ADDED a spelling.
    // Comment-stripped, so the historical notes in `types.ts` — which say what the field
    // WAS — are not violations, and a live re-declaration is.
    //
    // 🔴 THE DENOMINATOR IS ASSERTED, and it was not until the merge-gate review. MEASURED:
    // with `sourceFiles()` stubbed to return `[]` this file passed 10 of 10 — this row
    // reporting a clean empty set having opened nothing — while 56 tests across 22 files
    // redded. So the suite was never blind to an empty walk; THIS ROW was, and a row that
    // cannot tell "nobody spells it that way" from "I read nothing" is the rubber stamp it
    // was written to prevent. Its siblings across the phase's gates already carried this.
    const files = sourceFiles();
    const live = files
      .map(([path, src]) => [path, stripComments(src)] as const)
      .filter(([, src]) => /\bchainInput\b/.test(src))
      .map(([path]) => path);
    expect(files.length, 'the source walk read nothing').toBeGreaterThan(500);
    expect({ examined: files.length, live }).toEqual({ examined: files.length, live: [] });
  });

  it('the declaration is on the DEFINITION, so it cannot reach a value or params hash', () => {
    // Structural today — the evaluator keys on node id, type, version, params and inputs,
    // and nothing spreads a definition into a value. Pinned anyway because the failure mode
    // is invisible: a record folded into the params hash re-mints every cached entry for
    // every operator at once, and the only symptom is that everything is a little slower.
    expect(hashValue({ count: 3, offset: [2, 0, 0], muted: false })).toBe(
      hashValue({ count: 3, offset: [2, 0, 0], muted: false }),
    );
    const withChain = {
      count: 3,
      offset: [2, 0, 0],
      muted: false,
      chain: getNodeType('ArrayModifier')?.chain,
    };
    expect(hashValue(withChain)).not.toBe(hashValue({ count: 3, offset: [2, 0, 0], muted: false }));
  });
});
