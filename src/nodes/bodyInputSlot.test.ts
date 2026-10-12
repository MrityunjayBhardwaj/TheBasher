// #1574 — a body-input leaf's `slot`, checked against what its owner fills.
//
// A leaf reading a LIST input picks one element with `slot`. Past the end of the list the leaf
// is bound to nothing and reads its default, and nothing said so. The owner now states how long
// each list input is (`sizedBy`), the leaf's slot is checked against it, and on a single input,
// where `slot` does nothing, the row is not drawn.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, registerNodeType } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import { bindBodyInputs, bodyInputLeavesOf, bodyInputSlotOf } from '../core/dag/subnetworks';
import type { Op } from '../core/dag/types';
import { paramStandingOf } from './paramWidget';
import { registerAllNodes } from './registerAll';
import { BodyInputParams, bodyInputSlotStanding } from './Solver';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

/** A vector Solver `id` with `bodies` wired outputs; each is fed by a leaf reading `prevVec` at
 *  the slot given in `slots` (one leaf per entry, named `${id}_p${index}`). */
function vecSolver(id: string, bodies: number, slots: readonly number[]): Op[] {
  const ops: Op[] = [];
  slots.forEach((slot, i) =>
    ops.push(node(`${id}_p${i}`, 'BodyInputVec', { input: 'prevVec', slot })),
  );
  ops.push(node(id, 'Solver'));
  for (let b = 0; b < bodies; b++) {
    ops.push(node(`${id}_b${b}`, 'Vec3Math', { op: 'add' }));
    // Every leaf feeds every body, so each is inside the sub-network whatever `bodies` is.
    ops.push(wire(`${id}_p${b % slots.length}`, `${id}_b${b}`, 'a'));
    ops.push(wire(`${id}_b${b}`, id, 'bodies'));
  }
  // Leaves not yet reached by a body: hang them on the first body's other input.
  if (bodies > 0 && slots.length > bodies) {
    ops.push(node(`${id}_extra`, 'Vec3Math', { op: 'add' }));
    for (let i = bodies; i < slots.length; i++) {
      ops.push(wire(`${id}_p${i}`, `${id}_extra`, i === bodies ? 'a' : 'b'));
    }
    ops.push(wire(`${id}_extra`, `${id}_b0`, 'b'));
  }
  return ops;
}

describe('what a leaf`s slot means where it sits (#1574)', () => {
  it('a slot the owner fills, and one past the end', () => {
    // Two bodies (a spring: position and velocity), three leaves at slots 0, 1 and 2.
    const s = apply(emptyDagState(), vecSolver('S', 2, [0, 1, 2]));
    expect(bodyInputSlotOf(s, 'S_p0')).toEqual({
      kind: 'list',
      slot: 0,
      length: 2,
      filled: true,
      owner: 'S',
      sizedBy: 'bodies',
    });
    expect(bodyInputSlotOf(s, 'S_p1')).toMatchObject({ slot: 1, length: 2, filled: true });
    expect(bodyInputSlotOf(s, 'S_p2')).toMatchObject({ slot: 2, length: 2, filled: false });
  });

  it('agrees with what the cook really binds, slot by slot', () => {
    const s = apply(emptyDagState(), vecSolver('S', 2, [0, 1, 2]));
    const leaves = bodyInputLeavesOf(s, 'S');
    // The state a two-body Solver carries: one vector per body.
    const bound = bindBodyInputs(s, 'S', leaves, {
      prevVec: [
        [1, 1, 1],
        [2, 2, 2],
      ],
    });
    for (const leaf of ['S_p0', 'S_p1', 'S_p2']) {
      const at = bodyInputSlotOf(s, leaf);
      expect(at.kind === 'list' && at.filled, leaf).toBe(bound.has(leaf));
    }
    expect([...bound.keys()].sort()).toEqual(['S_p0', 'S_p1']);
  });

  it('wiring another body fills the slot', () => {
    let s = apply(emptyDagState(), vecSolver('S', 2, [0, 1, 2]));
    expect(bodyInputSlotOf(s, 'S_p2')).toMatchObject({ length: 2, filled: false });
    s = apply(s, [node('S_b2', 'Vec3Math', { op: 'add' }), wire('S_b2', 'S', 'bodies')]);
    expect(bodyInputSlotOf(s, 'S_p2')).toMatchObject({ length: 3, filled: true });
  });

  it('a single input has no slots', () => {
    const s = apply(emptyDagState(), [
      node('one', 'BodyInputVec', { input: 'inputVec', slot: 3 }),
      node('num', 'BodyInput', { input: 'prev', slot: 5 }),
      node('S', 'Solver'),
      node('b', 'Vec3Math', { op: 'add' }),
      wire('one', 'b', 'a'),
      wire('num', 'b', 's'),
      wire('b', 'S', 'bodies'),
    ]);
    expect(bodyInputSlotOf(s, 'one')).toEqual({ kind: 'single' });
    expect(bodyInputSlotOf(s, 'num')).toEqual({ kind: 'single' });
  });

  it('a leaf with no owner, or a name its owner does not declare, has nothing to check', () => {
    const s = apply(emptyDagState(), [
      node('stray', 'BodyInputVec', { input: 'prevVec', slot: 9 }),
      node('typo', 'BodyInputVec', { input: 'prevVce', slot: 9 }),
      // `prev` is a Number input; a vector leaf naming it reads nothing.
      node('wrongType', 'BodyInputVec', { input: 'prev', slot: 9 }),
      node('S', 'Solver'),
      node('b', 'Vec3Math', { op: 'add' }),
      wire('typo', 'b', 'a'),
      wire('wrongType', 'b', 'b'),
      wire('b', 'S', 'bodies'),
    ]);
    expect(bodyInputSlotOf(s, 'stray')).toEqual({ kind: 'no-owner' });
    expect(bodyInputSlotOf(s, 'typo')).toEqual({ kind: 'no-owner' });
    expect(bodyInputSlotOf(s, 'wrongType')).toEqual({ kind: 'no-owner' });
  });

  it('a leaf inside an inner Solver is measured against the inner one', () => {
    // Inner: one body. Outer: three bodies, one of them fed (through a Number) by nothing of
    // the inner's leaves, so the inner sub-network sits whole inside the outer one.
    const s = apply(emptyDagState(), [
      ...vecSolver('I', 1, [0, 1]),
      node('O', 'Solver'),
      node('O_b0', 'Vec3Math', { op: 'add' }),
      node('O_b1', 'Vec3Math', { op: 'add' }),
      node('O_b2', 'Vec3Math', { op: 'add' }),
      { type: 'connect', from: { node: 'I', socket: 'outVec' }, to: { node: 'O_b0', socket: 'a' } },
      wire('O_b0', 'O', 'bodies'),
      wire('O_b1', 'O', 'bodies'),
      wire('O_b2', 'O', 'bodies'),
    ]);
    expect(bodyInputSlotOf(s, 'I_p1')).toMatchObject({ owner: 'I', length: 1, filled: false });
    expect(bodyInputSlotOf(s, 'I_p0')).toMatchObject({ owner: 'I', length: 1, filled: true });
  });
});

describe('what the inspector is told about the slot row (#1574)', () => {
  it('the leaf`s `slot` declares the standing', () => {
    expect(paramStandingOf(BodyInputParams.shape.slot)).toBe(bodyInputSlotStanding);
    expect(paramStandingOf(BodyInputParams.shape.input)).toBeUndefined();
  });

  it('a filled slot is an ordinary row; a single input and a stray leaf draw no row', () => {
    const s = apply(emptyDagState(), [
      ...vecSolver('S', 2, [0, 1, 2]),
      node('one', 'BodyInputVec', { input: 'inputVec' }),
      wire('one', 'S_b1', 'b'),
      node('stray', 'BodyInputVec', { input: 'prevVec', slot: 4 }),
    ]);
    expect(bodyInputSlotStanding(s, 'S_p1')).toBeNull();
    expect(bodyInputSlotStanding(s, 'one')).toEqual({ kind: 'unused' });
    expect(bodyInputSlotStanding(s, 'stray')).toEqual({ kind: 'unused' });
  });

  it('a slot nothing fills is a note that says what is filled', () => {
    const two = apply(emptyDagState(), vecSolver('S', 2, [0, 1, 2]));
    expect(bodyInputSlotStanding(two, 'S_p2')).toEqual({
      kind: 'note',
      text: 'nothing fills slot 2: its bodies fill slots 0 to 1, so this reads its default',
    });
    const one = apply(emptyDagState(), vecSolver('S', 1, [0, 1]));
    expect(bodyInputSlotStanding(one, 'S_p1')).toEqual({
      kind: 'note',
      text: 'nothing fills slot 1: its bodies fill slot 0 only, so this reads its default',
    });
  });
});

describe('an owner says how long each list input is (#1574)', () => {
  const NUMBER = { type: 'Number', cardinality: 'single' } as const;
  const LIST = { type: 'Number', cardinality: 'list' } as const;
  const owner = (bodyInputs: unknown, inputs: unknown = { body: { ...LIST, body: true } }) =>
    ({
      type: 'Owner',
      version: 1,
      pure: false,
      stateful: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs,
      outputs: { out: NUMBER },
      bodyInputs,
      evaluate: () => 0,
    }) as never;

  it('a list input sized by one of the owner`s list sockets registers', () => {
    expect(() => registerNodeType(owner({ prev: { ...LIST, sizedBy: 'body' } }))).not.toThrow();
  });

  it('a list input with no length is refused', () => {
    expect(() => registerNodeType(owner({ prev: LIST }))).toThrow(
      /sub-network input "prev" is sized wrongly: a list input must say which input gives its length/,
    );
  });

  it('a length taken from a socket that does not exist, or carries one value, is refused', () => {
    expect(() => registerNodeType(owner({ prev: { ...LIST, sizedBy: 'nope' } }))).toThrow(
      /it has no input socket "nope"/,
    );
    expect(() =>
      registerNodeType(
        owner({ prev: { ...LIST, sizedBy: 'body' } }, { body: { ...NUMBER, body: true } }),
      ),
    ).toThrow(/"body" carries one value, so it cannot give a length/);
  });

  it('a single input that claims a length is refused', () => {
    expect(() => registerNodeType(owner({ prev: { ...NUMBER, sizedBy: 'body' } }))).toThrow(
      /it is a single value, which has no length/,
    );
  });
});
