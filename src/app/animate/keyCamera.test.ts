// #1763 — what Insert Keyframe (I) keys on a camera: its own location, rotation (in its mode) and
// scale, never the orientation its Track-To computes; and the aim of a point Track-To that wins
// on it, on the Track-To's `aimPoint`. A Track-To that follows a node gets no extra key.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { clockedCtx } from '../subjectClock';
import { cameraInsertKeys } from './keyCamera';

beforeAll(() => registerAllNodes());

const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};
const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
const trackTo = (id: string, params: Record<string, unknown>): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'TrackTo',
  params: { target: 'n_camera', aimSpace: 'parent', ...params },
});
const keysOf = (s: DagState, at = 0) =>
  Object.fromEntries(
    cameraInsertKeys(s, 'n_camera', clockedCtx(at, at)).map((k) => [
      `${k.nodeId}.${k.paramPath}`,
      k.value,
    ]),
  );

const base = () =>
  run(buildDefaultDagState(), [
    set('n_camera', 'position', [0, 0, 5]),
    set('n_camera', 'rotation', [10, 20, 30]),
  ]);

describe('#1763 — I on a camera keys its own transform and what aims it', () => {
  it('a plain camera: its own position, rotation and scale', () => {
    expect(keysOf(base())).toEqual({
      'n_camera.position': [0, 0, 5],
      'n_camera.rotation': [10, 20, 30],
      'n_camera.scale': [1, 1, 1],
    });
  });

  it('a point Track-To aims it: its own rotation, not the computed one, plus the aim point', () => {
    const s = run(base(), [trackTo('aim', { aimPoint: [5, 0, 5] })]);
    expect(keysOf(s)).toEqual({
      'n_camera.position': [0, 0, 5],
      'n_camera.rotation': [10, 20, 30],
      'n_camera.scale': [1, 1, 1],
      'aim.aimPoint': [5, 0, 5],
    });
  });

  it('the aim point keyed is the one its keys hold at that moment', () => {
    const s = run(base(), [
      trackTo('aim', { aimPoint: [0, 0, 0] }),
      {
        type: 'addNode',
        nodeId: 'aim_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'aim',
          paramPath: 'aimPoint',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [4, 0, 0], easing: 'linear' },
          ],
        },
      },
    ]);
    const k = keysOf(s, 1)['aim.aimPoint'] as number[];
    [2, 0, 0].forEach((v, i) => expect(k[i], `aimPoint[${i}]`).toBeCloseTo(v, 6));
  });

  it('only the winning Track-To is keyed', () => {
    const s = run(base(), [
      trackTo('low', { aimPoint: [1, 0, 0], order: 0 }),
      trackTo('top', { aimPoint: [2, 0, 0], order: 1 }),
    ]);
    const keys = keysOf(s);
    expect(keys['top.aimPoint']).toEqual([2, 0, 0]);
    expect(keys['low.aimPoint']).toBeUndefined();
  });

  it('a Track-To that follows a node: nothing extra — the node carries its own keys', () => {
    const s = run(base(), [trackTo('aim', { aimPoint: [5, 0, 5], aimNode: 'n_box' })]);
    expect(Object.keys(keysOf(s)).sort()).toEqual([
      'n_camera.position',
      'n_camera.rotation',
      'n_camera.scale',
    ]);
  });

  it('a muted Track-To aims nothing, so nothing extra', () => {
    const s = run(base(), [trackTo('aim', { aimPoint: [5, 0, 5], mute: true })]);
    expect(keysOf(s)['aim.aimPoint']).toBeUndefined();
  });

  it('quaternion mode: its quaternion is keyed, the channel that turns it', () => {
    const r = Math.SQRT1_2;
    const s = run(base(), [
      set('n_camera', 'rotationMode', 'quaternion'),
      set('n_camera', 'quaternion', [0, r, 0, r]),
    ]);
    const keys = keysOf(s);
    expect(keys['n_camera.rotation']).toBeUndefined();
    (keys['n_camera.quaternion'] as number[]).forEach((v, i) =>
      expect(v, `quaternion[${i}]`).toBeCloseTo([0, r, 0, r][i], 9),
    );
  });
});
