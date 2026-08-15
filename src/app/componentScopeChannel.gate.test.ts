// ns-2 step 9b — THE CHANNEL FROM THE EVALUATOR TO THE OPERATOR, and this file is where it
// is checked. (#607, #660)
//
// ── WHAT STEP 9 BUILT, AND WHY IT WAS NOT ENOUGH ──────────────────────────────────────
//
// Step 9 built `componentSelection.ts`: the resolved value, the memoized total, the one
// parser, the one canonicaliser and the one resolver. It had NO PRODUCTION CALLER. A road
// built and not driven on is the covered-but-unhonoured shape this boundary has paid for
// three times — a declaration everyone can point at and nothing honours, which is worse
// than an open gap because it gets relied on.
//
// This step gives it its caller: ONE line in the evaluator, immediately before it would
// call `evaluate`, supplying a fourth argument to the four operators that declare a scope.
// Being scopeable is true of the operator CATEGORY, exactly like the bypass, so it is the
// machinery that resolves — never the member.
//
// ── THE FOUR CLAIMS THIS FILE HOLDS ───────────────────────────────────────────────────
//
//   1. THE HAND-OFF HAPPENS. A scoped operator's `evaluate` receives a real selection,
//      and an unscoped one receives nothing. Minted, not searched for: a synthetic node
//      that RECORDS its fourth argument, because no shipped operator reads one yet (by
//      design — [[K32]] step 3 keeps the rewrite and the behaviour change apart).
//   2. THE OMISSION IS REFUSED AT RUNTIME. `npm run typecheck` excludes the test tier and
//      vitest checks no types at all, so a required parameter closes the omission only in
//      production unless something refuses ([[H327]], which has already fired twice here).
//   3. NOTHING FABRICATES A SELECTION. Pre-mortem #1: an operator that builds its own
//      total from a face count compiles, runs green, is byte-identical, and is entirely
//      decorative. `totalSelection` has exactly one caller and the parser is not exported,
//      so the fabrication has no constructor — asserted, with its denominator.
//   4. THE SHIPPED ROADS STILL WORK. The step's real risk, measured before it was written.
//
// ── 🔴 THE CENSUS THE PLAN ASKED FOR WAS FALSE AGAINST SHIPPED CODE ───────────────────
//
// The plan asked for "a census that no node module calls `totalSelection` or `faceCountOf`
// inside `evaluate`". Measured: `SetMaterialOp.evaluate` has called `faceCountOf` since
// ns-1b, for the face RANGE it already ships, and that call is correct. Written as stated
// the census would red on working code and be "fixed" by deleting the row.
//
// What the pre-mortem actually forbids is an operator CONSTRUCTING A SELECTION, and the
// discriminating name for that is `totalSelection` — the only exported way to obtain one
// without a query, since the parser is private. So `totalSelection` is censused at zero
// external callers and `faceCountOf`-in-an-evaluate was pinned as a LITERAL of exactly one,
// with the reason, so a second one reds ([[V200]]: a row leaves a defect census only by
// becoming unconstructible, never by having its probe weakened).
//
// 🔄 THAT LITERAL IS NOW ZERO (ns-2 step 12). The reason it carried named its own expiry —
// *step 12 is what replaces that range with the resolved selection* — and step 12 did: the
// count moved into `meshAttributes`, which walks the assignment anyway, and the operator
// derives nothing. The row ratcheted down rather than being relaxed, so an operator deriving
// a face count inside `evaluate` is now without exception the fabrication it catches.
//
// ── 🔴 AND THE FUSE IN THIS FILE HAS BLOWN (ns-2 step 12) ─────────────────────────────
//
// One row here read `declaring: []` — no node type declares a `scope` param — and existed
// purely to RED at the first declaration, because that is the moment an unparseable query
// becomes reachable and its named throw lands on the renderer's unguarded walk. The step
// that created the reachability had to decide who catches it; nobody could inherit the
// answer. TAKEN: nobody catches it, because it cannot be thrown — the query is refused at
// the schema, where the value is authored. A second row asks that BEHAVIOURALLY of every
// declarer, so an operator that gains a scope param and forgets the refinement reds.
//
// REF: src/nodes/componentSelection.ts (the resolver and the refusal);
//      src/core/dag/evaluator.ts (`scopeFor` — the one hand-off line);
//      src/core/dag/registry.ts (`assertChainDeclaration`, the sixth refusal);
//      src/app/operatorBypassHonouring.gate.test.ts (the same shape, for the bypass);
//      tools/gates/discards/scopeHandOff.patch (the named discard point for step 16).

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, listNodeTypes, registerNodeType } from '../core/dag/registry';
import { getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { importsOf } from '../../tools/gates/moduleShape';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import { sphereDescriptor, sphereGeometryRef } from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { hydrateInlineMaterial } from '../nodes/materialSchema';
import { resolveComponentSelection, SCOPE_PARAM } from '../nodes/componentSelection';
import type { ComponentSelection } from '../nodes/componentSelection';
import type { BakedDataValue, CurveDataValue, MeshDataValue, ObjectData } from '../nodes/types';

const MESH_ATTRIBUTE_KEY = mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate');

const MESH: MeshDataValue = {
  kind: 'MeshData',
  geometry: sphereGeometryRef(1, 8, 6, MESH_ATTRIBUTE_KEY),
  material: hydrateInlineMaterial(null, '#123456'),
  materialKey: null,
  // The SAME key the handle carries. A fixture that minted two would describe a mesh whose
  // handle and value disagree about their own attribute set — the shape [[H357]] names.
  attributeKey: MESH_ATTRIBUTE_KEY,
};

/** A curve on a modifier's spine — a shipped road: the modifier passes it through. */
const CURVE: CurveDataValue = {
  kind: 'CurveData',
  points: [
    [0, 0, 0],
    [1, 0, 0],
  ],
  samples: [
    [0, 0, 0],
    [1, 0, 0],
  ],
  closed: false,
};

/** Baked data on a modifier's spine — also shipped: it yields real `ModifiedData` (#258). */
const BAKED: BakedDataValue = {
  kind: 'BakedData',
  geometry: {
    key: 'baked|9b0000-8',
    descriptor: { kind: 'baked', hash: '9b0000', vertexCount: 8 },
  },
  // A BAKED value carries a BakedMaterialSpec, not an inline one — the two are different
  // types and the difference is the whole reason `modifierDataSource` returns a union.
  material: {
    materialClass: 'standard',
    color: '#654321',
    roughness: 0.4,
    metalness: 0.1,
    opacity: 1,
    transparent: false,
    emissive: '#000000',
    emissiveIntensity: 0,
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  },
};

/** What the last synthetic `evaluate` was handed as its fourth argument. */
let handed: { called: boolean; scope: ComponentSelection | null | undefined } = {
  called: false,
  scope: undefined,
};

/**
 * Register a synthetic operator that RECORDS its fourth argument.
 *
 * Minted rather than searched for, deliberately. No shipped operator reads a selection yet
 * — step 10 derives on the degenerate population and steps 12/13 are where behaviour moves
 * — so an assertion phrased over the shipped four could only ever say "nothing crashed",
 * which is what a decorative road also says.
 */
function registerRecorder(type: string, scope: 'source' | 'target' | 'unscoped'): void {
  registerNodeType({
    type,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ muted: z.boolean().default(false), scope: z.string().default('') }),
    inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
    outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
    chain: {
      input: 'target',
      scope:
        scope === 'unscoped' ? { kind: 'unscoped', why: 'declined' } : { kind: scope as 'source' },
      bypass: { kind: 'passthrough', param: 'muted' },
      section: 'none',
    },
    inspectorSections: [],
    // Annotated, because the `as never` below erases the contextual type — so without
    // these the four parameters are implicit `any`, in a tier no typecheck configuration
    // reaches. That is the same blindness this step's runtime refusal exists for.
    evaluate(
      _params: unknown,
      inputs: Record<string, unknown>,
      _ctx: unknown,
      handedScope: ComponentSelection | null | undefined,
    ) {
      handed = { called: true, scope: handedScope };
      return inputs.target as ObjectData;
    },
  } as never);
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  handed = { called: false, scope: undefined };
});

describe('ns-2 step 9b — the evaluator hands a scoped operator its selection', () => {
  it('a `source` operator receives a resolved selection with the mesh’s own face count', () => {
    registerRecorder('Ns2SourceRecorder', 'source');
    evaluateNodeAlone('Ns2SourceRecorder', { muted: false, scope: '' }, { target: MESH });
    // A sphere(8,6) tessellates to 2*8*(6-1) = 80 faces. Asserted as a NUMBER, not as
    // "truthy": a hand-off that supplied some other mesh's selection would be invisible to
    // a presence check, and this is the value an operator will branch on.
    expect(handed.called).toBe(true);
    expect(handed.scope?.length).toBe(80);
    expect(handed.scope?.count).toBe(80);
    expect(handed.scope?.domain).toBe('face');
  });

  it('a `target` operator receives one too — the hand-off is per DECLARATION, not per lane', () => {
    registerRecorder('Ns2TargetRecorder', 'target');
    evaluateNodeAlone('Ns2TargetRecorder', { muted: false, scope: '' }, { target: MESH });
    expect(handed.scope?.count).toBe(80);
  });

  it('🔴 an authored query narrows it — and reaches the operator RESOLVED, plus an identity', () => {
    registerRecorder('Ns2QueryRecorder', 'source');
    evaluateNodeAlone('Ns2QueryRecorder', { muted: false, [SCOPE_PARAM]: '0-9' }, { target: MESH });
    // Ten of eighty, and the operator was handed a resolved answer.
    expect(handed.scope?.count).toBe(10);
    expect(handed.scope?.length).toBe(80);
    expect(handed.scope?.has(0)).toBe(true);
    expect(handed.scope?.has(10)).toBe(false);

    // 🔴 STEP 13a CHANGED WHAT THIS ROW CLAIMS, AND THE CHANGE IS THE STEP. It used to
    // assert the value carried NO member holding the query. It carries one now:
    // `canonicalQuery`, the selection's identity, because a `'source'` operator's job is to
    // put its scope into a geometry key and a key needs an identity rather than a mask.
    //
    // So the claim is narrowed to what is still true and still load-bearing — the member
    // set is EXACT, and the only string in it is the CANONICAL form. An operator therefore
    // cannot read back what the author typed (`0-9` and `9,8,7,6,5,4,3,2,1,0` arrive
    // identical), and it has nothing to evaluate the string WITH: the census two describes
    // down pins the query language's node-module importers at zero. That census used to be
    // tidy and is load-bearing now that an operator holds a query at all.
    expect(Object.keys(handed.scope!).sort()).toEqual([
      'canonicalQuery',
      'count',
      'domain',
      'has',
      'length',
    ]);
    expect(handed.scope?.canonicalQuery).toBe('0-9');
  });

  it('…and two spellings of one scope arrive as ONE identity, so a key cannot fork', () => {
    // The half the row above cannot see. `canonicalQuery` is what a generator folds into a
    // geometry key, so if it echoed the authored text, `0-9` and `9,8,7,…,0` would mint two
    // byte-identical cached builds — the duplicate D9 chose canonicalisation to avoid.
    registerRecorder('Ns2SpellingRecorder', 'source');
    evaluateNodeAlone(
      'Ns2SpellingRecorder',
      { muted: false, [SCOPE_PARAM]: '9,8,7,6,5,4,3,2,1,0' },
      { target: MESH },
    );
    expect(handed.scope?.canonicalQuery).toBe('0-9');
    expect(handed.scope?.count).toBe(10);
  });

  it('an UNSCOPED authoring state carries a NULL identity, not an empty string', () => {
    // What keeps every pre-phase geometry key byte-identical. `null` is the unscoped road;
    // a query that happens to name every face is a scope the author wrote and mints its own
    // build. Two different values for two different states, so a generator cannot collapse
    // them by accident — the same separation `resolveComponentSelection` already draws
    // between a declared `null` and an omitted `undefined` ([[V205]]).
    registerRecorder('Ns2NoScopeRecorder', 'source');
    evaluateNodeAlone('Ns2NoScopeRecorder', { muted: false }, { target: MESH });
    expect(handed.scope?.count).toBe(80);
    expect(handed.scope?.canonicalQuery).toBeNull();

    registerRecorder('Ns2TotalQueryRecorder', 'source');
    evaluateNodeAlone(
      'Ns2TotalQueryRecorder',
      { muted: false, [SCOPE_PARAM]: '0-79' },
      { target: MESH },
    );
    expect(handed.scope?.count).toBe(80);
    expect(handed.scope?.canonicalQuery).toBe('0-79');
  });

  it('an UNSCOPED operator is handed nothing at all — the declaration decides', () => {
    registerRecorder('Ns2UnscopedRecorder', 'unscoped');
    evaluateNodeAlone('Ns2UnscopedRecorder', { muted: false, scope: '0-9' }, { target: MESH });
    expect(handed.called).toBe(true);
    // `undefined`, not `null`. `null` is the resolver's declared "no component domain
    // here"; `undefined` is "this node declares no scope", and the two are different
    // claims. An operator that declines a scope must not be able to read a stale one.
    expect(handed.scope).toBeUndefined();
  });

  it('a BYPASSED operator resolves nothing, because its `evaluate` never runs', () => {
    registerRecorder('Ns2MutedRecorder', 'source');
    const out = evaluateNodeAlone(
      'Ns2MutedRecorder',
      { muted: true, scope: 'not-a-range!!' },
      { target: MESH },
    );
    // The spine value straight back, and — the point — no throw, although the query is
    // unparseable. Muting is how an author makes an operator stop mattering; an operator
    // that still refuses while muted has not stopped mattering.
    expect(out).toBe(MESH);
    expect(handed.called).toBe(false);
  });
});

describe('ns-2 step 9b — the omission is refused where both standing gates are blind', () => {
  it('calling a scoped operator’s `evaluate` with no fourth argument throws BY NAME', () => {
    // [[H327]]: `typecheck` excludes test files and vitest strips types without checking
    // them, so this call compiles and runs in the tier that nothing type-checks. The
    // refusal is the only thing standing between that and a silent "scope everything".
    const def = getNodeType('ArrayModifier')!;
    expect(() =>
      def.evaluate(
        { count: 2, offset: [1, 0, 0], muted: false },
        { target: MESH },
        undefined as never,
      ),
    ).toThrow(/ArrayModifier\.evaluate was called with no resolved selection/);
  });

  it('all four scoped operators refuse it, and no unscoped one does', () => {
    // Derived from the declarations, never a list: the population is whoever declares a
    // scope, so an operator that starts declaring one is covered the day it does.
    const refused: string[] = [];
    const accepted: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type)!;
      if (def.chain === undefined || def.chain.scope.kind === 'unscoped') continue;
      try {
        def.evaluate({ muted: false } as never, { target: MESH }, undefined as never);
        accepted.push(type);
      } catch (e) {
        (String((e as Error).message).includes('no resolved selection') ? refused : accepted).push(
          type,
        );
      }
    }
    expect({ refused: refused.sort(), accepted }).toEqual({
      refused: ['ArrayModifier', 'MaterialOverrideOp', 'MirrorModifier', 'SetMaterialOp'],
      accepted: [],
    });
  });

  it('`null` is NOT refused — it is the resolver’s declared answer, and it passes through', () => {
    // The half that makes the refusal safe to have. If `null` were refused too, every
    // curve, camera and glTF handle on a modifier's spine would throw on the render road.
    const def = getNodeType('ArrayModifier')!;
    expect(() =>
      def.evaluate(
        { count: 2, offset: [1, 0, 0], muted: false },
        { target: CURVE },
        undefined as never,
        null,
      ),
    ).not.toThrow();
  });
});

describe('ns-2 step 9b — nothing fabricates a selection (pre-mortem #1)', () => {
  it('`totalSelection` has ZERO callers outside the module that owns it', () => {
    // The discriminating name. An operator computing its own total from a face count
    // compiles, runs green, is byte-identical to the real thing, and is decorative — so
    // the fabrication is censused rather than trusted. `examined` rides beside the
    // finding, because a clean zero from a walk that never descended reads identically.
    const files = sourceFiles();
    const callers: string[] = [];
    for (const [path, raw] of files) {
      if (path === 'src/nodes/componentSelection.ts') continue;
      if (path.includes('.test.')) continue;
      if (/\btotalSelection\s*\(/.test(stripComments(raw))) callers.push(path);
    }
    expect({ examined: files.length, callers }).toEqual({ examined: files.length, callers: [] });
  });

  it('NO operator calls `faceCountOf` inside its `evaluate` — step 12 took the count to zero', () => {
    // 🔴 THE RATCHET THIS ROW WAS WRITTEN TO ANTICIPATE HAS CLOSED. The plan's census said
    // ZERO and was false against shipped code: `SetMaterialOp` had called `faceCountOf`
    // since ns-1b, for the face RANGE it already shipped — correct code the census as
    // written would have redded and someone would have "fixed" by deletion. It was pinned
    // as a literal of one WITH its reason, and the reason named its own expiry: *step 12 is
    // what replaces that range with the resolved selection*.
    //
    // Step 12 did, so the literal is now the empty list. The count moved into
    // `meshAttributes.targetedMaterialAttributes`, which is where the assignment is walked
    // anyway — the operator hands over what it was given and derives nothing. A row leaves
    // a defect census by becoming unconstructible, never by having its probe weakened, and
    // this is that: any operator deriving a face count inside `evaluate` is now, without
    // exception, the fabrication this row exists to catch.
    const files = sourceFiles();
    const withCall: string[] = [];
    for (const [path, raw] of files) {
      if (!path.startsWith('src/nodes/') || path.includes('.test.')) continue;
      const code = stripComments(raw);
      const at = code.indexOf('evaluate(');
      if (at === -1) continue;
      if (/\bfaceCountOf\s*\(/.test(code.slice(at))) withCall.push(path);
    }
    expect({ examined: files.length, withCall }).toEqual({
      examined: files.length,
      withCall: [],
    });
  });

  it('no node module can reach the parser, so a second reading of a query has no import', () => {
    // Step 9's property, re-asserted from the consumer side now that consumers exist. The
    // parser is not exported; this checks nobody found another door to it.
    //
    // 🔴 THE SUBJECT MOVED AT STEP 12.5 AND ONE OF THE TWO NAMES STOPPED EXISTING. The
    // language now lives in `scopeQuery.ts` (a leaf, so a generator's face count and its
    // build can both reach it without the cycle `componentSelection -> faceCount` closes),
    // and `selectionFromTerms` was renamed `selectionFromQuery` when the terms stopped
    // crossing that boundary. A census that keeps grepping for a symbol nobody defines is
    // a probe testing half of what it names, and it reads exactly like a clean pass — so
    // both names are re-derived here, and the CONTROL below proves the probe can still see
    // its subject at all.
    const DEFINER = 'src/nodes/scopeQuery.ts';
    const files = sourceFiles();
    const probe = /\bparseScopeQuery\b|\bselectionFromQuery\b/;
    const reachers: string[] = [];
    const definers: string[] = [];
    for (const [path, raw] of files) {
      if (path.includes('.test.')) continue;
      if (!probe.test(stripComments(raw))) continue;
      // `componentSelection.ts` defines `selectionFromQuery`; `scopeQuery.ts` defines the
      // parser. Both are private to their file — the export censuses in
      // `componentSelection.test.ts` are what hold that, and they are a different claim.
      if (path === DEFINER || path === 'src/nodes/componentSelection.ts') definers.push(path);
      else reachers.push(path);
    }
    expect({ examined: files.length, reachers }).toEqual({ examined: files.length, reachers: [] });

    // The control. An empty `reachers` is only worth reading if the probe finds the two
    // files that DO name these symbols; a typo in the regex produces the same green.
    expect(definers.sort()).toEqual([DEFINER, 'src/nodes/componentSelection.ts'].sort());
  });

  it('🔴 …and no node module imports the query EVALUATORS, which is load-bearing now', () => {
    // 🔴 STEP 13a MADE THIS ROW NECESSARY, AND SAYING SO IS THE POINT. Until now an
    // operator could not interpret a query for a reason that cost nothing to maintain: it
    // never received one. A `'source'` operator now holds `canonicalQuery`, so the
    // guarantee stops being free — "cannot interpret" is no longer "has nothing to
    // interpret", it is "has nothing to interpret it WITH", and that is a claim about
    // imports which has to be asserted rather than observed once.
    //
    // The parser is unexported, so the two doors that turn a string into a SET are
    // `scopeSelection` and `scopeSelectedCount`. Their legitimate callers are the resolver
    // and the two descriptor-road consumers (the scoped count and the scoped build); NO
    // node module outside `componentSelection.ts` may name either. `isParsableScopeQuery`
    // is deliberately not in the probe: it is one bit wide, cannot return terms, and is the
    // authoring door every `scope` param refines with.
    const ALLOWED = [
      'src/nodes/scopeQuery.ts', // defines them
      'src/nodes/componentSelection.ts', // THE resolver
      'src/app/faceCount.ts', // the scoped count
      'src/app/geometryRegistry.ts', // the scoped build
    ];
    const probe = /\bscopeSelection\b|\bscopeSelectedCount\b/;
    const files = sourceFiles();
    const nodeModules = files.filter(
      ([path]) => path.startsWith('src/nodes/') && !path.includes('.test.'),
    );
    const interpreters = nodeModules
      .filter(([, src]) => probe.test(stripComments(src)))
      .map(([path]) => path)
      .filter((path) => !ALLOWED.includes(path));

    expect({ examined: nodeModules.length, interpreters }).toEqual({
      examined: nodeModules.length,
      interpreters: [],
    });

    // The control, because an empty list over a population of zero is not a finding. The
    // walk must actually reach node modules, and the probe must actually match its subject
    // somewhere — a typo produces the same green as a clean repo ([[H326]]).
    expect(nodeModules.length).toBeGreaterThan(50);
    const matched = files
      .filter(([, src]) => probe.test(stripComments(src)))
      .map(([path]) => path)
      .filter((path) => !path.includes('.test.'))
      .sort();
    expect(matched).toEqual([...ALLOWED].sort());
  });
});

describe('ns-2 step 9b — the roads that already ship still work', () => {
  // 🔴 THE STEP'S REAL RISK, AND IT WAS MEASURED BEFORE THE STEP WAS WRITTEN. The resolver
  // now runs ahead of every Array and Mirror cook. Its step-9 contract refused a curve, a
  // baked handle and an unwired spine — all three of which are ordinary values on a
  // modifier's spine today, with green tests of their own. Resolving unconditionally would
  // have thrown on the renderer's own walk: the identical failure the plan named when it
  // moved the required parameter off `modifierDataSource`, one level up.

  it('an Array over a CURVE passes it through, as it did before the channel existed', () => {
    const out = evaluateNodeAlone(
      'ArrayModifier',
      { count: 3, offset: [2, 0, 0], muted: false },
      { target: CURVE },
    );
    expect(out).toBe(CURVE);
  });

  it('an Array over BAKED data still yields real ModifiedData', () => {
    const out = evaluateNodeAlone(
      'ArrayModifier',
      { count: 3, offset: [2, 0, 0], muted: false },
      { target: BAKED },
    ) as { kind: string };
    expect(out.kind).toBe('ModifiedData');
  });

  it('an Array over an UNWIRED spine stays transparent', () => {
    expect(
      evaluateNodeAlone('ArrayModifier', { count: 3, offset: [2, 0, 0], muted: false }, {}),
    ).toBeUndefined();
  });
});

describe('ns-2 step 9b — the premises the hand-off rests on', () => {
  it('P10: the resolution is a pure function of exactly the spine value and the params', () => {
    // The evaluator's value key folds `paramsHash` and `inputsHash` and nothing else, so a
    // selection derived from anything further would not be covered by that cache — two
    // different scopes would collide on one entry. Asserted as determinism over repeated
    // calls with equal inputs, and as sensitivity to each of the two inputs separately.
    const a = resolveComponentSelection(MESH, { [SCOPE_PARAM]: '0-9' })!;
    const b = resolveComponentSelection(MESH, { [SCOPE_PARAM]: '0-9' })!;
    expect([a.count, a.length, a.has(3), a.has(40)]).toEqual([
      b.count,
      b.length,
      b.has(3),
      b.has(40),
    ]);
    // params moved → answer moves.
    expect(resolveComponentSelection(MESH, { [SCOPE_PARAM]: '0-4' })!.count).toBe(5);
    // spine moved → answer moves (a different mesh has a different length).
    const smallerKey = mintMeshAttributes(sphereDescriptor(1, 3, 2), 'evaluate');
    const smaller: MeshDataValue = {
      kind: 'MeshData',
      geometry: sphereGeometryRef(1, 3, 2, smallerKey),
      material: null,
      materialKey: null,
      attributeKey: smallerKey,
    };
    expect(resolveComponentSelection(smaller, {})!.length).toBe(6);
  });

  it('THE SIXTH REFUSAL: a scoped spine that does not carry ObjectData is refused at registration', () => {
    // The premise the one hand-off line casts on. Enforced where the author is present
    // ([[V201]]), and a REFUSAL rather than a conjunct on the predicate — a conjunct would
    // drop the operator silently out of the resolution instead of telling anyone.
    const make = (type: string, spine: string | string[]) => () =>
      registerNodeType({
        type,
        version: 1,
        pure: true,
        cost: 'cheap',
        paramSchema: z.object({ muted: z.boolean().default(false) }),
        inputs: { target: { type: spine, cardinality: 'single' } },
        outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
        chain: {
          input: 'target',
          scope: { kind: 'source' },
          bypass: { kind: 'passthrough', param: 'muted' },
          section: 'none',
        },
        inspectorSections: [],
        evaluate: (_p: unknown, i: { target?: unknown }) => i.target,
      } as never);

    expect(make('Ns2ScopedImage', 'Image')).toThrow(/not ObjectData alone/);
    // A UNION accepting ObjectData is refused too, and that is the silent half: membership
    // would pass while an `Image` still arrived at runtime.
    expect(make('Ns2ScopedUnion', ['ObjectData', 'Image'])).toThrow(/not ObjectData alone/);
    // The honest declaration for such an operator registers cleanly — the escape hatch is
    // real, not theoretical.
    expect(make('Ns2ScopedOk', 'ObjectData')).not.toThrow();
  });

  it('exactly THREE registered node types declare a `scope` param — one `target`, two `source`', () => {
    // 🔴 THE FUSE BLEW AT STEP 12, AND THE DECISION IT WAS GUARDING IS TAKEN. It read
    // `declaring: []` and existed to red at the first declaration, because an unparseable
    // query is a named THROW and `evaluate` runs on the render road with no try/catch above
    // it — `resolveEvaluatedMesh` calls it and `SceneFromDAG` calls that, measured. Whoever
    // created the reachability had to answer "who catches it?", and nobody could inherit
    // the answer.
    //
    // TAKEN: nobody catches it, because it cannot be thrown. The query is refused where it
    // is AUTHORED — `SetMaterialOp`'s schema refines the field with the parser's own
    // validator, and `setParam` rejects a value the schema will not take, so an unparseable
    // query never enters params. The bad state has no constructor rather than a handler,
    // which matters because this project has no node-error surfacing at all (censused at
    // zero): a throw here would have been the director's entire feedback.
    //
    // 🔴 STEP 13a ADDS THE SECOND, AND IT IS THE OTHER LANE. `SetMaterialOp` is `'target'`
    // — the selection names which faces RECEIVE a write. `ArrayModifier` is `'source'` —
    // the selection names which faces are GENERATED FROM. Same param name, same refinement,
    // opposite jobs, and the difference is declared in `chain.scope.kind` rather than
    // spelled into the param, which is the whole reason the param can be identical.
    //
    // 🔴 STEP 13b ADDS THE THIRD, AND IT IS THE SAME LANE AS THE SECOND. `MirrorModifier`
    // is `'source'` like `ArrayModifier` — the first time two operators share a scope KIND,
    // which is the whole reason 13b is a step rather than a footnote to 13a: they also share
    // the subset helper and the key builder, so their arithmetic has to be asserted from
    // literals neither can reach through the shared code ([[V189]]).
    //
    // The literal is kept EXACT rather than loosened to a count: this list is where a fourth
    // declarer shows up, and the question it has to answer on arrival is the one below —
    // does it refine? No next entrant is named, because none is planned; the row is now a
    // standing census rather than a fuse waiting on a known step.
    const declaring = listNodeTypes().filter((type) => {
      const shape = (
        getNodeType(type)!.paramSchema as unknown as { shape?: Record<string, unknown> }
      ).shape;
      return shape !== undefined && Object.prototype.hasOwnProperty.call(shape, SCOPE_PARAM);
    });
    expect({ examined: listNodeTypes().length, declaring }).toEqual({
      examined: listNodeTypes().length,
      // The order is `listNodeTypes()`'s — registration order, not alphabetical.
      declaring: ['ArrayModifier', 'MirrorModifier', 'SetMaterialOp'],
    });
  });

  it('🔴 …and EVERY declarer refuses an unparseable query at its own schema', () => {
    // This is the row that makes the decision above enforced rather than described. A
    // second operator gaining a scope param and forgetting the refinement is exactly the
    // per-member omission this phase exists to delete, and it would be SILENT: the param
    // would work perfectly for every query anyone tried by hand, and take the viewport down
    // the first time someone mistyped one.
    //
    // Asked BEHAVIOURALLY, of the schema itself, never of the source text — a grep for the
    // validator's name would pass on `.refine(() => true)` and on a refinement applied to
    // the wrong field.
    const declaring = listNodeTypes().filter((type) => {
      const shape = (
        getNodeType(type)!.paramSchema as unknown as { shape?: Record<string, unknown> }
      ).shape;
      return shape !== undefined && Object.prototype.hasOwnProperty.call(shape, SCOPE_PARAM);
    });
    expect(declaring.length).toBeGreaterThan(0);

    const accepting: string[] = [];
    for (const type of declaring) {
      const schema = getNodeType(type)!.paramSchema;
      // `wildcards are not implemented` is a named parser refusal, so a schema that takes
      // this value is one that did not consult the parser.
      if (schema.safeParse({ [SCOPE_PARAM]: 'arm*' }).success) accepting.push(type);
      // And a VALID query must still be accepted — a refinement that refuses everything
      // would pass the row above while making the param useless.
      expect(schema.safeParse({ [SCOPE_PARAM]: '0-5' }).success).toBe(true);
    }
    expect({ declaring, accepting }).toEqual({ declaring, accepting: [] });
  });
});

describe('ns-2 step 9b — the layering edge, stated and pinned', () => {
  it('`src/core/dag/**` reaches into `src/nodes/**` from exactly two files, for this channel', () => {
    // Measured at step 9: 14 production files, ZERO such imports. This step adds the two
    // the channel needs and no more — the VALUE import in the evaluator (the resolver) and
    // the erased TYPE import in `types.ts` (the fourth parameter's type). `modifierDataSource`
    // became a leaf one commit earlier precisely so the value edge does not close the cycle
    // `evaluator → componentSelection → modifierGeometry → evaluator`.
    //
    // A floor would be the wrong shape here: the whole point is that this set is SMALL and
    // deliberate, so it is pinned exactly and a third file has to argue for itself.
    const reaching: Record<string, string[]> = {};
    for (const [path] of sourceFiles()) {
      if (!path.startsWith('src/core/dag/') || path.includes('.test.')) continue;
      const outward = importsOf(path).filter((s) => s.includes('/nodes/') || s.includes('/app/'));
      if (outward.length > 0) reaching[path] = outward;
    }
    expect(reaching).toEqual({
      'src/core/dag/evaluator.ts': ['../../nodes/componentSelection', '../../nodes/types'],
      'src/core/dag/types.ts': ['../../nodes/componentSelection'],
    });
  });
});
