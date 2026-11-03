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
    });
    expect(transformControllerOf(nodes, 'n_box', 'quaternion')).toEqual({
      nodeId: 'tt',
      type: 'TrackTo',
    });
    expect(transformControllerOf(nodes, 'n_box', 'position')).toBeNull();
    expect(transformControllerOf(nodes, 'n_box', 'scale')).toBeNull();
  });

  it('a Follow-Path decides position, not rotation', () => {
    const nodes = { ...fp } as unknown as Nodes;
    expect(transformControllerOf(nodes, 'n_box', 'position')).toEqual({
      nodeId: 'fp',
      type: 'FollowPath',
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
