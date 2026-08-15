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
// external callers and `faceCountOf`-in-an-evaluate is pinned as a LITERAL of exactly one,
// with the reason, so a second one reds ([[V200]]: a row leaves a defect census only by
// becoming unconstructible, never by having its probe weakened).
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

const MESH: MeshDataValue = {
  kind: 'MeshData',
  geometry: sphereGeometryRef(1, 8, 6, mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate')),
  material: hydrateInlineMaterial(null, '#123456'),
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
  material: hydrateInlineMaterial(null, '#654321'),
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
    evaluate(_params, inputs, _ctx, handedScope) {
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

  it('🔴 an authored query narrows it — the query reaches the operator ONLY as a selection', () => {
    registerRecorder('Ns2QueryRecorder', 'source');
    evaluateNodeAlone('Ns2QueryRecorder', { muted: false, [SCOPE_PARAM]: '0-9' }, { target: MESH });
    // Ten of eighty, and the operator was handed a resolved answer — never the string.
    expect(handed.scope?.count).toBe(10);
    expect(handed.scope?.length).toBe(80);
    expect(handed.scope?.has(0)).toBe(true);
    expect(handed.scope?.has(10)).toBe(false);
    // The value carries no member holding the query, so an operator cannot re-parse it.
    expect(Object.keys(handed.scope!).sort()).toEqual(['count', 'domain', 'has', 'length']);
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

  it('exactly ONE operator calls `faceCountOf` inside its `evaluate`, and it is the pinned one', () => {
    // 🔴 The plan's census said ZERO. Measured: `SetMaterialOp` has called it since ns-1b,
    // for the face RANGE it already ships — correct code the census as written would have
    // redded. Pinned as a literal WITH its reason instead: step 12 is what replaces that
    // range with the resolved selection, and until then a SECOND operator doing the same
    // thing is the fabrication this row exists to catch.
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
      withCall: ['src/nodes/SetMaterialOp.ts'],
    });
  });

  it('no node module can reach the parser, so a second reading of a query has no import', () => {
    // Step 9's property, re-asserted from the consumer side now that consumers exist. The
    // parser is not exported; this checks nobody found another door to it.
    const files = sourceFiles();
    const reachers: string[] = [];
    for (const [path, raw] of files) {
      if (path === 'src/nodes/componentSelection.ts' || path.includes('.test.')) continue;
      if (/\bparseScopeQuery\b|\bselectionFromTerms\b/.test(stripComments(raw)))
        reachers.push(path);
    }
    expect({ examined: files.length, reachers }).toEqual({ examined: files.length, reachers: [] });
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
    const smaller: MeshDataValue = {
      kind: 'MeshData',
      geometry: sphereGeometryRef(
        1,
        3,
        2,
        mintMeshAttributes(sphereDescriptor(1, 3, 2), 'evaluate'),
      ),
      material: null,
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

  it('no registered node type declares a `scope` param yet — so the parse throw is UNREACHABLE', () => {
    // 🔴 THE FUSE ON A DECISION THIS STEP DOES NOT TAKE. An unparseable query is a named
    // throw, and `evaluate` is called on the render road with no try/catch above it — so
    // "who catches it?" is a real question. Today the answer is that nobody has to: no
    // node's schema declares the param, and `setParam` silently rejects a field the schema
    // does not declare, so no authored state can reach the parser.
    //
    // This row is the fuse. The step that first declares a `scope` param reds it, and that
    // is the step that must decide who catches the throw — inherited by nobody, decided by
    // whoever creates the reachability.
    const declaring = listNodeTypes().filter((type) => {
      const shape = (
        getNodeType(type)!.paramSchema as unknown as { shape?: Record<string, unknown> }
      ).shape;
      return shape !== undefined && Object.prototype.hasOwnProperty.call(shape, SCOPE_PARAM);
    });
    expect({ examined: listNodeTypes().length, declaring }).toEqual({
      examined: listNodeTypes().length,
      declaring: [],
    });
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
