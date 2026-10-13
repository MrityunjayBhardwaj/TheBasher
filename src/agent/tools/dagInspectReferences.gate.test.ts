// #1018 - dag.inspect must show the half of the graph that travels in params.
//
// An edge lives on its CONSUMER, so asking about a node already shows what feeds it.
// An id-reference lives on the REFERRER, so asking about the referent showed nothing
// at all: a model about to edit an animated param was never told a channel drives it,
// by the tool whose own description says to call it first.
//
// The row that matters most is BOTH DIRECTIONS FROM ONE NODE. A Follow-Path names its
// constrained object as a 'subject' and the curve it follows as an 'argument'. Asking
// about the object and asking about the curve must give different roles for the same
// referrer - collapsing them into one "related nodes" list inverts half the graph.

import { describe, expect, it, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { dagInspectTool } from './dagInspect';

__resetRegistryForTests();
registerAllNodes();

let base: DagState;
beforeEach(() => {
  base = buildDefaultDagState();
});

const apply = (from: DagState, ops: Op[]): DagState => {
  let s = from;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};

interface Ref {
  id: string;
  type: string;
  role: string;
  paramPath?: string;
}
const inspect = (state: DagState, nodeId: string): { referencedBy?: Ref[] } =>
  JSON.parse(
    dagInspectTool.handler({ scope: 'node', nodeId } as never, { dagState: state } as never).text,
  );

const channel: Op = {
  type: 'addNode',
  nodeId: 'n_chan',
  nodeType: 'KeyframeChannelVec3',
  params: {
    name: 'pos',
    target: 'n_box',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0] },
      { time: 2, value: [0, 9, 0] },
    ],
  },
} as Op;

describe('#1018 - the id-reference half reaches the model', () => {
  it('THE PIN: a channel driving this node is named, with the param it drives', () => {
    const s = apply(base, [channel]);
    expect(inspect(s, 'n_box').referencedBy).toEqual([
      { id: 'n_chan', type: 'KeyframeChannelVec3', role: 'subject', paramPath: 'position' },
    ]);
  });

  it('BOTH DIRECTIONS FROM ONE NODE: subject to its object, argument to its curve', () => {
    // A Follow-Path is a sidecar OF the cube and a READER of the curve. One node, two
    // roles, and the declaration is what says which is which.
    const s = apply(base, [
      { type: 'addNode', nodeId: 'n_curve', nodeType: 'CurveData', params: {} } as Op,
      {
        type: 'addNode',
        nodeId: 'n_follow',
        nodeType: 'FollowPath',
        params: { name: 'f', target: 'n_box', curve: 'n_curve' },
      } as Op,
    ]);
    expect(inspect(s, 'n_box').referencedBy).toEqual([
      { id: 'n_follow', type: 'FollowPath', role: 'subject' },
    ]);
    expect(inspect(s, 'n_curve').referencedBy).toEqual([
      { id: 'n_follow', type: 'FollowPath', role: 'argument' },
    ]);
  });

  it('a sidecar with no paramPath of its own is listed WITHOUT one, not with an empty one', () => {
    const s = apply(base, [
      {
        type: 'addNode',
        nodeId: 'n_track',
        nodeType: 'TrackTo',
        params: { target: 'n_box' },
      } as Op,
    ]);
    const [ref] = inspect(s, 'n_box').referencedBy!;
    expect(ref).toEqual({ id: 'n_track', type: 'TrackTo', role: 'subject' });
    expect('paramPath' in ref).toBe(false);
  });

  it('CONTROL: a node nothing references carries no key at all', () => {
    const s = apply(base, [channel]);
    // The cube's DATA node is referenced by nothing - only wired to.
    expect(inspect(s, 'n_box_data').referencedBy).toBeUndefined();
    // And on a scene with no sidecars, neither does the cube.
    expect(inspect(base, 'n_box').referencedBy).toBeUndefined();
  });

  it('a node never lists ITSELF, even when it names itself', () => {
    const s = apply(base, [
      {
        type: 'addNode',
        nodeId: 'n_self',
        nodeType: 'KeyframeChannelVec3',
        params: { name: 'c', target: 'n_self', paramPath: 'x', keyframes: [] },
      } as Op,
    ]);
    expect(inspect(s, 'n_self').referencedBy).toBeUndefined();
  });

  it('SCOPE=ALL IS UNTOUCHED: the full dump did not grow', () => {
    // The inverse index belongs where a model looks before editing ONE node. Adding it
    // to every entry of the full dump would multiply the largest payload the agent road
    // carries, for a reader that already has every referrer in front of it.
    const s = apply(base, [channel]);
    const all = dagInspectTool.handler({ scope: 'all' } as never, { dagState: s } as never).text;
    expect(all).not.toContain('referencedBy');
    expect(all).toContain('n_chan'); // the dump really did include the channel
  });
});

// #1553 — the same answer the delete and duplicate doors read, so the model is told about the
// relationships no param and no wire of its own shows.
describe('#1553 - every relationship of a node reaches the model', () => {
  const full = (state: DagState, nodeId: string): Record<string, unknown> =>
    JSON.parse(
      dagInspectTool.handler({ scope: 'node', nodeId } as never, { dagState: state } as never).text,
    );
  const math = (nodeId: string): Op => ({ type: 'addNode', nodeId, nodeType: 'Math', params: {} });
  const wire = (from: string, to: string, socket: string): Op => ({
    type: 'connect',
    from: { node: from, socket: 'out' },
    to: { node: to, socket },
  });

  it('a node whose name follows this one is listed, and so is what this one is wired into', () => {
    const s = apply(base, [
      math('n_hub'),
      math('n_reader'),
      wire('n_hub', 'n_reader', 'a'),
      math('n_named'),
      { type: 'setMeta', nodeId: 'n_named', name: 'x', nameFrom: 'n_hub' },
    ]);
    const hub = full(s, 'n_hub');
    expect(hub.nameFollowers).toEqual(['n_named']);
    expect(hub.consumers).toEqual([{ id: 'n_reader', socket: 'a' }]);
    expect(full(s, 'n_named').followsNameOf).toBe('n_hub');
  });

  it('a loop of references is named on every node of it, and in the full dump', () => {
    const s = apply(base, [
      math('n_x'),
      {
        type: 'addNode',
        nodeId: 'n_d',
        nodeType: 'ParamDriver',
        params: { target: 'n_x', paramPath: 'b' },
      } as Op,
      wire('n_x', 'n_d', 'in'),
    ]);
    const onX = full(s, 'n_x').referenceCycles as string[][];
    expect(onX.map((cycle) => [...cycle].sort())).toEqual([['n_d', 'n_x']]);
    expect(full(s, 'n_d').referenceCycles).toEqual(onX);
    const all = JSON.parse(
      dagInspectTool.handler({ scope: 'all' } as never, { dagState: s } as never).text,
    );
    expect(all.referenceCycles).toEqual(onX);
  });

  it('CONTROL: a node with none of these carries none of the keys', () => {
    const lone = full(apply(base, [math('n_lone')]), 'n_lone');
    for (const key of ['consumers', 'references', 'followsNameOf', 'nameFollowers']) {
      expect(lone, key).not.toHaveProperty(key);
    }
    expect(lone).not.toHaveProperty('referenceCycles');
    expect(lone).not.toHaveProperty('insideSubnetworkOf');
  });
});
