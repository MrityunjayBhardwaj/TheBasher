// ns-2 step 5 — THE BYPASS IS HONOURED ONCE, AND THIS FILE IS WHERE THAT IS CHECKED.
//
// ── WHAT STEP 4 CLOSED, AND WHAT IT LEFT OPEN ─────────────────────────────────────────
//
// Step 4 gave the operator category a DECLARATION: `chain.bypass` names the param that
// carries the mute, and `registerNodeType` refuses a declaration whose named param the
// schema does not declare. That closed the omitted-vs-false collapse on the DECLARING
// side. It did nothing about the HONOURING side, which stayed spelled per member: five
// `evaluate` guards each re-deciding what "muted" means, one unchecked cast in the stack
// walker, and one typed read in the material-ownership walker that no cast census could
// see. A declaration nobody honours is worse than an open gap, because it gets relied on.
//
// Step 5 moves the honouring to ONE site — the evaluator, immediately before it would
// call `evaluate` — and this file is the detector that it really moved, rather than
// merely acquired a second home.
//
// ── THE ARITHMETIC, RE-DERIVED. IT IS `3 → 1`, NEVER `3 → 0`. ─────────────────────────
//
// The plan said "5 copies + 3 casts → ONE application site". The 3 was measured wrong:
// three unchecked casts is the CONSTRAINT/DRIVER lane's number, a lane §11 puts out of
// scope, and the mis-scoped census also hid a member — the typed read one module over,
// which is not a cast at all. The honest arithmetic is:
//
//     1 unchecked cast (the stack walker)
//   + 1 typed read     (the material-ownership walker)
//   + 5 `evaluate` guards
//   → 1 CHECKED read
//
// One, not zero. The application site still reads `node.params`, which is `unknown`, so a
// cast survives. What makes it CHECKED rather than merely fewer: the field name comes from
// `chain.bypass.param` instead of a literal, and step 4's second refusal has already
// proven at registration that the schema declares a param of that name. A count that drops
// from three to one while every remaining read is still a guess would be progress in count
// and not in kind, and saying `3 → 0` would be false.
//
// ── WHICH ASSERTIONS HERE ARE DETECTORS AND WHICH ARE CONFIRMATIONS ───────────────────
//
// This matters, because a gate that passes before the work is not a detector, and a gate
// written to pass before AND after is worth keeping only if it says so out loud.
//
//   DETECTORS   — red on the PRE-step tree, green after:
//                 · `evaluate` is blind to the bypass param (all five)
//                 · the raw-read census over the operator category
//   CONFIRMATION — green on the PRE-step tree and required to stay green:
//                 · the five bypassed-output hashes, measured BEFORE the migration and
//                   written here as literals (four were RE-BASED at step 8 when D8 changed
//                   `GeometryRef`'s shape — see the note on `ROWS` for why that was owed
//                   rather than optional)
//                 · the second-road census over direct `evaluate` callers
//
// The five hashes are byte-identical across this step for one reason and it is worth
// naming, because the step is relying on it: none of the five operators does anything
// observable before its guard — each reads its spine input, returns early if unwired, and
// bypasses next. So deleting the guard and returning the spine input from one site upstream
// produces the same value by the same reference. That property is not self-evident and it
// is asserted below rather than assumed: every row checks reference identity, and every row
// carries an un-muted control that must DIFFER, so a fixture too thin to reach the
// operator's real work cannot make the whole table pass vacuously.
//
// REF: `.anvi/…/phases/ns-2-component-groups/PLAN.md` §8 step 5 + §17 (the re-derivation);
//      src/core/dag/chainBypass.ts (the one application site);
//      src/core/dag/evaluator.ts (where it is applied);
//      src/app/operatorBypass.gate.test.ts (step 3's census, which pins the lanes);
//      src/nodes/channelModifiers.ts (the working counter-example, one lane over);
//      issues #607, #660, #672, #673.

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { hashValue } from '../core/dag/hash';
import { stripComments } from '../test-utils/sourceScan';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { sphereDescriptor, sphereGeometryRef } from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { hydrateInlineMaterial, openpbrMaterialSchema } from '../nodes/materialSchema';
import { DEFAULT_IMAGE_DESCRIPTOR } from '../nodes/types';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { resolveComponentSelection } from '../nodes/componentSelection';
import type { ObjectData } from '../nodes/types';

const FILES: readonly (readonly [string, string])[] = sourceFiles().map(
  ([path, src]) => [path, stripComments(src)] as const,
);

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The registered operators, derived — "declares a chain spine", never a maintained list. */
function operators(): string[] {
  return listNodeTypes()
    .filter((type) => getNodeType(type)?.chain !== undefined)
    .sort();
}

/** Every param name any operator declares as its bypass. Derived from the declarations. */
function declaredBypassParams(): string[] {
  return [
    ...new Set(
      operators().flatMap((type) => {
        const bypass = getNodeType(type)!.chain!.bypass;
        return bypass.kind === 'passthrough' ? [bypass.param] : [];
      }),
    ),
  ].sort();
}

// ── THE FIXTURES ──────────────────────────────────────────────────────────────────────
// Real values, not sentinels. An opaque stand-in would make the un-muted control return
// the source too (`modifierDataSource` answers null for a non-mesh and the operator passes
// it through), so the whole table would pass with the bypass deleted entirely — the
// inverted-fixture shape, where the instrument agrees with every hypothesis.

const meshSrc = (color: string) => ({
  kind: 'MeshData' as const,
  geometry: sphereGeometryRef(1, 8, 6, mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate')),
  material: hydrateInlineMaterial(null, color),
  materialKey: null,
});

const imageSrc = {
  kind: 'Image' as const,
  passKind: 'beauty',
  descriptor: DEFAULT_IMAGE_DESCRIPTOR,
  sourceHash: 'gate-src',
};

const WIRED_MATERIAL = {
  kind: 'OpenPBRMaterial',
  spec: openpbrMaterialSchema().parse({ name: 'wired', base: { color: '#00ff00' } }),
};

/**
 * The five operators that declare a passthrough bypass, each with a distinct source value
 * so that a row copy-pasted from its neighbour shows up as an equal hash rather than
 * hiding.
 *
 * `hash` was measured on the PRE-step tree, before a line of step 5 was written.
 *
 * 🔴 FOUR OF THE FIVE WERE RE-BASED AT STEP 8, AND THAT IS RECORDED RATHER THAN QUIETLY
 * DONE. D8 removed `GeometryRef`'s hand-written `kind` field, so every value carrying a
 * geometry handle hashes differently — `ArrayModifier`, `MaterialOverrideOp`,
 * `MirrorModifier` and `SetMaterialOp` moved; `ColorCorrect` did not, because its value is
 * an image and holds no handle. That split is the evidence the move was a shape change and
 * not a behaviour change: a step-5 regression would not have spared the image row.
 *
 * ⚠️ RE-BASING WAS NOT OPTIONAL, AND THE REASON IS THE NEIGHBOUR. The row below these
 * hashes asserts `not.toBe(row.hash)` for an UN-MUTED run — a control that exists so a
 * fixture too thin to reach the operator's real work cannot pass the table vacuously. A
 * stale literal reds the first assertion loudly and makes that control pass without
 * examining anything, silently. The loud half is never the whole cost of a rotted literal.
 *
 * What is NOT re-based, because it never moved: every row's reference-identity assertion.
 * That is the one carrying the step-5 claim — the spine input is handed back, not rebuilt —
 * and it stayed green across the shape change, which is what a hash cannot show.
 */
const ROWS = [
  {
    type: 'ArrayModifier',
    src: meshSrc('#111111'),
    params: { count: 3, offset: [2, 0, 0] },
    hash: 'af33c5df',
  },
  {
    type: 'BevelModifier',
    src: meshSrc('#666666'),
    // #818 — the amount must be POSITIVE for this row to have anything to bypass: at zero
    // the operator is transparent by design (the reference's own `is_disabled`), which would
    // make a bypass test indistinguishable from its subject.
    params: { amount: 0.1 },
    hash: '0c8c55e1',
  },
  {
    type: 'ColorCorrect',
    src: imageSrc,
    params: { brightness: 0.5, contrast: 0, saturation: 0 },
    hash: '18b8ed1d',
  },
  {
    type: 'MaterialOverrideOp',
    src: meshSrc('#222222'),
    params: { color: '#00ff88', overridden: { color: true } },
    hash: '9e7c9dd1',
  },
  {
    type: 'MaskModifier',
    src: meshSrc('#555555'),
    // #668 — a scope is REQUIRED for the operator to do anything: with none it is
    // transparent by design, which would make this row a bypass test with nothing to bypass.
    params: { keep: true, scope: '0-5' },
    hash: '8a712627',
  },
  {
    type: 'MirrorModifier',
    src: meshSrc('#333333'),
    params: { axis: 'x', offset: 0 },
    hash: '82055c87',
  },
  {
    type: 'SetMaterialOp',
    src: meshSrc('#444444'),
    // ns-2 step 14 — the retired face range, and its default meant EVERY face; a blank
    // scope is the same authoring state, so the frozen hash below must not move.
    params: {},
    material: true,
    hash: '7e7b55d5',
  },
] as const;

type Row = (typeof ROWS)[number];

/** The operator's resolved inputs, as `evaluate` receives them. */
function inputsOf(row: Row): Record<string, unknown> {
  const inputs: Record<string, unknown> = { target: row.src };
  if ('material' in row && row.material) inputs.material = [WIRED_MATERIAL];
  return inputs;
}

/** Through the evaluator — the road the application site is on. */
function throughEvaluator(row: Row, bypassed: boolean): unknown {
  return evaluateNodeAlone(row.type, { ...row.params, muted: bypassed }, inputsOf(row));
}

/** Straight into the operator's own `evaluate`, skipping the application site entirely. */
function directly(row: Row, bypassed: boolean): unknown {
  const def = getNodeType(row.type)!;
  const params = { ...row.params, muted: bypassed };
  // ns-2 step 9b — the fourth argument, supplied here exactly as the evaluator supplies it:
  // resolved through the ONE resolver for a chain declaring a scope, and absent for every
  // other node. This road MUST stay direct — it is the [[H350]] blindness detector, whose
  // whole claim is that `evaluate`'s output is identical with the bypass flag on and off,
  // and only a direct call can observe that.
  const scoped = def.chain !== undefined && def.chain.scope.kind !== 'unscoped';
  return def.evaluate(
    params,
    inputsOf(row),
    undefined as never,
    scoped ? resolveComponentSelection(row.src as ObjectData, params, 'face') : undefined,
  );
}

describe('ns-2 step 5 — the bypass is honoured at ONE site', () => {
  it('THE INSTRUMENT CONTROL: the registry and the corpus both answered', () => {
    // A probe reaching through a field name it guessed reports a clean zero, and a zero
    // here would agree with this step's own thesis — the most expensive kind of agreement.
    expect(listNodeTypes()).toHaveLength(83); // 82 -> 83 at #901 (RetargetClip);
    expect(operators()).toHaveLength(9);
    expect(declaredBypassParams()).toEqual(['muted']);
    expect(FILES.length).toBeGreaterThan(500);
    // Every row below names a registered type — a typo would otherwise read as a clean set.
    for (const row of ROWS) expect(getNodeType(row.type)).toBeDefined();
    // And the rows are exactly the operators declaring a passthrough bypass, derived.
    expect(ROWS.map((r) => r.type as string).sort()).toEqual(
      operators().filter((t) => getNodeType(t)!.chain!.bypass.kind === 'passthrough'),
    );
  });

  // ── DETECTOR ────────────────────────────────────────────────────────────────────────
  it('DETECTOR: `evaluate` is BLIND to the bypass param — the guard is gone from all seven', () => {
    // The sharpest statement of the whole step. Before it, each operator decided for
    // itself what its mute meant; after it, an operator's `evaluate` is its WORK and
    // nothing else, and the category's bypass is applied above it. So flipping the param
    // and calling `evaluate` directly must change nothing at all.
    //
    // Restoring one guard reds THIS row, by operator name. That is the must-red the step
    // is gated on, and it is behavioural — a grep would go green again the moment someone
    // spelled the restored guard differently.
    for (const row of ROWS) {
      expect
        .soft(hashValue(directly(row, true)), `${row.type}.evaluate still reads its bypass param`)
        .toBe(hashValue(directly(row, false)));
    }
  });

  it('DETECTOR: no source file outside the one application site reads a bypass param raw', () => {
    // Derived from the declarations, so a tenth operator is covered the day it registers
    // rather than the day someone remembers to add it here.
    const raw = declaredBypassParams().flatMap((param) => {
      const re = new RegExp(`params\\.${param}\\b|as\\s*\\{[^}]*\\b${param}\\??:[^}]*\\}`, 'g');
      return FILES.filter(([, src]) => re.test(src)).map(([path]) => path);
    });

    // `Strip` declares `muted` and is NOT an operator — it declares no chain spine, so it
    // is outside this category and reads its own field legitimately. It is listed rather
    // than filtered out, because an exemption nobody can see is how a census starts lying.
    expect([...new Set(raw)].sort()).toEqual(['src/nodes/Strip.ts']);
    expect(operators()).not.toContain('Strip');

    // The same claim stated the other way, and this is the half that cannot pass
    // vacuously: not one of the nine operator files reads its OWN declared bypass param.
    const selfReaders = operators().filter((type) => {
      const bypass = getNodeType(type)!.chain!.bypass;
      if (bypass.kind !== 'passthrough') return false;
      const src = FILES.find(([p]) => p === `src/nodes/${type}.ts`)?.[1];
      // An unreadable file must not read as a clean answer.
      if (src === undefined) return true;
      return new RegExp(`params\\.${bypass.param}\\b`).test(src);
    });
    expect(selfReaders).toEqual([]);
  });

  // ── CONFIRMATION ────────────────────────────────────────────────────────────────────
  it('CONFIRMATION: the seven bypassed outputs are byte-identical to before the migration', () => {
    // These literals were measured on the tree as it stood BEFORE step 5. They pass here
    // both before and after, deliberately: they are not a detector, they are the evidence
    // that moving the honouring upstream changed no output. What makes them non-vacuous is
    // the control on the next line — an un-muted run that must NOT hash the same.
    //
    // 🔴 THE SEVENTH LITERAL ARRIVED AT #818 (`BevelModifier`), MEASURED ON THIS TREE rather
    // than carried from before the migration — there was no before for it. That makes it
    // weaker evidence than its six neighbours by construction, and the control on the third
    // line of the loop is what keeps it worth having: its un-muted run must NOT hash the
    // same, which is the half a freshly-measured literal cannot fake.
    //
    // 🔴 FIVE OF THE SIX ORIGINAL LITERALS MOVED AT #770, AND NOT BECAUSE THE BYPASS DID. A face-domain
    // attribute carries one element per POLYGON now, so the fixture spine's `material_index`
    // changed content and therefore its content key — which these hashes cover. The row's
    // claim is unchanged and still checked beside them: a bypassed output is the spine input
    // handed back BY REFERENCE, and an un-muted run must not hash the same. Both held across
    // the re-measurement, which is what says the move was in the fixture and not in the road.
    for (const row of ROWS) {
      const bypassed = throughEvaluator(row, true);
      expect.soft(hashValue(bypassed), `${row.type} bypassed output`).toBe(row.hash);
      // By REFERENCE, not by value: the spine input is handed back, never rebuilt.
      expect.soft(bypassed, `${row.type} rebuilt its passthrough`).toBe(row.src);
      expect
        .soft(hashValue(throughEvaluator(row, false)), `${row.type} fixture reaches no real work`)
        .not.toBe(row.hash);
    }
  });

  it('CONFIRMATION: the evaluator is the only road that could skip the application site', () => {
    // The bypass is applied by the machinery, so a SECOND caller of `evaluate` is a second
    // road on which no operator would ever bypass. Two exist, and both are the channel
    // lane, whose node types declare no chain at all — so they cannot reach an operator.
    // If a third appears, or one of these two starts reaching a chain declarer, this reds.
    const callers = FILES.filter(([, src]) => /\bdef\.evaluate\b/.test(src))
      .map(([path]) => path)
      .sort();
    expect(callers).toEqual([
      'src/app/layeredChannels.ts', // channel lane — KeyframeChannel*, no chain
      'src/app/nodeChannels.ts', // channel lane — KeyframeChannel*, no chain
      'src/core/dag/evaluator.ts', // THE application site's host
    ]);

    // Every KeyframeChannel node type is chain-less, so neither channel-lane caller can
    // reach an operator. Derived, and the population is named rather than assumed.
    const channels = listNodeTypes().filter((t) => t.startsWith('KeyframeChannel'));
    expect(channels).toHaveLength(7);
    expect(channels.filter((t) => getNodeType(t)!.chain !== undefined)).toEqual([]);
  });
});
