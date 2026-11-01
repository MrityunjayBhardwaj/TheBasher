// #1769 — a constraint's own keys run on the clock of the object it constrains.
//
// A camera runs on the playhead (#1594). The v26 step (#1762) moved a camera's keyed look-at onto
// a Track-To's aim point; read on the scene's clock, a slowed scene slowed the camera's aim with
// it. Measured before the fix: aim point keyed (0,0,0)@0 → (10,0,5)@2, Scene speed 0.5, playhead
// 2 s → the aim read (5, 0, 2.5), the halfway key.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { isRelationalPoseNode, resolveTrackToTarget } from './nodeConstraints';
import { sceneClockOf } from './sceneClock';
import { clockOf, clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());

const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};

/** The default scene slowed to half speed, with a Track-To on `target` whose aim point is keyed
 *  (0,0,0) at 0 s → (10,0,5) at 2 s. */
function slowedKeyedAim(target: string): DagState {
  return run(buildDefaultDagState(), [
    { type: 'setParam', nodeId: 'n_scene', paramPath: 'timeSpeed', value: 0.5 },
    {
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: { target, aimPoint: [0, 0, 0] },
    },
    {
      type: 'addNode',
      nodeId: 'tt_keys',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'aimPoint',
        target: 'tt',
        paramPath: 'aimPoint',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [10, 0, 5], easing: 'linear' },
        ],
      },
    },
  ] as Op[]);
}

/** Playhead `film` with the scene's own time beside it. */
const at = (s: DagState, film: number) => clockedCtx(sceneClockOf(s).sceneAt(film), film);

describe('#1769 — a constraint runs on the clock of what it constrains', () => {
  it('the fixture slows the scene: playhead 2 s is scene 1 s', () => {
    const s = slowedKeyedAim('n_camera');
    expect(sceneClockOf(s).sceneAt(2)).toBeCloseTo(1, 9);
  });

  it('a camera’s Track-To aim reaches the last key at playhead 2 s, as the camera’s own keys do', () => {
    const s = slowedKeyedAim('n_camera');
    expect(clockOf(s, 'tt')).toBe('film');
    const aim = resolveTrackToTarget(s, 'n_camera', at(s, 2))!;
    [10, 0, 5].forEach((v, i) => expect(aim[i]).toBeCloseTo(v, 9));
  });

  it('control: a cube’s Track-To aim stays on scene time, at the halfway key', () => {
    const s = slowedKeyedAim('n_box');
    expect(clockOf(s, 'tt')).toBe('scene');
    const aim = resolveTrackToTarget(s, 'n_box', at(s, 2))!;
    [5, 0, 2.5].forEach((v, i) => expect(aim[i]).toBeCloseTo(v, 9));
  });

  it('every constraint type answers for its target', () => {
    // The clock lookup spells the constraint types itself (an import of the constraint module
    // would cycle); this keeps that list and `isRelationalPoseNode` the same set.
    const types = listNodeTypes().filter((t) => isRelationalPoseNode({ type: t } as never));
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(getNodeType(type), type).toBeTruthy();
      const s = run(buildDefaultDagState(), [
        { type: 'addNode', nodeId: 'c', nodeType: type, params: { target: 'n_camera' } },
      ] as Op[]);
      expect(clockOf(s, 'c'), type).toBe('film');
    }
  });
});
