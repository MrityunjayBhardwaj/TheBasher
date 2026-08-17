// MirrorModifier — the second geometry MODIFIER (SOP), epic #201 / #209, V58.
// Proves: mesh data in → `ModifiedData` carrying a `mirror` geometry handle +
// INHERITED material; mute = identity passthrough; non-mesh data passes through; and —
// the unit-level boundary-pair — the `mirror` geometry KEY the node's evaluate emits is
// BYTE-IDENTICAL to the key the read-side `resolveEvaluatedMesh` derives for the same
// wired chain (H40, no drift). Same shape as ArrayModifier.test.ts — the substrate
// generalizes, and #415 re-confirmed that the cheap way: moving the stack onto the data
// lane changed both modifiers identically, line for line.
//
// See ArrayModifier.test.ts's header for what #415 INVERTED here — the pose assertions
// are gone because a data node has no pose to inherit, which is the point of the split.
//
// REF: src/nodes/MirrorModifier.ts; src/app/modifierGeometry.ts;
//      src/app/resolveEvaluatedMesh.ts (the modifier branch); vyapti V58; issue #415.

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { resolveComponentSelection } from './componentSelection';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedMesh } from '../app/resolveEvaluatedMesh';
import * as geometryRegistry from '../app/geometryRegistry';
import {
  boxDescriptor,
  boxGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
} from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { read } from '../app/attributeStore';
import { MATERIAL_INDEX } from './attributes';

/**
 * The merged face count of an unscoped mirror over the sphere fixture — MEASURED (160), not
 * derived. The fixture's sphere(1, 8, 6) tessellates to 80 triangles and an unscoped mirror
 * keeps the whole input and reflects all of it, so 160 is `2 x 80`. Written as a literal on
 * purpose: computing it from `faceCountOf` here would route the assertion through the same
 * arithmetic the production road uses, and it would then agree with a wrong answer.
 */
const MIRRORED_FACES = 160;
import { hydrateInlineMaterial } from './materialSchema';
import { makeSplitSphere } from '../test-utils/splitSphere';
import { buildAddModifierOps, resolveStackBase } from '../app/operatorStack';
import { MirrorModifierNode } from './MirrorModifier';
import type { CurveDataValue, MeshDataValue, ModifiedDataValue, ObjectData } from './types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** #415 — the modifier's source is DATA now, so the fixture is the data value itself. */
function sphereData(): MeshDataValue {
  return {
    kind: 'MeshData',
    // #638 — folded exactly as `SphereData.evaluate` folds it. An unfolded handle here
    // would make the parity assertion below compare a folded read road against an
    // unfolded fixture, so it would red for a reason that has nothing to do with the
    // modifier — and, worse, would go green again the day the fold was removed.
    geometry: sphereGeometryRef(1, 8, 6, mintMeshAttributes(sphereDescriptor(1, 8, 6), 'evaluate')),
    material: hydrateInlineMaterial(null, '#888888'),
  };
}

function evalMod(
  params: { axis: 'x' | 'y' | 'z'; offset?: number; muted: boolean; scope?: string },
  target: ObjectData | undefined,
): ObjectData | undefined {
  // offset defaults to 0 (zod's default isn't applied when calling evaluate directly,
  // and 0 matches the read-side's default → the parity keys line up).
  // ns-2 step 9b — the fourth argument goes through the ONE resolver, exactly as the
  // evaluator does; see `ArrayModifier.test.ts` for why this helper stays a DIRECT call.
  // ns-2 step 13b — `scope` is OPTIONAL here and REQUIRED on the node (the schema gives it
  // `.default('')`), filled in rather than loosened there: a case that omits it MEANS the
  // authoring state "the author cleared the field", and the two roads must not disagree
  // about that. Neither standing gate can see this — `npm run typecheck` excludes test files
  // and vitest strips types without checking them ([[H362]], [[H327]]).
  const full = { offset: 0, scope: '', ...params };
  return MirrorModifierNode.evaluate(
    full,
    { target },
    ctx,
    resolveComponentSelection(target, full),
  ) as ObjectData | undefined;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('MirrorModifier.evaluate', () => {
  it('mesh data → ModifiedData with a mirror geometry handle + inherited material', () => {
    const src = sphereData();
    const out = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue;
    expect(out.kind).toBe('ModifiedData');
    expect(out.geometry.descriptor.kind).toBe('mirror');
    expect(out.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'x' });
    // INHERITED — the material rides through from the source data (#358).
    expect(out.material).toBe(src.material);
  });

  // #415 — the subtraction, asserted on the second modifier too. If only one of them
  // carried a pose the split would be half-done in a way nothing else here would see.
  it('carries NO pose — a data node has none to carry', () => {
    const out = evalMod({ axis: 'x', muted: false }, sphereData());
    expect(Object.keys(out!).sort()).toEqual(['geometry', 'kind', 'material']);
  });

  it('the axis param feeds the descriptor + key (distinct axes → distinct keys)', () => {
    const src = sphereData();
    const x = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue;
    const y = evalMod({ axis: 'y', muted: false }, src) as ModifiedDataValue;
    expect(y.geometry.descriptor).toMatchObject({ kind: 'mirror', axis: 'y' });
    expect(x.geometry.key).not.toBe(y.geometry.key);
  });

  it('muted → identity passthrough (byte-identical to no modifier — the stack mute-bypass)', () => {
    // THROUGH THE EVALUATOR, not through `evaluate` (ns-2 step 5, #660) — the bypass is
    // declared and honoured by the machinery, so a muted operator's `evaluate` never runs.
    const src = sphereData();
    const out = evaluateNodeAlone('MirrorModifier', { axis: 'x', muted: true }, { target: src });
    expect(out).toBe(src); // same reference — no ModifiedData produced
    // And the operator itself is now blind to the field: its work is its work.
    expect(evalMod({ axis: 'x', muted: true }, src)).not.toBe(src);
  });

  it('non-mesh data (a curve) passes through unchanged — nothing to reshape', () => {
    const curve: CurveDataValue = {
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
    const out = evalMod({ axis: 'x', muted: false }, curve);
    expect(out).toBe(curve);
  });

  it('an unwired source (undefined) stays transparent (no crash)', () => {
    expect(evalMod({ axis: 'x', muted: false }, undefined)).toBeUndefined();
  });
});

describe('MirrorModifier — read-side parity (boundary-pair)', () => {
  // The source is a split sphere: an `Object` (SPHERE_ID) posing a `SphereData`. #415 —
  // the chain is spliced onto the DATA node through the real `buildAddModifierOps`, so
  // this file cannot describe a topology the panel no longer builds.
  const SPHERE_ID = 'n_sphere';
  const SPHERE_DATA = 'n_sphere_data';
  function withMod(axis: 'x' | 'y' | 'z', muted: boolean) {
    const state = makeSplitSphere(buildDefaultDagState(), {
      objectId: SPHERE_ID,
      dataId: SPHERE_DATA,
      radius: 1,
      widthSegments: 8,
      heightSegments: 6,
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
    const res = buildAddModifierOps(state, resolveStackBase(state, SPHERE_ID), 'MirrorModifier', {
      axis,
      muted,
    });
    expect(res).not.toBeNull();
    return {
      state: res!.ops.reduce((s, op) => applyOp(s, op).next, state),
      id: res!.modifierId,
    };
  }

  it('resolveEvaluatedMesh derives the SAME mirror geometry key the evaluate path emits', () => {
    const { state, id } = withMod('z', false);
    // POSSESSION (H218) — the modifier sits BETWEEN the data and the Object.
    expect(state.nodes[id].inputs.target).toMatchObject({ node: SPHERE_DATA, socket: 'out' });
    expect(state.nodes[SPHERE_ID].inputs.data).toMatchObject({ node: id, socket: 'out' });

    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.geometry.descriptor.kind).toBe('mirror');
    // Sync-buildable modified geometry → real UV islands (not null) for the UV editor.
    expect(resolved!.uvRead.status).toBe('ok');
    expect(
      resolved!.uvRead.status === 'ok' && resolved!.uvRead.islands.islands.length,
    ).toBeGreaterThan(0);

    // The evaluate path projects the SAME sphere data with the same axis.
    const evald = evalMod({ axis: 'z', muted: false }, sphereData()) as ModifiedDataValue;
    expect(resolved!.geometry.key).toBe(evald.geometry.key); // byte-identical → no drift
  });

  it('a muted modifier resolves to the source mesh on the read side too', () => {
    const { state, id } = withMod('x', true);
    const resolved = resolveEvaluatedMesh(state, id, ctx);
    expect(resolved!.geometry.descriptor.kind).toBe('sphere'); // passthrough — the source's own handle
  });
});

// ── ns-2 STEP 13b — THE SECOND `'source'` CONSUMER, AND THE LITERAL IT CANNOT REACH ──────
//
// The rule, from the operator's own doc comment and plan §2.2:
//
//     A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET.
//
// 🔴 WHY THIS BLOCK EXISTS AT ALL, GIVEN THAT `ArrayModifier.test.ts` ALREADY ASSERTS THE
// SAME RULE. Both generators reach the geometry through ONE subset helper and ONE key
// builder, and [[V189]] is the measured fact that a parity assertion routed through a shared
// builder cannot see a change to that builder — falsifying the ns-1b fold redded 4 of 4028
// while every same-builder parity row stayed green. Validating the rule on Array alone is
// therefore blind to exactly the code both operators depend on. The defence is a derivation
// this file does NOT share with the helper: the counts below are written as the NUMBERS that
// come out of the arithmetic — 12 preserved faces (36 index) + 6 reflected (18) = **54** —
// never as `faceCountOf(...)`, never as an expression over the unscoped reading, and never as
// a ratio. An expression over the shared code would inherit the shared code's mistake.
//
// Everything goes through `resolveComponentSelection`, the real resolver the evaluator calls,
// never a hand-built selection: a stand-in that skips the producer's transformation inverts
// the test ([[H328]]).
describe('MirrorModifier — a scoped generator, through the operator', () => {
  const boxSource = (): MeshDataValue => {
    const descriptor = boxDescriptor([1, 1, 1]);
    const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
    return {
      kind: 'MeshData',
      geometry: boxGeometryRef([1, 1, 1], attributeKey),
      material: hydrateInlineMaterial(null, '#888888'),
      materialKey: null,
      attributeKey,
    };
  };

  /** Index entries in the BUILT geometry — NEVER `position.count`. */
  function builtIndex(value: ObjectData | undefined): number {
    const geom = geometryRegistry.getForRead((value as ModifiedDataValue).geometry);
    expect(geom, 'the registry could not build this handle').not.toBeNull();
    const index = geom!.getIndex();
    expect(index, 'built without an index').not.toBeNull();
    // A face subset carries every position of the source through as dead weight — measured
    // here: a scoped mirror is 54 index entries over 48 positions — so the index is the only
    // honest reading of "how many triangles are there".
    return index!.count;
  }

  it('🔴 THE DISCRIMINATING ROW — a box mirrored and scoped to half is 54, not 72', () => {
    // THE DIFFERING CASE, FIRST, AND AS A LITERAL. The whole input is preserved (12 faces =
    // 36 index) and the selected half is reflected (6 faces = 18 index): 36 + 18 = 54. The
    // unscoped mirror is 12 + 12 = 24 faces = 72. Both numbers are written out; neither is
    // derived from the other, and neither is derived through the helper under test.
    //
    // This is the row that proves the scope was HONOURED, and it is the row that must red
    // when `MirrorModifier.evaluate` discards its fourth argument — while the array rows one
    // file over stay green, because a per-operator hand-off is what this step adds.
    const src = boxSource();
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false, scope: '0-5' }, src))).toBe(54);
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false }, src))).toBe(72);
  });

  it('…and the three-way comparison, with the by-construction leg LABELLED as such', () => {
    // unscoped 72 ≡ scoped-to-everything 72 ≠ scoped-to-half 54.
    //
    // ⚠️ THE FIRST COMPARISON IS TRUE BY CONSTRUCTION, NOT BY TEST (plan §2, D2). A selection
    // covering every face resolves to the same subset as no selection at all, so this leg
    // cannot fail while the implementation compiles — it is reported, not counted as
    // evidence. The `≠` leg is the one carrying proof. Recorded here so a later reader
    // cannot quote the triple as three independent findings.
    const src = boxSource();
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false }, src))).toBe(72);
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false, scope: '0-11' }, src))).toBe(
      72,
    );
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false, scope: '0-5' }, src))).toBe(54);
  });

  it('…and the same on a SPHERE, so the arithmetic is not a property of twelve faces', () => {
    // sphere(8,6) tessellates to 80 faces = 240 index — read from the BUILT geometry at the
    // measurement, never from the requested segments, because three.js clamps segments
    // silently ([[H324]]): the source row below is what makes the two after it legible.
    // Mirrored unscoped that is 160 faces = 480 index; scoped to `0-39`, half, it is
    // 80 + 40 = 120 faces = 360. Literals again, for the reason in this block's header.
    const src = sphereData();
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false }, src))).toBe(480);
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false, scope: '0-39' }, src))).toBe(
      360,
    );
  });

  it('the scope reaches the KEY as the CANONICAL query, so two spellings share one build', () => {
    // What the operator passes downstream is the resolved selection's IDENTITY, not the
    // authored text. `5,4,3,2,1,0` and `0-5` are one cached geometry rather than two
    // byte-identical ones.
    const src = boxSource();
    const written = evalMod({ axis: 'x', muted: false, scope: '5,4,3,2,1,0' }, src);
    const canonical = evalMod({ axis: 'x', muted: false, scope: '0-5' }, src);
    expect((written as ModifiedDataValue).geometry.key).toBe(
      (canonical as ModifiedDataValue).geometry.key,
    );
    expect((written as ModifiedDataValue).geometry.descriptor).toMatchObject({
      kind: 'mirror',
      scope: '0-5',
    });
  });

  it('🔴 an UNSCOPED mirror is byte-identical to what it was before this step existed', () => {
    // The regression clause. Every graph that ships today authors no scope, so every one of
    // their keys must be unchanged — the field OMITTED, never `{scope: undefined}`
    // ([[H265]]'s shape). A blank query is the same authoring state as none.
    //
    // ⚠️ WHAT HOLDS THIS IS `scopeField`, NOT the resolver's `null` — measured at step 13a,
    // where the first draft credited the wrong one. This row therefore guards the KEY
    // BUILDER's treatment of the unscoped case; the resolver's separate `null`/`''` claim is
    // guarded in the channel gate. Two rows, two subjects, neither evidence for the other.
    const src = boxSource();
    const bare = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue;
    const blank = evalMod({ axis: 'x', muted: false, scope: '' }, src) as ModifiedDataValue;
    //
    // 🔴 THE LITERAL MOVED AT #644 AND THE CLAIM DID NOT. The component is no longer the
    // SOURCE's embedded mid-key but the MIRROR's own tiled one, appended at the end — a
    // #644 change, not a scope change. The row's subject (does an unscoped generator pick
    // up a suffix?) is untouched, and the discriminating half below never moved ([[H342]]).
    expect(bare.geometry.key).toBe('mirror|box|1,1,1|x|0|a:06770795');
    expect(blank.geometry.key).toBe(bare.geometry.key);
    expect(Object.keys(bare.geometry.descriptor).sort()).toEqual([
      'axis',
      'kind',
      'offset',
      'source',
    ]);
  });

  it('a scope selecting NOTHING is the identity — the whole input, and it still builds', () => {
    // D6b through the operator, and it is a stronger statement for Mirror than for Array:
    // Houdini's Keep Original OFF would leave *only* the selected geometry, so an empty
    // selection there is an empty output. This node hard-codes Keep Original ON, so no scope
    // can empty it — 12 faces, 36 index — and `mergeGeometries([full, empty])` returns a
    // valid geometry rather than null, which the plan's own hazard note had assumed
    // otherwise until it was measured.
    const src = boxSource();
    expect(builtIndex(evalMod({ axis: 'x', offset: 3, muted: false, scope: '!0-11' }, src))).toBe(
      36,
    );
  });

  it('a scope over a CURVE never arrives — the resolver refuses it one frame earlier', () => {
    // The operator has no arm for "an authored scope on a value that cannot carry one",
    // because that state cannot reach `evaluate`. The refusal is the resolver's, by name,
    // and it is what makes the operator's `null` mean only "unscoped".
    const curve: CurveDataValue = {
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
    expect(() => evalMod({ axis: 'x', muted: false, scope: '0-5' }, curve)).toThrow(
      /cannot be honoured/,
    );
    // …and an UNSCOPED mirror over a curve still passes it straight through, as it always
    // has. The two conditions are separated, which is the whole of [[V205]].
    expect(evalMod({ axis: 'x', muted: false }, curve)).toBe(curve);
  });
});

// #691 — the table travels through the MIRROR too, asserted here rather than inferred from
// the Array's rows. Both modifiers now forward through one helper (`slotTableThrough`), and
// a shared helper is exactly the shape a parity assertion cannot see into ([[V189]]): a
// defect in it reds both sides or neither. So the discriminating row below is a LITERAL
// merged face count, which the Array's numbers cannot produce and the helper cannot supply.
describe('#691 the Mirror carries its source assignment through the merge', () => {
  it('emits the table and a tiled key sized to the MIRRORED face count', () => {
    const src: MeshDataValue & { materialSlots?: unknown[] } = {
      ...sphereData(),
      materialSlots: [
        hydrateInlineMaterial(null, '#ff0000'),
        hydrateInlineMaterial(null, '#00ff00'),
      ],
    };
    const out = evalMod({ axis: 'x', muted: false }, src) as ModifiedDataValue & {
      materialSlots?: unknown[];
      attributeKey?: string;
    };

    expect(out.material).toBe(src.material);
    expect(out.materialSlots).toEqual(src.materialSlots);
    // The MERGED handle's key, never the source's — the asymmetry the helper holds.
    expect(out.attributeKey).toBe(out.geometry.attributeKey);
    expect(out.attributeKey).not.toBe(src.attributeKey);

    // The literal. An unscoped mirror keeps the whole input and reflects all of it, so the
    // index is twice the source's — and it is the LENGTH that proves the key describes the
    // merged mesh: a forwarded source key would sit here at half this number and be refused
    // by the count gate, drawing slot 0 everywhere.
    const attribute = read(out.attributeKey!)?.[MATERIAL_INDEX];
    expect(attribute?.count).toBe(MIRRORED_FACES);
    expect(attribute?.domain).toBe('face');
  });

  it('emits NEITHER half when the source carries no table', () => {
    const out = evalMod({ axis: 'x', muted: false }, sphereData()) as ModifiedDataValue & {
      materialSlots?: unknown[];
      attributeKey?: string;
    };
    expect('materialSlots' in out).toBe(false);
    expect('attributeKey' in out).toBe(false);
  });
});
