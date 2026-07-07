// addStrip Mutator — place an Action onto the timeline (NLA, epic #283 Phase 4).
//
// Creates a Strip binding an Action to a concrete `target` object, and lands the
// Strip in a Track (auto-creating the Track when `trackId` is omitted — a director
// never wants a bare empty track, so track-birth folds in here rather than a
// standalone `mutator.nla.createTrack`). A Strip is INVISIBLE until it is referenced
// by a Track's `strips` array (the resolver only enumerates strips via tracks —
// layeredChannels.ts), so addStrip ALWAYS appends the strip to a track: render==read
// is unobservable otherwise.
//
// Emits (edge-less, V57 — no connect):
//   addNode(Strip)                              — the placement
//   [addNode(Track, {strips:[]})] if new        — the auto-created track (BEFORE the
//                                                 setParam, so the fresh track is in
//                                                 introducedIds for gate-3)
//   setParam(Track,'strips', [...prev, stripId]) — append (whole-array replace; the
//                                                 Track node is the single owner)
//
// Contract (V14): `requiredNodeTypes:['Action']` is the HONEST distinctness carrier —
// addStrip genuinely cannot bind without an Action, and NO existing mutator requires
// an Action, so the tuple is unique. (Its preserves-7 set — it drops `animation`
// because it introduces an animated placement on the target — is byte-identical to
// `mutator.timeline.keyframe`'s, so the preserves set alone does NOT distinguish it;
// dropping `animation` is honest disclosure, `['Action']` is the discriminator. Do
// NOT "fix" a collision by inventing a lossy token — the H36 trap.)
//
// REF: src/nodes/{Strip,Track,Action}.ts; src/app/layeredChannels.ts (the enumeration
//      dependency — strip invisible without a track); docs/NLA-DESIGN.md §3.3 (Phase 4);
//      vyapti V14/V57/V88 D2; src/agent/mutators/builders/{addChannel,shotCreate}.ts.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { CHANNEL_BLEND_MODES } from '../../../nodes/types';

const AddStripSpec = z.object({
  /** Action node id to place (edge-less ref). Must be an existing Action. */
  action: z.string().min(1),
  /** Target node id the placed Action drives (edge-less ref). Must exist. */
  target: z.string().min(1),
  /** Track to append the strip to. Omitted → a fresh Track is auto-created. */
  trackId: z.string().optional(),
  /** Deterministic strip id; auto-minted `nla_strip_<n>` when omitted. */
  stripId: z.string().optional(),
  name: z.string().default('Strip'),
  // Optional placement / blend — omitted fields fall through to Strip.paramSchema's
  // defaults at applyOp (partial addNode params are parsed there).
  start: z.number().optional(),
  timeScale: z.number().positive().optional(),
  repeat: z.number().min(1).optional(),
  reverse: z.boolean().optional(),
  blendMode: z.enum(CHANNEL_BLEND_MODES).optional(),
  influence: z.number().min(0).max(1).optional(),
  blendIn: z.number().min(0).optional(),
  blendOut: z.number().min(0).optional(),
});
export type AddStripSpec = z.infer<typeof AddStripSpec>;

export const addStripMutator: MutatorDefinition<AddStripSpec> = {
  name: 'mutator.nla.addStrip',
  description:
    'Place an Action onto the timeline: create a Strip binding the Action to a ' +
    'target object, and land it in a Track (auto-creating the Track when trackId is ' +
    'omitted). Optional placement (start seconds / timeScale>1 slower / repeat / ' +
    'reverse) and blend (blendMode replace|combine, influence 0..1, blendIn/blendOut ' +
    'crossfade ramp seconds). The Action source is never rewritten — all edits live ' +
    'on the Strip (mutator.nla.setStripTiming / setStripBlend). Returns stripId + trackId.',
  spec: AddStripSpec,
  specExample: {
    name: 'Strip',
    action: 'nla_action_1',
    target: 'box',
    stripId: 'nla_strip_1',
    start: 0,
  },
  contract: {
    // ['Action'] is the honest V14 discriminator (see file header). Edge-less (V57).
    // Drops 'animation' from preserves — it introduces an animated placement on the
    // target (honest disclosure; the same reason addChannel drops it).
    requiredEdges: [],
    requiredNodeTypes: ['Action'],
    preserves: [
      'position',
      'rotation',
      'scale',
      'children',
      'material',
      'animation-shape',
      'keyframe-density',
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root `spec.action` so gate-4 contract_scope finds the required Action in the
    // closure. Root an EXISTING trackId so the setParam(Track,'strips') stays in
    // closure. The fresh stripId + any auto-created trackId auto-mint (gate-3 skips
    // fresh addNodes — isFreshAddNode).
    return {
      rootSelectors: [spec.action, ...(spec.trackId ? [spec.trackId] : [])],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const action = state.nodes[spec.action];
    if (!action) return { ok: false, reason: `action "${spec.action}" not in DAG.` };
    if (action.type !== 'Action') {
      return {
        ok: false,
        reason: `action "${spec.action}" is ${action.type}; expected an Action node.`,
      };
    }
    if (!state.nodes[spec.target]) {
      return { ok: false, reason: `target "${spec.target}" not in DAG.` };
    }
    const resolvedStripId =
      spec.stripId ?? nextFreshId('nla_strip', new Set(Object.keys(state.nodes)));
    if (state.nodes[resolvedStripId]) {
      return { ok: false, reason: `stripId "${resolvedStripId}" already exists in the DAG.` };
    }
    // An explicitly-supplied trackId that already exists must be a Track (else the
    // strips setParam targets the wrong node type).
    if (spec.trackId && state.nodes[spec.trackId] && state.nodes[spec.trackId].type !== 'Track') {
      return {
        ok: false,
        reason: `trackId "${spec.trackId}" is ${state.nodes[spec.trackId].type}; expected a Track node.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const used = new Set<NodeId>(Object.keys(state.nodes));
    const stripId = spec.stripId ?? nextFreshId('nla_strip', used);
    used.add(stripId);
    const trackExists = !!(spec.trackId && state.nodes[spec.trackId]?.type === 'Track');
    const trackId = spec.trackId ?? nextFreshId('nla_track', used);

    // Partial params — omitted fields default via Strip.paramSchema at applyOp.
    const stripParams: Record<string, unknown> = {
      name: spec.name,
      action: spec.action,
      target: spec.target,
    };
    if (spec.start !== undefined) stripParams.start = spec.start;
    if (spec.timeScale !== undefined) stripParams.timeScale = spec.timeScale;
    if (spec.repeat !== undefined) stripParams.repeat = spec.repeat;
    if (spec.reverse !== undefined) stripParams.reverse = spec.reverse;
    if (spec.blendMode !== undefined) stripParams.blendMode = spec.blendMode;
    if (spec.influence !== undefined) stripParams.influence = spec.influence;
    if (spec.blendIn !== undefined) stripParams.blendIn = spec.blendIn;
    if (spec.blendOut !== undefined) stripParams.blendOut = spec.blendOut;

    const ops: Op[] = [
      { type: 'addNode', nodeId: stripId, nodeType: 'Strip', params: stripParams },
    ];
    // Auto-create the track BEFORE the setParam so the fresh track is in introducedIds.
    if (!trackExists) {
      ops.push({ type: 'addNode', nodeId: trackId, nodeType: 'Track', params: { strips: [] } });
    }
    const prevStrips =
      (state.nodes[trackId]?.params as { strips?: string[] } | undefined)?.strips ?? [];
    // Whole-array replace (Track.strips is one value-typed param); the Track is the
    // single owner of its strip order (read-current-then-append).
    ops.push({
      type: 'setParam',
      nodeId: trackId,
      paramPath: 'strips',
      value: [...prevStrips, stripId],
    });
    return ops;
  },
};

/** Next free `${base}_${n}` id — copied from shotCreate.ts (do not couple builders). */
function nextFreshId(base: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
