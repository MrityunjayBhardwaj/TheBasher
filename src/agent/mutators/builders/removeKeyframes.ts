// removeKeyframes Mutator — remove keyframes from a KeyframeChannel.
//
// Discriminated by `scope`:
//   - `scope: 'all'`         → wipe every sample (Blender `Shift-Alt-I` Clear).
//   - `scope: { time: T }`   → remove the single sample at time T (Blender
//                              `Alt-I` delete-at-playhead).
//
// In both shapes the channel node and its wiring (target / paramPath /
// TimeSource / AnimationLayer) are preserved — only the keyframes payload
// changes. When there is nothing to remove the Mutator is a SILENT NO-OP
// (build() returns []): empty channel + 'all' → no-op; missing sample +
// {time} → no-op. Same no-op discipline both old Mutators used.
//
// Closure: rootSelectors = [channelId], followedEdges = []. Purely local
// to the channel node.
//
// Provenance (issue #60 / hetvabhasa H36, 2026-05-18). Supersedes the
// pre-P7 `clearChannel` Mutator and the P7-Wave-B `deleteKeyframe` Mutator
// — the two were parameterizations of "remove keyframes by scope" that
// destroyed identical aspects (`animation-shape` + `keyframe-density`) at
// different scales. After widening V14's signature to read `lossy[].kind`,
// honest contracts for the two collided exactly as V14 was designed to
// catch: "almost always candidates for parameterization rather than fork".
// This Mutator is the parameterization. V14's `'keyframe-identity'`
// PreservedAspect token (introduced in P7 Wave B as the distinctness
// hack for the fork) has been retired as dead.
//
// REF: THESIS §123 (authoring UI + agent tool surface reduce to a small
// primitive set), vyapti V14 (Mutator non-redundancy, widened signature),
// hetvabhasa H36 (gaming a mechanical distinctness gate).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const RemoveKeyframesSpec = z.object({
  channelId: z.string().min(1),
  /**
   * 'all' wipes every sample. `{ time }` removes the single sample at that
   * time. Either is a silent no-op when there is nothing to remove.
   */
  scope: z.union([z.literal('all'), z.object({ time: z.number().nonnegative() })]),
});
export type RemoveKeyframesSpec = z.infer<typeof RemoveKeyframesSpec>;

export const removeKeyframesMutator: MutatorDefinition<RemoveKeyframesSpec> = {
  name: 'mutator.timeline.removeKeyframes',
  description:
    'Remove keyframes from a KeyframeChannel. scope:"all" wipes every ' +
    'sample (Blender Shift-Alt-I Clear); scope:{time} removes the single ' +
    'sample at that time (Blender Alt-I delete-at-playhead). Silent no-op ' +
    'when there is nothing to remove. The channel node and its wiring ' +
    '(target / paramPath / TimeSource / AnimationLayer) are preserved ' +
    'either way; only the keyframes array changes.',
  spec: RemoveKeyframesSpec,
  specExample: {
    channelId: 'cube_position_channel',
    scope: { time: 0.5 },
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Honest under both scopes:
    //   - 'all'  removes every sample — shape gone, density 0.
    //   - {time} removes one sample — shape changes (no ε bound), density N→N-1.
    // Both lose `animation-shape` and `keyframe-density`. They share the
    // same preserves/lossy because they ARE parameterizations of the
    // same destructive op at different scales; V14 collapses them into
    // one Mutator (this one).
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
    lossy: [
      {
        kind: 'animation-shape',
        reason:
          'scope:"all" destroys the curve entirely; scope:{time} changes ' +
          'the curve at the removed sample arbitrarily (no ε bound).',
      },
      {
        kind: 'keyframe-density',
        reason: 'scope:"all" sets sample count to 0; scope:{time} decreases it by one.',
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
    // Deliberately NOT failing here when scope:{time} has no matching
    // sample. Blender's Alt-I on a non-keyed frame is a silent no-op, not
    // an error. Same for 'all' on an already-empty channel. The no-op is
    // handled in build().
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const channel = state.nodes[spec.channelId];
    const params = (channel.params ?? {}) as {
      keyframes?: Array<{ time: number; value: unknown; easing: 'linear' | 'cubic' }>;
    };
    const existing = params.keyframes ?? [];

    if (spec.scope === 'all') {
      if (existing.length === 0) return []; // already empty → no-op
      return [{ type: 'setParam', nodeId: spec.channelId, paramPath: 'keyframes', value: [] }];
    }

    // scope: { time }
    const filtered = existing.filter((k) => k.time !== spec.scope.time);
    if (filtered.length === existing.length) return []; // no sample at time → no-op
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
