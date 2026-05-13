// clearChannel Mutator — wipe all keyframes from a KeyframeChannel.
//
// Single setParam Op writing an empty array. The channel node and its
// edges stay intact — only the keyframes payload is reset. Use cases:
// rebuild authoring from scratch, fix a bad import without dropping the
// channel + reconnecting the AnimationLayer / TimeSource.
//
// Closure: rootSelectors = [channelId]; followedEdges = []. Same shape
// as keyframe.ts + simplifyChannel.ts — purely local mutation.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const ClearChannelSpec = z.object({
  channelId: z.string().min(1),
});
export type ClearChannelSpec = z.infer<typeof ClearChannelSpec>;

export const clearChannelMutator: MutatorDefinition<ClearChannelSpec> = {
  name: 'mutator.timeline.clearChannel',
  description:
    'Wipe all keyframes from a KeyframeChannel. The channel node and its ' +
    'wiring (target / paramPath / TimeSource / AnimationLayer) are ' +
    'preserved — only the keyframes array is reset to []. No-op if the ' +
    'channel is already empty.',
  spec: ClearChannelSpec,
  specExample: { channelId: 'cube_position_channel' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Base 5 only — neither 'animation-shape' (curve destroyed) nor
    // 'keyframe-density' (zero samples). Distinguishes from keyframe
    // (both) and simplifyChannel (shape only) under V14.
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
    lossy: [
      {
        kind: 'animation-shape',
        reason: 'All keyframes deleted; the channel no longer drives its target.',
      },
      {
        kind: 'keyframe-density',
        reason: 'All keyframes deleted; sample count is zero.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.channelId],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) {
      return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    }
    if (!channel.type.startsWith('KeyframeChannel')) {
      return {
        ok: false,
        reason: `channelId "${spec.channelId}" is ${channel.type}; expected a KeyframeChannel*.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const channel = state.nodes[spec.channelId];
    const params = (channel.params ?? {}) as { keyframes?: unknown[] };
    const existing = params.keyframes ?? [];
    if (existing.length === 0) return []; // no-op
    return [
      {
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'keyframes',
        value: [],
      },
    ];
  },
};
