// keyframe Mutator — append a single keyframe to an existing
// KeyframeChannel<T>.
//
// Uses the channel's existing type to validate the value shape (number /
// vec3 / quat / color). Re-keyframing an existing time replaces the
// sample at that time — most authoring tools behave this way and it
// keeps the array bounded. Easing falls through to the channel's
// per-type default when omitted.
//
// Closure: rootSelectors = [channelId]; followedEdges = []. The setParam
// op targets the channel itself which is in closure as a root. No layer
// or target involvement at this level.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const KeyframeSpec = z.object({
  channelId: z.string().min(1),
  time: z.number().nonnegative(),
  value: z.unknown(),
  easing: z.enum(['linear', 'cubic']).optional(),
});
export type KeyframeSpec = z.infer<typeof KeyframeSpec>;

const VALUE_SHAPE_BY_TYPE: Record<string, (v: unknown) => boolean> = {
  KeyframeChannelNumber: (v) => typeof v === 'number',
  KeyframeChannelVec3: (v) =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number'),
  KeyframeChannelQuat: (v) =>
    Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number'),
  KeyframeChannelColor: (v) => typeof v === 'string',
};

const DEFAULT_EASING_BY_TYPE: Record<string, 'linear' | 'cubic'> = {
  KeyframeChannelNumber: 'linear',
  KeyframeChannelVec3: 'cubic',
  KeyframeChannelQuat: 'cubic',
  KeyframeChannelColor: 'cubic',
};

export const keyframeMutator: MutatorDefinition<KeyframeSpec> = {
  name: 'mutator.timeline.keyframe',
  description:
    'Append a keyframe { time, value } to an existing KeyframeChannel. ' +
    'Re-keying the same time replaces the existing sample. Use ' +
    'mutator.timeline.addChannel to create a channel; this Mutator only ' +
    'mutates an existing one.',
  spec: KeyframeSpec,
  specExample: {
    channelId: 'cube_position_channel',
    time: 0.5,
    value: [0, 2, 0],
    easing: 'cubic',
  },
  contract: {
    requiredEdges: [],
    // Channel must already be a known type — addChannel landed first.
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.channelId],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    if (!VALUE_SHAPE_BY_TYPE[channel.type]) {
      return {
        ok: false,
        reason: `channelId "${spec.channelId}" is ${channel.type}; expected a KeyframeChannel*.`,
      };
    }
    if (!VALUE_SHAPE_BY_TYPE[channel.type](spec.value)) {
      return {
        ok: false,
        reason: `value shape does not match channel type "${channel.type}".`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const channel = state.nodes[spec.channelId];
    const params = (channel.params ?? {}) as {
      keyframes?: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>;
    };
    const existing = params.keyframes ?? [];
    const easing = spec.easing ?? DEFAULT_EASING_BY_TYPE[channel.type] ?? 'linear';

    // Replace any sample at the same time; otherwise append. Sort by time
    // so the channel's evaluator can rely on monotonic input (and so the
    // dopesheet renders rows left-to-right without re-sorting on render).
    const filtered = existing.filter((k) => k.time !== spec.time);
    const next = [...filtered, { time: spec.time, value: spec.value, easing }].sort(
      (a, b) => a.time - b.time,
    );

    return [
      {
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'keyframes',
        value: next,
      },
    ];
  },
};
