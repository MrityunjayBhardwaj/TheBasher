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
import {
  KEYFRAME_INTERPS,
  EASE_DIRS,
  KEYFRAME_HANDLE_TYPES,
  type Easing,
  type EaseDir,
  type HandleType,
} from '../../../nodes/keyframeInterp';

const KeyframeSpec = z.object({
  channelId: z.string().min(1),
  time: z.number().nonnegative(),
  value: z.unknown(),
  // #281 — broadened from the pre-#272 {linear,cubic} to the full per-keyframe
  // interpolation vocabulary (#272/#273), so an agent can author an eased/stepped
  // key at CREATION time (not just linear/cubic). Omitted → the channel's per-type
  // default (byte-identical to pre-#281). `ease`/`handleType` are meaningful only
  // for Number/Vec2/Vec3 channels; on a Quat/Color channel their paramSchema strips
  // the extra fields and rejects a non-{linear,cubic} easing at gate 2.
  easing: z.enum(KEYFRAME_INTERPS as unknown as [Easing, ...Easing[]]).optional(),
  ease: z.enum(EASE_DIRS as unknown as [EaseDir, ...EaseDir[]]).optional(),
  handleType: z.enum(KEYFRAME_HANDLE_TYPES as unknown as [HandleType, ...HandleType[]]).optional(),
});
export type KeyframeSpec = z.infer<typeof KeyframeSpec>;

const VALUE_SHAPE_BY_TYPE: Record<string, (v: unknown) => boolean> = {
  KeyframeChannelNumber: (v) => typeof v === 'number',
  KeyframeChannelVec2: (v) =>
    Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'),
  KeyframeChannelVec3: (v) =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number'),
  KeyframeChannelQuat: (v) =>
    Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number'),
  KeyframeChannelColor: (v) => typeof v === 'string',
  // Step (discrete) string channels — prompt travel + reference-image triggers.
  // Teaching THIS gate is mandatory: a new KeyframeChannel<T> fans out across the
  // value-shape gates, and a 2nd key is SILENTLY rejected if any is missed (the
  // 3c-ii trap — dharana B24).
  KeyframeChannelText: (v) => typeof v === 'string',
  KeyframeChannelImage: (v) => typeof v === 'string',
};

const DEFAULT_EASING_BY_TYPE: Record<string, 'linear' | 'cubic'> = {
  KeyframeChannelNumber: 'linear',
  KeyframeChannelVec2: 'cubic',
  KeyframeChannelVec3: 'cubic',
  KeyframeChannelQuat: 'cubic',
  KeyframeChannelColor: 'cubic',
  // Step channels ignore easing; 'linear' is the inert default.
  KeyframeChannelText: 'linear',
  KeyframeChannelImage: 'linear',
};

export const keyframeMutator: MutatorDefinition<KeyframeSpec> = {
  name: 'mutator.timeline.keyframe',
  description:
    'Append a keyframe { time, value } to an existing KeyframeChannel. ' +
    'Re-keying the same time replaces the existing sample. `easing` is the ' +
    "per-key interpolation: 'linear','cubic','constant' (stepped), or a Penner " +
    "curve 'sine'|'quad'|'quart'|'quint'|'expo'|'circ'|'back'|'bounce'|'elastic' " +
    "(these + `ease` 'in'|'out'|'inout' and `handleType` apply to Number/Vec2/Vec3 " +
    'channels; Quat/Color take only linear|cubic). Omitting easing uses the ' +
    "channel's default. Use mutator.timeline.addChannel to create a channel; this " +
    'Mutator only mutates an existing one. To re-interp keys you already placed, ' +
    'use mutator.timeline.setKeyframeInterp.',
  spec: KeyframeSpec,
  specExample: {
    channelId: 'cube_position_channel',
    time: 0.5,
    value: [0, 2, 0],
    easing: 'back',
    ease: 'out',
  },
  contract: {
    requiredEdges: [],
    // Channel must already be a known type — addChannel landed first.
    requiredNodeTypes: [],
    // P6 W6 — adds 'animation-shape' + 'keyframe-density' to distinguish
    // from simplifyChannel + removeKeyframes under V14. keyframe appends
    // or replaces a single sample; the existing curve shape is preserved
    // AND the count of other samples is unchanged.
    preserves: [
      'position',
      'rotation',
      'scale',
      'material',
      'children',
      'animation-shape',
      'keyframe-density',
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
      keyframes?: Array<{ time: number; value: unknown; easing: Easing }>;
    };
    const existing = params.keyframes ?? [];
    const easing = spec.easing ?? DEFAULT_EASING_BY_TYPE[channel.type] ?? 'linear';

    // Build the new sample. `ease`/`handleType` are added ONLY when provided so a
    // legacy call (linear/cubic, no ease/handle) stays byte-identical to pre-#281.
    const key: {
      time: number;
      value: unknown;
      easing: Easing;
      ease?: EaseDir;
      handleType?: HandleType;
    } = { time: spec.time, value: spec.value, easing };
    if (spec.ease !== undefined) key.ease = spec.ease;
    if (spec.handleType !== undefined) key.handleType = spec.handleType;

    // Replace any sample at the same time; otherwise append. Sort by time
    // so the channel's evaluator can rely on monotonic input (and so the
    // dopesheet renders rows left-to-right without re-sorting on render).
    const filtered = existing.filter((k) => k.time !== spec.time);
    const next = [...filtered, key].sort((a, b) => a.time - b.time);

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
