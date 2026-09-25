// #1225 — the retarget's motion input is named `source`, and so is `AnimationClip`'s producer edge
// (#935). The walk that finds the rigs a clip drives through a retarget must therefore check the
// node type as well as the edge, or a clip PRODUCED from `clipId` reads as a retarget of it.

import { describe, expect, it } from 'vitest';
import { riggedSkeletonsForClip } from './boundClipsForAsset';

type Node = { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> };
const node = (type: string, inputs: Record<string, unknown> = {}): Node => ({
  type,
  params: {},
  inputs,
});

describe('riggedSkeletonsForClip', () => {
  it('counts a retarget of the clip, and not a clip whose producer edge names it', () => {
    const nodes: Record<string, Node> = {
      g_retargeted: node('GltfSkeleton'),
      g_produced: node('GltfSkeleton'),
      src: node('AnimationClip'),
      retarget: node('RetargetClip', {
        source: { node: 'src', socket: 'pose' },
        skeleton: { node: 'g_retargeted', socket: 'out' },
      }),
      // Same edge NAME and target as the retarget's, on a clip: a producer edge, not a retarget.
      produced: node('AnimationClip', {
        source: { node: 'src', socket: 'out' },
        skeleton: { node: 'g_produced', socket: 'out' },
      }),
    };
    expect(riggedSkeletonsForClip(nodes, 'src')).toEqual(['g_retargeted']);
  });
});
