// videoLayers — verify collectLayerRows reads ordered layer rows + source length
// from a raw DAG state.

import { beforeAll, describe, expect, it } from 'vitest';
import type { DagState } from '../../core/dag/state';
import { emptyDagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { applyOp } from '../../test-utils/committedApplyOp';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildMediaClipOps } from '../asset/importMediaClip';
import { buildDeleteNodesOps } from '../sceneNodeActions';
import { buildNewCompositionOps } from './newComposition';
import { buildAddLayerOps } from './addLayer';
import {
  buildReorderLayerOps,
  collectChannelKeyframes,
  collectChannelKeyframeSamples,
  collectComfySourceChannelRows,
  collectLayerRows,
  compositionLayerIds,
  compositionStack,
  stackLayerOnTopOps,
} from './videoLayers';
import { collectCompositeInputs } from './compositeDecode';
import { isLayerInput } from './composite';

// #1879 — the stack is walked through each node's DECLARED chain socket, so the registry is needed.
beforeAll(() => registerAllNodes());

function state(nodes: Record<string, unknown>): DagState {
  return { nodes } as unknown as DagState;
}

function apply(s: DagState, ops: readonly Op[]): DagState {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

const STILL = {
  mediaKind: 'image' as const,
  srcFps: 1,
  srcFrames: 1,
  durationSeconds: 0,
  width: 64,
  height: 64,
};

/** A comp holding one layer per name, back → front, each over its own MediaClip, built by the
 *  real New Composition and Add Layer ops. */
function realStack(names: readonly string[]): DagState {
  let s = apply(emptyDagState(), buildNewCompositionOps('comp', 'C'));
  for (const n of names) {
    s = apply(s, buildMediaClipOps(`clip_${n}`, n, `media/${n}.png`, STILL));
    s = apply(s, buildAddLayerOps(s, n, 'comp', `clip_${n}`, n));
  }
  return s;
}

describe('collectLayerRows', () => {
  it('returns layers in list order (back→front) with params + source frames', () => {
    const s = state({
      comp: {
        id: 'comp',
        type: 'Composition',
        params: { name: 'C' },
        inputs: { in: { node: 'l_fg', socket: 'out' } },
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
        params: { name: 'fg', muted: true, solo: true, locked: true, startFrame: 12 },
        inputs: {
          below: { node: 'l_bg', socket: 'out' },
          source: { node: 'clip', socket: 'out' },
        },
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
        inputs: { in: { node: 'l1', socket: 'out' } },
      },
      // The layer behind it is missing: the walk stops there instead of inventing a row.
      l1: {
        id: 'l1',
        type: 'Layer',
        params: { name: 'solo' },
        inputs: { below: { node: 'ghost', socket: 'out' } },
      },
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
  // #1879 — asserted on what the ops DO to a real stack (the order read back), not on their shape.
  const reordered = (names: string[], layer: string, to: number) => {
    const s = realStack(names);
    return compositionLayerIds(apply(s, buildReorderLayerOps(s, 'comp', layer, to)), 'comp');
  };

  it('moves a layer to a new index: back to front', () => {
    expect(reordered(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves a layer to a new index: front to back, and into the middle', () => {
    expect(reordered(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reordered(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
  });

  it('clamps an out-of-range target to the last index', () => {
    expect(reordered(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when the target equals the current index', () => {
    const s = realStack(['a', 'b', 'c']);
    expect(buildReorderLayerOps(s, 'comp', 'b', 1)).toEqual([]);
  });

  it('is a no-op for a missing comp or unknown layer', () => {
    const s = realStack(['a']);
    expect(buildReorderLayerOps(s, 'nope', 'a', 0)).toEqual([]);
    expect(buildReorderLayerOps(s, 'comp', 'ghost', 0)).toEqual([]);
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

// #1879 — one reader of a composition's layer stack: the chain under `Composition.in`, walked
// through each node's declared chain socket. Every reader (the rows, the composite, the header's
// count) goes through it.
/** Put a Color Correct `id` on the stack directly above layer `layer`, wired as a user would:
 *  between it and whatever read it (the next layer's `below`, or the comp's `in`). */
function stepAbove(s: DagState, layer: string, id = 'cc', params: Record<string, unknown> = {}) {
  const reader = Object.values(s.nodes).find(
    (n) => (n.inputs?.below as { node?: string } | undefined)?.node === layer,
  );
  const to = reader ? { node: reader.id, socket: 'below' } : { node: 'comp', socket: 'in' };
  return apply(s, [
    { type: 'addNode', nodeId: id, nodeType: 'ColorCorrect', params },
    { type: 'disconnect', from: { node: layer, socket: 'out' }, to },
    { type: 'connect', from: { node: layer, socket: 'out' }, to: { node: id, socket: 'target' } },
    { type: 'connect', from: { node: id, socket: 'out' }, to },
  ]);
}

const stackIds = (s: DagState) => compositionStack(s, 'comp').map((e) => e.id);

describe('buildReorderLayerOps across a step between layers (#1879 step 4)', () => {
  // The rule: steps keep their place relative to the layers that do not move; the moved layer
  // lands directly on the far side of the last layer it passes.
  const move = (s: DagState, layer: string, to: number) =>
    stackIds(apply(s, buildReorderLayerOps(s, 'comp', layer, to)));

  it("moving a layer back under an adjustment puts it in the adjustment's reach", () => {
    const s = stepAbove(realStack(['a', 'b']), 'a'); // a, cc, b
    expect(stackIds(s)).toEqual(['a', 'cc', 'b']);
    expect(move(s, 'b', 0)).toEqual(['b', 'a', 'cc']);
  });

  it('moving a layer forward over an adjustment takes it out of reach', () => {
    const s = stepAbove(realStack(['a', 'b']), 'a'); // a, cc, b
    expect(move(s, 'a', 1)).toEqual(['cc', 'b', 'a']);
  });

  it('a move between other layers leaves the step where it stood among them', () => {
    const s = stepAbove(realStack(['a', 'b', 'c']), 'b'); // a, b, cc, c
    expect(move(s, 'a', 1)).toEqual(['b', 'a', 'cc', 'c']);
    expect(move(s, 'a', 2)).toEqual(['b', 'cc', 'c', 'a']);
    expect(move(s, 'c', 0)).toEqual(['c', 'a', 'b', 'cc']);
  });

  it('a step on top stays on top', () => {
    const s = stepAbove(realStack(['a', 'b']), 'b'); // a, b, cc
    expect(move(s, 'b', 0)).toEqual(['b', 'a', 'cc']);
    expect(move(s, 'a', 1)).toEqual(['b', 'a', 'cc']);
  });

  it('a plain source wired under the back layer stays under the back layer', () => {
    let s = realStack(['a', 'b']);
    s = apply(s, buildMediaClipOps('plate', 'plate', 'media/plate.png', STILL));
    s = apply(s, [
      {
        type: 'connect',
        from: { node: 'plate', socket: 'out' },
        to: { node: 'a', socket: 'below' },
      },
    ]);
    const after = apply(s, buildReorderLayerOps(s, 'comp', 'b', 0));
    expect(stackIds(after)).toEqual(['b', 'a']);
    expect(after.nodes.b.inputs?.below).toMatchObject({ node: 'plate' });
    expect(after.nodes.a.inputs?.below).toMatchObject({ node: 'b' });
  });

  it('the moved stack is one chain: every entry read exactly once, the comp reads the top', () => {
    const s = stepAbove(realStack(['a', 'b', 'c']), 'b');
    const after = apply(s, buildReorderLayerOps(s, 'comp', 'c', 0));
    expect(stackIds(after)).toEqual(['c', 'a', 'b', 'cc']);
    expect(after.nodes.comp.inputs?.in).toMatchObject({ node: 'cc' });
    expect(after.nodes.cc.inputs?.target).toMatchObject({ node: 'b' });
    expect(after.nodes.c.inputs?.below).toBeUndefined();
  });
});

describe('collectCompositeInputs reads a step between layers as an adjustment (#1879 step 4)', () => {
  const CTX0 = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const kinds = (s: DagState) =>
    collectCompositeInputs(s, 'comp', CTX0).map((i) => (isLayerInput(i) ? i.layerId : i.kind));

  it('in its place in the stack, with its evaluated params', () => {
    const s = stepAbove(realStack(['a', 'b']), 'a', 'cc', { brightness: 0.5 });
    expect(kinds(s)).toEqual(['a', 'adjust', 'b']);
    const adj = collectCompositeInputs(s, 'comp', CTX0)[1];
    expect(adj).toMatchObject({ kind: 'adjust', nodeId: 'cc', effects: [{ brightness: 0.5 }] });
  });

  it('not at all when muted', () => {
    const s = stepAbove(realStack(['a', 'b']), 'a', 'cc', { muted: true });
    expect(kinds(s)).toEqual(['a', 'b']);
  });
});

describe('compositionLayerIds — the one read of a layer stack (#1879)', () => {
  it('reads a stack built by Add Layer, back to front', () => {
    expect(compositionLayerIds(realStack(['bg', 'mid', 'fg']), 'comp')).toEqual([
      'bg',
      'mid',
      'fg',
    ]);
  });

  it('walks through a step that is not a layer, and does not list it', () => {
    let s = realStack(['a', 'b']);
    s = apply(s, [
      { type: 'addNode', nodeId: 'cc', nodeType: 'ColorCorrect', params: {} },
      {
        type: 'disconnect',
        from: { node: 'a', socket: 'out' },
        to: { node: 'b', socket: 'below' },
      },
      { type: 'connect', from: { node: 'a', socket: 'out' }, to: { node: 'cc', socket: 'target' } },
      { type: 'connect', from: { node: 'cc', socket: 'out' }, to: { node: 'b', socket: 'below' } },
    ]);
    expect(compositionLayerIds(s, 'comp')).toEqual(['a', 'b']);
  });

  it('the rows and the composite read the same layers', () => {
    const s = realStack(['a', 'b']);
    expect(collectLayerRows(s, 'comp').map((r) => r.id)).toEqual(['a', 'b']);
    expect(
      collectCompositeInputs(s, 'comp', { time: { frame: 0, seconds: 0, normalized: 0 } })
        .filter(isLayerInput)
        .map((i) => i.layerId),
    ).toEqual(['a', 'b']);
  });

  it('is empty for a missing comp, and for a comp with no layers', () => {
    expect(compositionLayerIds(realStack([]), 'nope')).toEqual([]);
    expect(compositionLayerIds(realStack([]), 'comp')).toEqual([]);
  });

  it('a layer stacked on top becomes the front, and the old front moves under it', () => {
    const s = realStack(['a']);
    const next = apply(s, [
      { type: 'addNode', nodeId: 'b', nodeType: 'Layer', params: {} },
      ...stackLayerOnTopOps(s, 'comp', 'b'),
    ]);
    expect(compositionLayerIds(next, 'comp')).toEqual(['a', 'b']);
  });

  it('deleting a middle layer splices the stack closed', () => {
    // The generic delete splices any chain node out (#432), so the layers behind a deleted one
    // stay in the comp instead of falling off with it.
    const s = realStack(['a', 'b', 'c']);
    expect(compositionLayerIds(apply(s, buildDeleteNodesOps(s, ['b'])), 'comp')).toEqual([
      'a',
      'c',
    ]);
  });
});
