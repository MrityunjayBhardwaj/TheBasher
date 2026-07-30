// #394 S2 — the material socket: precedence, the persisted binding shape, and the
// structural refusal.
//
// THE VACUITY GUARD, and it is the whole design of this file: the Material node and the
// data node's own param are ALWAYS set to DIFFERENT colours. A test where the socket
// silently failed to connect would fall through to the param and read the param's
// colour, so "connected wins" cannot pass by collision. Asserting only "the material is
// #cccccc" with both sides at the default would be green in a build where the socket did
// nothing at all — which is the failure this slice exists to prevent.
//
// Precedence is asserted in BOTH directions (connected wins / disconnected falls back)
// because a one-directional assertion passes vacuously on a fixture where nothing is
// ever connected.

import { describe, expect, it } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { registerAllNodes } from './registerAll';
import { isMaterialLinked, resolveNodeMaterial } from './materialSocket';
import { setMaterialColorMutator } from '../agent/mutators/builders/setMaterialColor';
import type { DagState, Op } from '../core/dag/types';
import type { MeshDataValue, OpenPBRMaterialValue } from './types';

registerAllNodes();

/** The two colours are DISTINCT and neither is the standard #cccccc, so neither the
 *  schema default nor the renderer's #808080 missing-material grey can be mistaken for
 *  either one. A read that returns the standard means BOTH sides were ignored. */
const NODE_COLOR = '#c81e5a';
const PARAM_COLOR = '#1e9ac8';

function build(ops: Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** A data node carrying PARAM_COLOR in its own param, plus an unwired Material node
 *  carrying NODE_COLOR. Nothing is connected — each test wires what it needs. */
function pair(dataType: 'BoxData' | 'SphereData'): DagState {
  return build([
    {
      type: 'addNode',
      nodeId: 'm',
      nodeType: 'Material',
      params: { material: { name: 'linked', base: { color: NODE_COLOR } } },
    },
    {
      type: 'addNode',
      nodeId: 'd',
      nodeType: dataType,
      params: {
        ...(dataType === 'BoxData' ? { size: [1, 1, 1] } : {}),
        material: { name: 'inline', base: { color: PARAM_COLOR } },
      },
    },
  ]);
}

const link: Op = {
  type: 'connect',
  from: { node: 'm', socket: 'out' },
  to: { node: 'd', socket: 'material' },
};

const colorOf = (state: DagState) =>
  (evaluate(state, 'd').value as MeshDataValue).material!.base.color;

describe.each(['BoxData', 'SphereData'] as const)('%s material socket (#394)', (dataType) => {
  it('DISCONNECTED: the node evaluates its own param — the socket changes nothing', () => {
    const state = pair(dataType);
    expect(state.nodes.d.inputs.material).toBeUndefined(); // nothing connected
    expect(colorOf(state)).toBe(PARAM_COLOR);
  });

  it('CONNECTED: the Material node supersedes the param, wholesale', () => {
    const state = applyOp(pair(dataType), link).next;
    // The edge really exists — a green run cannot be one where connect silently no-oped.
    expect(state.nodes.d.inputs.material).toBeDefined();
    // …and the value read is the NODE's colour, not the param's. The param is still
    // sitting there holding a different colour, so this is a real precedence result.
    expect(colorOf(state)).toBe(NODE_COLOR);
    expect(colorOf(state)).not.toBe(PARAM_COLOR);
  });

  it('DISCONNECT: the param comes back untouched — precedence is not destructive', () => {
    const linked = applyOp(pair(dataType), link).next;
    const unlinked = applyOp(linked, {
      type: 'disconnect',
      from: { node: 'm', socket: 'out' },
      to: { node: 'd', socket: 'material' },
    }).next;
    expect(colorOf(unlinked)).toBe(PARAM_COLOR);
  });

  it('the persisted binding is an ARRAY — the list cardinality is what got saved', () => {
    // Pins the hedge (#394 §8.2). `connect` picks the binding shape from the INPUT
    // socket's declared cardinality, so a "simplification" to `single` would silently
    // change the shape written into save files — a format migration, not a type change.
    const state = applyOp(pair(dataType), link).next;
    expect(Array.isArray(state.nodes.d.inputs.material)).toBe(true);
  });

  it('REFUSES a non-material producer STRUCTURALLY, at connect', () => {
    // Not a runtime null downstream: the graph refuses to record the edge at all.
    const state = build([
      { type: 'addNode', nodeId: 'a', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      {
        type: 'addNode',
        nodeId: 'd',
        nodeType: dataType,
        params: dataType === 'BoxData' ? { size: [1, 1, 1] } : {},
      },
    ]);
    expect(() =>
      applyOp(state, {
        type: 'connect',
        from: { node: 'a', socket: 'out' },
        to: { node: 'd', socket: 'material' },
      }),
    ).toThrow(/type mismatch/);
  });
});

describe('fan-out — one Material, many consumers (#394 D5)', () => {
  it('feeds two data nodes from one Material node, and both read it', () => {
    let state = build([
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'Material',
        params: { material: { name: 'shared', base: { color: NODE_COLOR } } },
      },
      {
        type: 'addNode',
        nodeId: 'd',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: { name: 'inline', base: { color: PARAM_COLOR } } },
      },
      {
        type: 'addNode',
        nodeId: 'd2',
        nodeType: 'SphereData',
        params: { material: { name: 'inline', base: { color: PARAM_COLOR } } },
      },
    ]);
    state = applyOp(state, link).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'm', socket: 'out' },
      to: { node: 'd2', socket: 'material' },
    }).next;

    // `connect` puts no arity restriction on an OUTPUT — fan-out is legal by
    // construction, which is the entire point of giving the material a node.
    expect(colorOf(state)).toBe(NODE_COLOR);
    expect((evaluate(state, 'd2').value as MeshDataValue).material!.base.color).toBe(NODE_COLOR);

    // Editing the ONE material moves BOTH consumers — the claim #394 was filed on.
    const edited = applyOp(state, {
      type: 'setParam',
      nodeId: 'm',
      paramPath: 'material.base.color',
      value: '#00ff00',
    }).next;
    expect(colorOf(edited)).toBe('#00ff00');
    expect((evaluate(edited, 'd2').value as MeshDataValue).material!.base.color).toBe('#00ff00');
  });
});

describe('the WRITE road — the agent edits what actually renders (#394 S3)', () => {
  it('setMaterialColor on the OBJECT writes the linked Material node, and the render moves', () => {
    // The offer==accept gate. Before the ownership hop this was the tenth instance of a
    // shape worth naming: the mutator passed its precondition, emitted a setParam against
    // the BoxData, applied it cleanly — and the rendered colour did not move. Reported
    // success, did nothing. Asserted on the EVALUATED value, not on the emitted op,
    // because "an op was produced" is exactly what the broken version also did.
    let state = build([
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'Material',
        params: { material: { name: 'shared', base: { color: NODE_COLOR } } },
      },
      {
        type: 'addNode',
        nodeId: 'd',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: { name: 'inline', base: { color: PARAM_COLOR } } },
      },
      { type: 'addNode', nodeId: 'obj', nodeType: 'Object', params: { position: [0, 0, 0] } },
      { type: 'connect', from: { node: 'd', socket: 'out' }, to: { node: 'obj', socket: 'data' } },
      {
        type: 'connect',
        from: { node: 'm', socket: 'out' },
        to: { node: 'd', socket: 'material' },
      },
    ]);
    const spec = { targetSelectors: ['obj'], color: '#00ff00' };
    expect(setMaterialColorMutator.preconditions(spec, {} as never, state).ok).toBe(true);
    for (const op of setMaterialColorMutator.build(spec, {} as never, state)) {
      state = applyOp(state, op).next;
    }
    expect(colorOf(state)).toBe('#00ff00');
    // The data node's own param was NOT touched — the authority is the Material node, and
    // the param is still sitting underneath waiting for an unlink.
    expect(
      (state.nodes.d.params as { material: { base: { color: string } } }).material.base.color,
    ).toBe(PARAM_COLOR);
  });
});

describe('resolveNodeMaterial — the rule itself', () => {
  const linkedValue: OpenPBRMaterialValue = {
    kind: 'OpenPBRMaterial',
    spec: { base: { color: NODE_COLOR } } as never,
  };

  it('always returns a COMPLETE IR, whichever source won', () => {
    // The socket is a FOURTH source of a material value and goes through the same
    // hydrate seam as the other three, so no consumer has to ask whether a lobe is set.
    const fromSocket = resolveNodeMaterial([linkedValue], undefined);
    expect(fromSocket.specular.roughness).toBe(0.3);
    expect(fromSocket.maps.albedo).toBeNull();
    expect(fromSocket.uvTransform.tiling).toEqual([1, 1]);
    expect(fromSocket.base.color).toBe(NODE_COLOR);
  });

  it('treats an EMPTY list binding as disconnected, not as a material', () => {
    // A disconnect can leave `[]` behind; falling through to the param is the same
    // answer as never having connected, and is what keeps disconnect non-destructive.
    expect(resolveNodeMaterial([], { base: { color: PARAM_COLOR } }).base.color).toBe(PARAM_COLOR);
    expect(isMaterialLinked([])).toBe(false);
  });

  it('ignores a value that is not a material, rather than half-reading it', () => {
    expect(isMaterialLinked([{ kind: 'MeshData' }])).toBe(false);
    expect(
      resolveNodeMaterial([{ kind: 'MeshData' }], { base: { color: PARAM_COLOR } }).base.color,
    ).toBe(PARAM_COLOR);
  });

  it('accepts a bare (non-array) binding too — the evaluator shapes it from the BINDING', () => {
    expect(isMaterialLinked(linkedValue)).toBe(true);
    expect(resolveNodeMaterial(linkedValue, { base: { color: PARAM_COLOR } }).base.color).toBe(
      NODE_COLOR,
    );
  });
});
