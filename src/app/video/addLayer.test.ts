// addLayer — verify the pure op-builder + fresh-id helper. The
// importMediaClipAsLayer orchestration (ingest + dispatch) is covered by e2e.

import { describe, expect, it } from 'vitest';
import { buildAddLayerOps, freshLayerId } from './addLayer';

describe('buildAddLayerOps', () => {
  it('builds addNode(Layer) + source connect + comp-layers connect', () => {
    const ops = buildAddLayerOps('layer_1', 'comp_1', 'media_1', 'clip');
    expect(ops).toEqual([
      { type: 'addNode', nodeId: 'layer_1', nodeType: 'Layer', params: { name: 'clip' } },
      {
        type: 'connect',
        from: { node: 'media_1', socket: 'out' },
        to: { node: 'layer_1', socket: 'source' },
      },
      {
        type: 'connect',
        from: { node: 'layer_1', socket: 'out' },
        to: { node: 'comp_1', socket: 'layers' },
      },
    ]);
  });

  it('appends to the layers list (no index) → the new layer lands on top', () => {
    const ops = buildAddLayerOps('layer_2', 'comp_1', 'media_2', 'clip2');
    const compConnect = ops.find(
      (op) => op.type === 'connect' && op.to.node === 'comp_1' && op.to.socket === 'layers',
    );
    expect(compConnect).toBeDefined();
    expect((compConnect as { index?: number }).index).toBeUndefined();
  });
});

describe('freshLayerId', () => {
  it('returns layer_1 when none used', () => {
    expect(freshLayerId([])).toBe('layer_1');
  });

  it('skips used ids', () => {
    expect(freshLayerId(['layer_1', 'layer_2'])).toBe('layer_3');
  });
});
