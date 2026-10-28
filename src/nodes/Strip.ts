// Strip — a non-destructive PLACEMENT of an Action onto the timeline (NLA, epic
// #283 Phase 2).
//
// A Strip references an Action (edge-less id-ref, V57) and binds it to a concrete
// `target` node, carrying the placement edits: retime (start/timeScale/repeat/
// reverse/extrapolate — I-6), blend mode + static influence (I-7), and a mute
// gate. The Action source is never rewritten — all edits live here (I-1).
//
// INERT in Slice A (renders nothing, edge-less `inputs: {}`). The resolver
// enumerates strips by `target` (mirroring the channel scan) and folds them per
// track in Slices C–E. Serializable + registered so `addNode` validates it (V1).
//
// Strips target scene nodes AND cameras. A camera is wired through `scene.camera`, not the
// scene-child walk, so its pose folds its strips in `overlayCameraChannels`
// (cameraChannels.ts) — until #480 it folded none, and push-down had to refuse cameras (#479)
// because the strip it minted drove nothing while the channels it replaced were deleted.
//
// REF: docs/NLA-DESIGN.md §3.3/§6 (Phase 2), §11 (Fork A/B/D); vyapti V57/V88 D2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { StripValue } from './types';
import { CHANNEL_BLEND_MODES, STRIP_EXTRAPOLATES, type StripExtrapolate } from './types';
import { nameParam, optionsParam } from './paramWidget';
import { stripActionOptions, stripTargetOptions } from '../app/stripTargets';

export const StripParams = z.object({
  name: nameParam('Strip'),
  /** Action node id (edge-less ref). Empty → the strip contributes nothing. Picked from the
   *  project's Actions (#1065). The provider is wrapped so this module never reads an
   *  import during load: `stripTargets` reaches the scene walk, which can import back here. */
  action: optionsParam(z.string().default(''), (s) => stripActionOptions(s), undefined, 'nodeId'),
  /** Target node id the placed Action drives (edge-less ref). Picked from the add-strip
   *  popover's own rows (#1065), so the two cannot disagree about what a strip may drive. */
  target: optionsParam(z.string().default(''), (s) => stripTargetOptions(s), undefined, 'nodeId'),
  /** Global start time (seconds) where the Action's t=0 lands. */
  start: z.number().default(0),
  /** Playback rate: >1 = slower (stretches the Action over more time). */
  timeScale: z.number().positive().default(1),
  /** How many times the Action clip repeats within the placement (≥1). */
  repeat: z.number().min(1).default(1),
  reverse: z.boolean().default(false),
  /** Behavior for times outside the placed range. Phase 2 ships 'hold' fully;
   *  'nothing'/'hold-forward' are stored + remapped but reduced to 'hold' at
   *  enumeration in v1 (partial-range absence needs the Phase-3 influence seam). */
  extrapolate: z
    .enum(STRIP_EXTRAPOLATES as unknown as [StripExtrapolate, ...StripExtrapolate[]])
    .default('hold'),
  blendMode: z.enum(CHANNEL_BLEND_MODES).default('replace'),
  /** Static influence ∈ [0,1] (Phase 2). Time-varying ramps/crossfades = Phase 3. */
  influence: z.number().min(0).max(1).default(1),
  /** Lead-in crossfade ramp (seconds). >0 → time-varying influence 0→full over
   *  [start, start+blendIn]. Additive, defaulted 0 → no version bump (#277/#278). */
  blendIn: z.number().min(0).default(0),
  /** Lead-out crossfade ramp (seconds). >0 → full→0 over [end-blendOut, end]. */
  blendOut: z.number().min(0).default(0),
  muted: z.boolean().default(false),
});
export type StripParams = z.infer<typeof StripParams>;

export const StripNode: NodeDefinition<StripParams, StripValue> = {
  type: 'Strip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: StripParams,
  // #421 — `target` is the object this placement drives: the strip belongs to
  // that object's animation stack, so it dies with it. `action` is the OPPOSITE
  // despite looking the same: an Action is a reusable, target-less performance
  // that many strips place (addStrip.ts:40 requires a pre-existing one and never
  // mints it), so treating it as owned would make deleting ONE Action
  // cascade-delete every placement of it across the file. Clearing leaves the
  // strip inert — a state layeredChannels.ts:180 already handles.
  idRefs: [
    { path: 'target', shape: 'id', role: 'subject' },
    { path: 'action', shape: 'id', role: 'argument' },
  ],
  inputs: {},
  outputs: { out: { type: 'Strip', cardinality: 'single' } },
  inspectorSections: ['layout'],
  home: {
    name: 'layout',
  },
  evaluate(params): StripValue {
    return {
      kind: 'Strip',
      name: params.name,
      action: params.action,
      target: params.target,
      start: params.start,
      timeScale: params.timeScale,
      repeat: params.repeat,
      reverse: params.reverse,
      extrapolate: params.extrapolate,
      blendMode: params.blendMode,
      influence: params.influence,
      blendIn: params.blendIn,
      blendOut: params.blendOut,
      muted: params.muted,
    };
  },
};
