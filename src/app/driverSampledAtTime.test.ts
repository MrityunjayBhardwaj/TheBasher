// #1832 — a driver's channel reads its source at the time it is sampled. The renderer builds a
// target's driver channels once and samples them every frame, so a value read at build time froze
// a driver reading a keyed controller on screen while every read of the target followed it.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { KeyframeChannelValue } from '../nodes/types';
import { makeSplitCube } from '../test-utils/splitCube';
import { driverChannelValuesForTarget } from './paramDrivers';
import { clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());
const run = (s: DagState, op: object) => applyOp(s, op as never).next;

/** A cube, and a Null keyed from x = 0 at 0 s to x = 4 at 2 s. */
function rig(): DagState {
  let s = buildDefaultDagState();
  s = makeSplitCube(s, {
    objectId: 'box',
    position: [9, 9, 9],
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
  s = run(s, { type: 'addNode', nodeId: 'ctl', nodeType: 'Null', params: {} });
  s = run(s, {
    type: 'connect',
    from: { node: 'ctl', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  s = run(s, {
    type: 'addNode',
    nodeId: 'k_ctl',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'ctl',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 2, value: [4, 0, 0], easing: 'linear' },
      ],
    },
  });
  return s;
}

const driver = (params: Record<string, unknown>) => ({
  type: 'addNode',
  nodeId: 'drv',
  nodeType: 'ParamDriver',
  params: { target: 'box', blendMode: 'replace', order: 0, ...params },
});

/** As the renderer does: build the target's driver channels at 0 s, sample at `seconds`. */
const builtAtZeroSampledAt = (s: DagState, seconds: number) =>
  (
    driverChannelValuesForTarget(s, 'box', clockedCtx(0, 0))[0] as KeyframeChannelValue & {
      sample(t: number): unknown;
    }
  ).sample(seconds);

describe('#1832 — a driver channel built once follows a keyed controller', () => {
  it('the Point controller road', () => {
    const s = run(rig(), driver({ paramPath: 'position', sourceTransformVec: { node: 'ctl' } }));
    expect(builtAtZeroSampledAt(s, 0)).toEqual([0, 0, 0]);
    expect(builtAtZeroSampledAt(s, 1)).toEqual([2, 0, 0]);
  });

  it('the Transform Channel road', () => {
    const s = run(
      rig(),
      driver({ paramPath: 'scale.0', sourceTransform: { node: 'ctl', channel: 'tx' } }),
    );
    expect(builtAtZeroSampledAt(s, 1)).toBe(2);
  });

  it("a wired driver reading the controller's world", () => {
    let s = run(rig(), driver({ paramPath: 'position' }));
    s = run(s, { type: 'addNode', nodeId: 'sep', nodeType: 'SeparateTransform', params: {} });
    s = run(s, {
      type: 'connect',
      from: { node: 'ctl', socket: 'world' },
      to: { node: 'sep', socket: 'transform' },
    });
    s = run(s, {
      type: 'connect',
      from: { node: 'sep', socket: 'translation' },
      to: { node: 'drv', socket: 'in' },
    });
    expect(builtAtZeroSampledAt(s, 1)).toEqual([2, 0, 0]);
  });

  it('CONTROL: a wired driver whose graph does not move reads the same at every time', () => {
    let s = run(rig(), driver({ paramPath: 'position' }));
    s = run(s, { type: 'addNode', nodeId: 'k', nodeType: 'Fit', params: { outMin: 5, outMax: 5 } });
    s = run(s, {
      type: 'connect',
      from: { node: 'k', socket: 'out' },
      to: { node: 'drv', socket: 'in' },
    });
    expect([builtAtZeroSampledAt(s, 0), builtAtZeroSampledAt(s, 1)]).toEqual([5, 5]);
  });
});
