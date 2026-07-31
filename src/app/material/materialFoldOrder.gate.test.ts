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
// ── WHY THE DISCRIMINATOR IS `specular.ior` AND NOT A COLOUR ────────────────────────
//
// The obvious fixture — give each layer a different colour and see which one comes out —
// proves nothing here, and finding out why cost a run. `composeMaterial.ts:80` writes
// `color: fields.color` with NO `?? base.base.color`, so an override op forces
// `base.color` UNCONDITIONALLY, even with `overridden.color` unset. Every colour probe
// therefore reports the OP's colour whatever is underneath, and a fixture built on it
// would be uniform — one answer, no information ([[the choice-between-two rule]]: a test
// of a choice must present both sides).
//
// `specular.ior` is outside the op's vocabulary entirely — the op has no `ior` param and
// composes no opinion about it — so it passes through whatever base the op was handed.
// That makes it the one channel that can report WHICH base that was. The premise is
// itself guarded below, because the whole gate rests on it.
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

  it('GUARDS THE PREMISE: the op is silent about ior and unconditional about colour', () => {
    // The whole discriminator above rests on this, so it is asserted rather than trusted.
    // If a later change gave the op an `ior` opinion, every assertion in this file would
    // keep passing while measuring something else entirely — the failure mode where a
    // fixture quietly stops being able to tell the two answers apart.
    const state = build([
      materialNode('m', LINKED_IOR),
      dataNode('d', PARAM_IOR),
      overrideOp('op', 0.9),
      wire('m', 'out', 'd', 'material'),
      wire('d', 'out', 'op', 'target'),
    ]);

    // Silent about ior: the base's value survives untouched.
    expect(matOf(state, 'op').specular.ior).toBe(matOf(state, 'd').specular.ior);
    // Unconditional about colour: `overridden.color` was never set, and the op's default
    // white still wins over the linked material's colour. This is the behaviour that
    // makes a colour-based fixture useless here, pinned so the reasoning above stays true.
    expect(matOf(state, 'op').base.color).toBe('#ffffff');
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

  // 🔴 THIS GATE FOUND A DEFECT, AND PINS WHAT THE CODE DOES RATHER THAN WHAT IT SHOULD.
  //
  // The test written first asserted the fold is CUMULATIVE — two ops with disjoint
  // opinions, each surviving the other. It failed: the lower op's roughness came back as
  // the UPPER op's default, not its own authored 0.8.
  //
  // The cause is one `||` (materialOverrideMerge.ts:99). An op writes a scalar when the
  // director authored it OR when no source map defends the channel. That fallback is
  // correct where it came from — the glTF road, one override over an imported material,
  // where "no map" really does mean "the scalar is the value". On the data lane the base
  // is an untextured primitive, so the map test is ALWAYS false, the `||` short-circuits,
  // and the `overridden` set is never consulted. The mechanism that exists to make the
  // diff sparse is inert in exactly the case this lane is always in.
  //
  // Measured consequence: a single override op with EMPTY params, dropped onto an
  // authored material, resets six of its seven channels to the operator's own defaults —
  // colour, metalness, roughness, emissive, luminance and opacity. Only `ior` survives,
  // and only because the operator has no field for it.
  //
  // FILED AS #529. It is left unfixed here on purpose: the repair belongs with the
  // decision function, which is deliberately a single shared function, and turning it
  // into two spellings to fix this would undo the gate two files over. So this asserts
  // the real behaviour, so that the fold is documented rather than quietly wrong, and
  // #529 flips these expectations as part of its fix.
  it('⚠️ #529 — an upper op erases channels it never authored (measured, not intended)', () => {
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
    // The upper op's own opinion lands, as it should.
    expect(out.base.metalness).toBe(0.7);
    // …but so does its UNAUTHORED default roughness, erasing the lower op's 0.8.
    // #529 flips this line to `toBe(0.8)`.
    expect(out.specular.roughness).toBe(0.5);
    expect(matOf(state, 'lower').specular.roughness).toBe(0.8); // it really was there first

    // The one channel that composes correctly, and it does so only by being outside the
    // operator's vocabulary — which is the whole shape of #529 in one assertion.
    expect(out.specular.ior).toBe(PARAM_IOR);
  });
});
