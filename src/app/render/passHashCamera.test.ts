// #1950 — a render pass's hash at a frame changes when, and only when, the camera on screen at that
// frame moves.
//
// The graph: the default scene, three cameras on a switch cut at 0 s, 1 s and 2 s (three shots of
// 30 frames, `n_camera` → `cam2` → `cam3`), and a beauty pass filming through the switch. Before
// #1950 the pass hashed the switch's AUTHORED camera at every frame: moving shot 2's camera changed
// 0 of 90 hashes and moving the authored camera changed 90 of 90.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../../core/dag';
import { createEvaluatorCache, evaluate, type EvaluatorCache } from '../../core/dag/evaluator';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import type { ImageValue } from '../../nodes/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { buildSetActiveCameraOps } from '../setActiveCamera';
import { shotsOf } from '../shots';

beforeAll(() => registerAllNodes());

const FPS = 30;
const FRAMES = 90;

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

/** Three cameras cut at 0 s / 1 s / 2 s and every pass kind filming through the switch. */
function film(): DagState {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) s = apply(s, buildSetActiveCameraOps(s, id) ?? []);
  const select = shotsOf(s, 3).selectId!;
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: select,
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 'n_camera', easing: 'constant' },
          { time: 1, value: 'cam2', easing: 'constant' },
          { time: 2, value: 'cam3', easing: 'constant' },
        ],
      },
    },
  ];
  for (const [pass, type] of PASSES) {
    ops.push(
      { type: 'addNode', nodeId: pass, nodeType: type, params: {} },
      {
        type: 'connect',
        from: { node: 'n_scene', socket: 'out' },
        to: { node: pass, socket: 'scene' },
      },
      {
        type: 'connect',
        from: { node: select, socket: 'out' },
        to: { node: pass, socket: 'camera' },
      },
      {
        type: 'connect',
        from: { node: 'n_time', socket: 'out' },
        to: { node: pass, socket: 'time' },
      },
    );
  }
  return apply(s, ops);
}

const PASSES: readonly [string, string][] = [
  ['p_beauty', 'BeautyPass'],
  ['p_depth', 'DepthPass'],
  ['p_normal', 'NormalPass'],
  ['p_id', 'IDPass'],
];

const hashAt = (s: DagState, pass: string, frame: number, cache?: EvaluatorCache): string =>
  (
    evaluate(s, pass, {
      cache,
      ctx: { time: { frame, seconds: frame / FPS, normalized: frame / FRAMES } },
    }).value as ImageValue
  ).sourceHash;

const hashes = (s: DagState, pass = 'p_beauty', cache?: EvaluatorCache) =>
  Array.from({ length: FRAMES }, (_, f) => hashAt(s, pass, f, cache));

/** The frames whose hash differs between the two states. */
function changedFrames(
  a: DagState,
  b: DagState,
  pass = 'p_beauty',
  cache?: EvaluatorCache,
): number[] {
  const ha = hashes(a, pass, cache);
  const hb = hashes(b, pass, cache);
  return ha.flatMap((h, f) => (h === hb[f] ? [] : [f]));
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const SHOT1 = range(0, 30);
const SHOT2 = range(30, 60);
const SHOT3 = range(60, 90);

describe('#1950 — a pass hashes the camera on screen at each frame', () => {
  it("moving shot 2's camera changes shot 2's frames and no others, on every pass kind", () => {
    const s = film();
    const moved = apply(s, [
      { type: 'setParam', nodeId: 'cam2', paramPath: 'position', value: [25, 1, 0] },
    ]);
    for (const [pass] of PASSES) expect(changedFrames(s, moved, pass)).toEqual(SHOT2);
  });

  it("moving the switch's authored camera changes only the frames it is on screen", () => {
    const s = film();
    const moved = apply(s, [
      { type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [3, 9, 9] },
    ]);
    expect(changedFrames(s, moved)).toEqual(SHOT1);
  });

  it("a lens change on shot 3's camera changes shot 3's frames only", () => {
    const s = film();
    const moved = apply(s, [
      { type: 'setParam', nodeId: 'cam3_data', paramPath: 'fov', value: 20 },
    ]);
    expect(changedFrames(s, moved)).toEqual(SHOT3);
  });

  it('a keyed camera move changes the frames it moves, and only those', () => {
    // cam2 held at its place until 1.5 s, then moves to 2 s: the key edit after 1.5 s reaches
    // shot 2's frames from 1.5 s on (45..59) and nothing else.
    const key = (to: [number, number, number]): Op => ({
      type: 'addNode',
      nodeId: 'cam2_pos',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 'cam2',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [20, 0, 0], easing: 'linear' },
          { time: 1.5, value: [20, 0, 0], easing: 'linear' },
          { time: 2, value: to, easing: 'linear' },
        ],
      },
    });
    const a = apply(film(), [key([30, 0, 0])]);
    const b = apply(film(), [key([35, 2, 0])]);
    expect(changedFrames(a, b)).toEqual(range(46, 60));
  });

  it('a key added to the camera on screen reaches a pass read through a shared cache', () => {
    // The key touches nothing upstream of the pass, so only the camera on screen, in the pass's
    // cache key by its value, can tell the two states apart; a cache keyed on the wires alone
    // would hand the second state the first one's hashes.
    const s = film();
    const keyed = apply(s, [
      {
        type: 'addNode',
        nodeId: 'cam2_pos',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'cam2',
          paramPath: 'position',
          keyframes: [
            { time: 1.5, value: [20, 0, 0], easing: 'linear' },
            { time: 2, value: [30, 0, 0], easing: 'linear' },
          ],
        },
      },
    ]);
    expect(changedFrames(s, keyed, 'p_beauty', createEvaluatorCache())).toEqual(range(46, 60));
  });

  it('keying a camera that is never on screen changes nothing', () => {
    const s = film();
    const keyed = apply(s, [
      {
        type: 'addNode',
        nodeId: 'cam4_pos',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'cam3',
          paramPath: 'position',
          // cam3 is on screen from 2 s; a key that only moves it before then changes nothing.
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 1, value: [40, 0, 0], easing: 'constant' },
          ],
        },
      },
    ]);
    expect(changedFrames(s, keyed)).toEqual([]);
  });

  it('an unrelated edit changes no frame', () => {
    const s = film();
    const other = apply(s, [
      { type: 'addNode', nodeId: 'lonely', nodeType: 'Value', params: { value: 7 } },
    ]);
    expect(changedFrames(s, other)).toEqual([]);
  });

  it('a camera wired straight into the pass is still hashed at each frame', () => {
    const s = apply(film(), [
      {
        type: 'connect',
        from: { node: 'cam3', socket: 'out' },
        to: { node: 'p_beauty', socket: 'camera' },
      },
    ]);
    const moved = apply(s, [
      { type: 'setParam', nodeId: 'cam3', paramPath: 'position', value: [41, 0, 0] },
    ]);
    expect(changedFrames(s, moved)).toEqual(range(0, FRAMES));
  });
});
