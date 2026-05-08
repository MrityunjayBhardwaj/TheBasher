// addChannel Mutator — creates a new KeyframeChannel<T> wired to an
// existing AnimationLayer.
//
// One channel = one (target, paramPath, valueType) triple. The Mutator
// picks the concrete node type (KeyframeChannelNumber / Vec3 / Quat /
// Color) from spec.valueType. The channel id is deterministic so the LLM
// can reference it from a follow-up keyframe call without an intervening
// dag.inspect round.
//
// Auto-wires Time: the build step finds the project's TimeSource and
// connects it into the channel's `time` socket. If no TimeSource exists,
// preconditions fail — addLayer's prerequisite (P2 already seeds Time).
//
// Closure: rootSelectors = [layerId, timeSourceId]; followedEdges = []
// (both already exist; channel is a fresh add; connects target the layer
// + the channel itself which is fresh).

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

function findTimeSource(state: DagState): NodeId | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'TimeSource') return node.id;
  }
  return null;
}

function shapeOk(valueType: ValueType, value: unknown): boolean {
  switch (valueType) {
    case 'number':
      return typeof value === 'number';
    case 'vec3':
      return Array.isArray(value) && value.length === 3 && value.every((x) => typeof x === 'number');
    case 'quat':
      return Array.isArray(value) && value.length === 4 && value.every((x) => typeof x === 'number');
    case 'color':
      return typeof value === 'string';
  }
}

export const addChannelMutator: MutatorDefinition<AddChannelSpec> = {
  name: 'mutator.timeline.addChannel',
  description:
    'Create a KeyframeChannel<T> driving (target, paramPath) and wire it ' +
    'into the named AnimationLayer\'s animation socket. valueType picks ' +
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
    if (!findTimeSource(state)) {
      return {
        ok: false,
        reason:
          'No TimeSource node in DAG. Default projects seed `n_time`; this project has been mutated to remove it. ' +
          'Add one via `dag.exec` (`addNode` with nodeType "TimeSource") before re-trying.',
      };
    }
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
    const timeSourceId = findTimeSource(state);
    if (!timeSourceId) throw new Error('TimeSource missing — preconditions should have rejected.');

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

    ops.push({
      type: 'connect',
      from: { node: timeSourceId, socket: 'out' },
      to: { node: channelId, socket: 'time' },
    });

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
