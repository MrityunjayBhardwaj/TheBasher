// rowChannelWrite — where a timeline row's write lands, and the row's mute / solo (#1215).
//
// A row is a channel node, or a pose layer's curve (`layer:` rows). Both are resolved here into the
// ops that change the curve wherever it LIVES, so the keyboard, the curve editor, the gutter glyphs
// and the toolbar land in one place.
//
// This file was `clipRowMint.ts` and carried a third row kind: the read-only `clip:` rows an
// imported file's own clip projected onto a clone-road bone, minted into channels on first edit
// (#889 / #903 / #911). They went with the clone road (#1053): a kept clone-road import is not drawn
// and stays exactly as saved, so there is nothing to project and nothing to mint.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { resolveChannelAddress } from '../../agent/mutators/builders/channelAddress';
import { parseLayerRowId } from '../../timeline/layerChannelRows';

/** A channel a keyboard edit is about to write to, and what it will hold. */
export interface RowChannelWrite {
  readonly channelId: string;
  /** The curve's params — the extrapolation and modifier fields too, not just the keys, so a
   *  caller that needs to SAMPLE the channel has them. */
  readonly params: Record<string, unknown>;
  readonly nodeType: string;
  /** The ops that change the channel's fields wherever it lives (#1215: its node, or its entry in
   *  a pose layer's list). */
  readonly write: (fields: Readonly<Record<string, unknown>>) => Op[];
  /** A key inserted here takes the value the CURVE shows, not a target param: a layer's curve (a
   *  bone's value is the pose, not a param anyone typed). */
  readonly keyFromCurve: boolean;
  /** Removing the last key removes the curve (a layer's, as Blender removes an emptied F-curve);
   *  on a channel node an emptied channel would instead claim its component with zeros. */
  readonly emptyRemovesCurve: boolean;
}

const setKeys = (channelId: string) => (fields: Readonly<Record<string, unknown>>) =>
  Object.entries(fields).map(
    ([paramPath, value]): Op => ({ type: 'setParam', nodeId: channelId, paramPath, value }),
  );

/**
 * Resolve the timeline's active row id — a channel node's id, or a pose layer's `layer:` row
 * (#1215) — into the channel a write lands on, and the `write` that lands it there. Null when the
 * row has nothing to write to (a read-only computed row, or a stale id).
 */
export function resolveRowChannelForWrite(
  state: DagState,
  rowChannelId: string,
): RowChannelWrite | null {
  // #1215 — a layer row: the address resolver answers where the curve lives and how to write it.
  const layer = parseLayerRowId(rowChannelId);
  if (layer) {
    const resolved = resolveChannelAddress(state, { layer }, { mint: true });
    if (!resolved.ok) return null;
    return {
      channelId: resolved.channelId,
      params: resolved.view.params,
      nodeType: resolved.view.type,
      write: resolved.write,
      keyFromCurve: true,
      emptyRemovesCurve: true,
    };
  }
  const live = state.nodes[rowChannelId];
  if (!live) return null;
  return {
    channelId: rowChannelId,
    params: (live.params ?? {}) as Record<string, unknown>,
    nodeType: live.type,
    write: setKeys(rowChannelId),
    keyFromCurve: false,
    emptyRemovesCurve: false,
  };
}

/**
 * #1215 — the ops that flip a timeline row's `mute` or `solo`, wherever its curve lives: a channel
 * node's param, or the curve's entry in its pose layer (through the row resolver's `write`, so the
 * gutter glyph, the toolbar button and the agent's resolver land in one place). Null when the row has
 * nothing to flip: a read-only computed row, a missing row, or `solo` on a layer's curve, which has
 * none (Blender's F-curves have a mute and no solo; the layer solos).
 */
export function rowFlagToggleOps(
  state: DagState,
  rowChannelId: string,
  kind: 'mute' | 'solo',
): Op[] | null {
  if (kind === 'solo' && parseLayerRowId(rowChannelId)) return null;
  const resolved = resolveRowChannelForWrite(state, rowChannelId);
  if (!resolved) return null;
  return resolved.write({ [kind]: resolved.params[kind] !== true });
}

/** Whether a timeline row's `mute` / `solo` is on, read where its curve lives. */
export function rowFlag(state: DagState, rowChannelId: string, kind: 'mute' | 'solo'): boolean {
  return resolveRowChannelForWrite(state, rowChannelId)?.params[kind] === true;
}

/** What a diamond activation should DO — see {@link diamondActivation}. */
export type DiamondAction = 'delete' | 'refuse-nothing-authored' | 'key';

/**
 * Decide what clicking a parameter diamond means (#912).
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES INSIDE THE COMPONENT. The bug it
 * fixes lived in a conditional inside `ParamDiamond.onActivate`, where no unit
 * gate could reach it: the only way to observe an Alt-click doing the opposite
 * of its tooltip was to drive a browser. A decision worth getting right is worth
 * being able to test, so the decision moves out and the component renders it.
 *
 * THE RULE. `alt` is the DELETE gesture and must never key. It used to be gated
 * on an authored channel existing, so with nothing authored (`'none'`) it fell
 * past the delete branch onto the keying path and CREATED a key. (Found on a
 * clone-road bone driven by its file's clip, a road retired in #1053; the rule
 * holds for any param with nothing authored.)
 *
 * With nothing authored there is no delete to perform, and the honest answer is a
 * visible refusal — not a silent no-op, which reads as a broken button, and not a
 * key, which is the opposite of what was asked for.
 */
export function diamondActivation(
  alt: boolean,
  authoredState: 'none' | 'animated' | 'on-key',
): DiamondAction {
  if (alt) return authoredState === 'none' ? 'refuse-nothing-authored' : 'delete';
  return authoredState === 'on-key' ? 'delete' : 'key';
}
