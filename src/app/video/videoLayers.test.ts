// videoLayers — verify collectLayerRows reads ordered layer rows + source length
// from a raw DAG state.

import { describe, expect, it } from 'vitest';
import type { DagState } from '../../core/dag/state';
import { buildReorderLayerOps, collectLayerRows } from './videoLayers';

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
