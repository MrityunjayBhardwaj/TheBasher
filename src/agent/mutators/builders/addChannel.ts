// addChannel Mutator — creates a FREE-FLOATING KeyframeChannel<T> driving a node.
//
// v0.7 #199 / V57: a channel is free-floating — it carries `params.target` (the
// animated node's dagId) + `params.paramPath` and is overlaid by the ONE
// `overlayChannels` primitive that BOTH the renderer (DirectChannelsR) and the
// read-side (resolveEvaluatedTransform) consume. There is NO AnimationLayer
// wrapper and NO `animation` input socket to wire into — this is the agent's
// authoring counterpart of the UI's `dispatchDirectFirstKey`, and a sibling of
// `bakeGltfChannel` (which already mints free-floating channels for glTF bones).
//
// One channel = one (target, paramPath, valueType) triple; valueType picks the
// concrete node type (KeyframeChannelNumber / Vec3 / Quat / Color). The channel
// id is deterministic — `${spec.target}_${safePath(paramPath)}_channel`, matching
// dispatchDirectFirstKey — so the LLM (and the inspector diamond) can reference
// it from a follow-up `mutator.timeline.keyframe` call without a dag.inspect
// round. The channel reaches its target purely by the resolver's target scan; it
// is an edge-less satellite (no connect op, no closure membership beyond itself).
//
// #450: `params.target` is the node that OWNS the param, resolved through the
// object↔data split (a data param lives on the linked data node, not the Object
// the caller named). The id stays keyed to `spec.target`, so for a split object's
// data param the id and the target differ — harmless, because every lookup is a
// (target, paramPath) scan, never an id compare. See build() for the full why.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { resolveExposedTarget } from '../../../app/exposeParams';

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
  /** The node whose param this channel drives (carried on the channel's value). */
  target: z.string().min(1),
  /** Param path on target — e.g. 'position', 'material.base.color', 'fov'. */
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

/** Sanitize a paramPath for id use EXACTLY as dispatchDirectFirstKey does
 *  (`[^a-zA-Z0-9_-]` → `_`), so the agent + UI mint the SAME channel id. */
function safePath(paramPath: string): string {
  return paramPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The deterministic channel id for a (target, paramPath), unless caller-supplied. */
function channelIdFor(spec: AddChannelSpec): NodeId {
  return spec.channelId ?? `${spec.target}_${safePath(spec.paramPath)}_channel`;
}

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

function defaultEasing(valueType: ValueType): 'linear' | 'cubic' {
  // Per project_p3_plan: cubic for vec3/quat/color (spatial / smooth feel),
  // linear for scalar (predictable when scrubbing).
  return valueType === 'number' ? 'linear' : 'cubic';
}

export const addChannelMutator: MutatorDefinition<AddChannelSpec> = {
  name: 'mutator.timeline.addChannel',
  description:
    'Create a FREE-FLOATING KeyframeChannel<T> driving (target, paramPath) — no ' +
    'AnimationLayer wrapper (V57). valueType picks the concrete channel node ' +
    'type. Optional initialKeyframe seeds the first sample. Returns a ' +
    'deterministic channelId so subsequent mutator.timeline.keyframe calls can ' +
    'reference it directly.',
  spec: AddChannelSpec,
  specExample: {
    target: 'cube',
    paramPath: 'position',
    valueType: 'vec3',
    channelId: 'cube_position_channel',
    channelName: 'position',
    initialKeyframe: { time: 0, value: [0, 0, 0], easing: 'cubic' },
  },
  contract: {
    // The channel is edge-less (no `animation` socket) — it reaches its target by
    // the resolver's target scan, not a wire. The target's bands are untouched.
    requiredEdges: [],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the fresh channel id (a gate-3 isFreshAddNode). No edges: the
    // channel is a free-floating satellite of `target`, reached by the resolver.
    return { rootSelectors: [channelIdFor(spec)], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    if (!state.nodes[spec.target]) {
      return { ok: false, reason: `target "${spec.target}" not in DAG.` };
    }
    const channelId = channelIdFor(spec);
    if (state.nodes[channelId]) {
      return {
        ok: false,
        reason: `channel "${channelId}" already exists (use mutator.timeline.keyframe to add samples).`,
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
    const channelId = channelIdFor(spec);
    const nodeType = NODE_TYPE_BY_VALUE[spec.valueType];
    // The channel's `target` must be the node that actually OWNS the param, not
    // whatever the caller named. On a split object a data param (material/size)
    // lives on the linked data node, and the render overlay only collects
    // channels whose target is that data node (SceneFromDAG useDataParamChannels);
    // a channel left targeting the Object animates in the inspector read but
    // never paints. A transform param (position) resolves to the Object itself,
    // unchanged.
    //
    // #519 — AND THE ANSWER IS PER FIELD, NOT PER PARAM ROOT. Resolving the root
    // was sound while every superseding layer was wholesale. A material override
    // operator authors a SPARSE per-field set, so with one forcing `color` in the
    // lane the authority for `material.base.color` is the operator while the
    // authority for `material.specular.roughness` is still the layer underneath;
    // one answer for the whole `material` root cannot express that, and the one it
    // gave was the masked layer. Measured before the fix: the mutator reported
    // success, the channel was created, the dopesheet drew the curve, and the
    // composed material kept taking that field from the operator above.
    //
    // The PATH travels with the id, because the two layers spell the same field
    // differently: an IR node stores `material.base.color`, an override operator
    // the flat `color`. A resolved target with the caller's path would name a param
    // the operator does not have.
    //
    // The channel *id* stays keyed to spec.target (channelIdFor) so it matches
    // buildClosureSpec, which has no state to resolve the owner; harmless because
    // every channel lookup is a (target, paramPath) scan, never an id compare.
    const owner = resolveExposedTarget(state, spec.target, spec.paramPath);
    const target = owner?.nodeId ?? spec.target;
    const paramPath = owner?.paramPath ?? spec.paramPath;
    // ONE addNode op; NO connect (the channel is free-floating — reached by the
    // resolver's `params.target` scan, V57).
    return [
      {
        type: 'addNode',
        nodeId: channelId,
        nodeType,
        params: {
          name: spec.channelName ?? spec.paramPath,
          target,
          paramPath,
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
      },
    ];
  },
};
