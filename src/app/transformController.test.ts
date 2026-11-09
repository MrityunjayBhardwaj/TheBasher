// #1776 — which constraint decides a transform row, so the inspector can lock it and name it.
// #1795 — and whether it decides the row outright (locked, the drawn value) or only partly (named,
// the object's own value, editable).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { addStepOps, influenceOf, setInfluenceOps } from '../core/dag/chainEdit';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { transformControllerOf } from './nodeConstraints';

type Nodes = Parameters<typeof transformControllerOf>[0];
const node = (id: string, type: string, params: Record<string, unknown>) => ({
  [id]: { id, type, params, inputs: {} },
});

describe('transformControllerOf (#1776)', () => {
  const tt = node('tt', 'TrackTo', { target: 'n_box', aimPoint: [1, 0, 0], aimNode: '' });
  const fp = node('fp', 'FollowPath', { target: 'n_box', curve: 'c', evalTime: 0, offset: 0 });

  it('a Track-To decides rotation and quaternion, not position', () => {
    const nodes = { ...tt } as unknown as Nodes;
    expect(transformControllerOf(nodes, 'n_box', 'rotation')).toEqual({
      nodeId: 'tt',
      type: 'TrackTo',
      locks: true,
    });
    expect(transformControllerOf(nodes, 'n_box', 'quaternion')).toEqual({
      nodeId: 'tt',
      type: 'TrackTo',
      locks: true,
    });
    expect(transformControllerOf(nodes, 'n_box', 'position')).toBeNull();
    expect(transformControllerOf(nodes, 'n_box', 'scale')).toBeNull();
  });

  it('a Follow-Path names position without locking it (its own position is the offset), not rotation', () => {
    const nodes = { ...fp } as unknown as Nodes;
    expect(transformControllerOf(nodes, 'n_box', 'position')).toEqual({
      nodeId: 'fp',
      type: 'FollowPath',
      locks: false,
    });
    expect(transformControllerOf(nodes, 'n_box', 'rotation')).toBeNull();
  });

  it('a muted constraint decides nothing, and another object is not locked', () => {
    const nodes = node('tt', 'TrackTo', {
      target: 'n_box',
      aimPoint: [1, 0, 0],
      aimNode: '',
      mute: true,
    }) as unknown as Nodes;
    expect(transformControllerOf(nodes, 'n_box', 'rotation')).toBeNull();
    expect(transformControllerOf({ ...tt } as unknown as Nodes, 'other', 'rotation')).toBeNull();
  });
});

// #1795 — on a chain (#1811) a constraint's influence is its step's blend: a Value feeds the
// three mixes. It locks the row only when a live Track-To is at a fixed full influence; keyed,
// driven or stripped, the number moves, so it never locks.
describe('transformControllerOf — partial control on a chain (#1795)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  const run = (s: DagState, ops: readonly object[] | null) => {
    expect(ops).not.toBeNull();
    for (const o of ops!) s = applyOp(s, o as never).next;
    return s;
  };
  const scene = () =>
    makeSplitCube(buildDefaultDagState(), {
      objectId: 'a',
      position: [0, 4, 0],
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  const aim = (s: DagState, id: string, influence?: number, force = false) => {
    s = run(s, addStepOps(s, 'a', id, 'TrackTo', { aimNode: '', aimPoint: [1, 0, 0] }));
    return influence === undefined ? s : run(s, setInfluenceOps(s, 'a', id, influence, force));
  };
  /** The Value node holding `step`'s influence: what a key, a driver or a strip names. */
  const held = (s: DagState, step: string) => {
    const inf = influenceOf(s, 'a', step);
    expect(inf?.kind).toBe('value');
    return (inf as { nodeId: string }).nodeId;
  };
  const withNodes = (s: DagState, extra: object) => ({ ...s.nodes, ...extra }) as unknown as Nodes;
  const ctl = (nodes: Nodes) => transformControllerOf(nodes, 'a', 'rotation');

  it('a Track-To below full influence names the row without locking it', () => {
    const s = aim(scene(), 'tt', 0.5);
    expect(ctl(s.nodes as unknown as Nodes)).toEqual({
      nodeId: 'tt',
      type: 'TrackTo',
      locks: false,
    });
  });

  it('a Track-To at full influence locks the row, with or without a blend wired', () => {
    expect(ctl(aim(scene(), 'tt').nodes as unknown as Nodes)?.locks).toBe(true);
    // Wired at 1 so there is a number to key, and nothing keys it yet.
    expect(ctl(aim(scene(), 'tt', 1, true).nodes as unknown as Nodes)?.locks).toBe(true);
  });

  it('a keyed or driven influence never locks, even if its held value is 1', () => {
    const s = aim(scene(), 'tt', 1, true);
    const value = held(s, 'tt');
    const key = node('k', 'KeyframeChannelNumber', { target: value, paramPath: 'value' });
    const driver = node('d', 'ParamDriver', { target: value, paramPath: 'value' });
    expect(ctl(withNodes(s, key))?.locks).toBe(false);
    expect(ctl(withNodes(s, driver))?.locks).toBe(false);
  });

  it('a strip on the influence never locks; a muted driver animates nothing', () => {
    const s = aim(scene(), 'tt', 1, true);
    const value = held(s, 'tt');
    expect(ctl(withNodes(s, node('st', 'Strip', { target: value, clip: 'clip' })))?.locks).toBe(
      false,
    );
    const muted = node('d', 'ParamDriver', { target: value, paramPath: 'value', mute: true });
    expect(ctl(withNodes(s, muted))?.locks).toBe(true);
  });

  it('a fixed influence of 0 controls nothing, unless it is keyed', () => {
    const s = aim(scene(), 'tt', 0);
    expect(ctl(s.nodes as unknown as Nodes)).toBeNull();
    const key = node('k', 'KeyframeChannelNumber', { target: held(s, 'tt'), paramPath: 'value' });
    expect(ctl(withNodes(s, key))?.nodeId).toBe('tt');
  });

  it('two stacked: one at full influence locks the row, wherever it sits; the top one is named', () => {
    const lowerFull = aim(aim(scene(), 'ta'), 'tb', 0.5);
    expect(ctl(lowerFull.nodes as unknown as Nodes)).toEqual({
      nodeId: 'tb',
      type: 'TrackTo',
      locks: true,
    });
    const bothHalf = aim(aim(scene(), 'ta', 0.5), 'tb', 0.5);
    expect(ctl(bothHalf.nodes as unknown as Nodes)?.locks).toBe(false);
  });

  it('a Follow Path never locks position, at any influence', () => {
    const fpAt = (f: number) => {
      let s = scene();
      s = run(s, addStepOps(s, 'a', 'fp', 'FollowPath', { curve: '', evalTime: 0, offset: 0 }));
      return run(s, setInfluenceOps(s, 'a', 'fp', f, true));
    };
    for (const f of [1, 0.5])
      expect(transformControllerOf(fpAt(f).nodes as unknown as Nodes, 'a', 'position')?.locks).toBe(
        false,
      );
  });
});
