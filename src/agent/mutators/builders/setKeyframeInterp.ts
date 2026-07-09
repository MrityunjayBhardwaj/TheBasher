// setKeyframeInterp Mutator — the agent's authoring op for per-keyframe
// INTERPOLATION MODE (#272), EASE DIRECTION (#272), and HANDLE TYPE (#273) on
// EXISTING keyframes of a KeyframeChannel{Number,Vec2,Vec3}. The agent
// counterpart of the curve editor's interp/ease/handle pickers
// (curve-interp-select / curve-ease-select / curve-handle-select), but scoped
// to a chosen key ({time}) or the whole channel ('all') in one call.
//
// Blender analogs: "Set Interpolation Type" (T), "Set Easing Type" (Ctrl-E),
// "Set Handle Type" (V) — all operate on the SELECTED keys, changing HOW the
// curve moves without touching the keys' times or values.
//
// Unlike `keyframe` (which appends/replaces a sample and REQUIRES a value), this
// mutates only the interpolation fields of keys that already exist. It rewrites
// the `keyframes` array (the single value-typed param) preserving every key's
// time + value; only the provided interp fields change.
//
// Closure: rootSelectors = [channelId]; followedEdges = []. The setParam targets
// the channel itself (a root); a free-floating satellite of its target (V57).
//
// REF: src/nodes/keyframeInterp.ts (KEYFRAME_INTERPS / EASE_DIRS /
//      KEYFRAME_HANDLE_TYPES — the single authorities); src/timeline/
//      EditableCurve.tsx (the UI pickers); vyapti V88 D1; H40.

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

/** The KeyframeChannel node types that carry the broadened per-keyframe interp /
 *  ease / handle vocabulary (Number/Vec2/Vec3, from #272/#273). Quat/Color keep the
 *  legacy linear|cubic easing and no handles → targeting one is a reject, not a
 *  gate-2 surprise (their paramSchema would refuse 'back'/'auto'). */
const INTERP_CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec2',
  'KeyframeChannelVec3',
]);

const KeyframeScope = z.union([z.literal('all'), z.object({ time: z.number() })]);

const SetKeyframeInterpSpec = z
  .object({
    /** The KeyframeChannel{Number,Vec2,Vec3} whose keyframes to re-interp. */
    channelId: z.string().min(1),
    /** Which keyframes: 'all' (every key) or { time } (the key AT that exact time). */
    scope: KeyframeScope.optional().default('all'),
    /** Interpolation mode — how the curve ARRIVES at each targeted key. */
    easing: z.enum(KEYFRAME_INTERPS as unknown as [Easing, ...Easing[]]).optional(),
    /** Ease direction for the equation interps (sine…elastic); ignored by linear/cubic/constant. */
    ease: z.enum(EASE_DIRS as unknown as [EaseDir, ...EaseDir[]]).optional(),
    /** Bézier handle type (auto/auto-clamped/vector/aligned/free) for linear/cubic keys. */
    handleType: z
      .enum(KEYFRAME_HANDLE_TYPES as unknown as [HandleType, ...HandleType[]])
      .optional(),
  })
  .refine((s) => s.easing !== undefined || s.ease !== undefined || s.handleType !== undefined, {
    message: 'provide at least one of `easing` / `ease` / `handleType`.',
  });
export type SetKeyframeInterpSpec = z.infer<typeof SetKeyframeInterpSpec>;

interface RawKey {
  time: number;
  value: unknown;
  easing?: Easing;
  ease?: EaseDir;
  handleType?: HandleType;
  [k: string]: unknown;
}

function channelKeyframes(state: DagState, channelId: string): RawKey[] {
  const params = (state.nodes[channelId]?.params ?? {}) as { keyframes?: RawKey[] };
  return Array.isArray(params.keyframes) ? params.keyframes : [];
}

/** Normalize scope to 'all' when absent. The zod `.default('all')` only applies at
 *  the safeParse boundary; a validatePlan caller passing a raw spec leaves scope
 *  undefined, so resolve it here (and in preconditions) rather than trust the default. */
function resolveScope(spec: SetKeyframeInterpSpec): 'all' | { time: number } {
  return spec.scope ?? 'all';
}

function matches(scope: 'all' | { time: number }, key: RawKey): boolean {
  return scope === 'all' || key.time === scope.time;
}

export const setKeyframeInterpMutator: MutatorDefinition<SetKeyframeInterpSpec> = {
  name: 'mutator.timeline.setKeyframeInterp',
  description:
    'Set the INTERPOLATION of existing keyframes on a KeyframeChannel' +
    "{Number,Vec2,Vec3} (Blender's Set Interpolation / Easing / Handle Type). " +
    "`easing` = the interpolation mode ('linear','cubic','constant' (stepped), or " +
    "a Penner curve 'sine'|'quad'|'quart'|'quint'|'expo'|'circ'|'back'|'bounce'|" +
    "'elastic'); `ease` = the direction 'in'|'out'|'inout' for the Penner curves; " +
    "`handleType` = the bézier handle 'auto'|'auto-clamped'|'vector'|'aligned'|" +
    "'free' for linear/cubic keys. `scope` = 'all' (every key, the default) or " +
    '{ time } (the key at that exact time). Only the provided fields change; each ' +
    "key's time and value are preserved.",
  spec: SetKeyframeInterpSpec,
  specExample: {
    channelId: 'cube_position_channel',
    scope: 'all',
    easing: 'back',
    ease: 'out',
    handleType: 'auto',
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Times + values + the count of samples are untouched — only HOW the curve moves
    // between keys changes. Dropping 'animation-shape' is the honest discriminator:
    // the in-between curve is reshaped. Distinct vs `keyframe` (preserves all 7) and
    // vs `addChannelModifier` (also drops animation-shape but carries no lossy) via
    // the lossy:['prior-interpolation'] note.
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'keyframe-density'],
    lossy: [
      {
        kind: 'prior-interpolation',
        reason:
          "overwrites each targeted keyframe's interpolation / ease / handle type; the prior in-between curve shape no longer renders.",
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.channelId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    if (!INTERP_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        reason: `channel "${spec.channelId}" is ${channel.type}; per-keyframe interpolation/handles apply only to KeyframeChannel{Number,Vec2,Vec3}.`,
      };
    }
    // Defense-in-depth vs the spec `.refine()` (only fires at safeParse): an
    // already-parsed spec with no fields would emit an unchanged-array setParam.
    if (spec.easing === undefined && spec.ease === undefined && spec.handleType === undefined) {
      return { ok: false, reason: 'provide at least one of `easing` / `ease` / `handleType`.' };
    }
    const keys = channelKeyframes(state, spec.channelId);
    if (keys.length === 0) {
      return { ok: false, reason: `channel "${spec.channelId}" has no keyframes.` };
    }
    const scope = resolveScope(spec);
    if (scope !== 'all' && !keys.some((k) => k.time === scope.time)) {
      return {
        ok: false,
        reason: `no keyframe at time ${scope.time} on "${spec.channelId}".`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const keys = channelKeyframes(state, spec.channelId);
    const scope = resolveScope(spec);
    const next = keys.map((k) => {
      if (!matches(scope, k)) return k;
      const updated: RawKey = { ...k };
      if (spec.easing !== undefined) updated.easing = spec.easing;
      if (spec.ease !== undefined) updated.ease = spec.ease;
      if (spec.handleType !== undefined) updated.handleType = spec.handleType;
      return updated;
    });
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
