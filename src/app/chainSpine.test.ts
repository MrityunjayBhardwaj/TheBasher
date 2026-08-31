// chainSpine — the test that can tell a DECLARATION from a socket NAME (#396).
//
// WHY THIS FILE HAD TO EXIST BEFORE THE REFACTOR COULD BE BELIEVED.
// Replacing `const TARGET = 'target'` with the node's own chain declaration is invisible to every
// other test in the suite: all seven operators registered today declare `target` as their spine, so a walk that reads the declaration and a walk that matches the name
// return the SAME answer on every fixture that exists. The refactor ran the full unit
// tier and moved nothing — 314 files, 3860 tests, green before and after. A green like
// that licenses nothing.
//
// The discriminating perturbation is therefore not "does the walk still work" but
// "does the walk follow a spine that is NOT called `target`". Two node types below are
// byte-identical except for which socket they nominate; a name-matching walk cannot
// tell them apart, and a declaration-reading walk must.
//
// The second half is the case the whole issue is about: an operator with a SECOND
// input of the SAME type as its spine. Before #396 that operator registered, connected
// and evaluated while every chain-walking surface silently addressed one of its two
// operands — observed, not predicted.
//
// REF: src/app/operatorChain.ts (`chainSocketOf`, `resolveOperatorBase`);
//      src/core/dag/types.ts (`NodeDefinition.chain`); issue #396.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { registerNodeType, getNodeType, listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import type { DagState } from '../core/dag/state';
import type { Op, SocketId } from '../core/dag/types';
import { acceptedTypes, inputAccepts } from '../core/dag/types';
import { chainSocketOf, isDataLaneOperator, resolveOperatorBase } from './operatorChain';
import { enumerateModifierStack } from './operatorStack';

const ObjectDataSocket = { type: 'ObjectData', cardinality: 'single' } as const;
const BinaryParams = z.object({ muted: z.boolean().default(false) });

/** A binary data-lane operator: a spine plus a same-typed ARGUMENT (Houdini's boolean
 *  cutter, the shape #393's deform needs three of). `spine` decides which is which —
 *  the ONLY difference between the two registrations below. */
function registerBinaryOp(type: string, spine: SocketId): void {
  registerNodeType({
    type,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: BinaryParams,
    inputs: { target: ObjectDataSocket, cutter: ObjectDataSocket },
    outputs: { out: ObjectDataSocket },
    chain: {
      input: spine,
      // A data-lane geometry operator: the selection would name what it reads.
      scope: { kind: 'source', domain: 'face' },
      bypass: { kind: 'passthrough', param: 'muted' },
      section: 'modifier',
    },
    evaluate: (_p, inputs) => inputs[spine],
  } as never);
}

function applyOps(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** The default project's box data, plus a second data node, plus `opType` wired with
 *  `n_box_data → .target` and `n_cut_data → .cutter`. */
function wireBinary(opType: string): DagState {
  let state = buildDefaultDagState();
  state = applyOps(state, [
    {
      type: 'addNode',
      nodeId: 'n_cut_data',
      nodeType: 'BoxData',
      params: { size: [1, 1, 1] },
    } as unknown as Op,
    { type: 'addNode', nodeId: 'n_op', nodeType: opType, params: {} } as unknown as Op,
  ]);
  return applyOps(state, [
    {
      type: 'connect',
      from: { node: 'n_box_data', socket: 'out' },
      to: { node: 'n_op', socket: 'target' },
    } as unknown as Op,
    {
      type: 'connect',
      from: { node: 'n_cut_data', socket: 'out' },
      to: { node: 'n_op', socket: 'cutter' },
    } as unknown as Op,
  ]);
}

describe('#396 — the chain spine is declared, not named', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('THE DISCRIMINATOR: the base moves when the SAME graph nominates a different spine', () => {
    // Two operators, identical in every respect except the socket they nominate.
    registerBinaryOp('TmpSpineTarget', 'target');
    registerBinaryOp('TmpSpineCutter', 'cutter');

    const viaTarget = resolveOperatorBase(wireBinary('TmpSpineTarget'), 'n_op', isDataLaneOperator);
    const viaCutter = resolveOperatorBase(wireBinary('TmpSpineCutter'), 'n_op', isDataLaneOperator);

    // A walk that matched the socket NAME would return 'n_box_data' for BOTH — the
    // `target` edge is present and identical in the two graphs. Only a walk reading the
    // declaration can follow `cutter`. If these two are ever equal, the walk has gone
    // back to matching names and this whole change is cosmetic.
    expect(viaTarget).toBe('n_box_data');
    expect(viaCutter).toBe('n_cut_data');
    expect(viaTarget).not.toBe(viaCutter);
  });

  it('a second SAME-TYPED input is an argument, not a second chain', () => {
    registerBinaryOp('TmpSpineTarget', 'target');
    const state = wireBinary('TmpSpineTarget');

    // It really is on the lane — the point is not that it is excluded.
    expect(isDataLaneOperator(state.nodes['n_op'])).toBe(true);
    expect(chainSocketOf(state.nodes['n_op'])).toBe('target');

    // From the ARGUMENT's side the operator is not something standing on it: the cutter
    // is its own base. This is what stops an argument being mistaken for the chain.
    expect(resolveOperatorBase(state, 'n_cut_data', isDataLaneOperator)).toBe('n_cut_data');
    // And the cutter carries no stack of its own.
    expect(enumerateModifierStack(state, 'n_cut_data')).toEqual([]);
  });

  it('every declared spine names a real input socket whose type matches the output', () => {
    // Two claims the declaration makes that nothing else would catch: a typo'd socket
    // name (the walk would silently find nothing and treat every operator as a base),
    // and the type rule — "an operator's output type equals its input type" was only
    // ever true of the SPINE, and stating the spine is what makes it checkable.
    const offenders: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      const spine = def?.chain?.input;
      if (!def || !spine) continue;
      const inDesc = def.inputs[spine];
      if (!inDesc) {
        offenders.push(`${type}: chain.input '${spine}' is not one of its inputs`);
        continue;
      }
      const outDesc = def.outputs['out'];
      if (!outDesc) {
        offenders.push(`${type}: declares a chain but has no 'out' output`);
        continue;
      }
      // #609 — MEMBERSHIP: a spine may accept a SET of types, and the rule the census
      // states is that the operator's own output type is one the spine takes. Equality
      // here would read FALSE for a set-valued spine while still compiling, silently
      // reporting every such operator as an offender.
      if (!inputAccepts(inDesc, outDesc.type)) {
        offenders.push(
          `${type}: spine '${spine}' accepts ${acceptedTypes(inDesc).join('|')} but 'out' is ${outDesc.type}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the set of chain nodes is EXACTLY the nine operators, across all three lanes', () => {
    // An EXACT set, not a floor: this population grows, and the failure mode of a new
    // operator is that it registers without a spine and every stack surface goes blind
    // to it — silently, because a node with no spine simply is not a chain node. Making
    // the census exact turns that into a failing test at the moment of registration,
    // where the author is present to decide.
    const declared = listNodeTypes().filter((t) => getNodeType(t)?.chain);
    expect(declared.sort()).toEqual([
      'ArrayModifier', // data lane — geometry
      'BevelModifier', // data lane — geometry (#818/#814, the first that MINTS elements)
      'ColorCorrect', // effect lane
      'MaskModifier', // data lane — geometry (#668/#671, the first that REMOVES faces)
      'MaterialOverride', // scene lane
      'MaterialOverrideOp', // data lane — material
      'MirrorModifier', // data lane — geometry
      'SetMaterialOp', // data lane — material (already binary today)
      'Transform', // scene lane
    ]);
  });
});
