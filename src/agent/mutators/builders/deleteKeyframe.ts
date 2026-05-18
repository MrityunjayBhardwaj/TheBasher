// deleteKeyframe Mutator — remove a single keyframe at a given time
// from an existing KeyframeChannel<T>.
//
// The exact inverse of keyframe.ts's append: keyframe.ts replaces/appends
// one sample and re-sorts; deleteKeyframe filters out the sample whose
// `time` matches and writes the remaining array back. The channel node
// and its wiring (target / paramPath / TimeSource / AnimationLayer) stay
// intact — only the keyframes payload shrinks by one.
//
// Blender parity (D-06): `Alt-I` deletes the key at the playhead and is a
// SILENT NO-OP when the current frame has no sample. So if no keyframe
// matches `time`, build() returns [] (no Ops, state byte-unchanged) —
// the same no-op discipline as clearChannel.ts:72. We do NOT hard-fail
// the precondition for a missing sample.
//
// Closure: rootSelectors = [channelId]; followedEdges = []. Identical to
// keyframe.ts:76-81 — the operation is purely local to the channel node.
//
// V14 distinctness: contract.preserves carries 'keyframe-identity' (the
// P7 Wave B union member). deleteKeyframe removes ONE identified sample
// and leaves every other sample's identity untouched — distinct from
// simplifyChannel (re-fits the curve; would otherwise share a byte-
// identical signature since `lossy` is not part of the V14 signature),
// keyframe (preserves shape + density), and clearChannel (preserves
// neither). See types.ts PreservedAspect.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const DeleteKeyframeSpec = z.object({
  channelId: z.string().min(1),
  time: z.number().nonnegative(),
});
export type DeleteKeyframeSpec = z.infer<typeof DeleteKeyframeSpec>;

// Same value-shape guard set as keyframe.ts — a channel is a valid
// deleteKeyframe target iff it is one of the four KeyframeChannel* types.
const VALUE_SHAPE_BY_TYPE: Record<string, true> = {
  KeyframeChannelNumber: true,
  KeyframeChannelVec3: true,
  KeyframeChannelQuat: true,
  KeyframeChannelColor: true,
};

export const deleteKeyframeMutator: MutatorDefinition<DeleteKeyframeSpec> = {
  name: 'mutator.timeline.deleteKeyframe',
  description:
    'Delete the keyframe at { time } from an existing KeyframeChannel. ' +
    'The channel node and its wiring (target / paramPath / TimeSource / ' +
    'AnimationLayer) are preserved — only the matching sample is removed. ' +
    'No-op (no state change) if no keyframe exists at that time, mirroring ' +
    "Blender's Alt-I delete-at-playhead. Use mutator.timeline.clearChannel " +
    'to wipe ALL keyframes instead.',
  spec: DeleteKeyframeSpec,
  specExample: {
    channelId: 'cube_position_channel',
    time: 0.5,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // 'keyframe-identity' kept: deleteKeyframe removes ONE identified
    // sample; every other sample's (time, value, easing) identity is
    // untouched. This member makes the V14 signature distinct from
    // simplifyChannel (same base5 + 'animation-shape' set otherwise —
    // `lossy` is not part of the V14 signature, mutators.test.ts:155).
    // 'animation-shape' kept: removing one sample does not re-fit or
    // destroy the curve the other samples define.
    // 'keyframe-density' dropped: the sample count decreases by one.
    preserves: [
      'position',
      'rotation',
      'scale',
      'material',
      'children',
      'animation-shape',
      'keyframe-identity',
    ],
    lossy: [
      {
        kind: 'keyframe-identity',
        reason: 'one identified sample removed',
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
    if (!VALUE_SHAPE_BY_TYPE[channel.type]) {
      return {
        ok: false,
        reason: `channelId "${spec.channelId}" is ${channel.type}; expected a KeyframeChannel*.`,
      };
    }
    // NOTE: deliberately NOT failing here when no sample exists at
    // `time`. Blender's Alt-I on a non-keyed frame is a silent no-op,
    // not an error (D-06). The no-op is handled in build() — same
    // discipline as clearChannel.ts:72.
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const channel = state.nodes[spec.channelId];
    const params = (channel.params ?? {}) as {
      keyframes?: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>;
    };
    const existing = params.keyframes ?? [];
    const filtered = existing.filter((k) => k.time !== spec.time);
    // No sample at `time` → nothing removed → no-op (state unchanged).
    // Mirrors clearChannel.ts:72's empty-array no-op precedent.
    if (filtered.length === existing.length) return [];
    return [
      {
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'keyframes',
        value: filtered,
      },
    ];
  },
};
