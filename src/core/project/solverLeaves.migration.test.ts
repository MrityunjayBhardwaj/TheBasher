// #1548 — v21 → v22: the Solver's four input leaves become named body-input leaves.
//
// The old project is built by writing a v22 graph back into the v21 shape (old type, old
// params), so "migrate" has an exact expected answer: the graph it came from. Node ids, the
// output socket and every wire are untouched, which is why the Solver cooks the same values.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../dag';
import type { Op } from '../dag/types';
import { bodyInputLeavesOf } from '../dag/subnetworks';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { loadProject } from './io';
import { migrateProjectFormat } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const node = (nodeId: string, nodeType: string, params: Record<string, unknown>): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

/** A scalar Solver over Math{prev, input} and a tuple Solver over two Vec3Math nodes. */
function current(): DagState {
  return [
    node('p', 'BodyInput', { input: 'prev', slot: 0 }),
    node('i', 'BodyInput', { input: 'input', slot: 0 }),
    node('m', 'Math', { op: 'add' }),
    wire('p', 'm', 'a'),
    wire('i', 'm', 'b'),
    node('s', 'Solver', {}),
    wire('m', 's', 'body'),
    node('iv', 'BodyInputVec', { input: 'inputVec', slot: 0 }),
    node('p0', 'BodyInputVec', { input: 'prevVec', slot: 0 }),
    node('p1', 'BodyInputVec', { input: 'prevVec', slot: 1 }),
    node('a', 'Vec3Math', { op: 'add' }),
    wire('iv', 'a', 'a'),
    wire('p0', 'a', 'b'),
    node('b', 'Vec3Math', { op: 'add' }),
    wire('p1', 'b', 'a'),
    node('sv', 'Solver', {}),
    wire('a', 'sv', 'bodies'),
    wire('b', 'sv', 'bodies'),
    wire('a', 'b', 'b'), // after `b` is inside the body: one owner (#1547)
  ].reduce((st, op) => applyOp(st, op).next, emptyDagState());
}

/** The same graph as v21 saved it. */
function asV21(state: DagState) {
  const OLD: Record<string, (slot: number) => { type: string; params: object }> = {
    p: () => ({ type: 'PrevFrame', params: {} }),
    i: () => ({ type: 'SolverInput', params: {} }),
    iv: () => ({ type: 'SolverInputVec', params: {} }),
    p0: (slot) => ({ type: 'PrevFrameVec', params: { slot } }),
    p1: (slot) => ({ type: 'PrevFrameVec', params: { slot } }),
  };
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([id, n]) => {
      const old = OLD[id]?.((n.params as { slot: number }).slot);
      return [id, old ? { ...n, ...old } : n];
    }),
  );
  return JSON.parse(JSON.stringify({ formatVersion: 21, state: { ...state, nodes } }));
}

describe('#1548 — v21 → v22: Solver input leaves read their input by name', () => {
  it('the app writes v22', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(22);
  });

  it('turns each old leaf into the named leaf it stood for, and nothing else changes', () => {
    const before = current();
    const raw = asV21(before);
    expect(Object.values(raw.state.nodes).map((n) => (n as { type: string }).type)).toEqual(
      expect.arrayContaining(['PrevFrame', 'SolverInput', 'PrevFrameVec', 'SolverInputVec']),
    );
    const migrated = migrateProjectFormat(raw) as { formatVersion: number; state: DagState };
    expect(migrated.formatVersion).toBe(22);
    expect(migrated.state).toEqual(JSON.parse(JSON.stringify(before)));
  });

  it('the migrated leaves are the ones each Solver binds', () => {
    const migrated = migrateProjectFormat(asV21(current())) as { state: DagState };
    const names = (owner: string) =>
      bodyInputLeavesOf(migrated.state, owner)
        .map((l) => `${l.id}=${l.input}[${l.slot}]`)
        .sort();
    expect(names('s')).toEqual(['i=input[0]', 'p=prev[0]']);
    expect(names('sv')).toEqual(['iv=inputVec[0]', 'p0=prevVec[0]', 'p1=prevVec[1]']);
  });

  it('a saved v21 project loads through the real door with the new leaves and the same wires', async () => {
    // The whole load path, not the one step: parse, the format ladder, then the per-node
    // ladder, which throws on a type nothing registers — as the four old ones no longer are.
    const before = current();
    const saved = {
      ...asV21(before),
      id: 'p',
      name: 'old solver',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { PrevFrame: 1, SolverInput: 1, PrevFrameVec: 1, SolverInputVec: 1 },
    };
    const storage = new MemoryStorage();
    await storage.write('projects/p/project.json', new TextEncoder().encode(JSON.stringify(saved)));
    const loaded = await loadProject(storage, 'p');
    expect(loaded.formatVersion).toBe(22);
    expect(loaded.state.nodes).toEqual(JSON.parse(JSON.stringify(before.nodes)));
    expect(Object.keys(loaded.nodeVersions).sort()).toEqual(
      ['BodyInput', 'BodyInputVec', 'Math', 'Solver', 'Vec3Math'].sort(),
    );
  });
});
