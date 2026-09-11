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
