// The registry gate: a data kind cannot exist without a conformance descriptor.
//
// Node types are STRINGS, so there is no compiler exhaustiveness to lean on here — a
// fifth `ObjectData` producer can register with nothing anywhere forcing anyone to
// notice. The registry substitutes for the missing `never`: rows come from what is
// actually registered, never from a list somebody maintains, so #388 and #389 redden
// this file on arrival rather than needing to be remembered.
//
// Which makes assertion order load-bearing. If the `ObjectData` filter ever drifts —
// a renamed socket, a changed output type — it silently matches nothing, and a sweep
// over nothing passes for every kind forever. So the FIRST assertion is that the
// filter still finds the kinds we know exist. Guard the guard, then guard.
//
// REF: src/test-utils/splitKinds.ts; src/app/inspectorSectionsRegistry.test.ts (the
//      same shape, for section reachability); issue #471.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, snapshotRegistry } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { inputAccepts } from '../core/dag/types';
import type { InputDescriptor } from '../core/dag/types';
import {
  isDataKindDef,
  isDataOperatorDef,
  OBJECT_SECTIONS,
  SPLIT_KINDS,
  SPLIT_KIND_NAMES,
  type DataLaneDef,
} from './splitKinds';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/**
 * Every node type in `snap` that is a data KIND — an `ObjectData` producer that is not
 * merely an operator over `ObjectData`.
 *
 * #415: this used to be "emits ObjectData", full stop, and the modifier stack moving
 * onto the data lane made that over-broad — a modifier produces the socket without
 * being a kind of data. The discriminator lives in `splitKinds.ts` because the outliner
 * icon sweep derives the same set and the two must not drift apart.
 */
function dataTypesIn(snap: Record<string, DataLaneDef>) {
  return Object.entries(snap)
    .filter(([, def]) => isDataKindDef(def))
    .map(([type]) => type);
}

/** THE GATE, as a function of a registry snapshot rather than of global state — which
 *  is what lets the falsification below run it against a registry containing a kind
 *  that does not exist, instead of against a doctored copy of one that does. */
function undescribedDataTypes(snap: Record<string, DataLaneDef>): string[] {
  const described = new Set(SPLIT_KIND_NAMES.map((k) => SPLIT_KINDS[k].dataType));
  return dataTypesIn(snap).filter((t) => !described.has(t));
}

/** Every registered node type whose `out` socket produces an `ObjectData`. */
function registeredDataTypes(): string[] {
  return dataTypesIn(snapshotRegistry());
}

describe('the split-kind registry gate', () => {
  it('the ObjectData filter still finds the kinds we know exist (guard the guard)', () => {
    // Five kinds are split today: box, sphere, curve, light, camera. If this drops below
    // five the filter has drifted and every assertion below would pass vacuously.
    expect(
      registeredDataTypes().length,
      'fewer than 5 ObjectData-output node types found — the registry filter has drifted, ' +
        'and every check in this file is now passing over an empty set',
    ).toBeGreaterThanOrEqual(5);
  });

  it('every registered ObjectData kind has a conformance descriptor', () => {
    const undescribed = undescribedDataTypes(snapshotRegistry());
    expect(
      undescribed,
      `these node types output ObjectData but have no entry in SPLIT_KINDS, so no ` +
        `conformance road runs for them — they can ship with any road silently broken: ` +
        `${undescribed.join(', ')}`,
    ).toEqual([]);
  });

  // The falsification of the assertion above, kept rather than run once and thrown away.
  //
  // It has to introduce a kind that does NOT exist. Deleting BoxData's descriptor and
  // watching the gate fire would only prove the comparison runs — box is the case the
  // gate already covers, and a generalization cannot be falsified by a special case it
  // already absorbed. A synthetic fifth kind is the thing the gate CLAIMS to catch and
  // has never actually seen.
  it('a NEW ObjectData kind with no descriptor is reported by name', () => {
    const withSynthetic = {
      ...snapshotRegistry(),
      // A kind nobody has written a descriptor for — what #388 and #389 will look like
      // on the day they land.
      TeapotData: { outputs: { out: { type: 'ObjectData' } } },
    };
    expect(undescribedDataTypes(withSynthetic)).toEqual(['TeapotData']);
  });

  // THE CONTROL ON THE NARROWING, and it is the assertion that makes #415's change to
  // this gate honest rather than convenient.
  //
  // #415 taught `dataTypesIn` to skip data-lane OPERATORS, which is a narrowing — and a
  // narrowed gate is indistinguishable from a weakened one unless something proves it
  // still catches what it used to. So both arms run against the SAME synthetic registry:
  // an operator (data in, data out) must be skipped, and a kind sitting right beside it
  // must still be named. If the exclusion were written even slightly too wide — matching
  // any node with a `target` input, say — the teapot would vanish with it and this test
  // would fail rather than quietly reporting an empty set forever.
  it('NARROWING CONTROL — an operator on the data lane is skipped; a real kind beside it is not', () => {
    const withBoth = {
      ...snapshotRegistry(),
      // A modifier-shaped node: the same socket type on both sides, which is exactly
      // what makes it stackable and exactly why it is not a KIND of data. #396 — it
      // must NOMINATE that socket as its chain; being shaped like an operator is no
      // longer enough to be treated as one, and this fixture stating so is the point
      // rather than a chore. A synthetic def that forgot to declare a spine is exactly
      // the real-registry mistake the exact-set census in chainSpine.test.ts guards.
      SubdivideModifier: {
        inputs: { target: { type: 'ObjectData' } },
        outputs: { out: { type: 'ObjectData' } },
        chainInput: 'target',
      },
      TeapotData: { outputs: { out: { type: 'ObjectData' } } },
    };
    expect(undescribedDataTypes(withBoth)).toEqual(['TeapotData']);

    // …and the predicate says so directly, not just by the set it produces.
    expect(isDataKindDef(withBoth.SubdivideModifier)).toBe(false);
    expect(isDataKindDef(withBoth.TeapotData)).toBe(true);
  });

  it('every descriptor names a node type that is actually registered', () => {
    // The other direction. A descriptor for a type that no longer exists would keep the
    // matrix looking full while covering a kind nobody ships.
    const registered = new Set(registeredDataTypes());
    for (const name of SPLIT_KIND_NAMES) {
      const spec = SPLIT_KINDS[name];
      expect(
        registered.has(spec.dataType),
        `SPLIT_KINDS.${name} describes "${spec.dataType}", which is not a registered ` +
          `ObjectData producer — the descriptor has outlived its kind`,
      ).toBe(true);
    }
  });

  it('every kind names at least one primary workflow that routes through a moved param', () => {
    // An empty list reads as coverage while asserting nothing — the same failure mode
    // this whole file exists to prevent, one level up. Each kind has to say which of its
    // real workflows the split put at risk, because that is what has to be checked
    // before it merges.
    for (const name of SPLIT_KIND_NAMES) {
      expect(
        SPLIT_KINDS[name].primaryWorkflows.length,
        `SPLIT_KINDS.${name}.primaryWorkflows is empty — name the workflows that route ` +
          `through a param the split moved, or this kind reports coverage it does not have`,
      ).toBeGreaterThan(0);
    }
  });

  it('every NO answer a kind records names a reason and an issue', () => {
    // `roadAnswers` is where a road's answer may be NO. That is not a skip — the road
    // still runs the same steps and asserts the opposite outcome — but a NO with no
    // reason and no issue is indistinguishable from one, so the metadata is required.
    //
    // NECESSARY, NOT SUFFICIENT, and worth being explicit about: this checks the
    // ANNOTATION. What makes the answer honest is that the road itself evaluates
    // `roadAnswers?.management?.reaches ?? true` on BOTH sides (offer and accept) with
    // no early return, so a negative row applies the same stimulus. A metadata check
    // alone would be the kind of checklist this suite exists to replace.
    for (const name of SPLIT_KIND_NAMES) {
      const answer = SPLIT_KINDS[name].roadAnswers?.management;
      if (!answer || answer.reaches) continue;
      expect(answer.why.length, `SPLIT_KINDS.${name}: a NO must say why`).toBeGreaterThan(0);
      expect(answer.issue, `SPLIT_KINDS.${name}: a NO must name the issue that closes it`).toMatch(
        /#\d+/,
      );
    }
  });

  it('NEGATIVE CONTROL — the NO-answer check bites', () => {
    // No kind records a NO today, so the sweep above runs over an empty subject and
    // would be equally green if it were broken. Asserting the predicate against a
    // deliberately malformed answer is what keeps it a detector rather than a decoration.
    const bad = { reaches: false as const, why: '', issue: 'see the tracker' };
    expect(bad.why.length).toBe(0);
    expect(bad.issue).not.toMatch(/#\d+/);
  });

  it("each kind's dataSections MIRROR what the data node declares, exactly and in order", () => {
    // An EQUALITY, not a subset — that is the whole difference from the customSections
    // check below. The sections road asserts that selecting the Object renders every
    // section the pair declares AND nothing beyond it; a subset would let a section be
    // dropped from the descriptor and the road would still pass, having stopped looking
    // at it. Order is pinned too, because §5.8's default-collapsed rule keys off the
    // first entry, so a reordered list is a different UI.
    const snap = snapshotRegistry();
    for (const name of SPLIT_KIND_NAMES) {
      const spec = SPLIT_KINDS[name];
      expect(
        spec.dataSections,
        `SPLIT_KINDS.${name}.dataSections has drifted from ${spec.dataType}.inspectorSections — ` +
          `the sections road would assert against a list the product no longer declares`,
      ).toEqual(snap[spec.dataType]?.inspectorSections ?? []);
    }
  });

  it('OBJECT_SECTIONS mirrors what the Object declares', () => {
    // The other half of the same pin. Every kind pairs the SAME Object, so this list is
    // shared across all six rows — which makes a single drift here wrong six times over.
    const snap = snapshotRegistry();
    expect(
      OBJECT_SECTIONS,
      'OBJECT_SECTIONS has drifted from ObjectNode.inspectorSections',
    ).toEqual(snap['Object']?.inspectorSections ?? []);
    // Guard the guard: an empty registry lookup would make the equality above pass only
    // if the constant were also empty, but it would pass SILENTLY the day someone empties
    // both. The Object owning a transform section is the split's founding claim.
    expect(OBJECT_SECTIONS, 'the Object half must own transform').toContain('transform');
  });

  it("each kind's customSections are sections the node actually declares", () => {
    // Carried for the sections road in the e2e tier. Pinning it against the live
    // declaration means it cannot quietly go stale in the meantime.
    const snap = snapshotRegistry();
    for (const name of SPLIT_KIND_NAMES) {
      const spec = SPLIT_KINDS[name];
      const declared = snap[spec.dataType]?.inspectorSections ?? [];
      for (const section of spec.customSections) {
        expect(
          declared,
          `SPLIT_KINDS.${name}.customSections names "${section}", which ${spec.dataType} ` +
            `does not declare in inspectorSections`,
        ).toContain(section);
      }
    }
  });

  it("each kind's base value differs from the param's schema default", () => {
    // H177: a fixture value equal to the fallback is a green test that proves nothing.
    // The read-equals-render road writes `base` and asserts it comes back; if `base`
    // happened to BE the default, a road that silently returns the default would pass.
    const snap = snapshotRegistry();
    for (const name of SPLIT_KIND_NAMES) {
      const spec = SPLIT_KINDS[name];
      const [base, overlaid] = spec.distinctValues;
      expect(base, `SPLIT_KINDS.${name}: base and overlaid values must differ`).not.toEqual(
        overlaid,
      );

      // Parse the kind's minimum valid params and read the observable back out — that is
      // the schema default for this param, whatever the schema happens to say.
      const parsed = snap[spec.dataType]?.paramSchema?.safeParse({ ...spec.baseDataParams });
      expect(
        parsed?.success,
        `SPLIT_KINDS.${name}.baseDataParams does not satisfy ${spec.dataType}'s schema — a ` +
          `fixture built from it would measure its own fallback, not the node`,
      ).toBe(true);
      if (!parsed?.success) continue;
      let def: unknown = parsed.data;
      for (const key of spec.observableDataParam.split('.')) {
        if (def === null || typeof def !== 'object') {
          def = undefined;
          break;
        }
        def = (def as Record<string, unknown>)[key];
      }
      expect(
        base,
        `SPLIT_KINDS.${name}: base value equals ${spec.dataType}'s default for ` +
          `"${spec.observableDataParam}" — a road that silently returns the default would ` +
          `pass this fixture`,
      ).not.toEqual(def);
    }
  });

  it('SET-VALUED SPINES: a spine is on the data lane iff its declared set contains ObjectData', () => {
    // `isDataOperatorDef` now CALLS `inputAccepts` (#612) rather than re-spelling it, so
    // the old AGREEMENT check between the two copies (#615) would compare a function with
    // itself. What that check was really protecting is kept here: the set-valued
    // population, which the registry does not contain.
    //
    // A sweep over the registry ALONE cannot exercise it. The only set-valued socket that
    // exists is `ParamDriver.in`, which is not on the data lane and which this predicate
    // never looks at — so the reader could stop handling sets entirely and every fixture
    // in the suite would still pass. These synthetic defs are the population that says no.
    const OUT_DATA = { out: { type: 'ObjectData' } };
    const cases: { name: string; def: DataLaneDef; expected: boolean }[] = [
      {
        name: 'spine accepts a set INCLUDING ObjectData',
        def: {
          chainInput: 'target',
          inputs: { target: { type: ['Mesh', 'ObjectData'] } },
          outputs: OUT_DATA,
        },
        expected: true,
      },
      {
        name: 'spine accepts a set EXCLUDING ObjectData',
        def: {
          chainInput: 'target',
          inputs: { target: { type: ['Mesh', 'SceneObject'] } },
          outputs: OUT_DATA,
        },
        expected: false,
      },
      {
        name: 'ObjectData is the FIRST member',
        def: {
          chainInput: 'target',
          inputs: { target: { type: ['ObjectData', 'Mesh'] } },
          outputs: OUT_DATA,
        },
        expected: true,
      },
      {
        name: 'scalar spine, the ordinary form',
        def: {
          chainInput: 'target',
          inputs: { target: { type: 'ObjectData' } },
          outputs: OUT_DATA,
        },
        expected: true,
      },
      {
        name: 'spine names a socket that is not declared',
        def: { chainInput: 'missing', inputs: {}, outputs: OUT_DATA },
        expected: false,
      },
    ];

    const wrong = cases
      .filter(({ def, expected }) => isDataOperatorDef(def) !== expected)
      .map(({ name }) => name);
    expect(wrong).toEqual([]);
    // Both answers are exercised, so this cannot pass by always returning one of them.
    expect(cases.filter((c) => c.expected).length).toBeGreaterThan(0);
    expect(cases.filter((c) => !c.expected).length).toBeGreaterThan(0);

    // And the shared reader agrees on the ordinary registry road too — the same call the
    // predicate makes, over every registered def, so a drift there is not invisible.
    for (const [name, def] of Object.entries(snapshotRegistry())) {
      const d = def as unknown as DataLaneDef;
      const spine = d?.chainInput;
      if (!spine) continue;
      expect(
        isDataOperatorDef(d),
        `${name}: the predicate and a direct \`inputAccepts\` read disagree`,
      ).toBe(
        inputAccepts(d?.inputs?.[spine] as InputDescriptor | undefined, 'ObjectData') &&
          d?.outputs?.out?.type === 'ObjectData',
      );
    }
  });

  it('the descriptor drags no module graph into Playwright — checked, not allowlisted', () => {
    // Both tiers share ONE descriptor. That only holds while it is importable from a
    // Playwright spec without dragging the graph in — the moment it needs `applyOp` or
    // `DagState`, the e2e tier needs its own second copy and the duplication this
    // module removed comes straight back. Cheaper to assert than to rediscover.
    //
    // #612 — this used to forbid every VALUE import of `core/dag` outright, which is what
    // forced `isDataOperatorDef` to re-spell the membership test. The rule was never
    // really about the path; it was about what the import DRAGS. So it is now derived:
    // a value import of `core/dag` is allowed only from a module that is itself leaf —
    // zero value imports of its own, therefore nothing to pull in. Widening this to a
    // path allowlist would let the exemption outlive the property that justified it; the
    // moment `socketMembership.ts` gains a value import, this fails.
    const valueImports = (source: string): string[] =>
      [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);

    const source = readFileSync(join(__dirname, 'splitKinds.ts'), 'utf8');
    const dagImports = valueImports(source).filter((spec) => spec.includes('core/dag'));

    const notLeaf: string[] = [];
    for (const spec of dagImports) {
      const path = join(__dirname, `${spec.replace(/^\.\.\//, '../')}.ts`);
      const dragged = valueImports(readFileSync(path, 'utf8'));
      if (dragged.length > 0) notLeaf.push(`${spec} → ${dragged.join(', ')}`);
    }
    expect(
      notLeaf,
      `splitKinds.ts may value-import a DAG module only while that module drags nothing — ` +
        `an e2e spec importing this descriptor would otherwise pull the whole module graph ` +
        `into Playwright: ${notLeaf.join(' | ')}`,
    ).toEqual([]);

    // Guard the guard: if nothing matched, the loop above proved nothing. The one import
    // that is expected to be here today is the membership reader.
    expect(dagImports).toContain('../core/dag/socketMembership');
  });
});
