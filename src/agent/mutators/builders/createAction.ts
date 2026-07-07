// createAction Mutator — mint a reusable, target-LESS Action (NLA, epic #283 Phase 4).
//
// An Action is a bundle of relative-path keyframe channel specs — a "walk" authored
// once with NO bound target (I-1: the source is immutable; a Strip binds it to a
// concrete object at placement time via mutator.nla.addStrip). This is the agent's
// authoring counterpart of hand-adding an Action node; it is a sibling of
// `addChannel` (which mints a bound channel) — an addNode-emitting, edge-less builder
// (V57: the Action is reached by the resolver scan, never wired).
//
// The `channels` spec reuses `ActionChannelSchema` verbatim (the discriminated union
// on `valueType`) so the Action never drifts from the channel schema (V57/DRY) and
// the placement resolver can feed each spec straight to `build{Type}Sampler`.
//
// Contract (V14): edge-less, requires nothing, loses nothing, preserves ALL 8 aspects
// — the Action is INERT until a Strip places it, so it changes no existing render.
// This all-8-inert tuple is UNIQUE in the registry (nothing else preserves all 8),
// so it needs no invented discriminator (unlike a bare `createTrack`, which would
// collide with it — the H36 trap; track-birth is folded into addStrip instead).
//
// REF: src/nodes/Action.ts (the node + ActionChannelSchema); docs/NLA-DESIGN.md §3.1
//      (Phase 4); vyapti V57/V88 D2; src/agent/mutators/builders/addChannel.ts (the
//      addNode template); src/agent/mutators/builders/shotCreate.ts (nextFreshId).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { ActionChannelSchema } from '../../../nodes/Action';

const CreateActionSpec = z.object({
  /** Display name for the Action. */
  name: z.string().default('Action'),
  /** Deterministic id; auto-minted `nla_action_<n>` when omitted so a follow-up
   *  addStrip can reference it without a dag.inspect round. */
  actionId: z.string().optional(),
  /** The relative-path channel specs (the same shape as a KeyframeChannel*, minus
   *  `target`, plus a `valueType` discriminant). At least one. */
  channels: z.array(ActionChannelSchema).min(1),
});
export type CreateActionSpec = z.infer<typeof CreateActionSpec>;

/** The deterministic Action id for a spec, unless caller-supplied. */
function actionIdFor(spec: CreateActionSpec, used: Set<NodeId>): NodeId {
  return spec.actionId ?? nextFreshId('nla_action', used);
}

export const createActionMutator: MutatorDefinition<CreateActionSpec> = {
  name: 'mutator.nla.createAction',
  description:
    'Mint a reusable, target-LESS Action — a bundle of relative-path keyframe ' +
    'channels ("a walk") authored once, with NO bound object. Place it on the ' +
    'timeline with mutator.nla.addStrip (which binds it to a target in a Track). ' +
    'Each channel is { valueType, paramPath, keyframes:[{time,value,easing}], ... } ' +
    '— the same shape as a KeyframeChannel minus `target`. Returns a deterministic ' +
    'actionId. The Action is immutable once placed (edits live on the Strip).',
  spec: CreateActionSpec,
  specExample: {
    name: 'walk',
    actionId: 'nla_action_1',
    // The minimal author shape the LLM copies: valueType + paramPath + keyframes.
    // ActionChannelSchema fills the inert per-channel defaults (name/weight/mute/
    // blendMode/order/extend*/modifiers) at safeParse; the "specExample parses through
    // its own spec" registration test guarantees this literal is valid at runtime.
    channels: [
      {
        valueType: 'vec3',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [2, 1, 0], easing: 'linear' },
        ],
      },
    ] as unknown as CreateActionSpec['channels'],
  },
  contract: {
    // Edge-less (V57): the Action is a free-floating sidecar, reached by the resolver
    // scan, never wired. Inert until a Strip places it → preserves ALL 8 aspects
    // (changes no existing render). The unique all-8-inert tuple — no discriminator
    // needed (a bare createTrack would collide with it; track-birth folds into addStrip).
    requiredEdges: [],
    requiredNodeTypes: [],
    preserves: [
      'position',
      'rotation',
      'scale',
      'animation',
      'children',
      'material',
      'animation-shape',
      'keyframe-density',
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the (possibly caller-supplied) fresh id. A build-minted fresh id needs
    // no root — gate-3 skips fresh addNodes (isFreshAddNode) — so an omitted actionId
    // yields an empty root set, which is fine.
    return { rootSelectors: spec.actionId ? [spec.actionId] : [], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    // Defense-in-depth vs the spec `.min(1)` (fires only at the safeParse boundary):
    // a validatePlan-direct caller passing an empty channels array would otherwise
    // emit an Action with no channels (a silent no-op strip source).
    if (!Array.isArray(spec.channels) || spec.channels.length === 0) {
      return { ok: false, reason: 'provide at least one channel.' };
    }
    if (spec.actionId && state.nodes[spec.actionId]) {
      return {
        ok: false,
        reason: `actionId "${spec.actionId}" already exists in the DAG.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const actionId = actionIdFor(spec, new Set<NodeId>(Object.keys(state.nodes)));
    // ONE addNode; NO connect (edge-less — reached by the resolver scan, V57).
    return [
      {
        type: 'addNode',
        nodeId: actionId,
        nodeType: 'Action',
        params: { name: spec.name, channels: spec.channels },
      },
    ];
  },
};

/** Next free `${base}_${n}` id — copied from shotCreate.ts (do not couple builders). */
function nextFreshId(base: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
