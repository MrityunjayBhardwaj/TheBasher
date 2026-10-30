// #1686 — addNode refuses a key its schema would drop, as setParam does (#1636).
//
// setParam compares what was written with what the parse kept, at every depth, and refuses the
// first key that was written and then lost. addNode parsed and kept the result without asking,
// so the same input went in by one door and was refused at the other: a Cycles modifier on a
// quaternion channel (which loops by `extendAfter`, and has no `modifiers`) was dropped without a
// word when the pose layer was created with it. addNode is how the agent, templates and
// importers make most nodes, so it was the busier door of the two.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from './ops';
import { emptyDagState } from './state';
import { registerAllNodes } from '../../nodes/registerAll';

beforeEach(() => registerAllNodes());

const cycles = {
  type: 'cycles',
  beforeMode: 'repeat',
  afterMode: 'repeat',
  beforeCycles: 0,
  afterCycles: 0,
};
const quatChannel = {
  name: 'c',
  bone: 'Hips',
  component: 'quaternion',
  keyframes: [{ time: 0, value: [0, 0, 0, 1], easing: 'linear' }],
};

const add = (params: unknown) =>
  applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: 'pl',
    nodeType: 'PoseLayer',
    params,
  } as never);

describe('#1686 — addNode refuses a key its schema drops, as setParam does', () => {
  it('a key lost inside a list is refused, naming where', () => {
    expect(() => add({ channels: [{ ...quatChannel, modifiers: [cycles] }] })).toThrow(
      'addNode: PoseLayer has no field at channels[0].modifiers',
    );
  });

  it('a key the node does not have at all is refused', () => {
    expect(() => add({ bogus: 1 })).toThrow('addNode: PoseLayer has no field at bogus');
  });

  it('both doors refuse the same input', () => {
    const written = [{ ...quatChannel, modifiers: [cycles] }];
    const state = add({}).next;
    const viaSet = applyOp(state, {
      type: 'setParam',
      nodeId: 'pl',
      paramPath: 'channels',
      value: written,
    });
    expect(viaSet.reportable?.reason).toBe('PoseLayer has no field at [0].modifiers');
    expect(() => add({ channels: written })).toThrow();
  });

  it('control: the same channel looping by extendAfter is created', () => {
    const node = add({ channels: [{ ...quatChannel, extendAfter: 'cycle' }] }).next.nodes.pl;
    expect((node.params as { channels: { extendAfter: string }[] }).channels[0].extendAfter).toBe(
      'cycle',
    );
  });

  it('control: defaults the schema fills in, and an undefined key, are not a loss', () => {
    const node = add({ channels: [{ ...quatChannel, extendAfter: undefined }] }).next.nodes.pl;
    expect((node.params as { channels: unknown[] }).channels).toHaveLength(1);
  });
});

// #1746 — a delete's undo is an addNode with the node's stored params. A loaded project's params
// never pass through their schema, so a node saved with a key its type no longer has could be
// deleted and then not restored: the undo threw at the refusal above and the node stayed gone.
describe('#1746 — undoing a delete restores a node saved with a key its type dropped', () => {
  const channel = {
    name: 'x',
    target: 'n_box',
    paramPath: 'position',
    keyframes: [{ time: 0, value: 1, easing: 'linear' }],
  };
  const loaded = () => {
    const s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'ch',
      nodeType: 'KeyframeChannelNumber',
      params: channel,
    } as never).next;
    // As a save loads it: the stored params carry a key the type no longer has.
    const node = s.nodes.ch;
    return {
      ...s,
      nodes: {
        ...s.nodes,
        ch: { ...node, params: { ...(node.params as object), legacyField: 7 } },
      },
    };
  };

  it('delete then undo puts the node back, without the key nothing reads', () => {
    const s0 = loaded();
    const removed = applyOp(s0, { type: 'removeNode', nodeId: 'ch' });
    expect(removed.next.nodes.ch).toBeUndefined();
    const restored = applyOp(removed.next, removed.inverse).next;
    expect(restored.nodes.ch?.type).toBe('KeyframeChannelNumber');
    expect(restored.nodes.ch?.params).toEqual(
      applyOp(emptyDagState(), {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelNumber',
        params: channel,
      } as never).next.nodes.ch.params,
    );
  });

  it('an addNode an author writes with that key is still refused', () => {
    expect(() =>
      applyOp(emptyDagState(), {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelNumber',
        params: { ...channel, legacyField: 7 },
      } as never),
    ).toThrow(/has no field at legacyField/);
  });
});
