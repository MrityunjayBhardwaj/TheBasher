// #1016 — a muted channel must lose on the READ road exactly as it loses on the
// render road.
//
// The render drops a muted channel in `overlayChannels` (`channelIsActive`).
// `resolveEvaluatedParam` folds a single param path and so cannot call
// `overlayChannels`; it re-implemented the fold and reproduced everything except that
// one filter, so a muted channel rendered as the base and READ as its sampled value —
// at the inspector row, the compositor, a bake, the Comfy batch compile.
//
// The row that matters most is not the headline. It is the 2-stack: muting the TOP
// channel must yield the BOTTOM channel's value, which is neither the base (what a
// blunt "muted => null" would give) nor the muted value (the bug).

import { describe, expect, it, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { directChannelValuesForTarget } from './nodeChannels';
import { channelIsActive } from '../nodes/overlayChannels';

__resetRegistryForTests();
registerAllNodes();

const CTX = { time: { frame: 24, seconds: 1, normalized: 0 } } as never;

let base: DagState;
beforeEach(() => {
  base = buildDefaultDagState();
});

/** A vec3 position channel on `target`, reaching [0,top,0] at t=2 (so [0,top/2,0] at t=1). */
const channel = (
  id: string,
  top: number,
  extra: Record<string, unknown> = {},
  target = 'n_box',
  paramPath = 'position',
): Op =>
  ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: id,
      target,
      paramPath,
      keyframes: [
        { time: 0, value: [0, 0, 0] },
        { time: 2, value: [0, top, 0] },
      ],
      ...extra,
    },
  }) as Op;

const apply = (from: DagState, ops: Op[]): DagState => {
  let s = from;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};

describe('#1016 — the mute gate on the read road', () => {
  it('THE PIN: a muted channel does not override — the read returns null, not its sample', () => {
    const s = apply(base, [channel('n_chan', 9, { mute: true })]);
    // null IS the contract: "nothing overrides this param, caller uses the base".
    // Before the fix this returned {value:[0,4.5,0]} while the viewport showed [0,0,0].
    expect(resolveEvaluatedParam(s, 'n_box', 'position', CTX)).toBeNull();
  });

  it('THE STACK: muting the TOP of two channels yields the BOTTOM one, not the base', () => {
    const s = apply(base, [
      channel('n_a', 4, { order: 0 }),
      channel('n_b', 100, { order: 1, mute: true }),
    ]);
    // [0,2,0] is n_a at t=1. [0,50,0] would be the muted winner (the bug); null/base
    // would be an over-broad "any mute silences the param".
    expect(resolveEvaluatedParam(s, 'n_box', 'position', CTX)).toEqual({ value: [0, 2, 0] });
  });

  it('BOUNDARY PAIR: the read agrees with what the render is left holding', () => {
    const s = apply(base, [channel('n_chan', 9, { mute: true })]);
    const rendered = directChannelValuesForTarget(Object.values(s.nodes) as never, 'n_box').filter(
      channelIsActive,
    );
    const read = resolveEvaluatedParam(s, 'n_box', 'position', CTX);
    // Render holds zero live channels => it paints the base. Read must say the same.
    expect(rendered).toHaveLength(0);
    expect(read).toBeNull();
  });

  it('CONTROL: an UNMUTED channel is untouched', () => {
    const s = apply(base, [channel('n_chan', 9)]);
    expect(resolveEvaluatedParam(s, 'n_box', 'position', CTX)).toEqual({ value: [0, 4.5, 0] });
  });

  it('CONTROL: solo is untouched — it is gated per TARGET, upstream, not by this filter', () => {
    const s = apply(base, [
      channel('n_c', 9),
      channel('n_d', 9, { solo: true }, 'n_box', 'rotation'),
    ]);
    // A solo'd channel anywhere on the target silences its non-solo siblings.
    expect(resolveEvaluatedParam(s, 'n_box', 'position', CTX)).toBeNull();
  });

  it('THE PLACEMENT: an all-muted param falls THROUGH to the object-data reach', () => {
    // The gate runs BEFORE the empty check, so "every channel here is muted" behaves
    // like "no channel here" — the cube's size lives on its BoxData, and the read must
    // still reach it for the base rather than stopping at the muted channel.
    const s = apply(base, [
      { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [3, 3, 3] } as Op,
      channel('n_size', 9, { mute: true }, 'n_box_data', 'size'),
    ]);
    expect(resolveEvaluatedParam(s, 'n_box', 'size', CTX)).toEqual({ value: [3, 3, 3] });
  });
});
