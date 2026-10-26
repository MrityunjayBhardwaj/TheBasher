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
  declaredKeyChannelType,
  isDiscreteParamAt,
  offeredNodeIds,
} from '../../../nodes/paramWidget';
import {
  KEYFRAME_INTERPS,
  EASE_DIRS,
  KEYFRAME_HANDLE_TYPES,
  type Easing,
  type EaseDir,
  type HandleType,
  type HandledKey,
  type QuatKey,
  quatValueOnCurve,
  splitSegmentForKey,
} from '../../../nodes/keyframeInterp';
import {
  CHANNEL_ADDRESS_DOC,
  CHANNEL_ADDRESS_FIELDS,
  channelRootSelectors,
  resolveChannelAddress,
  superRefineChannelAddress,
} from './channelAddress';

const KeyframeSpec = z
  .object({
    ...CHANNEL_ADDRESS_FIELDS,
    time: z.number().nonnegative(),
    value: z.unknown(),
    // #281 — broadened from the pre-#272 {linear,cubic} to the full per-keyframe
    // interpolation vocabulary (#272/#273), so an agent can author an eased/stepped
    // key at CREATION time (not just linear/cubic). Omitted → the channel's per-type
    // default (byte-identical to pre-#281). `ease`/`handleType` are meaningful only
    // for Number/Vec2/Vec3 channels; on a Quat/Color channel their paramSchema strips
    // the extra fields and rejects an easing it does not take at gate 2 (Quat:
    // linear/cubic/constant; Color: linear/cubic).
    easing: z.enum(KEYFRAME_INTERPS as unknown as [Easing, ...Easing[]]).optional(),
    ease: z.enum(EASE_DIRS as unknown as [EaseDir, ...EaseDir[]]).optional(),
    handleType: z
      .enum(KEYFRAME_HANDLE_TYPES as unknown as [HandleType, ...HandleType[]])
      .optional(),
  })
  .superRefine(superRefineChannelAddress);
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

/** The channels whose keys carry bézier handles — the ones an insert can split (#1165). A
 *  quaternion joined when its keys gained handles (#1157), split per component the way
 *  Blender splits its four rotation F-curves (#1177). */
const HANDLED_CHANNEL_TYPES: ReadonlySet<string> = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec2',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
]);

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
    'Re-keying the same time replaces its value and keeps its handles and interpolation; ' +
    'a key between handled keys keeps the curve. `easing` is the ' +
    "per-key interpolation: 'linear','cubic','constant' (stepped), or a Penner " +
    "curve 'sine'|'quad'|'quart'|'quint'|'expo'|'circ'|'back'|'bounce'|'elastic' " +
    "(these + `ease` 'in'|'out'|'inout' and `handleType` apply to Number/Vec2/Vec3 " +
    'channels; Quat takes only linear|cubic|constant, Color only linear|cubic). Omitting easing takes the ' +
    "interpolation of the segment the key lands in (the channel default for a first or second key). A key on a choice (the active camera, CameraSelect.active) is always stored 'constant' so a cut lands on its key. A camera cut's key holds the camera's node id (a text channel), and must name a camera wired into the switch. Use mutator.timeline.addChannel to create a channel on an " +
    'ordinary node. `time` is on the clock the channel\u2019s target runs on: the playhead for a ' +
    "camera, a cut, Scene.timeSpeed and anything under an Object/Group whose `clock` is 'film' " +
    '(inherited down the parent chain); scene time (slowed by Scene.timeSpeed) for everything ' +
    'else (agent.getStrategy animation). To re-interp keys you already placed, ' +
    'use mutator.timeline.setKeyframeInterp.' +
    CHANNEL_ADDRESS_DOC,
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
      rootSelectors: channelRootSelectors(spec),
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const resolved = resolveChannelAddress(state, spec, { mint: true });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    // The channel's TYPE, read through the mint: on the bone road the node is
    // not in state yet, and the value-shape gate still has to run against the
    // type it is ABOUT to have.
    const view = resolved.view;
    if (!view) {
      return { ok: false, reason: `channel "${resolved.channelId}" could not be resolved.` };
    }
    if (!VALUE_SHAPE_BY_TYPE[view.type]) {
      return {
        ok: false,
        reason: `channel "${resolved.channelId}" is ${view.type}; expected a KeyframeChannel*.`,
      };
    }
    if (!VALUE_SHAPE_BY_TYPE[view.type](spec.value)) {
      return {
        ok: false,
        reason: `value shape does not match channel type "${view.type}".`,
      };
    }
    // #1668 — a key on a choice that names a node (the active camera) holds the node's id in a
    // text channel, and may only name a node the param can pick — one wired into the switch.
    // Anything else would be stored and then silently skipped by the resolver.
    const { target, paramPath } = view.params as { target?: unknown; paramPath?: unknown };
    if (typeof target === 'string' && typeof paramPath === 'string') {
      const targetType = state.nodes[target]?.type;
      const declared = declaredKeyChannelType(targetType, paramPath);
      if (declared && view.type !== declared) {
        return {
          ok: false,
          reason: `${targetType}.${paramPath} names a node; its keys belong in a ${declared} holding that node's id, not a ${view.type}.`,
        };
      }
      const offered = offeredNodeIds(state, target, paramPath);
      if (offered && !offered.includes(spec.value as string)) {
        return {
          ok: false,
          reason: `"${String(spec.value)}" is not one ${targetType}.${paramPath} can pick (it can pick: ${offered.join(', ') || 'nothing yet'}).`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const resolved = resolveChannelAddress(state, spec, { mint: true });
    if (!resolved.ok) throw new Error(resolved.reason);
    const view = resolved.view;
    if (!view) throw new Error(`channel "${resolved.channelId}" could not be resolved.`);
    type Key = {
      time: number;
      value: unknown;
      easing: Easing;
      ease?: EaseDir;
      handleType?: HandleType;
    };
    const params = view.params as { keyframes?: Key[] };
    // The SEEDED keys when this mint just took them from the clip — reading
    // `state` here instead would author onto an empty channel and throw the
    // seed away, which is the difference between editing a motion and
    // replacing it.
    const existing = params.keyframes ?? [];
    const easing = spec.easing ?? DEFAULT_EASING_BY_TYPE[view.type] ?? 'linear';

    // #1165 — keying a value the curve already has must not reshape it (Blender: animrig
    // `fcurve.cc` `insert_bezt_fcurve`).
    //
    // Re-keying a time replaces its VALUE and keeps the rest of the key: its handles (stored as
    // offsets, so they ride with the value exactly as `replace_bezt_keyframe_ypos` shifts them
    // by dy), and its interpolation unless this call names one — Auto-Key names none, and
    // resetting a linear key to the channel default reshaped both segments beside it.
    const at = existing.findIndex((k) => k.time === spec.time);
    let next: Key[];
    if (at >= 0) {
      const kept: Key = { ...existing[at], value: spec.value };
      if (spec.easing !== undefined) kept.easing = spec.easing;
      if (spec.ease !== undefined) kept.ease = spec.ease;
      if (spec.handleType !== undefined) kept.handleType = spec.handleType;
      next = existing.map((k, i) => (i === at ? kept : k));
    } else {
      // A new sample. `ease`/`handleType` are added ONLY when provided so a legacy call
      // (linear/cubic, no ease/handle) stays byte-identical to pre-#281.
      const key: Key = { time: spec.time, value: spec.value, easing };
      if (spec.ease !== undefined) key.ease = spec.ease;
      if (spec.handleType !== undefined) key.handleType = spec.handleType;
      // Sorted by time so the channel's evaluator can rely on monotonic input (and so the
      // dopesheet renders rows left-to-right without re-sorting on render).
      next = [...existing, key].sort((a, b) => a.time - b.time);
      const i = next.indexOf(key);
      // #1170 — a new key on a curve that already has two keys takes the interpolation of the
      // segment it lands in unless this call names one, as Blender's takes its neighbour's
      // (animrig `fcurve.cc` `insert_vert_fcurve`: the key before, or after when it is first).
      // A segment's interpolation here is its ARRIVING key's, so that is the key after; past the
      // last key, the last. The channel default is for a curve with no shape to keep yet.
      if (spec.easing === undefined && existing.length >= 2) {
        const from = next[i + 1] ?? next[i - 1];
        key.easing = from.easing;
        if (spec.ease === undefined && from.ease !== undefined) key.ease = from.ease;
      }
      // Landing between two keys whose handles are stored, the segment is split so the curve
      // keeps its shape (`subdivide_nonauto_handles`).
      if (HANDLED_CHANNEL_TYPES.has(view.type) && i > 0 && i < next.length - 1) {
        const prev = next[i - 1] as HandledKey;
        const after = next[i + 1] as HandledKey;
        // #1177 — a quaternion arrives as the UNIT rotation the channel samples, but the split cuts
        // the curve at its raw, un-normalized point. Put the rotation back on the curve's ray first
        // so keying the rotation a curve already has stores that raw point, as Blender's I key does.
        if (view.type === 'KeyframeChannelQuat') {
          (key as { value: unknown }).value = quatValueOnCurve(
            prev as QuatKey,
            after as QuatKey,
            key.value as QuatKey['value'],
            key.time,
          );
        }
        const split = splitSegmentForKey(prev, after, key as HandledKey);
        if (split) next.splice(i - 1, 3, split.a as Key, split.key as Key, split.b as Key);
      }
    }

    // #1663 — a key on a choice (the active camera) is stored stepped whatever this call or a
    // neighbour asked for, as Blender's `initialize_bezt` forces CONSTANT on a discrete curve, so
    // the curve the editor draws is the one that plays. Re-keying an existing time is covered too.
    const { target, paramPath } = view.params as { target?: unknown; paramPath?: unknown };
    const targetType = typeof target === 'string' ? state.nodes[target]?.type : undefined;
    if (isDiscreteParamAt(targetType, typeof paramPath === 'string' ? paramPath : '')) {
      next = next.map((k) => {
        if (k.time !== spec.time) return k;
        const held: Key = { ...k, easing: 'constant' };
        delete held.ease; // a direction means nothing on a step
        return held;
      });
    }

    return resolved.write({ keyframes: next });
  },
};
