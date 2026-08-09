// socketTypeUnion — the test that can tell MEMBERSHIP from EQUALITY at the connect
// gate (#609).
//
// WHY THIS FILE HAD TO EXIST BEFORE THE GATE CHANGE COULD BE BELIEVED.
// Replacing `inputDesc.type !== outputDesc.type` with `inputAccepts(...)` is invisible
// to every other test in the suite: every input socket registered today declares
// exactly ONE type, so membership and equality return the same answer on every fixture
// that exists. The change ran the full unit tier and moved nothing — 315 files, 3864
// tests, green before and after, three runs in a row. A green computed over a
// population that is degenerate on the very axis under test licenses nothing, including
// "the change is still there": nothing in the suite would notice the gate being
// silently reverted to equality.
//
// So the discriminating perturbation is not "do connections still work". It is: two
// node types byte-identical except that one input socket declares a SET, wired from the
// same producer. An equality gate cannot tell them apart; a membership gate must.
//
// THE FAILURE MODE THIS FILE IS REALLY GUARDING IS THE OPPOSITE ONE. A gate widened
// until it accepts everything passes every "the union works" test ever written and
// silently stops being a type system. Every acceptance case below is therefore paired
// with a REJECTION on the same socket — a non-member must still throw, and the single
// -type socket must still refuse the type its union-declaring twin takes.
//
// REF: src/core/dag/ops.ts (`applyConnect`, the one and only type gate in the repo);
//      src/core/dag/types.ts (`InputDescriptor`, `inputAccepts`, `acceptedTypes`);
//      issue #609.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyOp } from './ops';
import { emptyDagState } from './state';
import { getNodeType, listNodeTypes, registerNodeType, __resetRegistryForTests } from './registry';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { acceptedTypes } from './types';
import type { DagState } from './state';
import type { Op, SocketTypeName } from './types';

const NoParams = z.object({});

/** A leaf producer emitting exactly `type` on `out`. Outputs are single-typed by
 *  construction — a producer that could emit either of two types is a different node. */
function registerProducer(nodeType: string, type: SocketTypeName): void {
  registerNodeType({
    type: nodeType,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: NoParams,
    inputs: {},
    outputs: { out: { type, cardinality: 'single' } },
    evaluate: () => undefined,
  } as never);
}

/** A consumer whose single `in` socket accepts `accepts` — one type, or a set. The ONLY
 *  difference between the two registrations the discriminator compares. */
function registerConsumer(
  nodeType: string,
  accepts: SocketTypeName | readonly SocketTypeName[],
): void {
  registerNodeType({
    type: nodeType,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: NoParams,
    inputs: { in: { type: accepts, cardinality: 'single' } },
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: () => undefined,
  } as never);
}

function addNode(state: DagState, nodeId: string, nodeType: string): DagState {
  return applyOp(state, { type: 'addNode', nodeId, nodeType, params: {} } as unknown as Op).next;
}

/** Wire `producer.out → consumer.in` on a fresh two-node graph. Throws exactly what the
 *  gate throws. */
function wire(producerType: string, consumerType: string): DagState {
  let state = emptyDagState();
  state = addNode(state, 'n_src', producerType);
  state = addNode(state, 'n_dst', consumerType);
  return applyOp(state, {
    type: 'connect',
    from: { node: 'n_src', socket: 'out' },
    to: { node: 'n_dst', socket: 'in' },
  } as unknown as Op).next;
}

describe('#609 — an input socket accepts a SET of types', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerProducer('TmpEmitsNumber', 'Number');
    registerProducer('TmpEmitsVec3', 'Vector3');
    registerProducer('TmpEmitsObjectData', 'ObjectData');
    // Byte-identical but for the accepted set — this pair IS the discriminator.
    registerConsumer('TmpTakesNumber', 'Number');
    registerConsumer('TmpTakesNumberOrVec3', ['Number', 'Vector3']);
  });

  it('THE DISCRIMINATOR: the same producer is refused by one socket and taken by its set-declaring twin', () => {
    // An equality gate returns the SAME answer for both — 'Vector3' !== 'Number' in each
    // case, because it can only ever ask "is this THE type". Only a membership gate can
    // separate them. If these two ever agree, the gate has gone back to equality and this
    // whole change is cosmetic.
    expect(() => wire('TmpEmitsVec3', 'TmpTakesNumber')).toThrow(/type mismatch/);
    expect(() => wire('TmpEmitsVec3', 'TmpTakesNumberOrVec3')).not.toThrow();

    // And the edge really landed — a gate that returns early leaves no binding behind.
    const state = wire('TmpEmitsVec3', 'TmpTakesNumberOrVec3');
    expect(state.nodes['n_dst'].inputs['in']).toEqual({ node: 'n_src', socket: 'out' });
  });

  it('a set still REFUSES a non-member — the widened-to-uselessness failure mode', () => {
    // The whole risk of this change: a gate relaxed until it takes anything passes every
    // acceptance test above while no longer being a type system at all. ObjectData is in
    // neither socket's set and must still throw.
    expect(() => wire('TmpEmitsObjectData', 'TmpTakesNumberOrVec3')).toThrow(/type mismatch/);
    expect(() => wire('TmpEmitsObjectData', 'TmpTakesNumber')).toThrow(/type mismatch/);
  });

  it('BOTH members of the set are taken, not just the one that happens to be first', () => {
    // Guards the read-the-first-entry bug, which the discriminator alone would miss: it
    // wires a Vector3, which is the SECOND entry, so a gate comparing against entry 0
    // would already be caught — but a gate comparing against the LAST entry would not.
    expect(() => wire('TmpEmitsNumber', 'TmpTakesNumberOrVec3')).not.toThrow();
    expect(() => wire('TmpEmitsVec3', 'TmpTakesNumberOrVec3')).not.toThrow();
  });

  it('a rejection names the whole accepted SET, not one type of it', () => {
    // A gate should say what WOULD have been taken. With a set-valued socket the old
    // message interpolated the raw field and printed `Number,Vector3` — an array coerced
    // by accident, which reads as a typo rather than as a contract.
    expect(() => wire('TmpEmitsObjectData', 'TmpTakesNumberOrVec3')).toThrow(
      /TmpEmitsObjectData\.out:ObjectData → TmpTakesNumberOrVec3\.in:Number\|Vector3/,
    );
  });

  it('acceptedTypes reads a single-type socket as a one-element set', () => {
    // The collapse the helper exists for: every reader sees a set, so no caller has to
    // branch on which spelling the declaration used.
    expect(acceptedTypes({ type: 'Number', cardinality: 'single' })).toEqual(['Number']);
    expect(acceptedTypes({ type: ['Number', 'Vector3'], cardinality: 'single' })).toEqual([
      'Number',
      'Vector3',
    ]);
  });

  it('the set of PRODUCTION input sockets declaring a union is EXACTLY empty today', () => {
    // An EXACT census, not a floor, because the population grows: this feature ships
    // with zero adopters, which is precisely the state in which a silent revert is
    // invisible. Pinning it at empty means the FIRST production socket to declare a set
    // has to come here and say so, where the author is present — rather than the feature
    // quietly having no users forever, or quietly acquiring one nobody reviewed.
    //
    // ⚠️ The known first adopter is `ParamDriver`, whose one role is spelled as two
    // sockets (`in: Number` + `inVec: Vector3`). Collapsing it is NOT free — the socket
    // id is a persisted binding key, so it needs a project-format migration — and is
    // deliberately left out of this slice. When it lands, this list gains
    // `ParamDriver.in` and the four folded readers below start earning their keep.
    __resetRegistryForTests();
    __reseedAllNodesForTests();

    const unions: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      if (!def) continue;
      for (const [socket, desc] of Object.entries(def.inputs)) {
        if (Array.isArray(desc.type)) unions.push(`${type}.${socket}`);
      }
    }
    expect(unions.sort()).toEqual([]);
  });
});
