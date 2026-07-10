// driverBind (#293, Inc 2) — the pure bind op-builder + the G6 cycle guard's FIRST
// real use. Proves a bind produces applyable ops, a self-bind + a multi-hop driver
// loop are rejected via `driverParamDeps` fed to `wouldCreateCycle`, and the source
// picker lists only Number-output nodes (never the target or another driver).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import {
  buildBindDriverOps,
  buildSetDriverRemapOps,
  buildUnbindDriverOps,
  driverSourceOptions,
  type DriverSource,
} from './driverBind';
import { driverTargetSet } from './paramDrivers';

/** A wired-output DriverSource for `node`'s `out` socket. */
const outSource = (node: string): DriverSource => ({
  kind: 'output',
  id: `out:${node}:out`,
  label: node,
  ref: { node, socket: 'out' },
});
/** A spare-param DriverSource (the `ch()` road). */
const spareSource = (node: string, key: string): DriverSource => ({
  kind: 'spare',
  id: `spare:${node}:${key}`,
  label: `${node} · ${key}`,
  node,
  key,
});
const addSpare = (nodeId: string, key: string, value: number): Op => ({
  type: 'setSpareParam',
  nodeId,
  key,
  param: { type: 'float', value, promoted: true },
});

const BOX_ID = 'n_box';
const PARAM = 'material.metalness';
const DEFAULT_REMAP = { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };

function withNodes(...ops: Op[]): DagState {
  let state = buildDefaultDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}
const addClamp = (id: string): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'Clamp',
  params: { min: 0, max: 1 },
});
const addDriver = (id: string, target: string, paramPath: string): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'ParamDriver',
  params: { target, paramPath, blendMode: 'replace', order: 0 },
});
const connect = (from: string, to: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket: 'in' },
});

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('driverBind', () => {
  it('builds addNode + connect ops that apply cleanly (the happy path)', () => {
    const state = withNodes(addClamp('c1'));
    const res = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: PARAM,
      source: outSource('c1'),
      driverId: 'drv1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    expect(driverTargetSet(next.nodes).has(BOX_ID)).toBe(true);
    expect(next.nodes.drv1.inputs.in).toEqual({ node: 'c1', socket: 'out' });
  });

  it('REJECTS a self-bind (source === target — the trivial cycle, G6)', () => {
    const state = withNodes(addClamp('c1'));
    const res = buildBindDriverOps(state, {
      targetId: 'c1',
      paramPath: 'min',
      source: outSource('c1'),
      driverId: 'drv1',
    });
    expect(res.ok).toBe(false);
  });

  it('REJECTS a multi-hop driver loop via driverParamDeps (G6, the real guard)', () => {
    // c1.min ← D1 ← c2  (c1 depends on c2, edge-less through D1)
    const state = withNodes(
      addClamp('c1'),
      addClamp('c2'),
      addDriver('d1', 'c1', 'min'),
      connect('c2', 'd1'),
    );
    // Now attempt c2.min ← c1 : that would close c2 → c1 → (paramDep) D1 → c2.
    const res = buildBindDriverOps(state, {
      targetId: 'c2',
      paramPath: 'min',
      source: outSource('c1'),
      driverId: 'd2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cycle/i);
  });

  it('buildUnbindDriverOps removes exactly the driver(s) on that param', () => {
    const state = withNodes(
      addClamp('c1'),
      addDriver('drv1', BOX_ID, PARAM),
      connect('c1', 'drv1'),
    );
    const ops = buildUnbindDriverOps(state, BOX_ID, PARAM);
    expect(ops).toEqual([{ type: 'removeNode', nodeId: 'drv1' }]);
    let next = state;
    for (const op of ops) next = applyOp(next, op).next;
    expect(driverTargetSet(next.nodes).has(BOX_ID)).toBe(false);
  });

  it('driverSourceOptions lists Number-output nodes, excluding the target + drivers', () => {
    const state = withNodes(
      addClamp('c1'),
      addDriver('drv1', BOX_ID, PARAM),
      connect('c1', 'drv1'),
    );
    const opts = driverSourceOptions(state, BOX_ID);
    const nodes = opts.filter((o) => o.kind === 'output').map((o) => o.ref.node);
    expect(nodes).toContain('c1');
    expect(nodes).not.toContain(BOX_ID); // never self
    expect(nodes).not.toContain('drv1'); // ParamDriver output is introspection-only
  });

  // ── #294 (Inc 3) — the spare road (a promoted numeric spare is a driver source) ──
  it('driverSourceOptions lists numeric spare params as spare sources (the ch() road)', () => {
    const state = withNodes(addClamp('c1'), addSpare('c1', 'throttle', 5));
    const opts = driverSourceOptions(state, BOX_ID);
    const spare = opts.find((o) => o.kind === 'spare');
    expect(spare).toBeTruthy();
    if (spare?.kind === 'spare') {
      expect(spare.node).toBe('c1');
      expect(spare.key).toBe('throttle');
    }
  });

  it('a spare source excludes the target node itself (avoids the self-node false cycle)', () => {
    const state = withNodes(addSpare(BOX_ID, 'throttle', 5));
    const opts = driverSourceOptions(state, BOX_ID);
    expect(opts.some((o) => o.kind === 'spare' && o.node === BOX_ID)).toBe(false);
  });

  it('driverSourceOptions exposes a Null controller as nine transform-channel sources', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const state = withNodes(addNull);
    const xf = driverSourceOptions(state, BOX_ID).filter(
      (o) => o.kind === 'transform' && o.node === 'ctl',
    );
    expect(xf).toHaveLength(9);
    expect(xf.map((o) => (o.kind === 'transform' ? o.channel : '')).sort()).toEqual([
      'rx',
      'ry',
      'rz',
      'sx',
      'sy',
      'sz',
      'tx',
      'ty',
      'tz',
    ]);
  });

  it('binds via a transform channel: edge-less driver carrying sourceTransform + remap, NO connect', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const state = withNodes(addNull);
    const source: DriverSource = {
      kind: 'transform',
      id: 'xf:ctl:tx',
      label: 'ctl · tx',
      node: 'ctl',
      channel: 'tx',
      remap: { inMin: 0, inMax: 2, outMin: 0, outMax: 10 },
    };
    const res = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: PARAM,
      source,
      driverId: 'drv1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops).toHaveLength(1);
    expect(res.ops[0]).toMatchObject({
      type: 'addNode',
      nodeType: 'ParamDriver',
      params: {
        target: BOX_ID,
        paramPath: PARAM,
        sourceTransform: {
          node: 'ctl',
          channel: 'tx',
          remap: { inMin: 0, inMax: 2, outMin: 0, outMax: 10 },
        },
      },
    });
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    expect(driverTargetSet(next.nodes).has(BOX_ID)).toBe(true);
  });

  it('driverSourceOptions exposes a Null as a vec Point-controller for a vec3 target (#300 F2b)', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const state = withNodes(addNull);
    // A vec3 target offers the Null's WHOLE position as ONE transformVec source (not the
    // nine scalar channels — those are the scalar-target road).
    const vec = driverSourceOptions(state, BOX_ID, 'vec3').filter(
      (o) => o.kind === 'transformVec' && o.node === 'ctl',
    );
    expect(vec).toHaveLength(1);
    // The scalar transform-channel sources are absent for a vec target.
    expect(driverSourceOptions(state, BOX_ID, 'vec3').some((o) => o.kind === 'transform')).toBe(
      false,
    );
  });

  it('binds via a Null Point-controller: edge-less driver carrying sourceTransformVec, NO connect (#300 F2b)', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const state = withNodes(addNull);
    const source: DriverSource = {
      kind: 'transformVec',
      id: 'xfvec:ctl',
      label: 'ctl · position',
      node: 'ctl',
    };
    const res = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: 'position',
      source,
      driverId: 'drv1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops).toHaveLength(1); // no connect — the vec source is edge-less
    expect(res.ops[0]).toMatchObject({
      type: 'addNode',
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'position', sourceTransformVec: { node: 'ctl' } },
    });
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    expect(driverTargetSet(next.nodes).has(BOX_ID)).toBe(true);
  });

  it('buildSetDriverRemapOps sets a range on a transform driver (one setParam, undo-safe)', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    let state = withNodes(addNull);
    const bind = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: PARAM,
      source: { kind: 'transform', id: 'xf:ctl:tx', label: 'ctl · tx', node: 'ctl', channel: 'tx' },
      driverId: 'drv1',
    });
    expect(bind.ok).toBe(true);
    if (!bind.ok) return;
    for (const op of bind.ops) state = applyOp(state, op).next;
    // No remap yet → the raw channel road.
    expect(
      (state.nodes.drv1.params as { sourceTransform?: { remap?: unknown } }).sourceTransform?.remap,
    ).toBeUndefined();

    const ops = buildSetDriverRemapOps(state, 'drv1', {
      inMin: 0,
      inMax: 2,
      outMin: 0,
      outMax: 10,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'setParam',
      nodeId: 'drv1',
      paramPath: 'sourceTransform',
    });
    const applied = applyOp(state, ops[0]);
    expect(
      (
        applied.next.nodes.drv1.params as {
          sourceTransform: { node: string; channel: string; remap: unknown };
        }
      ).sourceTransform,
    ).toEqual({ node: 'ctl', channel: 'tx', remap: { inMin: 0, inMax: 2, outMin: 0, outMax: 10 } });
    // Inverse restores the prior (remap-absent) shape.
    let undone = applied.next;
    undone = applyOp(undone, applied.inverse).next;
    expect(
      (undone.nodes.drv1.params as { sourceTransform?: { remap?: unknown } }).sourceTransform
        ?.remap,
    ).toBeUndefined();
  });

  it('buildSetDriverRemapOps clears a range (remap null → raw channel)', () => {
    const addNull: Op = {
      type: 'addNode',
      nodeId: 'ctl',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    let state = withNodes(addNull);
    const bind = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: PARAM,
      source: {
        kind: 'transform',
        id: 'xf:ctl:tx',
        label: 'ctl · tx',
        node: 'ctl',
        channel: 'tx',
        remap: { inMin: 0, inMax: 2, outMin: 0, outMax: 10 },
      },
      driverId: 'drv1',
    });
    if (!bind.ok) throw new Error('bind failed');
    for (const op of bind.ops) state = applyOp(state, op).next;
    const ops = buildSetDriverRemapOps(state, 'drv1', null);
    expect(ops).toHaveLength(1);
    const applied = applyOp(state, ops[0]);
    expect(applied.next.nodes.drv1.params).toMatchObject({
      sourceTransform: { node: 'ctl', channel: 'tx' },
    });
    expect(
      (applied.next.nodes.drv1.params as { sourceTransform: { remap?: unknown } }).sourceTransform
        .remap,
    ).toBeUndefined();
  });

  it('buildSetDriverRemapOps is empty for a non-transform (wired) driver or a missing node', () => {
    const state = withNodes(addClamp('c1'), addDriver('drv1', BOX_ID, PARAM), {
      type: 'connect',
      from: { node: 'c1', socket: 'out' },
      to: { node: 'drv1', socket: 'in' },
    } as Op);
    expect(buildSetDriverRemapOps(state, 'drv1', DEFAULT_REMAP)).toHaveLength(0);
    expect(buildSetDriverRemapOps(state, 'nope', DEFAULT_REMAP)).toHaveLength(0);
  });

  it('binds via a spare source: one edge-less driver carrying sourceSpare, NO connect', () => {
    const state = withNodes(addClamp('c1'), addSpare('c1', 'throttle', 5));
    const res = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: PARAM,
      source: spareSource('c1', 'throttle'),
      driverId: 'drv1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Exactly one op — the addNode — and no connect (edge-less pull).
    expect(res.ops).toHaveLength(1);
    expect(res.ops[0]).toMatchObject({
      type: 'addNode',
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: PARAM, sourceSpare: { node: 'c1', key: 'throttle' } },
    });
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    expect(driverTargetSet(next.nodes).has(BOX_ID)).toBe(true);
  });

  it('REJECTS a spare-road bind that would close a cycle (G6 via the spare dep edge)', () => {
    // c2.min ← D1 ← (spare on c1).  Then bind c1.max ← (spare on c2): closes
    // c1 → D2 → c2 → D1 → c1.
    const state = withNodes(
      addClamp('c1'),
      addClamp('c2'),
      addSpare('c1', 'k', 1),
      addSpare('c2', 'k', 1),
      {
        type: 'addNode',
        nodeId: 'd1',
        nodeType: 'ParamDriver',
        params: {
          target: 'c2',
          paramPath: 'min',
          blendMode: 'replace',
          order: 0,
          sourceSpare: { node: 'c1', key: 'k' },
        },
      },
    );
    const res = buildBindDriverOps(state, {
      targetId: 'c1',
      paramPath: 'max',
      source: spareSource('c2', 'k'),
      driverId: 'd2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cycle/i);
  });
});

describe('driverBind — the Vector3 road (vec target drive)', () => {
  const addMakeVec3 = (id: string): Op => ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'MakeVec3',
    params: {},
  });
  const vecSource = (node: string): DriverSource => ({
    kind: 'output',
    id: `out:${node}:out`,
    label: node,
    ref: { node, socket: 'out' },
    socketType: 'Vector3',
  });

  it('a Vector3 source binds through the driver `inVec` socket (not `in`)', () => {
    const state = withNodes(addMakeVec3('mv1'));
    const res = buildBindDriverOps(state, {
      targetId: BOX_ID,
      paramPath: 'material.emissive',
      source: vecSource('mv1'),
      driverId: 'drvV',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    let next = state;
    for (const op of res.ops) next = applyOp(next, op).next;
    expect(next.nodes.drvV.inputs.inVec).toEqual({ node: 'mv1', socket: 'out' });
    expect(next.nodes.drvV.inputs.in).toBeUndefined();
  });

  it("driverSourceOptions('vec3') offers Vector3 outputs and excludes scalar sources", () => {
    // A Vector3 producer (MakeVec3), a scalar producer (Clamp), and a numeric spare.
    const state = withNodes(addMakeVec3('mv1'), addClamp('c1'), addSpare('c1', 'knob', 3));
    const vecOpts = driverSourceOptions(state, BOX_ID, 'vec3');
    // MakeVec3.out (Vector3) is offered, tagged for the inVec road…
    const mv = vecOpts.find((o) => o.kind === 'output' && o.ref.node === 'mv1');
    expect(mv).toBeTruthy();
    expect(mv?.kind === 'output' && mv.socketType).toBe('Vector3');
    // …and NO scalar source (Number output / spare) leaks into the vec picker.
    expect(vecOpts.some((o) => o.kind === 'output' && o.ref.node === 'c1')).toBe(false);
    expect(vecOpts.some((o) => o.kind === 'spare')).toBe(false);
    // The scalar picker is unchanged: Clamp.out + the spare, never the Vector3 output.
    const numOpts = driverSourceOptions(state, BOX_ID, 'number');
    expect(numOpts.some((o) => o.kind === 'output' && o.ref.node === 'c1')).toBe(true);
    expect(numOpts.some((o) => o.kind === 'output' && o.ref.node === 'mv1')).toBe(false);
    expect(numOpts.some((o) => o.kind === 'spare')).toBe(true);
  });
});
