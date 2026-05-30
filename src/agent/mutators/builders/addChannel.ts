// addChannel Mutator — creates a new KeyframeChannel<T> wired to an
// existing AnimationLayer.
//
// One channel = one (target, paramPath, valueType) triple. The Mutator
// picks the concrete node type (KeyframeChannelNumber / Vec3 / Quat /
// Color) from spec.valueType. The channel id is deterministic so the LLM
// can reference it from a follow-up keyframe call without an intervening
// dag.inspect round.
//
// P7.12 D-04 — NO Time auto-wire. Pre-7.12 the build step found the project's
// TimeSource and connected it into the channel's `time` socket, and the
// preconditions REJECTED when no TimeSource existed. After D-04 the channel
// nodes have no `time` socket (time enters via the value's sample(seconds)
// closure), so the connect would target a non-existent socket and the
// precondition would needlessly reject a freshly-dropped glTF project. Both
// are removed — mirrors P7.10 Wave B dropping the importer's
// TimeSource→TransformClip connect. A project with no TimeSource is now legal
// for channel creation.
//
// Closure: rootSelectors = [layerId]; followedEdges = ['animation'] — the
// timeSource was never in the closure root here (it was only in the build's
// connect op), so the closure spec is unchanged by D-04.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';

const ValueType = z.enum(['number', 'vec3', 'quat', 'color']);
type ValueType = z.infer<typeof ValueType>;

const InitialKeyframeSchema = z
  .object({
    time: z.number().nonnegative(),
    value: z.unknown(),
    easing: z.enum(['linear', 'cubic']).optional(),
  })
  .optional();

const AddChannelSpec = z.object({
  layerId: z.string().min(1),
  /** The node whose param this channel drives (carried on the channel's value). */
  target: z.string().min(1),
  /** Param path on target — e.g. 'position', 'material.color', 'fov'. */
  paramPath: z.string().min(1),
  valueType: ValueType,
  channelId: z.string().optional(),
  channelName: z.string().optional(),
  initialKeyframe: InitialKeyframeSchema,
});
export type AddChannelSpec = z.infer<typeof AddChannelSpec>;

const NODE_TYPE_BY_VALUE: Record<ValueType, string> = {
  number: 'KeyframeChannelNumber',
  vec3: 'KeyframeChannelVec3',
  quat: 'KeyframeChannelQuat',
  color: 'KeyframeChannelColor',
};

function shapeOk(valueType: ValueType, value: unknown): boolean {
  switch (valueType) {
    case 'number':
      return typeof value === 'number';
    case 'vec3':
      return (
        Array.isArray(value) && value.length === 3 && value.every((x) => typeof x === 'number')
      );
    case 'quat':
      return (
        Array.isArray(value) && value.length === 4 && value.every((x) => typeof x === 'number')
      );
    case 'color':
      return typeof value === 'string';
  }
}

export const addChannelMutator: MutatorDefinition<AddChannelSpec> = {
  name: 'mutator.timeline.addChannel',
  description:
    'Create a KeyframeChannel<T> driving (target, paramPath) and wire it ' +
    "into the named AnimationLayer's animation socket. valueType picks " +
    'the concrete channel node type. Optional initialKeyframe seeds the ' +
    'first sample. Returns deterministic channelId so subsequent ' +
    'mutator.timeline.keyframe calls can reference it directly.',
  spec: AddChannelSpec,
  specExample: {
    layerId: 'cube_layer',
    target: 'cube',
    paramPath: 'position',
    valueType: 'vec3',
    channelId: 'cube_position_channel',
    channelName: 'position',
    initialKeyframe: { time: 0, value: [0, 0, 0], easing: 'cubic' },
  },
  contract: {
    requiredEdges: ['animation'],
    requiredNodeTypes: ['AnimationLayer'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // 'animation' walks layer's existing channels so they sit in scope
    // alongside the layer root — keeps the contract.requiredEdges
    // declaration honest (gate 1 contract_edges) and lets future
    // preconditions diff against existing channels for the same target+path.
    return {
      rootSelectors: [spec.layerId],
      followedEdges: ['animation'],
    };
  },
  preconditions(spec, _closure, state) {
    const layer = state.nodes[spec.layerId];
    if (!layer) return { ok: false, reason: `layerId "${spec.layerId}" not in DAG.` };
    if (layer.type !== 'AnimationLayer') {
      return {
        ok: false,
        reason: `layerId "${spec.layerId}" is ${layer.type}; expected an AnimationLayer.`,
      };
    }
    // P7.12 D-04: no TimeSource precondition — the channel has no `time`
    // socket, so a project without a TimeSource is legal for channel creation.
    if (spec.initialKeyframe && !shapeOk(spec.valueType, spec.initialKeyframe.value)) {
      return {
        ok: false,
        reason: `initialKeyframe.value shape does not match valueType="${spec.valueType}".`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));
    const channelId = spec.channelId ?? defaultChannelId(spec.target, spec.paramPath, usedIds);

    const nodeType = NODE_TYPE_BY_VALUE[spec.valueType];
    const ops: Op[] = [];

    ops.push({
      type: 'addNode',
      nodeId: channelId,
      nodeType,
      params: {
        name: spec.channelName ?? spec.paramPath,
        target: spec.target,
        paramPath: spec.paramPath,
        keyframes: spec.initialKeyframe
          ? [
              {
                time: spec.initialKeyframe.time,
                value: spec.initialKeyframe.value,
                easing: spec.initialKeyframe.easing ?? defaultEasing(spec.valueType),
              },
            ]
          : [],
      },
    });

    // P7.12 D-04: NO `connect TimeSource→channel.time` op — the channel has no
    // `time` socket. Only the channel→layer.animation edge remains.
    ops.push({
      type: 'connect',
      from: { node: channelId, socket: 'out' },
      to: { node: spec.layerId, socket: 'animation' },
    });

    return ops;
  },
};

function defaultChannelId(target: string, paramPath: string, used: Set<NodeId>): NodeId {
  // Sanitize paramPath for id use: '.' / '[' / ']' / '/' → '_'.
  const safe = paramPath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = `${target}_${safe}_channel`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function defaultEasing(valueType: ValueType): 'linear' | 'cubic' {
  // Per project_p3_plan: cubic for vec3/quat/color (spatial / smooth feel),
  // linear for scalar (predictable when scrubbing).
  return valueType === 'number' ? 'linear' : 'cubic';
}
