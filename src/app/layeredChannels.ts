// layeredChannels — the NLA enumeration seam (epic #283 Phase 2, Slice C).
//
// The ONE place strips + bare channels are unified into the `KeyframeChannelValue[]`
// that BOTH fold seams already consume (the render `overlayChannels` and the read
// `resolveEvaluatedParam`). A bare channel is a degenerate single-strip; a Strip
// placing an Action emits one synthetic channel value per param it touches, whose
// `.sample` retimes the Action via `remapStripTime` (Slice B). Because both seams
// route through here, a placed strip lights up render AND read at once (H40 — the
// one-consumer trap is closed by construction).
//
// Enumeration is TRACK-DRIVEN (Blender's model): tracks fold bottom→top by
// `Track.order`, strips within a track by array position; a soloing track silences
// non-solo tracks (global); muted tracks/strips drop out AT ENUMERATION so both
// seams receive already-gated values (render == read for mute, for free). A strip
// belongs to exactly one track (single-owner): if a strip id appears in two tracks,
// the lowest-order track wins (deterministic dedupe). Bare channels concatenate
// FIRST and the fold's stable sort keeps them below strips at equal order — so an
// empty strip set is byte-identical to the bare path (the anchor test).
//
// v1 SCOPE (checker-locked): 'hold' extrapolate only (the placement forces 'hold',
// so `remapStripTime` always yields a real τ — no absence path reaches the fold);
// STATIC influence (the untouched render seam reads a static weight). Time-varying
// ramps / crossfades + 'nothing'/'hold-forward' land in Phase 3.
//
// REF: docs/NLA-DESIGN.md §3.1/§3.4/§6 (Phase 2, Slice C); vyapti V57/V88 D2/D3;
//      krama K21; RESEARCH.md "Injection strategy (option a)".

import { directChannelNodesForTarget, directChannelValuesForTarget } from './nodeChannels';
import { getNodeType } from '../core/dag/registry';
import { remapStripTime, type StripPlacement } from './stripRetime';
import type { KeyframeChannelValue } from '../nodes/types';
import type { StripParams } from '../nodes/Strip';
import type { TrackParams } from '../nodes/Track';
import type { ActionParams, ActionChannel } from '../nodes/Action';

/** Minimal node shape read here (a DagState node subset — strips/tracks/actions/
 *  channels all live in the same node table). */
interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** Within-track order granularity: strip fold position = trackRank·STRIDE + index. */
const ORDER_STRIDE = 1000;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** valueType → the KeyframeChannel* node type whose evaluate builds the sampler. */
const channelNodeType = (valueType: string) =>
  `KeyframeChannel${valueType.charAt(0).toUpperCase()}${valueType.slice(1)}`;

/**
 * The Action's local time domain across ALL its channels (Blender's Action frame
 * range): `actStart` = earliest key time, `actLen` = span. One domain per Action so
 * every channel of a placed "walk" retimes as a unit. Null when the Action has no
 * keys at all (→ the strip contributes nothing).
 */
function actionTimeDomain(
  channels: readonly ActionChannel[],
): { actStart: number; actLen: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const ch of channels) {
    const keys = (ch as { keyframes?: { time: number }[] }).keyframes;
    if (!Array.isArray(keys)) continue;
    for (const k of keys) {
      if (k.time < min) min = k.time;
      if (k.time > max) max = k.time;
    }
  }
  if (min === Infinity) return null;
  return { actStart: min, actLen: max - min };
}

/** Build the synthetic channel value for one (strip, Action-channel): reuse the
 *  channel node's OWN evaluate (via the registry — the same sampler the dopesheet
 *  uses, no drift, H40) to get the raw action-time sampler, then wrap it with the
 *  strip's placement retime + override the blend fields with the strip's. */
function syntheticChannelValue(
  strip: StripParams,
  ch: ActionChannel,
  domain: { actStart: number; actLen: number },
  order: number,
): KeyframeChannelValue | null {
  const def = getNodeType(channelNodeType(ch.valueType));
  if (!def) return null;
  // The ActionChannel is a KeyframeChannel*Params minus `target`; add it back so
  // the channel's evaluate builds its sampler exactly as authored (the extra
  // `valueType` field is ignored by evaluate). One arg — a channel evaluate is pure
  // over params (no inputs/ctx), as channelValuesFromNodes relies on too.
  const evaluate = def.evaluate as (params: unknown) => KeyframeChannelValue;
  const base = evaluate({ ...(ch as object), target: strip.target });
  // v1: force 'hold' extrapolate so remapStripTime always yields a real τ (Phase 3
  // honors strip.extrapolate). `?? actStart` is a dead safe-guard under 'hold'.
  const placement: StripPlacement = {
    start: strip.start,
    timeScale: strip.timeScale,
    repeat: strip.repeat,
    reverse: strip.reverse,
    extrapolate: 'hold',
    actStart: domain.actStart,
    actLen: domain.actLen,
  };
  // Override the identity/blend fields with the strip's placement (the Strip owns
  // blend, not the Action's inert channel fields). Cast once: the runtime shape is a
  // valid KeyframeChannelValue, but TS can't narrow the discriminant through the
  // dynamic valueType.
  return {
    ...base,
    name: `${strip.name}/${ch.paramPath}`,
    target: strip.target,
    paramPath: ch.paramPath,
    mute: false,
    weight: clamp01(strip.influence),
    blendMode: strip.blendMode,
    order,
    sample: (s: number) => base.sample(remapStripTime(s, placement) ?? domain.actStart),
  } as KeyframeChannelValue;
}

/** Tracks that are live at the fold, sorted bottom→top by `Track.order`, with the
 *  global solo rule + track mute applied. */
function activeTracksSorted(
  nodes: Readonly<Record<string, NodeLike>>,
): { id: string; params: TrackParams }[] {
  const tracks: { id: string; params: TrackParams }[] = [];
  for (const node of Object.values(nodes)) {
    if (node.type !== 'Track') continue;
    tracks.push({ id: node.id, params: node.params as TrackParams });
  }
  const soloActive = tracks.some((t) => t.params.solo);
  return tracks
    .filter((t) => !t.params.mute && (!soloActive || t.params.solo))
    .sort((a, b) => a.params.order - b.params.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The strip-derived synthetic channel values driving `targetId` — track-driven,
 * mute/solo filtered, single-owner deduped, one value per (strip, Action-channel).
 * Empty when no non-muted track holds a strip that targets `targetId`.
 */
export function stripChannelValuesForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  targetId: string,
): KeyframeChannelValue[] {
  if (!targetId) return [];
  const out: KeyframeChannelValue[] = [];
  const seenStrips = new Set<string>(); // single-owner: lowest-order track wins
  activeTracksSorted(nodes).forEach((track, trackRank) => {
    track.params.strips.forEach((stripId, stripIndex) => {
      if (seenStrips.has(stripId)) return;
      const stripNode = nodes[stripId];
      if (!stripNode || stripNode.type !== 'Strip') return;
      seenStrips.add(stripId);
      const strip = stripNode.params as StripParams;
      if (strip.muted || strip.target !== targetId || !strip.action) return;
      const actionNode = nodes[strip.action];
      if (!actionNode || actionNode.type !== 'Action') return;
      const channels = (actionNode.params as ActionParams).channels as ActionChannel[];
      if (!channels || channels.length === 0) return;
      const domain = actionTimeDomain(channels);
      if (!domain) return;
      const orderBase = trackRank * ORDER_STRIDE + stripIndex;
      for (const ch of channels) {
        const value = syntheticChannelValue(strip, ch, domain, orderBase);
        if (value) out.push(value);
      }
    });
  });
  return out;
}

/**
 * The set of node ids that have at least one Strip targeting them (non-empty
 * action) — the render-mount membership gate (mirrors `directChannelTargetSet`,
 * R4 — tested per child, never O(N²)). Conservative: includes muted/orphan strips
 * (an extra idle follower mount is harmless; a MISSING one would freeze a
 * strip-only node).
 */
export function stripTargetSet(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type !== 'Strip') continue;
    const p = node.params as StripParams;
    if (typeof p.target === 'string' && p.target && p.action) targets.add(p.target);
  }
  return targets;
}

/**
 * Every {@link KeyframeChannelValue} driving `targetId` — bare direct channels
 * FIRST, then strip-derived synthetic channels. This is the array both fold seams
 * consume. Bare-first + the fold's stable sort keeps bare channels below strips at
 * equal order; an empty strip set returns exactly the bare array (byte-identical).
 */
export function layeredChannelValues(
  nodes: Readonly<Record<string, NodeLike>>,
  targetId: string,
): KeyframeChannelValue[] {
  const bare = directChannelValuesForTarget(nodes, targetId);
  const strips = stripChannelValuesForTarget(nodes, targetId);
  return strips.length === 0 ? bare : [...bare, ...strips];
}

/**
 * The stable node refs whose params feed `targetId`'s layered fold — bare channel
 * nodes + every Strip targeting it + its referenced Actions + ALL Track nodes (a
 * track's solo/mute/order is a GLOBAL input to every fold). A render memo keyed off
 * this array (shallow) rebuilds the sample closures only when a contributing node's
 * ref actually changes (immutable Ops → H48), never per frame.
 */
export function layeredChannelNodesForTarget(
  nodes: Readonly<Record<string, NodeLike>>,
  targetId: string,
): NodeLike[] {
  const out: NodeLike[] = [...directChannelNodesForTarget(nodes, targetId)];
  const actionIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type === 'Track') {
      out.push(node); // global solo/mute/order affects every fold
    } else if (node.type === 'Strip') {
      const p = node.params as StripParams;
      if (p.target === targetId) {
        out.push(node);
        if (p.action) actionIds.add(p.action);
      }
    }
  }
  for (const id of actionIds) {
    const a = nodes[id];
    if (a) out.push(a);
  }
  return out;
}
