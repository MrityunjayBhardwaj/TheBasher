// channelRow — the dopesheet's row shape: one channel the timeline draws, wherever its curve lives
// (a KeyframeChannel node, a pose layer's curve, or a computed source's read-only projection).
//
// It lived in `clipChannelRows.ts` beside the read-only rows an imported file's own clip projected
// onto a clone-road bone. Those rows went with the clone road (#1053); the shape every other row
// kind uses stays here.

export interface ChannelRow {
  channelId: string;
  name: string;
  keyframes: ReadonlyArray<{ time: number }>;
  /** True for a read-only row (a computed source not yet baked, #1215) — no drag/edit handlers. */
  readOnly?: boolean;
  /**
   * True when the channel's `mute` param is set (#263 — the per-channel mute
   * restored after the AnimationLayer retirement, V57/#199). A muted channel
   * contributes nothing to the resolver (`overlayChannels.ts` filters it), so
   * the dopesheet paints its row dimmed. Optional so read-only rows and existing
   * fixtures (which omit it) stay structurally identical.
   */
  mute?: boolean;
  /**
   * True when the channel's `solo` param is set (#263). Solo is RELATIONAL — when any
   * channel on the same `targetId` is solo'd, the resolver drives ONLY the solo'd ones
   * (`overlayChannels.ts`), so the dopesheet paints the solo'd row highlighted and its
   * soloed-out siblings dimmed. Optional so read-only rows / fixtures stay identical.
   */
  solo?: boolean;
  /** The channel's `target` node id — the grouping key for the per-object solo scope. */
  targetId?: string;
  /** #1215 — the row's curve sits in a MUTED pose layer: dimmed, while `mute` stays the curve's own. */
  layerMuted?: boolean;
  /** #1215 — the curve has no solo (a layer's curve: Blender's F-curves have none; the layer does). */
  noSolo?: boolean;
}
