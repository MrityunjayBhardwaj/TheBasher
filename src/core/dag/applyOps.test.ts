// #1585 — a batch of operations is applied on one copy of the graph.
//
// One at a time, every operation copies the whole `nodes` record: 6.4 s of a 7.6 s import of
// 5,019 nodes. `applyOps` copies it once and writes the rest in place. That is only allowed to
// change the cost. So the first thing pinned here is that a batch gives EXACTLY what the same
// operations give one by one: the graph (key order included), each inverse, which operations
// changed anything, each badge, and the same refusal at the same operation. The second is that
// the graph handed in is never written. The third is the cost itself.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { sceneOnlyState } from '../../test-utils/sceneOnlyState';
import { buildNativeGltfImportOps } from '../import/nativeGltfImport';
import { __resetRegistryForTests, applyOp } from './index';
import { applyOps, validateOp, type AppliedOp } from './ops';
import type { DagState } from './state';
import { emptyDagState } from './state';
import { useDagStore } from './store';
import { subnetworkOwnersOf } from './subnetworks';
import type { Op } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
});

type Outcome =
  | { readonly ok: true; readonly next: DagState; readonly applied: AppliedOp[] }
  | { readonly ok: false; readonly at: number; readonly message: string };

/** The operations one by one, as the store applied a batch before #1585. */
function oneByOne(state: DagState, ops: readonly Op[]): Outcome {
  const applied: AppliedOp[] = [];
  let working = state;
  for (let i = 0; i < ops.length; i++) {
    try {
      const forward = validateOp(ops[i]);
      const { next, inverse, reportable } = applyOp(working, forward);
      const step = { forward, inverse, changed: next !== working };
      applied.push(reportable ? { ...step, reportable } : step);
      working = next;
    } catch (e) {
      return { ok: false, at: i, message: (e as Error).message };
    }
  }
  return { ok: true, next: working, applied };
}

function asBatch(state: DagState, ops: readonly Op[]): Outcome {
  try {
    return { ok: true, ...applyOps(state, ops) };
  } catch (e) {
    return { ok: false, at: -1, message: (e as Error).message };
  }
}

/** A graph nothing is known about, whose record cannot be written: a write to it throws. */
function frozenCopy(state: DagState): DagState {
  return { ...state, nodes: Object.freeze({ ...state.nodes }) };
}

function expectSame(state: DagState, ops: readonly Op[], label: string): Outcome {
  const expected = oneByOne(frozenCopy(state), ops);
  const got = asBatch(frozenCopy(state), ops);
  if (!expected.ok) {
    expect(got.ok, label).toBe(false);
    if (!got.ok) expect(got.message, label).toBe(expected.message);
    return expected;
  }
  if (!got.ok)
    throw new Error(`${label}: the batch refused what one by one applies: ${got.message}`);
  // Serialised, so the order of the nodes is compared as well as their content: it is the
  // order a saved project lists them in.
  expect(JSON.stringify(got.next), label).toBe(JSON.stringify(expected.next));
  expect(got.applied, label).toEqual(expected.applied);
  // What is kept beside the graph (#1583) is still true of the graph the batch returns.
  expect([...subnetworkOwnersOf(got.next)].sort(), label).toEqual(
    [...subnetworkOwnersOf(frozenCopy(got.next))].sort(),
  );
  return got;
}

// ── random operations of every kind ─────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOCKETS: Readonly<Record<string, readonly string[]>> = {
  Math: ['a', 'b'],
  Lag: ['in'],
  Solver: ['body'],
};
const TYPES = ['Math', 'Math', 'Math', 'BodyInput', 'Lag', 'Solver'] as const;

/** One random operation against `state`. Many are refused, on purpose. */
function randomOp(state: DagState, next: () => number, id: string): Op {
  const ids = Object.keys(state.nodes);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const roll = next();
  if (ids.length < 3 || roll < 0.22) {
    const nodeType = pick(TYPES);
    const params = nodeType === 'BodyInput' ? { input: pick(['prev', 'input', 'other']) } : {};
    const sockets = SOCKETS[nodeType];
    const inputs =
      sockets && ids.length > 0 && next() < 0.4
        ? { [pick(sockets)]: { node: pick(ids), socket: 'out' } }
        : undefined;
    return { type: 'addNode', nodeId: id, nodeType, params, ...(inputs ? { inputs } : {}) };
  }
  const target = pick(ids);
  const sockets = SOCKETS[state.nodes[target].type] ?? ['a'];
  if (roll < 0.45) {
    return {
      type: 'connect',
      from: { node: pick(ids), socket: 'out' },
      to: { node: target, socket: pick(sockets) },
    };
  }
  if (roll < 0.53) {
    const socket = pick(sockets);
    const bound = state.nodes[target].inputs[socket];
    const from = Array.isArray(bound) ? bound[0] : bound;
    return {
      type: 'disconnect',
      from: from ?? { node: pick(ids), socket: 'out' },
      to: { node: target, socket },
    };
  }
  if (roll < 0.66) {
    // A rename; a name that follows another node; a link dropped.
    const kind = next();
    if (kind < 0.45)
      return { type: 'setMeta', nodeId: target, name: `name ${Math.floor(next() * 5)}` };
    if (kind < 0.9)
      return { type: 'setMeta', nodeId: target, name: 'follower', nameFrom: pick(ids) };
    return { type: 'setMeta', nodeId: target, name: undefined };
  }
  if (roll < 0.8) {
    const type = state.nodes[target].type;
    if (type === 'BodyInput') {
      return {
        type: 'setParam',
        nodeId: target,
        paramPath: 'input',
        value: pick(['prev', 'input', 'other']),
      };
    }
    // A real value, a value the schema refuses, a path the node does not own.
    const kind = next();
    if (kind < 0.6)
      return {
        type: 'setParam',
        nodeId: target,
        paramPath: 'op',
        value: pick(['add', 'mul', 'sub']),
      };
    if (kind < 0.8)
      return { type: 'setParam', nodeId: target, paramPath: 'op', value: 'no such op' };
    return { type: 'setParam', nodeId: target, paramPath: 'nowhere.deep', value: 1 };
  }
  if (roll < 0.88) return { type: 'removeNode', nodeId: target };
  if (roll < 0.95) {
    return {
      type: 'setSpareParam',
      nodeId: target,
      key: pick(['k1', 'k2']),
      param: { type: 'float', value: Math.floor(next() * 3) },
    };
  }
  return { type: 'removeSpareParam', nodeId: target, key: pick(['k1', 'k2']) };
}

describe('#1585 — a batch gives what the same operations give one by one', () => {
  it('over 50 random graphs, in batches of 1 to 25, refusals included', () => {
    const seen = {
      batches: 0,
      refused: 0,
      ops: 0,
      followed: 0,
      removed: 0,
      badges: 0,
      unchanged: 0,
    };
    for (let seed = 1; seed <= 50; seed++) {
      const next = rng(seed);
      let state = emptyDagState();
      let counter = 0;
      for (let b = 0; b < 14; b++) {
        // Build the batch against a rehearsal, so most of it applies and its last operation
        // is sometimes one that is refused.
        const size = 1 + Math.floor(next() * 25);
        const ops: Op[] = [];
        let rehearsal = state;
        while (ops.length < size) {
          const op = randomOp(rehearsal, next, `n${seed}_${counter++}`);
          let after: DagState;
          try {
            after = applyOp(rehearsal, validateOp(op)).next;
          } catch {
            if (next() < 0.12) {
              ops.push(op);
              break;
            }
            continue;
          }
          ops.push(op);
          rehearsal = after;
        }
        const outcome = expectSame(state, ops, `seed ${seed} batch ${b}`);
        seen.batches++;
        if (!outcome.ok) {
          seen.refused++;
          continue;
        }
        seen.ops += ops.length;
        for (const [i, step] of outcome.applied.entries()) {
          if (step.reportable) seen.badges++;
          if (!step.changed) seen.unchanged++;
          if (ops[i].type === 'removeNode') seen.removed++;
        }
        // A name that reached a follower: the follower's name is its source's.
        for (const node of Object.values(outcome.next.nodes)) {
          const source = node.meta?.nameFrom ? outcome.next.nodes[node.meta.nameFrom] : undefined;
          if (source?.meta?.name !== undefined && node.meta?.name === source.meta.name)
            seen.followed++;
        }
        state = outcome.next;
      }
    }
    // The comparison is only worth what the generator reaches.
    expect(seen.batches).toBe(700);
    expect(seen.refused).toBeGreaterThan(40);
    expect(seen.ops).toBeGreaterThan(4000);
    expect(seen.followed).toBeGreaterThan(200);
    expect(seen.removed).toBeGreaterThan(50);
    expect(seen.badges).toBeGreaterThan(50);
    expect(seen.unchanged).toBeGreaterThan(50);
  });

  it('a rename reaches a follower made earlier in the same batch, and one made before it', () => {
    const state = apply([
      { type: 'addNode', nodeId: 'src', nodeType: 'Math', params: {} },
      { type: 'addNode', nodeId: 'old', nodeType: 'Math', params: {} },
      { type: 'setMeta', nodeId: 'src', name: 'first' },
      { type: 'setMeta', nodeId: 'old', name: 'x', nameFrom: 'src' },
    ]);
    const ops: Op[] = [
      { type: 'setMeta', nodeId: 'src', name: 'second' },
      { type: 'addNode', nodeId: 'late', nodeType: 'Math', params: {} },
      { type: 'setMeta', nodeId: 'late', name: 'x', nameFrom: 'src' },
      { type: 'setMeta', nodeId: 'old', name: 'own name' },
      { type: 'setMeta', nodeId: 'src', name: 'third' },
    ];
    const outcome = expectSame(state, ops, 'followers');
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.next.nodes.late.meta?.name).toBe('third');
    // `old` dropped its link in this batch: the later rename does not reach it.
    expect(outcome.next.nodes.old.meta?.name).toBe('own name');
  });

  it('a wire refused by a sub-network rule mid-batch is refused with the same words', () => {
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'leaf', nodeType: 'BodyInput', params: { input: 'prev' } },
      { type: 'addNode', nodeId: 'm', nodeType: 'Math', params: {} },
      { type: 'connect', from: { node: 'leaf', socket: 'out' }, to: { node: 'm', socket: 'a' } },
      { type: 'addNode', nodeId: 's', nodeType: 'Solver', params: {} },
      { type: 'connect', from: { node: 'm', socket: 'out' }, to: { node: 's', socket: 'body' } },
      { type: 'addNode', nodeId: 'outside', nodeType: 'Math', params: {} },
      { type: 'connect', from: { node: 'm', socket: 'out' }, to: { node: 'outside', socket: 'a' } },
    ];
    const outcome = expectSame(emptyDagState(), ops, 'single owner');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/"m" is inside the sub-network of Solver "s"/);
  });

  it('a node wired earlier in the batch cannot be removed later in it, and one unwired can', () => {
    const state = apply([
      { type: 'addNode', nodeId: 'a', nodeType: 'Math', params: {} },
      { type: 'addNode', nodeId: 'b', nodeType: 'Math', params: {} },
      { type: 'addNode', nodeId: 'spare', nodeType: 'Math', params: {} },
    ]);
    const wired: Op[] = [
      // The first removal is what makes the batch start counting wires.
      { type: 'removeNode', nodeId: 'spare' },
      { type: 'connect', from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'a' } },
      { type: 'removeNode', nodeId: 'a' },
    ];
    const refused = expectSame(state, wired, 'wired then removed');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toBe('removeNode: a is still consumed by b');

    const unwired: Op[] = [
      ...wired.slice(0, 2),
      { type: 'disconnect', from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'a' } },
      { type: 'removeNode', nodeId: 'a' },
    ];
    const applied = expectSame(state, unwired, 'unwired then removed');
    expect(applied.ok && Object.keys(applied.next.nodes)).toEqual(['b']);
  });

  it('a real import: the cube file', async () => {
    const bytes = readFileSync('public/assets/cube.gltf');
    const result = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/cube.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    const outcome = expectSame(sceneOnlyState(), result.ops, 'cube import');
    expect(outcome.ok).toBe(true);
  });

  it('a batch that changes nothing hands back the graph it was given', () => {
    const state = apply([
      { type: 'addNode', nodeId: 'm', nodeType: 'Math', params: { op: 'add' } },
    ]);
    const { next, applied } = applyOps(state, [
      { type: 'setParam', nodeId: 'm', paramPath: 'op', value: 'add' },
      { type: 'setMeta', nodeId: 'm', name: undefined },
    ]);
    expect(next).toBe(state);
    expect(applied.map((a) => a.changed)).toEqual([false, false]);
  });

  it('a write the schema strips leaves nothing behind in the batch', () => {
    // One by one this hands back the graph it was given; in a batch a write lands in place, so
    // it must not be made at all.
    const state = apply([{ type: 'addNode', nodeId: 'm', nodeType: 'Math', params: {} }]);
    const outcome = expectSame(
      state,
      [
        { type: 'setMeta', nodeId: 'm', name: 'named' },
        { type: 'setParam', nodeId: 'm', paramPath: 'nowhere.deep', value: 1 },
      ],
      'stripped write',
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.applied[1].changed).toBe(false);
    expect(outcome.applied[1].reportable?.badge).toBe('stripped-write');
    expect(outcome.next.nodes.m.params).toEqual(state.nodes.m.params);
  });
});

const apply = (ops: readonly Op[]): DagState =>
  ops.reduce((s, op) => applyOp(s, validateOp(op)).next, emptyDagState());

describe('#1585 — the store applies a batch, its undo and its redo this way', () => {
  const BATCH: Op[] = [
    { type: 'addNode', nodeId: 'a', nodeType: 'Math', params: {} },
    { type: 'addNode', nodeId: 'b', nodeType: 'Math', params: {} },
    { type: 'connect', from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'a' } },
    { type: 'setMeta', nodeId: 'a', name: 'source' },
    { type: 'setMeta', nodeId: 'b', name: 'x', nameFrom: 'a' },
    { type: 'setMeta', nodeId: 'a', name: 'renamed' },
  ];

  it('dispatchAtomic, undo and redo land where one-by-one lands', () => {
    const store = useDagStore.getState();
    const before = useDagStore.getState().state;
    const expected = oneByOne(before, BATCH);
    if (!expected.ok) throw new Error(expected.message);
    const inverses = store.dispatchAtomic(BATCH, 'user', 'batch');
    expect(JSON.stringify(useDagStore.getState().state)).toBe(JSON.stringify(expected.next));
    expect(inverses.map((i) => i.inverse)).toEqual(expected.applied.map((a) => a.inverse));
    expect(useDagStore.getState().undoStack).toHaveLength(1);

    store.undo();
    expect(JSON.stringify(useDagStore.getState().state)).toBe(JSON.stringify(before));
    store.redo();
    expect(JSON.stringify(useDagStore.getState().state)).toBe(JSON.stringify(expected.next));
  });

  it('a batch refused at its last operation leaves the store exactly as it was', () => {
    const store = useDagStore.getState();
    store.dispatchAtomic(BATCH, 'user', 'batch');
    const held = useDagStore.getState().state;
    const snapshot = JSON.stringify(held);
    expect(() =>
      store.dispatchAtomic(
        [
          { type: 'setMeta', nodeId: 'a', name: 'half way' },
          { type: 'addNode', nodeId: 'c', nodeType: 'Math', params: {} },
          { type: 'connect', from: { node: 'b', socket: 'out' }, to: { node: 'a', socket: 'a' } },
        ],
        'user',
        'refused',
      ),
    ).toThrow(/would create a cycle/);
    expect(useDagStore.getState().state).toBe(held);
    expect(JSON.stringify(held)).toBe(snapshot);
    expect(useDagStore.getState().undoStack).toHaveLength(1);
  });
});

describe('#1585 — the cost of a batch', () => {
  /** N nodes, each named, each followed by a second node, then every source renamed. */
  function workload(count: number): Op[] {
    const ops: Op[] = [];
    for (let i = 0; i < count; i++) {
      ops.push({ type: 'addNode', nodeId: `s${i}`, nodeType: 'Math', params: {} });
      ops.push({ type: 'addNode', nodeId: `f${i}`, nodeType: 'Math', params: {} });
      ops.push({ type: 'setMeta', nodeId: `s${i}`, name: `source ${i}` });
      ops.push({ type: 'setMeta', nodeId: `f${i}`, name: 'x', nameFrom: `s${i}` });
      ops.push({
        type: 'connect',
        from: { node: `s${i}`, socket: 'out' },
        to: { node: `f${i}`, socket: 'a' },
      });
    }
    for (let i = 0; i < count; i++)
      ops.push({ type: 'setMeta', nodeId: `s${i}`, name: `renamed ${i}` });
    return ops;
  }
  const timed = (run: () => void): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it('9,000 operations into a graph that grows to 3,000 nodes: at least 10 times faster', () => {
    // A ratio inside one process, so a loaded machine slows both sides. Measured: about 2 s
    // one by one against about 40 ms as a batch.
    const ops = workload(1500);
    let batched: DagState = emptyDagState();
    const asOne = timed(() => {
      batched = applyOps(emptyDagState(), ops).next;
    });
    let single: DagState = emptyDagState();
    const oneAtATime = timed(() => {
      for (const op of ops) single = applyOp(single, validateOp(op)).next;
    });
    expect(Object.keys(batched.nodes)).toHaveLength(3000);
    expect(batched.nodes.f1499.meta?.name).toBe('renamed 1499');
    expect(JSON.stringify(batched)).toBe(JSON.stringify(single));
    expect(asOne * 10).toBeLessThan(oneAtATime);
  });

  it('undoing the batch in the store is not slower than applying it by more than a few times', () => {
    // Undo removes every node again. Asking, per node, whether anything still consumes it by
    // reading every node made undoing a 5,019-node import take 2.2 s against 58 ms to apply.
    const ops = workload(1500);
    const store = useDagStore.getState();
    const applying = timed(() => store.dispatchAtomic(ops, 'user', 'batch'));
    const undoing = timed(() => store.undo());
    expect(Object.keys(useDagStore.getState().state.nodes)).toHaveLength(0);
    expect(undoing).toBeLessThan(applying * 5 + 50);
  });

  it('twice the operations take about twice as long, not four times', () => {
    const small = workload(1500);
    const large = workload(3000);
    applyOps(emptyDagState(), small); // warm
    const best = (ops: Op[]) =>
      Math.min(...[0, 1, 2].map(() => timed(() => applyOps(emptyDagState(), ops))));
    const ratio = best(large) / best(small);
    // Copying per operation gives 4; one copy gives 2. Three is the line between them.
    expect(ratio).toBeLessThan(3);
  });
});
