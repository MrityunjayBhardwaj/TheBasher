// addChannelModifier Mutator — the agent's authoring op for a channel's
// F-MODIFIER STACK (#274–#280, V88 D2). The agent counterpart of the NPanel
// "+ Add <type>" button (ChannelModifierControls): it appends (or inserts) one
// Blender-style F-Modifier — Noise / Cycles / Generator / Limits / Stepped /
// Envelope — onto a KeyframeChannel's `modifiers` array, through the SAME
// `defaultModifier(type)` factory the UI uses. ONE wiring authority, no second
// road: the modifier the agent adds is byte-identical to the one the button
// adds, and every consumer (3D render, read-side, curve editor, camera) picks
// it up via `ch.sample()` (H40).
//
// This exposes the ENTIRE #274–#280 F-Modifier arc to agents — until now the
// stack was reachable only from the UI or raw JSON. Basher is agent-native; a
// procedural-video agent must be able to say "put a noise on this channel".
//
// Closure: rootSelectors = [channelId]; followedEdges = []. Like `keyframe`, the
// setParam targets the channel itself (a root); the channel is a free-floating
// satellite of its target (V57) — no edge to walk.
//
// REF: src/nodes/channelModifiers.ts (defaultModifier, FMODIFIER_TYPES,
//      FModifierSchema — the single authority); src/app/NPanel.tsx
//      (ChannelModifierControls — the UI counterpart); vyapti V88 D2;
//      src/agent/mutators/builders/keyframe.ts (the channel-targeting template).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import {
  defaultModifier,
  FMODIFIER_TYPES,
  FModifierSchema,
  type FChannelModifier,
} from '../../../nodes/channelModifiers';

/** The KeyframeChannel node types that carry a `modifiers` stack (Number/Vec2/Vec3).
 *  Quat/Color/Text/Image channels have no F-Modifier stack (they were left legacy by
 *  the #274 arc) — targeting one is a precondition reject, not a silent no-op. */
const MODIFIER_CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec2',
  'KeyframeChannelVec3',
]);

const AddChannelModifierSpec = z.object({
  /** The KeyframeChannel{Number,Vec2,Vec3} to add the modifier to. */
  channelId: z.string().min(1),
  /** Which F-Modifier to add — the same authoring vocabulary as the UI's Add menu. */
  modifierType: z.enum(FMODIFIER_TYPES),
  /**
   * Optional field overrides, shallow-merged onto `defaultModifier(modifierType)`
   * and re-validated through FModifierSchema. Lets the agent author a tuned
   * modifier in ONE call (e.g. { strength: 3, offset: 10 } on a noise) instead of
   * add-then-setParam. Fields that don't belong to the chosen type are ignored
   * (zod strips them); the merged modifier must still parse (checked in
   * preconditions), so a bad value (e.g. depth: 99) is rejected, not silently clamped.
   */
  overrides: z.record(z.unknown()).optional(),
  /**
   * Insertion index into the existing stack (0 = top/front). Omitted → append to
   * the end. Order matters: modifiers run in array order, each feeding the next.
   */
  index: z.number().int().nonnegative().optional(),
});
export type AddChannelModifierSpec = z.infer<typeof AddChannelModifierSpec>;

/** Merge overrides onto the type's default modifier and validate. `type` is forced
 *  (overrides can't change it) so the discriminated union always resolves. Returns
 *  the parsed modifier, or a zod error message on failure. */
function buildModifier(
  spec: AddChannelModifierSpec,
): { ok: true; modifier: FChannelModifier } | { ok: false; reason: string } {
  const base = defaultModifier(spec.modifierType);
  const merged = { ...base, ...(spec.overrides ?? {}), type: spec.modifierType };
  const parsed = FModifierSchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, reason: `merged modifier failed schema: ${parsed.error.message}` };
  }
  return { ok: true, modifier: parsed.data as FChannelModifier };
}

function existingModifiers(state: DagState, channelId: string): FChannelModifier[] {
  const params = (state.nodes[channelId]?.params ?? {}) as { modifiers?: FChannelModifier[] };
  return Array.isArray(params.modifiers) ? params.modifiers : [];
}

export const addChannelModifierMutator: MutatorDefinition<AddChannelModifierSpec> = {
  name: 'mutator.timeline.addChannelModifier',
  description:
    'Add a Blender-style F-MODIFIER to a KeyframeChannel{Number,Vec2,Vec3} — a ' +
    'procedural operator layered on top of the evaluated curve. modifierType: ' +
    '"noise" (fractal value-noise jitter), "cycles" (repeat/mirror the range ' +
    'before/after), "generator" (add/replace with a polynomial y=c0+c1·t+…), ' +
    '"limits" (clamp value and/or time), "stepped" (stop-motion hold every N ' +
    'seconds), "envelope" (keyed reference-band remap). Seeded with ' +
    "director-friendly defaults (same as the UI's + Add button); pass `overrides` " +
    'to tune fields in one call (e.g. { strength: 3, offset: 10 } for a noise, or ' +
    '{ coefficients: [0, 2] } for a generator). Appends to the stack unless ' +
    '`index` is given. Tune further later with dag.exec setParam on `modifiers`.',
  spec: AddChannelModifierSpec,
  specExample: {
    channelId: 'cube_position_channel',
    modifierType: 'noise',
    overrides: { strength: 3, offset: 10 },
    index: 0,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // The keyframes (times + values + interp) are untouched, and so is the count of
    // samples — only the OUTPUT curve is reshaped by the modifier. Dropping
    // 'animation-shape' is the honest discriminator: the rendered value changes
    // wherever the modifier is active. Distinct vs `keyframe` (preserves all 7) and
    // vs `setKeyframeInterp` (which carries lossy:['prior-interpolation']).
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'keyframe-density'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.channelId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    if (!MODIFIER_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        reason: `channel "${spec.channelId}" is ${channel.type}; F-Modifiers apply only to KeyframeChannel{Number,Vec2,Vec3}.`,
      };
    }
    const built = buildModifier(spec);
    if (!built.ok) return { ok: false, reason: built.reason };
    if (spec.index !== undefined) {
      const len = existingModifiers(state, spec.channelId).length;
      if (spec.index > len) {
        return {
          ok: false,
          reason: `index ${spec.index} out of range (stack has ${len} modifier(s); max insertion index ${len}).`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const built = buildModifier(spec);
    if (!built.ok) {
      throw new Error(
        `addChannelModifier.build: ${built.reason} (preconditions should have caught).`,
      );
    }
    const existing = existingModifiers(state, spec.channelId);
    const at = spec.index ?? existing.length;
    const next = [...existing.slice(0, at), built.modifier, ...existing.slice(at)];
    return [
      {
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'modifiers',
        value: next,
      },
    ];
  },
};
