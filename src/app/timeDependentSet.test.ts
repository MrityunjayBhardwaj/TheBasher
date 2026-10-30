// #1730 — the time-dependent set: every node that can change with time, and no node that can't.
//
// One fixture per way a node comes to depend on time (a keyed channel, a strip, a driver, a
// constraint, a follow-path, a posed armature, a data-lane key, a descendant of any of those),
// plus static nodes that must stay out.

import { describe, expect, it } from 'vitest';
import type { DagState } from '../core/dag/state';
import { timeDependentSetOf } from './timeDependentSet';

type N = {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
};
const ref = (node: string) => ({ node, socket: 'out' });

function stateOf(list: N[]): DagState {
  const nodes: Record<string, unknown> = {};
  for (const n of list) nodes[n.id] = { params: {}, inputs: {}, ...n };
  return { nodes, outputs: {} } as unknown as DagState;
}

const KEYS = [
  { frame: 0, value: [0, 0, 0] },
  { frame: 10, value: [1, 0, 0] },
];

const fixture = () =>
  stateOf([
    // the scene and what it holds
    {
      id: 'scene',
      type: 'Scene',
      inputs: { children: [ref('keyed'), ref('grp'), ref('static'), ref('arm'), ref('lane_obj')] },
    },
    // a keyed node
    { id: 'keyed', type: 'Object' },
    {
      id: 'keyed_ch',
      type: 'KeyframeChannelVec3',
      params: { target: 'keyed', name: 'position', keyframes: KEYS },
    },
    // a channel with no keys is not an animation
    {
      id: 'empty_ch',
      type: 'KeyframeChannelVec3',
      params: { target: 'static', name: 'position', keyframes: [] },
    },
    // a strip-only node, a driven node, a constrained node, a followed node
    { id: 'stripped', type: 'Object' },
    { id: 'act', type: 'Action' },
    { id: 'strip', type: 'Strip', params: { target: 'stripped', action: 'act' } },
    { id: 'driven', type: 'Object' },
    { id: 'drv', type: 'ParamDriver', params: { target: 'driven', paramPath: 'position.x' } },
    {
      id: 'drv_muted',
      type: 'ParamDriver',
      params: { target: 'static', paramPath: 'position.x', mute: true },
    },
    { id: 'aimed', type: 'Object' },
    { id: 'aim', type: 'TrackTo', params: { target: 'aimed' } },
    { id: 'aim_unbound', type: 'TrackTo', params: { target: '' } },
    { id: 'pathed', type: 'Object' },
    { id: 'path', type: 'FollowPath', params: { target: 'pathed' } },
    // a Group holding a keyed child holding a static grandchild: the Group is static, the
    // grandchild moves with its keyed holder
    { id: 'grp', type: 'Group', inputs: { children: [ref('mid')] } },
    { id: 'mid', type: 'Group', inputs: { children: [ref('leaf')] } },
    {
      id: 'mid_ch',
      type: 'KeyframeChannelVec3',
      params: { target: 'mid', name: 'position', keyframes: KEYS },
    },
    { id: 'leaf', type: 'Object' },
    // a posed armature and an object parented under it (the sword under the hand)
    { id: 'arm', type: 'Object', inputs: { pose: ref('layer'), children: [ref('sword')] } },
    { id: 'layer', type: 'PoseLayer' },
    { id: 'sword', type: 'Object' },
    // a split object whose DATA node is keyed (colour on BoxData)
    { id: 'lane_obj', type: 'Object', inputs: { data: ref('lane_data') } },
    { id: 'lane_data', type: 'BoxData' },
    {
      id: 'lane_ch',
      type: 'KeyframeChannelColor',
      params: { target: 'lane_data', name: 'color', keyframes: KEYS },
    },
    // static
    { id: 'static', type: 'Object' },
  ]);

describe('timeDependentSetOf (#1730)', () => {
  const set = timeDependentSetOf(fixture());

  it.each([
    ['keyed', 'a keyed channel'],
    ['stripped', 'a strip'],
    ['driven', 'a bound driver'],
    ['aimed', 'a Track-To'],
    ['pathed', 'a Follow-Path'],
    ['arm', 'a pose'],
    ['lane_obj', 'a key on its data node'],
    ['mid', 'a keyed Group'],
    ['leaf', 'a keyed holder (descendant)'],
    ['sword', 'a posed holder (bone-parented child)'],
  ])('%s depends on time through %s', (id) => {
    expect(set.has(id)).toBe(true);
  });

  it.each([
    ['static', 'empty channel, muted driver, nothing else'],
    ['grp', 'holds a keyed child but is not keyed itself'],
    ['scene', 'the scene node'],
    ['keyed_ch', 'a channel node is not drawn'],
  ])('%s does not (%s)', (id) => {
    expect(set.has(id)).toBe(false);
  });

  it('keeps the bands apart', () => {
    expect([...set.channelDriven].sort()).toEqual([
      'driven',
      'keyed',
      'lane_data',
      'lane_obj',
      'mid',
      'stripped',
    ]);
    expect([...set.constrained].sort()).toEqual(['aimed', 'pathed']);
    expect([...set.followed]).toEqual(['pathed']);
    expect([...set.posed]).toEqual(['arm']);
  });

  it('orders every holder before what it holds', () => {
    const at = (id: string) => set.order.indexOf(id);
    expect(at('mid')).toBeLessThan(at('leaf'));
    expect(at('arm')).toBeLessThan(at('sword'));
    expect(new Set(set.order).size).toBe(set.order.length);
  });

  it('is kept per node table and rebuilt on an edit', () => {
    const s = fixture();
    expect(timeDependentSetOf(s)).toBe(timeDependentSetOf(s));
    const edited = { ...s, nodes: { ...s.nodes } } as DagState;
    expect(timeDependentSetOf(edited)).not.toBe(timeDependentSetOf(s));
  });
});
