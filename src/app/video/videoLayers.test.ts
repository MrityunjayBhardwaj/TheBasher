// videoLayers — verify collectLayerRows reads ordered layer rows + source length
// from a raw DAG state.

import { describe, expect, it } from 'vitest';
import type { DagState } from '../../core/dag/state';
import {
  buildReorderLayerOps,
  collectChannelKeyframes,
  collectChannelKeyframeSamples,
  collectComfySourceChannelRows,
  collectLayerRows,
} from './videoLayers';

function state(nodes: Record<string, unknown>): DagState {
  return { nodes } as unknown as DagState;
}

describe('collectLayerRows', () => {
  it('returns layers in list order (back→front) with params + source frames', () => {
    const s = state({
      comp: {
        id: 'comp',
        type: 'Composition',
        params: { name: 'C' },
        inputs: {
          layers: [
            { node: 'l_bg', socket: 'out' },
            { node: 'l_fg', socket: 'out' },
          ],
        },
      },
      l_bg: {
        id: 'l_bg',
        type: 'Layer',
        params: { name: 'bg', startFrame: 0, inPoint: 0, outPoint: -1 },
        inputs: { source: { node: 'clip', socket: 'out' } },
      },
      l_fg: {
        id: 'l_fg',
        type: 'Layer',
        params: { name: 'fg', enabled: false, solo: true, locked: true, startFrame: 12 },
        inputs: { source: { node: 'clip', socket: 'out' } },
      },
      clip: { id: 'clip', type: 'MediaClip', params: { srcFrames: 48 }, inputs: {} },
    });

    const rows = collectLayerRows(s, 'comp');
    expect(rows.map((r) => r.name)).toEqual(['bg', 'fg']);
    expect(rows[0]).toMatchObject({ enabled: true, solo: false, locked: false, srcFrames: 48 });
    expect(rows[1]).toMatchObject({ enabled: false, solo: true, locked: true, startFrame: 12 });
  });

  it('skips dangling layer refs and defaults a missing source to 1 frame', () => {
    const s = state({
      comp: {
        id: 'comp',
        type: 'Composition',
        params: {},
        inputs: {
          layers: [
            { node: 'ghost', socket: 'out' },
            { node: 'l1', socket: 'out' },
          ],
        },
      },
      l1: { id: 'l1', type: 'Layer', params: { name: 'solo' }, inputs: {} },
    });
    const rows = collectLayerRows(s, 'comp');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'solo', srcFrames: 1 });
  });

  it('returns [] for a missing comp', () => {
    expect(collectLayerRows(state({}), 'nope')).toEqual([]);
  });
});

describe('buildReorderLayerOps', () => {
  const comp = (layerIds: string[]) =>
    state({
      comp: {
        id: 'comp',
        type: 'Composition',
        params: {},
        inputs: { layers: layerIds.map((node) => ({ node, socket: 'out' })) },
      },
    });

  it('moves a layer to a new index via disconnect + connect-with-index', () => {
    // [a,b,c]; move a (index 0) to index 2 → [b,c,a].
    const ops = buildReorderLayerOps(comp(['a', 'b', 'c']), 'comp', 'a', 2);
    expect(ops).toEqual([
      {
        type: 'disconnect',
        from: { node: 'a', socket: 'out' },
        to: { node: 'comp', socket: 'layers' },
      },
      {
        type: 'connect',
        from: { node: 'a', socket: 'out' },
        to: { node: 'comp', socket: 'layers' },
        index: 2,
      },
    ]);
  });

  it('clamps an out-of-range target to the last index', () => {
    const ops = buildReorderLayerOps(comp(['a', 'b', 'c']), 'comp', 'a', 99);
    expect((ops[1] as { index: number }).index).toBe(2);
  });

  it('is a no-op when the target equals the current index', () => {
    expect(buildReorderLayerOps(comp(['a', 'b', 'c']), 'comp', 'b', 1)).toEqual([]);
  });

  it('is a no-op for a missing comp or unknown layer', () => {
    expect(buildReorderLayerOps(comp(['a']), 'nope', 'a', 0)).toEqual([]);
    expect(buildReorderLayerOps(comp(['a']), 'comp', 'ghost', 0)).toEqual([]);
  });
});

describe('collectChannelKeyframes', () => {
  const withChannel = (target: string, paramPath: string, times: number[]) =>
    state({
      ch: {
        id: 'ch',
        type: 'KeyframeChannelScalar',
        params: { target, paramPath, keyframes: times.map((time) => ({ time, value: 1 })) },
        inputs: {},
      },
      other: { id: 'other', type: 'Layer', params: { name: 'L' }, inputs: {} },
    });

  it('returns the keyframe times (ascending) of the channel for a (layer, param)', () => {
    const s = withChannel('l1', 'opacity', [2, 0.5, 1]);
    expect(collectChannelKeyframes(s, 'l1', 'opacity')).toEqual([0.5, 1, 2]);
  });

  it('returns [] when no channel targets the param', () => {
    const s = withChannel('l1', 'opacity', [0, 1]);
    expect(collectChannelKeyframes(s, 'l1', 'transform.rotation')).toEqual([]);
    expect(collectChannelKeyframes(s, 'l2', 'opacity')).toEqual([]);
  });
});

describe('collectChannelKeyframeSamples', () => {
  const withChannel = (target: string, paramPath: string, times: number[]) =>
    state({
      ch: {
        id: 'ch',
        type: 'KeyframeChannelScalar',
        params: { target, paramPath, keyframes: times.map((time) => ({ time, value: 1 })) },
        inputs: {},
      },
    });

  it('carries the owning channel id with each sample, ascending by time', () => {
    const s = withChannel('l1', 'opacity', [2, 0.5, 1]);
    expect(collectChannelKeyframeSamples(s, 'l1', 'opacity')).toEqual([
      { channelId: 'ch', time: 0.5 },
      { channelId: 'ch', time: 1 },
      { channelId: 'ch', time: 2 },
    ]);
  });

  it('returns [] when no channel targets the param', () => {
    const s = withChannel('l1', 'opacity', [0, 1]);
    expect(collectChannelKeyframeSamples(s, 'l1', 'transform.rotation')).toEqual([]);
    expect(collectChannelKeyframeSamples(s, 'l2', 'opacity')).toEqual([]);
  });
});

describe('collectComfySourceChannelRows', () => {
  // A comp layer whose source is a ComfyUIWorkflow carrying a starter graph with a
  // KSampler (node 3, for Mode-B comfy:3.cfg) AND a basher_controller (node 10, for
  // Mode-A controller:10). The keyed channels TARGET the ComfyUIWorkflow node (cf_1),
  // never the Layer — both modes are the same enumeration (V81 unified transport).
  const apiJson = {
    '3': { class_type: 'KSampler', inputs: { cfg: 7, steps: 20 } },
    '10': {
      class_type: 'basher_controller',
      inputs: { name: 'Denoise CFG', kind: 'float', values_json: '[1.5]', frame_count: 1 },
    },
  };
  const baseNodes = {
    l1: {
      id: 'l1',
      type: 'Layer',
      params: { name: 'ComfyUI' },
      inputs: { source: { node: 'cf_1', socket: 'out' } },
    },
    cf_1: { id: 'cf_1', type: 'ComfyUIWorkflow', params: { graph: { apiJson } }, inputs: {} },
  };
  const channel = (id: string, type: string, paramPath: string, times: number[]) => ({
    id,
    type,
    params: { target: 'cf_1', paramPath, keyframes: times.map((time) => ({ time, value: 1 })) },
    inputs: {},
  });

  it('surfaces a Mode-B comfy: channel with a class_type.input label', () => {
    const s = state({
      ...baseNodes,
      ch_cfg: channel('ch_cfg', 'KeyframeChannelNumber', 'comfy:3.cfg', [0, 1]),
    });
    expect(collectComfySourceChannelRows(s, 'l1')).toEqual([
      { paramPath: 'comfy:3.cfg', label: 'KSampler.cfg', sourceNodeId: 'cf_1' },
    ]);
  });

  it('surfaces a Mode-A controller: channel with the declared controller name', () => {
    const s = state({
      ...baseNodes,
      ch_ctrl: channel('ch_ctrl', 'KeyframeChannelNumber', 'controller:10', [2]),
    });
    expect(collectComfySourceChannelRows(s, 'l1')).toEqual([
      { paramPath: 'controller:10', label: 'Denoise CFG', sourceNodeId: 'cf_1' },
    ]);
  });

  it('surfaces a TEXT channel too (the dot row is channel-type-agnostic)', () => {
    const s = state({
      ...baseNodes,
      ch_txt: channel('ch_txt', 'KeyframeChannelText', 'comfy:6.text', [0]),
    });
    const rows = collectComfySourceChannelRows(s, 'l1');
    // node 6 absent from apiJson → falls back to the raw nodeId.input address.
    expect(rows).toEqual([{ paramPath: 'comfy:6.text', label: '6.text', sourceNodeId: 'cf_1' }]);
  });

  it('ignores empty channels, native channels, and non-comfy sources', () => {
    const s = state({
      ...baseNodes,
      ch_empty: channel('ch_empty', 'KeyframeChannelNumber', 'comfy:3.cfg', []), // no keyframes
      ch_native: channel('ch_native', 'KeyframeChannelNumber', 'opacity', [0]), // not comfy:/controller:
    });
    expect(collectComfySourceChannelRows(s, 'l1')).toEqual([]);

    // A layer whose source is a plain MediaClip → no comfy rows.
    const sMedia = state({
      l2: {
        id: 'l2',
        type: 'Layer',
        params: {},
        inputs: { source: { node: 'm1', socket: 'out' } },
      },
      m1: { id: 'm1', type: 'MediaClip', params: {}, inputs: {} },
      ch: channel('ch', 'KeyframeChannelNumber', 'comfy:3.cfg', [0]),
    });
    expect(collectComfySourceChannelRows(sMedia, 'l2')).toEqual([]);
  });
});
