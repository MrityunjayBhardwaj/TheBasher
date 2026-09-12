// #1017 - a write that lands and is then overridden must reach the model.
//
// Four of these rows exist because the first draft of this gate was VACUOUS and
// falsification said so. Every row wrote to a node that OWNED its param, so the
// de-dup skip and the comparison were never the thing doing the work: removing
// either left all nine rows green. Worse, two guards turned out to be dead code -
// removing them changed nothing, because `renderedValue` already answered for a
// node missing from the state it is handed.
//
// THE SPLIT, THE COINCIDENCE and THE LAST WRITE WINS are the rows that actually
// discriminate; each reds for exactly one guard, and the negative controls red
// together under an over-broad rule that reports every write. A row that cannot
// be made to fail is not evidence that the code is right.

import { describe, expect, it, beforeEach } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag';
import { createFork } from '../diff/forkedDag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { maskedWrites, renderMaskedWrites } from './maskedWrites';

__resetRegistryForTests();
registerAllNodes();

let base: DagState;
beforeEach(() => {
  base = buildDefaultDagState();
});

/** A vec3 position channel on `target`. Reaches `top` at t=2, so top/2 at t=1. */
const channel = (id: string, extra: Record<string, unknown> = {}, top: number[] = [0, 9, 0]): Op =>
  ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: id,
      target: 'n_box',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0] },
        { time: 2, value: top },
      ],
      ...extra,
    },
  }) as Op;

/** Run a plan through the REAL fork the orchestrator uses, then ask for masks. */
const run = (from: DagState, ops: Op[], seconds = 1) => {
  const forked = createFork(from, ops);
  return {
    hits: maskedWrites(from, forked.fork, ops, forked.reportable, seconds),
    reportable: forked.reportable,
  };
};

const setPos = (value: unknown, nodeId = 'n_box'): Op =>
  ({ type: 'setParam', nodeId, paramPath: 'position', value }) as Op;

describe('#1017 - a write the scene does not show', () => {
  it('THE PIN: a write under a live channel is reported, with the value and the time', () => {
    const seeded = createFork(base, [channel('n_chan')]).fork;
    const { hits } = run(seeded, [setPos([5, 0, 0])]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      nodeId: 'n_box',
      paramPath: 'position',
      wrote: [5, 0, 0],
      rendered: [0, 4.5, 0],
      // Named off the DECLARATION (role 'subject'), not off a list of node types.
      overriddenBy: ['n_chan'],
    });
    const text = renderMaskedWrites(hits);
    expect(text).toContain('n_chan');
    expect(text).toContain('1.0s');
    expect(text).toContain('[0,4.5,0]');
    expect(text).toContain('[5,0,0]');
  });

  it('CONTROL: the same write with NO channel says nothing', () => {
    const { hits } = run(base, [setPos([5, 0, 0])]);
    expect(hits).toEqual([]);
    expect(renderMaskedWrites(hits)).toBe('');
  });

  it('THE SPLIT: a stripped write to a param the node does not OWN is not called masked', () => {
    // `size` lives on the BoxData, so `n_box.size` is stripped - AND the rendered
    // value is unchanged, because it was never stored. Without the de-dup skip this
    // reads as "overridden", which is false: nothing overrides it.
    const { hits, reportable } = run(base, [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'size', value: [2, 2, 2] } as Op,
    ]);
    // Precondition, asserted so the row cannot pass for the wrong reason.
    expect(reportable[0]).toMatchObject({ badge: 'stripped-write', paramPath: 'size' });
    expect(hits).toEqual([]);
  });

  it('THE COINCIDENCE: a write equal to the channel at this instant is STILL masked', () => {
    // The channel samples [5,0,0] at t=1 and the plan writes [5,0,0]. Comparing the
    // write against the resolved value would call this fine; it is not - the base
    // moved and the screen did not, here and at every other instant.
    const seeded = createFork(base, [channel('n_chan', {}, [10, 0, 0])]).fork;
    const { hits } = run(seeded, [setPos([5, 0, 0])]);
    expect(hits).toHaveLength(1);
    expect(hits[0].rendered).toEqual([5, 0, 0]);
    expect(hits[0].wrote).toEqual([5, 0, 0]);
  });

  it('A MUTED channel masks nothing - the write IS what the scene shows', () => {
    const seeded = createFork(base, [channel('n_chan', { mute: true })]).fork;
    const { hits } = run(seeded, [setPos([5, 0, 0])]);
    expect(hits).toEqual([]);
  });

  it('AN UNRELATED param on an animated node is not reported', () => {
    const seeded = createFork(base, [channel('n_chan')]).fork;
    const { hits } = run(seeded, [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] } as Op,
    ]);
    expect(hits).toEqual([]);
  });

  it('THE LAST WRITE WINS: the report quotes the value the plan ended on', () => {
    // Both writes are masked by the channel, so "is there a hit" cannot tell the two
    // readings apart - only the value quoted back can. Reporting the superseded [1,0,0]
    // would send the model to re-check a value its own plan had already abandoned.
    const seeded = createFork(base, [channel('n_chan')]).fork;
    const { hits } = run(seeded, [setPos([1, 0, 0]), setPos([5, 0, 0])]);
    expect(hits).toHaveLength(1);
    expect(hits[0].wrote).toEqual([5, 0, 0]);
  });

  it('WITHOUT an overlay, neither write is reported', () => {
    const { hits } = run(base, [setPos([1, 0, 0]), setPos([5, 0, 0])]);
    expect(hits).toEqual([]);
  });

  it('A node the plan REMOVED says nothing - it renders as undefined after', () => {
    const seeded = createFork(base, [channel('n_chan')]).fork;
    const { hits } = run(seeded, [
      { type: 'setParam', nodeId: 'n_chan', paramPath: 'name', value: 'renamed' } as Op,
      { type: 'removeNode', nodeId: 'n_chan' } as Op,
    ]);
    expect(hits).toEqual([]);
  });

  it('A node the plan ADDED says nothing - it renders as undefined before', () => {
    const { hits } = run(base, [
      { type: 'addNode', nodeId: 'n_t', nodeType: 'Transform', params: {} } as Op,
      { type: 'setParam', nodeId: 'n_t', paramPath: 'position', value: [3, 0, 0] } as Op,
    ]);
    expect(hits).toEqual([]);
  });

  it('A PLAN THAT BRINGS ITS OWN CHANNEL is not reported - the scene did change', () => {
    // Adding a channel AND writing the base in one plan. The base write is masked by
    // the plan's own new channel, but what the scene shows DID change, so "did not
    // change what is rendered" would be false. The criterion answers this for free;
    // the row exists so the answer is stated rather than discovered later.
    const { hits } = run(base, [channel('n_chan'), setPos([5, 0, 0])]);
    expect(hits).toEqual([]);
  });

  it('ONLY THE LIVE overrider is named: a muted sibling is not', () => {
    const seeded = createFork(base, [channel('n_live'), channel('n_muted', { mute: true })]).fork;
    const { hits } = run(seeded, [setPos([5, 0, 0])]);
    expect(hits).toHaveLength(1);
    expect(hits[0].overriddenBy).toEqual(['n_live']);
  });
});
