// ns-2 step 17 — DOES AN OPERATOR HONOUR THE SCOPE IT DECLARES? (#607, #660)
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS THE LAST THING THE PHASE BUILDS ───────────────
//
// Every other gate in this phase checks that a DECLARATION is present, total, consistent
// with its siblings and derived from nothing hand-maintained. Not one of them checks that
// the declaration is TRUE. `chain.scope` says what the selection means to this operator:
//
//     'source'    the selection names the components it GENERATES FROM
//     'target'    the selection names the components that RECEIVE the write
//     'unscoped'  there is nothing to scope — the spine value has no component domain
//
// An operator can declare any of those and then ignore its fourth argument entirely. It
// compiles. Every behavioural test passes, because every behavioural test that exists was
// written against the operator's own behaviour. The census that pins the declarations
// passes, because the declaration is there. The discard harness passes, because there is
// nothing to discard. **A lying label passes every behavioural test** — this project has
// paid for that shape three times, and it is strictly worse than an open gap because a
// covered-but-unhonoured grade gets relied on.
//
// So the question this file asks is the one nothing else can:
//
//     run the operator against a PROPER SUBSET of its components, and against the total,
//     and require the two to DIFFER for every operator whose declaration promises they will.
//
// ── WHY IT IS DERIVED, AND WHAT THE EXEMPTIONS ARE ────────────────────────────────────
//
// The population is `chain.scope.kind !== 'unscoped'`, read off the registry. An operator
// registering tomorrow is covered the day it registers, not the day someone remembers this
// file. An `unscoped` operator is exempt because the resolver hands it `null` — there is no
// selection to vary, and that is a property of the value on its spine (a scene object, an
// image), not a favour granted here. The exemption is therefore derived too, and the
// control below requires the population to be non-empty so a probe that lost its subject
// cannot report a serene green ([[H326]]).
//
// ── THE MINTED LIAR ───────────────────────────────────────────────────────────────────
//
// A cross-check that has never been seen to fail is a claim about nothing. `Ns2LyingScope`
// declares `'source'` and hands its input straight back. The check must NAME it. Without
// that row this file would be one more instrument nobody has watched fail.
//
// REF: src/nodes/componentSelection.ts (the resolver and `ScopeKind`);
//      src/app/operatorChainDeclaration.gate.test.ts (the declarations, censused exactly);
//      src/app/operatorBypassHonouring.gate.test.ts (the same shape for the OTHER declared
//      capability — read them together); the ns-2 plan §8 step 17; issues #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, getNodeType, listNodeTypes, registerNodeType } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { hashValue } from '../core/dag/hash';
import { resolveComponentSelection } from '../nodes/componentSelection';
import { sphereDescriptor, sphereGeometryRef } from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { hydrateInlineMaterial, openpbrMaterialSchema } from '../nodes/materialSchema';
import type { MeshDataValue } from '../nodes/types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/**
 * sphere(8,6) — 80 faces, so `0-39` is an unambiguous PROPER subset with plenty on both
 * sides of the boundary. A box would do, but twelve faces is the population that lets a
 * hard-coded number pass ([[H374]]).
 */
function meshSource(color: string): MeshDataValue {
  const descriptor = sphereDescriptor(1, 8, 6);
  const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
  return {
    kind: 'MeshData',
    geometry: sphereGeometryRef(1, 8, 6, attributeKey),
    material: hydrateInlineMaterial(null, color),
    materialKey: null,
    attributeKey,
  };
}

const WIRED_MATERIAL = {
  kind: 'OpenPBRMaterial',
  spec: openpbrMaterialSchema().parse({ name: 'wired', base: { color: '#00ff00' } }),
};

const TOTAL = '';
const SUBSET = '0-39';

/**
 * A fixture per scoped operator: params that reach the operator's real work, and any
 * second input it needs. Real values, never sentinels — an opaque stand-in makes the
 * operator pass its input through, so both legs return the same thing and the whole table
 * agrees with every hypothesis ([[H328]]).
 *
 * Keyed by type and CHECKED against the derived population below, so an operator arriving
 * without a fixture is a red rather than a silent omission.
 */
const FIXTURES: Record<string, { params: Record<string, unknown>; material?: boolean }> = {
  ArrayModifier: { params: { count: 3, offset: [2, 0, 0], muted: false } },
  MirrorModifier: { params: { axis: 'x', offset: 3, muted: false } },
  SetMaterialOp: { params: { muted: false }, material: true },
};

/** The operators whose declaration PROMISES the selection changes what they emit. */
function scopedOperators(): string[] {
  return listNodeTypes()
    .filter((type) => {
      const scope = getNodeType(type)?.chain?.scope;
      return scope !== undefined && scope.kind !== 'unscoped';
    })
    .sort();
}

/**
 * Run one operator twice — total selection, then a proper subset — and report whether its
 * output moved. Both selections come from the ONE resolver, exactly as the evaluator
 * produces them; a hand-built selection would skip the producer's transformation and
 * invert the test ([[H328]]).
 */
function honours(type: string): { moved: boolean; kind: string } {
  const def = getNodeType(type)!;
  const kind = def.chain!.scope.kind;
  const fixture = FIXTURES[type];
  const src = meshSource('#808080');
  const inputs: Record<string, unknown> = { target: src };
  if (fixture.material) inputs.material = [WIRED_MATERIAL];

  const run = (scope: string): unknown => {
    const params = { ...fixture.params, scope };
    return def.evaluate(
      params as never,
      inputs as never,
      ctx as never,
      resolveComponentSelection(src, params),
    );
  };

  return { moved: hashValue(run(TOTAL)) !== hashValue(run(SUBSET)), kind };
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('ns-2 step 17 — a declared scope is HONOURED, not merely declared', () => {
  it('THE INSTRUMENT CONTROL: the population is derived, non-empty, and every member has a fixture', () => {
    // An exact census of the empty set is the strongest form ([[V150]]) — but only once the
    // walk is known to reach anything. A probe that lost its subject reports the same clean
    // answer as a clean repo.
    const population = scopedOperators();
    expect(population.length).toBeGreaterThan(0);
    expect(population.filter((type) => FIXTURES[type] === undefined)).toEqual([]);

    // And the exemptions are derived from the same field rather than listed here, so an
    // operator cannot be excused by being forgotten.
    //
    // 🔴 `MaterialOverrideOp` IS IN THIS LIST BECAUSE OF WHAT THE ROW BELOW FOUND, and it
    // is the one member here for a different reason from the other three. Those three have
    // no component domain at all — a scene object, a scene object, an image — so there is
    // nothing a selection could name. `MaterialOverrideOp` has one and does not use it:
    // it declared `'target'`, emitted byte-identical output for a total selection and for
    // half the faces, and was re-declared `unscoped, why: 'declined'` at step 17. The two
    // reasons are DIFFERENT CLAIMS and the union carries which is which, so this row does
    // not have to. Honouring it is #682, and the day that lands this list loses a member.
    const exempt = listNodeTypes().filter((t) => getNodeType(t)?.chain?.scope.kind === 'unscoped');
    expect(exempt.sort()).toEqual([
      'ColorCorrect',
      'MaterialOverride',
      'MaterialOverrideOp',
      'Transform',
    ]);
  });

  it('🔴 THE CROSS-CHECK — every operator declaring a scope emits something DIFFERENT for a subset', () => {
    // The whole file. `moved: false` means the operator took a selection naming half the
    // mesh, took one naming all of it, and produced byte-identical output for both — while
    // declaring that the selection decides what it generates from, or what it writes to.
    const dishonouring = scopedOperators()
      .map((type) => ({ type, ...honours(type) }))
      .filter((r) => !r.moved)
      .map((r) => `${r.type} declares scope '${r.kind}' and ignores it`);

    expect({ examined: scopedOperators().length, dishonouring }).toEqual({
      examined: scopedOperators().length,
      dishonouring: [],
    });
  });

  it('🔴 THE MINTED LIAR: an operator that declares a scope and ignores it is NAMED', () => {
    // Without this the row above is an instrument nobody has watched fail. The liar is a
    // complete, registrable operator — it passes the totality refusal, declares a real
    // section and a real bypass, and its only defect is the one this file exists to find.
    registerNodeType({
      type: 'Ns2LyingScope',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({ muted: z.boolean().default(false), scope: z.string().default('') }),
      inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
      outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
      chain: {
        input: 'target',
        scope: { kind: 'source' },
        bypass: { kind: 'passthrough', param: 'muted' },
        section: 'modifier',
      },
      evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.target,
    } as never);
    FIXTURES.Ns2LyingScope = { params: { muted: false } };

    try {
      expect(scopedOperators()).toContain('Ns2LyingScope');
      const named = scopedOperators()
        .map((type) => ({ type, ...honours(type) }))
        .filter((r) => !r.moved)
        .map((r) => r.type);
      expect(named).toEqual(['Ns2LyingScope']);
    } finally {
      delete FIXTURES.Ns2LyingScope;
    }
  });
});
