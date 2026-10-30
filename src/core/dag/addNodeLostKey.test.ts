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
