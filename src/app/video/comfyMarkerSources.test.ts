// #1951 — a workflow marker fed by a wire, or by its own output a frame back, reads as such in the
// Controls panel; an unwired marker keeps its picker or field.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { markerSourcesOf } from './ComfyControlsSection';
import { buildNewCompositionOps } from './newComposition';
import { makeShotClipsPlan, shotClipsOf } from './shotClips';

beforeAll(() => registerAllNodes());

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

describe('#1951 — where each workflow marker gets its value', () => {
  it("a shot clip's passes read as wired, its previous frame as fed, its prompt as the panel's", () => {
    let s = apply(buildDefaultDagState(), buildNewCompositionOps('comp', 'Film'));
    s = apply(s, makeShotClipsPlan(s, 'comp').ops);
    const id = shotClipsOf(s, 'comp')[0].workflowId!;
    const sources = markerSourcesOf(s, id);
    // The stylized file's markers: 5 beauty, 6 depth, 7 normal, 8 prev_frame_image, 20 prompt.
    for (const marker of ['5', '6', '7']) {
      expect(sources[marker]).toMatchObject({ kind: 'wired' });
    }
    const beautyFrom = (sources['5'] as { from: string }).from;
    expect(s.nodes[beautyFrom].type).toBe('BeautyPass');
    expect(sources['8']).toEqual({ kind: 'fed', from: 'stylized' });
    expect(sources['20']).toBeUndefined();
    expect(sources['21']).toBeUndefined();
  });

  it('a node that is not a workflow has none', () => {
    expect(markerSourcesOf(buildDefaultDagState(), 'n_box')).toEqual({});
  });
});
