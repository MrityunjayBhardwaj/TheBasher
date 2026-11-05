// #1791 — the v26 scenes the v26 → v27 Follow Path step is gated on. Built from ops so the same
// module builds them on both sides: under the v26 code that recorded `followPathOffset.v26poses.json`
// and under the code that reads the converted state.

import { applyOp, type DagState } from '../../dag';
import { buildDefaultDagState } from '../default';
import { withIds } from '../../../test-utils/curvePoints';
import { makeSplitCube } from '../../../test-utils/splitCube';

type Vec3 = [number, number, number];
export const FOLLOW_TIMES = [0, 0.25, 0.5, 1, 1.5, 2, 3];

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};

/** A curve object `crv` (origin → (10, 0, 0) → (10, 0, 6)) at `pose`, a Follow Path `fp` putting
 *  `target` on it, its `evalTime` keyed 0 → 1 over 2 s. */
function onPath(
  s: DagState,
  target: string,
  pose: { position?: Vec3; rotation?: Vec3; scale?: Vec3 } = {},
  extra: Record<string, unknown> = {},
): DagState {
  return run(s, [
    {
      type: 'addNode',
      nodeId: 'crv_data',
      nodeType: 'CurveData',
      params: {
        points: withIds([
          [0, 0, 0],
          [10, 0, 0],
          [10, 0, 6],
        ]),
        closed: false,
        resolution: 32,
      },
    },
    {
      type: 'addNode',
      nodeId: 'crv',
      nodeType: 'Object',
      params: {
        position: pose.position ?? [0, 0, 0],
        rotation: pose.rotation ?? [0, 0, 0],
        scale: pose.scale ?? [1, 1, 1],
      },
    },
    { type: 'connect', from: { node: 'crv_data', socket: 'out' }, to: { node: 'crv', socket: 'data' } },
    { type: 'connect', from: { node: 'crv', socket: 'out' }, to: { node: 'n_scene', socket: 'children' } },
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { name: 'fp', target, curve: 'crv', evalTime: 0, offset: 0, ...extra },
    },
    {
      type: 'addNode',
      nodeId: 'fp_time',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'evalTime',
        target: 'fp',
        paramPath: 'evalTime',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 2, value: 1, easing: 'linear' },
        ],
      },
    },
  ]);
}

/** A top-level cube `f` at its own (0, 4, 0). */
const cube = (s: DagState) =>
  makeSplitCube(s, {
    objectId: 'f',
    position: [0, 4, 0],
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;

/** Each fixture: its scene, and the objects whose drawn position the gate compares. */
export const FOLLOW_FIXTURES: Record<string, { build: () => DagState; objects: string[] }> = {
  'a top-level cube with its own position': {
    build: () => onPath(cube(buildDefaultDagState()), 'f'),
    objects: ['f'],
  },
  'a top-level cube whose position is keyed': {
    build: () =>
      run(onPath(cube(buildDefaultDagState()), 'f'), [
        {
          type: 'addNode',
          nodeId: 'f_pos',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'f',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [1, 2, 3], easing: 'linear' },
              { time: 3, value: [-4, 0, 2], easing: 'linear' },
            ],
          },
        },
      ]),
    objects: ['f'],
  },
  'a cube on a curve object moved, turned and scaled': {
    build: () =>
      onPath(cube(buildDefaultDagState()), 'f', {
        position: [5, 0, 3],
        rotation: [0, 0, 90],
        scale: [2, 2, 2],
      }),
    objects: ['f'],
  },
  'the default camera, standing at its own position': {
    build: () => onPath(buildDefaultDagState(), 'n_camera'),
    objects: ['n_camera'],
  },
  'a muted Follow Path (the cube stands where it stands)': {
    build: () => onPath(cube(buildDefaultDagState()), 'f', {}, { mute: true }),
    objects: ['f'],
  },
};
