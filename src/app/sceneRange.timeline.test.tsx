// #1287 — content past the scene's End is reached, scrubbable, and shaded.
//
// Blender leaves End alone when content runs longer, lets the playhead go past it, and its
// animation editors draw what lies past End, shaded. Basher's timeline used to span exactly the
// playable range, so a key at 12.1 s with a 10 s range was off the canvas and the playhead could
// not reach it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { collectChannelRows, paintStaticLayer } from '../timeline/TimelineCanvas';
import { sceneContentEnd } from './sceneRange';
import { SceneRangeSync } from './SceneRangeSync';
import { useEditorStore } from './stores/editorStore';
import { useTimeStore } from './stores/timeStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function run(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** The default scene with the light's intensity keyed from 0 s to `lastKey` s. */
function withKeyedLight(lastKey: number): DagState {
  return run(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_int',
      nodeType: 'KeyframeChannelNumber',
      params: {
        target: 'n_light_data',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 1 },
          { time: lastKey, value: 5 },
        ],
      },
    } as Op,
  ]);
}

/** An Action keyed over 0–4 s placed by a Strip at `start` (so it ends at start + 4). */
function withStrip(state: DagState, start: number, muted: boolean): DagState {
  return run(state, [
    {
      type: 'addNode',
      nodeId: 'act',
      nodeType: 'Action',
      params: {
        name: 'act',
        channels: [
          {
            valueType: 'number',
            paramPath: 'intensity',
            keyframes: [
              { time: 0, value: 1 },
              { time: 4, value: 2 },
            ],
          },
        ],
      },
    } as Op,
    {
      type: 'addNode',
      nodeId: 'strip',
      nodeType: 'Strip',
      params: { name: 'strip', action: 'act', target: 'n_light_data', start, muted },
    } as Op,
    {
      type: 'addNode',
      nodeId: 'trk',
      nodeType: 'Track',
      params: { name: 'trk', strips: ['strip'], order: 0 },
    } as Op,
  ]);
}

describe('#1287 — where the content ends', () => {
  it('a key at 12.1 s ends the content at 12.1 s, named by its channel', () => {
    const end = sceneContentEnd(withKeyedLight(12.1));
    expect(end.seconds).toBe(12.1);
    expect(end.nodeId).toBe('ch_int');
    expect(end.label).toBeTruthy();
  });

  it('a live strip counts to its placed end; a muted one does not', () => {
    const base = withKeyedLight(3);
    expect(sceneContentEnd(withStrip(base, 9, false)).seconds).toBe(13);
    expect(sceneContentEnd(withStrip(base, 9, false)).nodeId).toBe('strip');
    expect(sceneContentEnd(withStrip(base, 9, true)).seconds).toBe(3);
  });

  it('a motion clip plays from 0 for its duration', () => {
    const state = run(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'clip',
        nodeType: 'AnimationClip',
        params: { name: 'a person walks forward', duration: 12.1 },
      } as Op,
    ]);
    expect(sceneContentEnd(state)).toEqual({
      seconds: 12.1,
      nodeId: 'clip',
      label: 'a person walks forward',
    });
  });

  it('a scene with nothing animated ends at 0', () => {
    expect(sceneContentEnd(buildDefaultDagState()).seconds).toBe(0);
  });
});

describe('#1287 — the 3D range follows the scene, and the reach follows the content', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useEditorStore.getState().setSpace('view3d');
    useTimeStore.getState().setDuration(10);
    useTimeStore.getState().setTime(0);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('End stays at 10 s while the playhead reaches the 12.1 s key, and samples there', () => {
    act(() => useDagStore.getState().hydrate(withKeyedLight(12.1)));
    act(() => root.render(<SceneRangeSync />));
    expect(useTimeStore.getState().durationSeconds).toBe(10);
    expect(useTimeStore.getState().extentSeconds).toBe(12.1);
    useTimeStore.getState().setTime(11.7);
    expect(useTimeStore.getState().seconds).toBe(11.7);
  });

  it('a key moved inside End pulls the reach back to End', () => {
    act(() => useDagStore.getState().hydrate(withKeyedLight(12.1)));
    act(() => root.render(<SceneRangeSync />));
    act(() => useDagStore.getState().hydrate(withKeyedLight(6)));
    expect(useTimeStore.getState().extentSeconds).toBe(10);
  });

  it('in Video mode the sync leaves the composition’s range alone', () => {
    act(() => useDagStore.getState().hydrate(withKeyedLight(12.1)));
    act(() => useEditorStore.getState().setSpace('video'));
    act(() => root.render(<SceneRangeSync />));
    useTimeStore.getState().setDuration(5);
    act(() => useDagStore.getState().hydrate(withKeyedLight(20)));
    expect(useTimeStore.getState().durationSeconds).toBe(5);
    expect(useTimeStore.getState().extentSeconds).toBe(5);
  });
});

describe('#1287 — the dopesheet shades past End', () => {
  /** A stub that records each fillRect with the fill style in force (the draw contract). */
  function recordingCtx() {
    const fills: { style: string; x: number; w: number }[] = [];
    let style = '';
    const noop = () => {};
    const ctx = {
      clearRect: noop,
      fillRect: (x: number, _y: number, w: number) => fills.push({ style, x, w }),
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      closePath: noop,
      fill: noop,
      stroke: noop,
      fillText: noop,
      set fillStyle(v: string) {
        style = v;
      },
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set globalAlpha(_v: number) {},
      set font(_v: string) {},
      set textBaseline(_v: string) {},
      set textAlign(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    return { ctx, fills };
  }
  type Fill = { style: string; x: number; w: number };
  const shade = (fills: Fill[]) => fills.filter((f) => f.style.startsWith('rgba(0'));

  it('with content to 12.1 s and End at 10 s, the last sixth of the track is shaded', () => {
    const rows = collectChannelRows(withKeyedLight(12.1).nodes);
    const { ctx, fills } = recordingCtx();
    paintStaticLayer(ctx, rows, { cssW: 1000, cssH: 100 }, 12.1, null, null, undefined, 10);
    const [s] = shade(fills);
    expect(s).toBeDefined();
    // The shade starts at End's x and runs to the right edge.
    expect(s.x + s.w).toBe(1000);
    expect(s.x).toBeGreaterThan(800);
    expect(s.x).toBeLessThan(900);
  });

  it('nothing is shaded when End is the timeline’s end', () => {
    const rows = collectChannelRows(withKeyedLight(6).nodes);
    const { ctx, fills } = recordingCtx();
    paintStaticLayer(ctx, rows, { cssW: 1000, cssH: 100 }, 10, null, null, undefined, 10);
    expect(shade(fills)).toEqual([]);
  });
});
