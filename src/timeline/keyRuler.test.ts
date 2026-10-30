// #1641 / #1688 — a key is drawn on the dopesheet's playhead ruler where it plays, and a key
// dragged along the ruler is stored back on its own clock.
//
// The scene runs at a quarter, so a scene-time key at 4 s plays at 16 s: past a 10 s timeline.

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { sceneClockOf } from '../app/sceneClock';
import type { TimeMap } from '../app/stores/timeStore';
import { keyRulerFor } from './keyRuler';
import { collectChannelRows, paintStaticLayer } from './TimelineCanvas';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function keyAt4(id: string, target: string, paramPath: string, type: string): Op {
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: type,
    params: {
      name: paramPath,
      target,
      paramPath,
      keyframes: [
        {
          time: 4,
          value: type === 'KeyframeChannelVec3' ? [1, 0, 0] : 1,
          easing: 'linear',
        },
      ],
    },
  };
}

/** Quarter speed, a key at 4 s on the box (scene time) and one on the camera (playhead). */
function slowed(): { state: DagState; map: TimeMap } {
  let state = buildDefaultDagState();
  const scene = state.outputs.scene!.node;
  const ops: Op[] = [
    { type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0.25 },
    keyAt4('ch_box', 'n_box', 'position', 'KeyframeChannelVec3'),
    keyAt4('ch_cam', 'n_camera', 'position', 'KeyframeChannelVec3'),
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return { state, map: sceneClockOf(state) };
}

function row(state: DagState, id: string) {
  return collectChannelRows(state.nodes).find((r) => r.channelId === id)!;
}

describe('keyRulerFor (#1641)', () => {
  it('draws a scene-time key where it plays on the playhead ruler', () => {
    const { state, map } = slowed();
    expect(keyRulerFor(state, row(state, 'ch_box'), map).toRuler(4)).toBeCloseTo(16);
  });

  it('leaves a key on the playhead clock where it is (a camera)', () => {
    const { state, map } = slowed();
    expect(keyRulerFor(state, row(state, 'ch_cam'), map).toRuler(4)).toBe(4);
  });

  it('stores a dragged key back on its own clock', () => {
    const { state, map } = slowed();
    const box = keyRulerFor(state, row(state, 'ch_box'), map);
    expect(box.fromRuler(8)).toBeCloseTo(2);
    expect(box.fromRuler(box.toRuler(3))).toBeCloseTo(3);
    expect(keyRulerFor(state, row(state, 'ch_cam'), map).fromRuler(8)).toBe(8);
  });

  it("the Scene's speed is keyed on the playhead; its other keys on scene time", () => {
    let state = buildDefaultDagState();
    const scene = state.outputs.scene!.node;
    // A speed key holding a quarter, and a key on the Scene's environment strength.
    for (const op of [
      keyAt4('ch_speed', scene, 'timeSpeed', 'KeyframeChannelNumber'),
      keyAt4('ch_env', scene, 'envIntensity', 'KeyframeChannelNumber'),
    ] as Op[]) {
      state = applyOp(state, op).next;
    }
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'ch_speed',
      paramPath: 'keyframes',
      value: [{ time: 4, value: 0.25, easing: 'linear' }],
    }).next;
    const map = sceneClockOf(state);
    expect(keyRulerFor(state, row(state, 'ch_speed'), map).toRuler(4)).toBe(4);
    expect(keyRulerFor(state, row(state, 'ch_env'), map).toRuler(4)).toBeCloseTo(16);
  });

  it('moves nothing in a scene that runs at speed 1', () => {
    const state = buildDefaultDagState();
    const map = sceneClockOf(state);
    const r = { channelId: 'c', name: 'c', keyframes: [], targetId: 'n_box' };
    expect(keyRulerFor(state, r, map).toRuler(4)).toBe(4);
  });

  it('the dopesheet draws through the mapping: the box key leaves a 10 s window', () => {
    const { state, map } = slowed();
    const rows = collectChannelRows(state.nodes).filter((r) => r.channelId.startsWith('ch_'));
    const rulers = rows.map((r) => keyRulerFor(state, r, map));
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get: () => () => undefined,
      set: () => true,
    });
    const dims = { cssW: 400, cssH: 100 };
    // As stored, both keys sit at 4 s inside the window; on the ruler only the camera's does.
    expect(paintStaticLayer(ctx, rows, dims, 10, null)).toBe(2);
    expect(paintStaticLayer(ctx, rows, dims, 10, null, null, undefined, undefined, rulers)).toBe(1);
  });
});
