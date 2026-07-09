// #291 (Epic 1 Inc 0) — spare-parameter substrate + driver-aware cycle guard.
//
// Spare params (`node.spare`) are ad-hoc, node-authored params living OUTSIDE the
// fixed per-type paramSchema (the Houdini "spare parms" model). The fixed schema
// stays STRICT; spare params are validated by the ONE shared SpareParamSchema.
// The pre-#291 serialize/migration layers already carry arbitrary node fields, so
// the only change needed was the write path + the schema field (see the deleted
// probe / memory note). These tests pin: the strict schema is NOT loosened, spare
// params round-trip through save/load, undo is exact, and the cycle guard now sees
// driver/overlay dependencies that are not wired input edges.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, OpError } from './ops';
import { emptyDagState, wouldCreateCycle } from './state';
import type { DagState, Node, SpareParam } from './types';
import { seedTestRegistry } from './__fixtures__/testNodes';
import { composeProject, loadProject, saveProject } from '../project/io';
import { MemoryStorage } from '../storage/MemoryStorage';

const FLOAT = (value: number): SpareParam => ({ type: 'float', value });

function addTestNumber(state: DagState, id: string, value: number): DagState {
  return applyOp(state, { type: 'addNode', nodeId: id, nodeType: 'TestNumber', params: { value } })
    .next;
}

describe('#291 spare params — write path + strict-schema preservation', () => {
  beforeEach(() => seedTestRegistry());

  it('setSpareParam attaches a spare param and returns a removeSpareParam inverse (new key)', () => {
    const s = addTestNumber(emptyDagState(), 'n1', 7);
    const { next, inverse } = applyOp(s, {
      type: 'setSpareParam',
      nodeId: 'n1',
      key: 'gasLevel',
      param: FLOAT(0.7),
    });
    expect(next.nodes.n1.spare).toEqual({ gasLevel: FLOAT(0.7) });
    // The fixed params are untouched.
    expect(next.nodes.n1.params).toEqual({ value: 7 });
    expect(inverse).toEqual({ type: 'removeSpareParam', nodeId: 'n1', key: 'gasLevel' });
  });

  it('setSpareParam over an existing key returns a restoring setSpareParam inverse', () => {
    let s = addTestNumber(emptyDagState(), 'n1', 7);
    s = applyOp(s, { type: 'setSpareParam', nodeId: 'n1', key: 'gas', param: FLOAT(0.1) }).next;
    const { next, inverse } = applyOp(s, {
      type: 'setSpareParam',
      nodeId: 'n1',
      key: 'gas',
      param: FLOAT(0.7),
    });
    expect(next.nodes.n1.spare).toEqual({ gas: FLOAT(0.7) });
    expect(inverse).toEqual({ type: 'setSpareParam', nodeId: 'n1', key: 'gas', param: FLOAT(0.1) });
  });

  it('removeSpareParam normalizes an emptied collection back to undefined (byte-identical to never-had)', () => {
    let s = addTestNumber(emptyDagState(), 'n1', 7);
    s = applyOp(s, { type: 'setSpareParam', nodeId: 'n1', key: 'gas', param: FLOAT(0.7) }).next;
    const { next, inverse } = applyOp(s, { type: 'removeSpareParam', nodeId: 'n1', key: 'gas' });
    expect(next.nodes.n1.spare).toBeUndefined();
    expect(inverse).toEqual({ type: 'setSpareParam', nodeId: 'n1', key: 'gas', param: FLOAT(0.7) });
  });

  it('removeSpareParam on a missing key throws', () => {
    const s = addTestNumber(emptyDagState(), 'n1', 7);
    expect(() => applyOp(s, { type: 'removeSpareParam', nodeId: 'n1', key: 'nope' })).toThrow(
      OpError,
    );
  });

  it('setSpareParam rejects a malformed spare param', () => {
    const s = addTestNumber(emptyDagState(), 'n1', 7);
    expect(() =>
      applyOp(s, {
        type: 'setSpareParam',
        nodeId: 'n1',
        key: 'bad',
        // @ts-expect-error — invalid type tag, must be rejected at apply time.
        param: { type: 'quaternion', value: 1 },
      }),
    ).toThrow(OpError);
  });

  it('the fixed schema stays STRICT — an undeclared real-param key is still stripped (not promoted to spare)', () => {
    let s = addTestNumber(emptyDagState(), 'n1', 7);
    s = applyOp(s, { type: 'setParam', nodeId: 'n1', paramPath: 'gasLevel', value: 0.7 }).next;
    // A typo'd real param does NOT silently become data — it is dropped, and it is
    // NOT quietly captured as a spare (spare requires the explicit setSpareParam op).
    expect((s.nodes.n1.params as Record<string, unknown>).gasLevel).toBeUndefined();
    expect(s.nodes.n1.spare).toBeUndefined();
  });

  it('undo is exact — inverse restores the prior state deeply', () => {
    const s = addTestNumber(emptyDagState(), 'n1', 7);
    const before = structuredClone(s.nodes.n1);
    const { next, inverse } = applyOp(s, {
      type: 'setSpareParam',
      nodeId: 'n1',
      key: 'gas',
      param: FLOAT(0.7),
    });
    const restored = applyOp(next, inverse).next;
    expect(restored.nodes.n1).toEqual(before);
  });
});

describe('#291 spare params — serialize round-trip', () => {
  beforeEach(() => seedTestRegistry());

  it('a spare param survives composeProject -> save -> load', async () => {
    let s = addTestNumber(emptyDagState(), 'n1', 7);
    s = applyOp(s, { type: 'setSpareParam', nodeId: 'n1', key: 'gas', param: FLOAT(0.7) }).next;
    const project = composeProject({
      id: 'p1',
      name: 'probe',
      state: s,
      createdAt: 1,
      updatedAt: 1,
    });
    const storage = new MemoryStorage();
    await saveProject(storage, project);
    const loaded = await loadProject(storage, 'p1');
    expect(loaded.state.nodes.n1.spare).toEqual({ gas: FLOAT(0.7) });
  });

  it('a bare project (no spare params) round-trips byte-identical', async () => {
    const s = addTestNumber(emptyDagState(), 'n1', 5);
    const before = composeProject({ id: 'p2', name: 'bare', state: s, createdAt: 1, updatedAt: 1 });
    const storage = new MemoryStorage();
    await saveProject(storage, before);
    const after = await loadProject(storage, 'p2');
    expect(JSON.stringify(after.state)).toBe(JSON.stringify(before.state));
  });
});

describe('#291 driver-aware cycle guard (G6)', () => {
  // Hand-built minimal nodes (no evaluator needed) to exercise the traversal.
  function node(id: string, inputNode?: string): Node {
    return {
      id,
      type: 'TestNumber',
      version: 1,
      params: { value: 0 },
      inputs: inputNode ? { in: { node: inputNode, socket: 'out' } } : {},
    };
  }

  it('still catches wired-input cycles and leaves acyclic input graphs alone (pre-#291 behavior intact)', () => {
    // b consumes a (edge a -> b). Adding b -> a would close the loop.
    const state: DagState = { nodes: { a: node('a'), b: node('b', 'a') }, outputs: {} };
    expect(wouldCreateCycle(state, 'b', 'a')).toBe(true);
    expect(wouldCreateCycle(state, 'a', 'b')).toBe(false);
  });

  it('catches a driver/overlay cycle that is NOT a wired input edge', () => {
    // No input edges at all. `a` is driven by `b` (a param dependency a -> b).
    // Adding a -> b (b driven by a) would form a -> b -> a. The input-only walk
    // would miss this; with paramDeps it is caught.
    const state: DagState = { nodes: { a: node('a'), b: node('b') }, outputs: {} };
    const paramDeps = { a: ['b'] };
    expect(wouldCreateCycle(state, 'a', 'b', 32, paramDeps)).toBe(true);
    // Without the paramDeps the same query is (wrongly, pre-#291) considered safe.
    expect(wouldCreateCycle(state, 'a', 'b', 32)).toBe(false);
  });

  it('mixes wired edges and driver deps in one transitive walk', () => {
    // Wired: c consumes b (c depends on b). Driver: b depends on a. So c
    // transitively depends on a — `wouldCreateCycle('c','a')` finds that path, so
    // adding the reverse edge (a depending on c) would close a loop. The wired-only
    // walk stops at b and misses it; the paramDeps walk reaches a.
    const state: DagState = {
      nodes: { a: node('a'), b: node('b'), c: node('c', 'b') },
      outputs: {},
    };
    const paramDeps = { b: ['a'] };
    expect(wouldCreateCycle(state, 'c', 'a', 32, paramDeps)).toBe(true);
    expect(wouldCreateCycle(state, 'c', 'a', 32)).toBe(false);
  });
});
