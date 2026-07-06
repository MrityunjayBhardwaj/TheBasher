// setChannelExtend Mutator — the agent's authoring op for a channel's per-side
// EXTRAPOLATION rule (#269/#275, V88 D1). The agent counterpart of the NPanel
// "Extend / Before / After" dropdowns (ChannelExtendControls): it sets how a
// KeyframeChannel{Number,Vec2,Vec3} extrapolates for times OUTSIDE the authored
// keyframe domain — 'hold' (clamp to the boundary key, the default) or 'slope'
// (continue the boundary segment's slope, Blender LINEAR extrapolation). The
// cycle/mirror family lives in a Cycles F-Modifier (add it with
// mutator.timeline.addChannelModifier), NOT here — this is the pure
// extrapolation property only (#275 split).
//
// Blender analog: F-Curve "Set Extrapolation" (Shift-E → Constant / Linear).
//
// Closure: rootSelectors = [channelId]; followedEdges = []. Like `keyframe`, the
// setParam targets the channel itself (a root); the channel is a free-floating
// satellite of its target (V57) — no edge to walk.
//
// REF: src/nodes/keyframeInterp.ts (EXTRAPOLATE_RULES — the single authority);
//      src/app/NPanel.tsx (ChannelExtendControls — the UI counterpart);
//      vyapti V88 D1; src/agent/mutators/builders/keyframe.ts (the template).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { EXTRAPOLATE_RULES, type ChannelExtrapolate } from '../../../nodes/keyframeInterp';

/** The KeyframeChannel node types that carry per-side extrapolation (Number/Vec2/Vec3).
 *  Quat/Color/Text/Image channels have no extend rule (they clamp) — targeting one is
 *  a precondition reject, not a silent no-op. */
const EXTEND_CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec2',
  'KeyframeChannelVec3',
]);

const ExtendRule = z.enum(
  EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]],
);

const SetChannelExtendSpec = z
  .object({
    /** The KeyframeChannel{Number,Vec2,Vec3} whose extrapolation to set. */
    channelId: z.string().min(1),
    /** Extrapolation for times BEFORE the first keyframe. Omit to leave unchanged. */
    before: ExtendRule.optional(),
    /** Extrapolation for times AFTER the last keyframe. Omit to leave unchanged. */
    after: ExtendRule.optional(),
  })
  .refine((s) => s.before !== undefined || s.after !== undefined, {
    message: 'provide at least one of `before` / `after`.',
  });
export type SetChannelExtendSpec = z.infer<typeof SetChannelExtendSpec>;

export const setChannelExtendMutator: MutatorDefinition<SetChannelExtendSpec> = {
  name: 'mutator.timeline.setChannelExtend',
  description:
    'Set how a KeyframeChannel{Number,Vec2,Vec3} EXTRAPOLATES outside its keyframe ' +
    "range (Blender's Set Extrapolation). `before` / `after` each take 'hold' " +
    "(clamp to the boundary keyframe — the default) or 'slope' (continue the " +
    'boundary segment slope, linear extrapolation). Provide either or both. The ' +
    'authored keyframes and the in-range curve are untouched — only the ' +
    'out-of-range tails change. For repeating/mirroring a range, add a Cycles ' +
    'F-Modifier via mutator.timeline.addChannelModifier instead.',
  spec: SetChannelExtendSpec,
  specExample: {
    channelId: 'cube_position_channel',
    before: 'hold',
    after: 'slope',
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Every keyframe (time + value + interp + handles) and the in-range curve are
    // untouched — only the out-of-domain extrapolation changes. So all seven aspects
    // are preserved; the honest discriminator vs `keyframe` (which shares that
    // preserves-set) is the lossy note: the prior tail behavior no longer renders.
    preserves: [
      'position',
      'rotation',
      'scale',
      'material',
      'children',
      'animation-shape',
      'keyframe-density',
    ],
    lossy: [
      {
        kind: 'prior-extrapolation',
        reason:
          "replaces the channel's per-side extrapolation rule; the prior out-of-range tail behavior no longer renders.",
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.channelId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    if (!EXTEND_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        reason: `channel "${spec.channelId}" is ${channel.type}; extrapolation applies only to KeyframeChannel{Number,Vec2,Vec3}.`,
      };
    }
    // Defense-in-depth vs the spec `.refine()` (which only fires at the safeParse
    // boundary): a validatePlan caller passing an already-parsed spec with neither
    // side set would otherwise emit an empty-ops "success" (a silent no-op).
    if (spec.before === undefined && spec.after === undefined) {
      return { ok: false, reason: 'provide at least one of `before` / `after`.' };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // One setParam per provided side (idempotent if unchanged). Deterministic order:
    // before then after.
    const ops: Op[] = [];
    if (spec.before !== undefined) {
      ops.push({
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'extendBefore',
        value: spec.before,
      });
    }
    if (spec.after !== undefined) {
      ops.push({
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'extendAfter',
        value: spec.after,
      });
    }
    return ops;
  },
};
