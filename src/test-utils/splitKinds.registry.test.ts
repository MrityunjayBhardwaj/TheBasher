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
import { SPLIT_KINDS, SPLIT_KIND_NAMES } from './splitKinds';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** Every node type in `snap` whose `out` socket produces an `ObjectData`. */
function dataTypesIn(snap: Record<string, { outputs?: Record<string, { type?: string }> }>) {
  return Object.entries(snap)
    .filter(([, def]) => def.outputs?.out?.type === 'ObjectData')
    .map(([type]) => type);
}

/** THE GATE, as a function of a registry snapshot rather than of global state — which
 *  is what lets the falsification below run it against a registry containing a kind
 *  that does not exist, instead of against a doctored copy of one that does. */
function undescribedDataTypes(
  snap: Record<string, { outputs?: Record<string, { type?: string }> }>,
): string[] {
  const described = new Set(SPLIT_KIND_NAMES.map((k) => SPLIT_KINDS[k].dataType));
  return dataTypesIn(snap).filter((t) => !described.has(t));
}

/** Every registered node type whose `out` socket produces an `ObjectData`. */
function registeredDataTypes(): string[] {
  return dataTypesIn(snapshotRegistry());
}

describe('the split-kind registry gate', () => {
  it('the ObjectData filter still finds the kinds we know exist (guard the guard)', () => {
    // Four kinds are split today: box, sphere, curve, light. If this drops below four
    // the filter has drifted and every assertion below would pass vacuously.
    expect(
      registeredDataTypes().length,
      'fewer than 4 ObjectData-output node types found — the registry filter has drifted, ' +
        'and every check in this file is now passing over an empty set',
    ).toBeGreaterThanOrEqual(4);
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

  it('the descriptor stays free of the DAG graph so e2e specs can import it', () => {
    // Both tiers share ONE descriptor. That only holds while it is importable from a
    // Playwright spec without dragging the graph in — the moment it needs `applyOp` or
    // `DagState`, the e2e tier needs its own second copy and the duplication this
    // module removed comes straight back. Cheaper to assert than to rediscover.
    const source = readFileSync(join(__dirname, 'splitKinds.ts'), 'utf8');
    // Only VALUE imports matter — `import type` is erased and drags nothing.
    const graphImports = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)';/gms)]
      .map((m) => m[1])
      .filter((spec) => spec.includes('core/dag'));
    expect(
      graphImports,
      `splitKinds.ts must not import the DAG graph — an e2e spec importing it would pull ` +
        `the whole module graph into Playwright: ${graphImports.join(', ')}`,
    ).toEqual([]);
  });
});
