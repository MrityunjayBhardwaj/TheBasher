// #394 S4 — THE FOLD ORDER, PINNED.
//
// Three layers can each supply a material field, and until this file nothing said in
// which order. The order was implemented correctly and asserted nowhere, which is the
// state a plan calls out as its own pre-mortem item ("the fold order is assumed rather
// than stated; three layers, no precedent in-repo").
//
// MEASURED AT HEAD, bottom to top:
//
//   1. the data node's own `material` PARAM            (the authored base)
//   2. the `material` SOCKET supersedes it WHOLESALE   (materialSocket.ts — not a merge:
//                                                       if an edge is present the param
//                                                       is not consulted at all)
//   3. the material-lane OPERATOR STACK, bottom → top, each op composing onto the result
//      below it — and the bottom one composes onto (2), NOT onto (1). That is the 🔑
//      claim of this slice: an op sees the socket-resolved base.
//   4. the scene-band `MaterialOverride` wrapper, applied last, at compile time.
//
// ── WHY THE DISCRIMINATOR IS `specular.ior` ─────────────────────────────────────────
//
// It has to be a channel the operator does NOT write, or the probe reports the operator's
// own value instead of the base it was handed — one uniform answer, no information.
//
// When this file was first written that ruled out colour, because an override op forced
// `base.color` unconditionally. That was #529, and it is now fixed: an op writes a field
// only where the director authored it, so an unauthored colour passes through too.
//
// `ior` is still the better discriminator, and for a reason the fix does not touch: it is
// outside the operator's vocabulary ENTIRELY — there is no `ior` param and no bit that
// could ever author one — whereas colour merely happens to be unauthored in these
// fixtures. A structural silence is a stronger premise than a circumstantial one, and it
// stays true no matter what the authored set says. Both are pinned below, separately,
// because they are silent for different reasons and only one of them is load-bearing.
//
// ── WHAT THIS TIER CANNOT REACH, STATED RATHER THAN FUDGED ─────────────────────────
//
// Step 4 is NOT asserted here and cannot be. The scene-band wrapper composes inside the
// renderer (`SceneFromDAG.tsx`, `composeMaterial(ir, override)` at compile), not in the
// evaluator, and the ownership resolver walks only the data lane. So no unit fixture can
// observe the wrapper's position in the fold; its only witness is the browser. The
// wrapper's migration into the lane is deliberately out of scope for this epic, so this
// is a declared boundary and not a gap to close here — recorded so a later reader does
// not mistake the silence for coverage.
//
// REF: src/nodes/materialSocket.ts (step 2); src/nodes/MaterialOverrideOp.ts (step 3);
//      src/app/material/composeMaterial.ts (the fold itself); PLAN-2-COMPOSABLE.md S4
//      + pre-mortem row 4; issue #394.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp, emptyDagState } from '../../core/dag';
import { evaluate } from '../../core/dag/evaluator';
import type { DagState, Op } from '../../core/dag/types';
import type { MeshDataValue } from '../../nodes/types';

registerAllNodes();

/** Three distinct, non-default values, so no two layers can be confused and the schema
 *  default (1.5) cannot masquerade as either one. A read of 1.5 means BOTH were ignored. */
const PARAM_IOR = 1.1;
const LINKED_IOR = 2.4;

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

const materialNode = (id: string, ior: number): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'Material',
  params: { material: { name: 'linked', specular: { ior } } },
});

const dataNode = (id: string, ior: number): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'BoxData',
  params: { size: [1, 1, 1], material: { name: 'inline', specular: { ior } } },
});

/** An override op that forces ROUGHNESS only — deliberately silent about `ior`. */
const overrideOp = (id: string, roughness: number): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'MaterialOverrideOp',
  params: { roughness, overridden: { roughness: true } },
});

const wire = (from: string, fromSocket: string, to: string, toSocket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket: toSocket },
});

const matOf = (state: DagState, id: string) =>
  (evaluate(state, id).value as MeshDataValue).material!;

describe('#394 S4 — an operator sees the SOCKET-resolved base', () => {
  it('CONNECTED: the op composes onto the linked Material, not the data node param', () => {
    const state = build([
      materialNode('m', LINKED_IOR),
      dataNode('d', PARAM_IOR),
      overrideOp('op', 0.9),
      wire('m', 'out', 'd', 'material'),
      wire('d', 'out', 'op', 'target'),
    ]);

    // The base the op was handed carried the LINKED ior, so the socket had already
    // superseded the param BEFORE the stack ran. Had the op composed onto the raw param,
    // this would read PARAM_IOR — the two are distinct precisely so that shows.
    expect(matOf(state, 'op').specular.ior).toBe(LINKED_IOR);
    expect(matOf(state, 'op').specular.ior).not.toBe(PARAM_IOR);
    // …and the op really did run (otherwise the claim above is about a no-op).
    expect(matOf(state, 'op').specular.roughness).toBe(0.9);
  });

  it('DISCONNECTED: the same op composes onto the param — the fall-back half', () => {
    // The other direction, and it is not decoration: asserting only the connected case
    // passes vacuously against a build where the op ALWAYS reads the linked material, or
    // where the fixture never connected anything in the first place.
    const state = build([
      dataNode('d', PARAM_IOR),
      overrideOp('op', 0.9),
      wire('d', 'out', 'op', 'target'),
    ]);

    expect(matOf(state, 'op').specular.ior).toBe(PARAM_IOR);
    expect(matOf(state, 'op').specular.roughness).toBe(0.9);
  });

  it('GUARDS THE PREMISE: the op is silent about ior structurally, about colour by authorship', () => {
    // The discriminator above rests on this, so it is asserted rather than trusted. If a
    // later change gave the op an `ior` opinion, every assertion in this file would keep
    // passing while measuring something else entirely — the failure mode where a fixture
    // quietly stops being able to tell the two answers apart.
    const state = build([
      materialNode('m', LINKED_IOR),
      dataNode('d', PARAM_IOR),
      overrideOp('op', 0.9),
      wire('m', 'out', 'd', 'material'),
      wire('d', 'out', 'op', 'target'),
    ]);

    // STRUCTURAL silence — there is no `ior` param and no bit that could author one, so
    // the base's value survives whatever the director does. This is the load-bearing half.
    expect(matOf(state, 'op').specular.ior).toBe(matOf(state, 'd').specular.ior);

    // CIRCUMSTANTIAL silence — colour is untouched here only because this fixture never
    // authored it. Post-#529 that is enough to pass it through; the op's default white no
    // longer overwrites the linked material. Pinned as the regression witness for #529 at
    // the smallest possible scale: one op, one unauthored field, nothing wiped.
    expect(matOf(state, 'op').base.color).toBe(matOf(state, 'd').base.color);
    expect(matOf(state, 'op').base.color).not.toBe('#ffffff');
  });
});

describe('#394 S4 — the stack folds bottom → top, and the top layer wins', () => {
  it('two ops forcing the same field: the one nearest the Object wins', () => {
    const state = build([
      dataNode('d', PARAM_IOR),
      {
        type: 'addNode',
        nodeId: 'lower',
        nodeType: 'MaterialOverrideOp',
        params: { color: '#111111', overridden: { color: true } },
      },
      {
        type: 'addNode',
        nodeId: 'upper',
        nodeType: 'MaterialOverrideOp',
        params: { color: '#222222', overridden: { color: true } },
      },
      wire('d', 'out', 'lower', 'target'),
      wire('lower', 'out', 'upper', 'target'),
    ]);

    expect(matOf(state, 'upper').base.color).toBe('#222222');
    // Non-vacuous: the lower op genuinely ran and produced its own answer, so this is
    // "the upper one overwrote it", not "the lower one never applied".
    expect(matOf(state, 'lower').base.color).toBe('#111111');
  });

  // ✅ THIS TEST FOUND #529 AND IS NOW ITS REGRESSION WITNESS.
  //
  // Written first as the cumulative claim, it failed: the lower op's authored roughness
  // came back as the UPPER op's default. One `||` was the cause — an op wrote a scalar
  // when the director authored it OR when no source map defended the channel. On the
  // glTF road that fallback is right; on the data lane the base is an untextured
  // primitive, so the map test was always false, the `||` short-circuited, and the
  // authored set was never consulted at all.
  //
  // The fix made the regime an explicit input rather than something inferred from map
  // presence: the data lane composes 'authored-only', where a field is written iff the
  // director authored it. So the expectations below are now the ones originally drafted.
  it('two ops with DISJOINT opinions: each survives the other', () => {
    const state = build([
      dataNode('d', PARAM_IOR),
      overrideOp('lower', 0.8),
      {
        type: 'addNode',
        nodeId: 'upper',
        nodeType: 'MaterialOverrideOp',
        params: { metalness: 0.7, overridden: { metalness: true } },
      },
      wire('d', 'out', 'lower', 'target'),
      wire('lower', 'out', 'upper', 'target'),
    ]);

    const out = matOf(state, 'upper');
    expect(out.base.metalness).toBe(0.7); // the upper op's own opinion lands
    expect(out.specular.roughness).toBe(0.8); // …and the LOWER op's survives it (#529)
    expect(matOf(state, 'lower').specular.roughness).toBe(0.8); // it really was there first
    expect(out.specular.ior).toBe(PARAM_IOR); // …and the base's untouched channel
  });

  it('#529 — an operator with EMPTY params is a no-op, not a wipe', () => {
    // The measured symptom that filed the issue, at its smallest: one operator, nothing
    // authored, dropped onto a material with every channel deliberately set away from the
    // operator's defaults. It used to reset six of the seven.
    const state = build([
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'Material',
        params: {
          material: {
            name: 'authored',
            base: { color: '#c81e5a', metalness: 0.9 },
            specular: { roughness: 0.05, ior: LINKED_IOR },
            emission: { color: '#ff0000', luminance: 3 },
            geometry: { opacity: 0.4 },
          },
        },
      },
      dataNode('d', PARAM_IOR),
      { type: 'addNode', nodeId: 'op', nodeType: 'MaterialOverrideOp', params: {} },
      wire('m', 'out', 'd', 'material'),
      wire('d', 'out', 'op', 'target'),
    ]);

    // Every channel identical to the layer below — asserted as a whole object rather than
    // field by field, so a NEW channel the operator learns to claim is caught too.
    expect(matOf(state, 'op')).toEqual(matOf(state, 'd'));

    // Guard the guard: the layer below really does hold non-default values, so "identical"
    // is a claim about preservation and not about two copies of the schema defaults.
    const below = matOf(state, 'd');
    expect(below.base.color).toBe('#c81e5a');
    expect(below.specular.roughness).toBe(0.05);
    expect(below.geometry.opacity).toBe(0.4);
  });
});
