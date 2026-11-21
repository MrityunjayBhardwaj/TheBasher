// addLayer — verify the pure op-builder + fresh-id helper. The
// importMediaClipAsLayer orchestration (ingest + dispatch) is covered by e2e.

import { beforeAll, describe, expect, it } from 'vitest';
import { emptyDagState } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { applyOp } from '../../test-utils/committedApplyOp';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildMediaClipOps } from '../asset/importMediaClip';
import { useDagStore } from '../../core/dag/store';
import { addComfyWorkflowLayerFromGraph, buildAddLayerOps, freshLayerId } from './addLayer';
import { collectCompositeInputs } from './compositeDecode';
import { buildNewCompositionOps } from './newComposition';
import { compositionLayerIds } from './videoLayers';

function apply(s: DagState, ops: readonly Op[]): DagState {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('buildAddLayerOps', () => {
  // #1879 — asserted on the stack the ops build (the order read back), not on their shape.
  beforeAll(() => registerAllNodes());
  const still = {
    mediaKind: 'image' as const,
    srcFps: 1,
    srcFrames: 1,
    durationSeconds: 0,
    width: 64,
    height: 64,
  };
  const withClip = (s: DagState, id: string) =>
    apply(s, buildMediaClipOps(id, id, `media/${id}.png`, still));

  it('wraps the source as a Layer and puts it on an empty comp', () => {
    let s = withClip(apply(emptyDagState(), buildNewCompositionOps('comp_1', 'C')), 'media_1');
    s = apply(s, buildAddLayerOps(s, 'layer_1', 'comp_1', 'media_1', 'clip'));
    expect(s.nodes.layer_1).toMatchObject({ type: 'Layer', params: { name: 'clip' } });
    expect(s.nodes.layer_1.inputs.source).toMatchObject({ node: 'media_1', socket: 'out' });
    expect(compositionLayerIds(s, 'comp_1')).toEqual(['layer_1']);
  });

  it('a second layer lands on top, with the first under it', () => {
    let s = withClip(apply(emptyDagState(), buildNewCompositionOps('comp_1', 'C')), 'media_1');
    s = apply(s, buildAddLayerOps(s, 'layer_1', 'comp_1', 'media_1', 'clip'));
    s = withClip(s, 'media_2');
    s = apply(s, buildAddLayerOps(s, 'layer_2', 'comp_1', 'media_2', 'clip2'));
    expect(compositionLayerIds(s, 'comp_1')).toEqual(['layer_1', 'layer_2']);
    expect(s.nodes.layer_2.inputs.below).toMatchObject({ node: 'layer_1', socket: 'out' });
  });
});

describe('addComfyWorkflowLayerFromGraph (#1715 × #1879)', () => {
  // A workflow node's sockets come from its file (#1715), so its layer reads the file's first
  // output, not `out`; the layer still goes on top of the comp's chain (#1879).
  beforeAll(() => registerAllNodes());

  it("stacks the workflow's layer on top, its source wired to the file's first output", () => {
    let s = apply(emptyDagState(), buildNewCompositionOps('comp_1', 'C'));
    s = apply(
      s,
      buildMediaClipOps('media_1', 'plate', 'media/plate.png', {
        mediaKind: 'image',
        srcFps: 1,
        srcFrames: 1,
        durationSeconds: 0,
        width: 64,
        height: 64,
      }),
    );
    s = apply(s, buildAddLayerOps(s, 'layer_1', 'comp_1', 'media_1', 'plate'));
    useDagStore.setState({ state: s } as never);

    const graph = {
      apiJson: {
        '1': { class_type: 'basher_controller', inputs: { name: 'seed', kind: 'int' } },
        '2': {
          class_type: 'basher_export',
          inputs: { name: 'clip', kind: 'video', images: ['9', 0] },
        },
      },
      meta: { name: 'wf', importedAt: 'x', fps: 30, frames: 1 },
    };
    const layerId = addComfyWorkflowLayerFromGraph('comp_1', graph, 'AI');
    const after = useDagStore.getState().state;
    const source = after.nodes[layerId].inputs.source as { node: string; socket: string };
    expect(after.nodes[source.node].type).toBe('ComfyUIWorkflow');
    expect(source.socket).toBe('clip');
    expect(compositionLayerIds(after, 'comp_1')).toEqual(['layer_1', layerId]);
    expect(after.nodes[layerId].inputs.below).toMatchObject({ node: 'layer_1', socket: 'out' });
    // The composite draws both, the workflow's on top.
    const plan = collectCompositeInputs(after, 'comp_1', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    expect(plan.map((i) => i.layerId)).toEqual(['layer_1', layerId]);
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
