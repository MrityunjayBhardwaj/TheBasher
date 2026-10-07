// setPoseMemberMode — change the rotation mode of one member of a pose layer (#1242, decision D-E of
// "Bones as Channels").
//
// A member's rotation is keyed in its mode: three euler curves in an order, or a quaternion curve.
// Changing the mode is an explicit act with two choices, because the keys cannot mean the same thing
// between keys in two modes:
//
//   convert   keep the keys' TIMES; each key becomes the same rotation written in the new mode. Exact
//             at every key; between keys the curve follows the new mode's interpolation.
//   resample  key every frame across the old curve first, then write those. Exact at every frame;
//             dense.
//
// Euler keys written from rotations pass through the order-aware continuity filter
// (`continuousEulerIn`), so a curve does not jump a whole turn between two keys a degree apart. Extend
// and Cycles carry across by their TIME rule, the only half that reaches a rotation. The curves of the
// old mode are replaced, not left beside the new ones: Blender keeps a mode's unused curves, but a
// layer here finds a channel by bone and component, and a stale curve there would be a second answer.
//
// Reference: Blender's pose bone rotation mode decides which curves apply (`armature.cc`); Maya's
// rotation interpolation change converts or resamples keys (`animated-rotation.txt`).
//
// REF: src/nodes/PoseLayer.ts (`memberRotationSampler`, the one reader); src/nodes/bonePose.ts
//      (`eulerFromQuat`, `continuousEulerIn`); issue #1242.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import {
  POSE_ROTATION_MODES,
  memberRotationSampler,
  type PoseLayerChannel,
  type PoseLayerMember,
  type PoseRotationMode,
} from '../../../nodes/PoseLayer';
import { continuousEulerIn, eulerFromQuat, type EulerOrder } from '../../../nodes/bonePose';
import { resolveExtend, type ChannelExtend } from '../../../nodes/keyframeInterp';
import { defaultModifier, type FChannelModifier } from '../../../nodes/channelModifiers';
import type { Quat, Vec3 } from '../../../nodes/types';

const DEG = 180 / Math.PI;

const SetPoseMemberModeSpec = z.object({
  /** The `PoseLayer` holding the member. */
  layer: z.string().min(1),
  /** The member's bone, in the skeleton's spelling. */
  bone: z.string().min(1),
  rotationMode: z.enum(POSE_ROTATION_MODES),
  /** Euler modes only: read the curve per axis, or as quaternions between keys. */
  eulerInterp: z.enum(['axis', 'quaternion']).optional(),
  method: z.enum(['convert', 'resample']).default('convert'),
  /** Frames per second for `resample`. */
  fps: z.number().positive().default(24),
});
export type SetPoseMemberModeSpec = z.infer<typeof SetPoseMemberModeSpec>;

type Params = { members?: PoseLayerMember[]; channels?: PoseLayerChannel[] };

function paramsOf(state: DagState, layer: string): Params {
  return (state.nodes[layer]?.params ?? {}) as Params;
}

/** The rotation curve a member keys in its mode, or undefined. */
function rotationChannelOf(member: PoseLayerMember, channels: readonly PoseLayerChannel[]) {
  const component = member.rotationMode === 'quaternion' ? 'quaternion' : 'rotation';
  return channels.find((c) => c.component === component && c.bone === member.bone);
}

/** The rule a key curve's ends follow, reduced to what a rotation honours: hold, cycle, mirror. */
function rotationEnds(channel: PoseLayerChannel | undefined): {
  before: 'hold' | 'cycle' | 'mirror';
  after: 'hold' | 'cycle' | 'mirror';
} {
  const reduce = (r: ChannelExtend | undefined) =>
    r === 'cycle' || r === 'cycle-offset' ? 'cycle' : r === 'mirror' ? 'mirror' : 'hold';
  if (!channel) return { before: 'hold', after: 'hold' };
  if (channel.component === 'quaternion') {
    return { before: reduce(channel.extendBefore), after: reduce(channel.extendAfter) };
  }
  const v = channel as Extract<PoseLayerChannel, { component: 'rotation' }>;
  const { before, after } = resolveExtend(v.extendBefore, v.extendAfter, v.modifiers);
  return { before: reduce(before), after: reduce(after) };
}

/** Those ends as an euler curve spells them: a Cycles modifier. */
function cyclesFor(ends: ReturnType<typeof rotationEnds>): FChannelModifier[] {
  if (ends.before === 'hold' && ends.after === 'hold') return [];
  const mode = (r: 'hold' | 'cycle' | 'mirror') =>
    r === 'cycle' ? 'repeat' : r === 'mirror' ? 'repeat-mirror' : 'none';
  return [
    { ...defaultModifier('cycles'), beforeMode: mode(ends.before), afterMode: mode(ends.after) },
  ] as FChannelModifier[];
}

export const setPoseMemberModeMutator: MutatorDefinition<SetPoseMemberModeSpec> = {
  name: 'mutator.animate.setPoseMemberMode',
  description:
    "Set a pose-layer bone's rotation mode, keeping its pose. " +
    // Back-ticked, so the first sentence ends above: a lower-case word after its period is not a
    // boundary to `firstSentence`, and the picker's summary became this whole description (#1575).
    "`rotationMode` is an euler order as Blender names it (XYZ … ZYX) or 'quaternion'; eulerInterp " +
    "'quaternion' slerps an euler curve between keys. method 'convert' keeps the key times (exact " +
    "at keys), 'resample' keys every frame at fps (exact everywhere).",
  spec: SetPoseMemberModeSpec,
  specExample: {
    layer: 'node_id',
    bone: 'Bone1',
    rotationMode: 'ZYX',
    method: 'convert',
    fps: 24,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['PoseLayer'],
    preserves: ['position', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.layer], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const node = state.nodes[spec.layer];
    if (!node) return { ok: false, reason: `layer "${spec.layer}" not in DAG.` };
    if (node.type !== 'PoseLayer') {
      return { ok: false, reason: `"${spec.layer}" is a ${node.type}; expected a PoseLayer.` };
    }
    const members = paramsOf(state, spec.layer).members ?? [];
    if (!members.some((m) => m.bone === spec.bone)) {
      return {
        ok: false,
        reason: `bone "${spec.bone}" is not a member of this layer. Its members are: ${
          members.map((m) => m.bone).join(', ') || '(none)'
        }.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const { members = [], channels = [] } = paramsOf(state, spec.layer);
    const at = members.findIndex((m) => m.bone === spec.bone);
    const member = members[at];
    const target: PoseRotationMode = spec.rotationMode;
    const interp = target === 'quaternion' ? undefined : spec.eulerInterp;

    const rotationAt = memberRotationSampler(member, channels);
    const oldCurve = rotationChannelOf(member, channels);

    const nextMember: PoseLayerMember = { ...member, rotationMode: target };
    delete (nextMember as { rotation?: unknown }).rotation;
    delete (nextMember as { quaternion?: unknown }).quaternion;
    delete (nextMember as { eulerInterp?: unknown }).eulerInterp;
    if (interp !== undefined) nextMember.eulerInterp = interp;

    // One rotation, written in the target mode; euler kept continuous with the previous key.
    let prev: Vec3 | null = null;
    const written = (q: Quat): Quat | Vec3 => {
      if (target === 'quaternion') return q;
      const e = continuousEulerIn(
        eulerFromQuat(q, target as EulerOrder),
        prev,
        target as EulerOrder,
      );
      prev = e;
      return [e[0] * DEG, e[1] * DEG, e[2] * DEG];
    };

    let nextChannels = channels.filter(
      (c) =>
        !(c.bone === spec.bone && (c.component === 'rotation' || c.component === 'quaternion')),
    );

    if (oldCurve && rotationAt) {
      const sorted = [...oldCurve.keyframes].sort((a, b) => a.time - b.time);
      const times: number[] = [];
      if (spec.method === 'convert') {
        for (const k of sorted) times.push(k.time);
      } else {
        const first = sorted[0].time;
        const last = sorted[sorted.length - 1].time;
        const step = 1 / spec.fps;
        for (let i = 0; first + i * step < last - 1e-9; i++) times.push(first + i * step);
        times.push(last);
      }
      const easingAt = (t: number): 'linear' | 'cubic' | 'constant' => {
        if (spec.method === 'resample') return 'linear';
        const e = sorted.find((k) => k.time === t)?.easing;
        return e === 'linear' || e === 'constant' ? e : 'cubic';
      };
      const ends = rotationEnds(oldCurve);
      const keyframes = times.map((t) => ({
        time: t,
        value: written(rotationAt(t)),
        easing: easingAt(t),
      }));
      const curve =
        target === 'quaternion'
          ? {
              bone: spec.bone,
              component: 'quaternion' as const,
              keyframes,
              ...(ends.before !== 'hold' ? { extendBefore: ends.before } : {}),
              ...(ends.after !== 'hold' ? { extendAfter: ends.after } : {}),
              // #1215 — a muted curve stays muted in its new mode.
              ...(oldCurve.mute === true ? { mute: true } : {}),
            }
          : {
              bone: spec.bone,
              component: 'rotation' as const,
              keyframes,
              modifiers: cyclesFor(ends),
              ...(oldCurve.mute === true ? { mute: true } : {}),
            };
      nextChannels = [...nextChannels, curve as unknown as PoseLayerChannel];
    } else if (rotationAt) {
      // Static only: the one rotation, written in the new mode.
      const v = written(rotationAt(0));
      if (target === 'quaternion') nextMember.quaternion = v as Quat as never;
      else nextMember.rotation = v as Vec3 as never;
    }

    const nextMembers = members.slice();
    nextMembers[at] = nextMember;
    return [
      { type: 'setParam', nodeId: spec.layer, paramPath: 'members', value: nextMembers },
      { type: 'setParam', nodeId: spec.layer, paramPath: 'channels', value: nextChannels },
    ];
  },
};
