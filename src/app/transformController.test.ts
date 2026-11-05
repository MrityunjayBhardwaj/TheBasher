// #1776 — which constraint decides a transform row, so the inspector can lock it and name it.

import { describe, expect, it } from 'vitest';
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

// #1795 — a row a constraint only partly decides shows the own value, editable: it is named but
// not locked. It locks only when a live Track-To is at a fixed full influence.
describe('transformControllerOf — partial control (#1795)', () => {
  const trackTo = (id: string, extra: Record<string, unknown>) =>
    node(id, 'TrackTo', { target: 'n_box', aimPoint: [1, 0, 0], aimNode: '', ...extra });
  const keyOn = (constraint: string, type = 'KeyframeChannelNumber') =>
    node(`${constraint}_k`, type, { target: constraint, paramPath: 'influence', keyframes: [] });
  const ctl = (nodes: object) =>
    transformControllerOf(nodes as unknown as Nodes, 'n_box', 'rotation');

  it('a Track-To below full influence names the row without locking it', () => {
    expect(ctl(trackTo('tt', { influence: 0.5 }))).toEqual({
      nodeId: 'tt',
      type: 'TrackTo',
      locks: false,
    });
  });

  it('a keyed or driven influence never locks, even if its authored value is 1', () => {
    expect(ctl({ ...trackTo('tt', { influence: 1 }), ...keyOn('tt') })?.locks).toBe(false);
    expect(ctl({ ...trackTo('tt', { influence: 1 }), ...keyOn('tt', 'ParamDriver') })?.locks).toBe(
      false,
    );
  });

  it('a strip on the constraint never locks; a muted driver animates nothing', () => {
    const strip = node('tt_strip', 'Strip', { target: 'tt', clip: 'clip' });
    expect(ctl({ ...trackTo('tt', { influence: 1 }), ...strip })?.locks).toBe(false);
    const muted = node('tt_d', 'ParamDriver', { target: 'tt', paramPath: 'influence', mute: true });
    expect(ctl({ ...trackTo('tt', { influence: 1 }), ...muted })?.locks).toBe(true);
  });

  it('a fixed influence of 0 controls nothing', () => {
    expect(ctl(trackTo('tt', { influence: 0 }))).toBeNull();
    // ...unless it is keyed: then it can be above 0.
    expect(ctl({ ...trackTo('tt', { influence: 0 }), ...keyOn('tt') })?.nodeId).toBe('tt');
  });

  it('two stacked: one at full influence locks the row, wherever it sits; the top one is named', () => {
    const lower = trackTo('ta', { order: 0 });
    const upper = trackTo('tb', { order: 1, influence: 0.5 });
    expect(ctl({ ...lower, ...upper })).toEqual({ nodeId: 'tb', type: 'TrackTo', locks: true });
    const both = { ...trackTo('ta', { order: 0, influence: 0.5 }), ...upper };
    expect(ctl(both)?.locks).toBe(false);
  });

  it('a Follow Path never locks position, at any influence', () => {
    const fpAt = (f: number) =>
      node('fp', 'FollowPath', {
        target: 'n_box',
        curve: 'c',
        evalTime: 0,
        offset: 0,
        influence: f,
      });
    expect(transformControllerOf(fpAt(1) as unknown as Nodes, 'n_box', 'position')?.locks).toBe(
      false,
    );
    expect(transformControllerOf(fpAt(0.5) as unknown as Nodes, 'n_box', 'position')?.locks).toBe(
      false,
    );
  });
});
