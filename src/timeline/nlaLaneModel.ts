// nlaLaneModel — the READ-ONLY display mirror of the NLA enumeration
// (epic #283 Phase 5; UI-SPEC §3.1).
//
// `src/app/layeredChannels.ts` is DO-NOT-TOUCH and exports none of its
// internals (`actionTimeDomain`, `activeTracksSorted` are module-private) — so
// the lane view derives its rows in THIS pure module, which RE-STATES the
// fold's rules verbatim (each rule carries its source-line citation). The
// §3.1 parity test (nlaLaneModel.test.ts) feeds one synthetic node table to
// BOTH this module and the real `layeredChannelValues` and asserts they
// agree — the ONLY acceptable substitute for shared code given the read-only
// constraint. This module never imports from layeredChannels (types come from
// the node schemas), never renders, never writes: node table in, rows out.
//
// KEY DISPLAY DELTA vs the fold: the fold DROPS muted/soloed-out/orphan/
// duplicate contributions at enumeration; the view SHOWS every authored track
// and strip and FLAGS the degraded ones (authored state visible, live state
// styled — §1.3/§1.4/§4.2). `live` marks the instances the fold enumerates.
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §3.1/§1.3/§1.4;
//      src/app/layeredChannels.ts:61-76/:119/:147-195 (the mirrored rules);
//      vyapti V88 D2; issue #283.

import type { StripParams } from '../nodes/Strip';
import type { TrackParams } from '../nodes/Track';
import type { ActionParams, ActionChannel } from '../nodes/Action';

/** Minimal node shape read here (a DagState node subset — the same local
 *  shape layeredChannels.ts:39-44 reads; NOT imported, it is module-private). */
interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** One strip block in a track lane — display model only, never stored. */
export interface NlaStripBlock {
  readonly stripId: string;
  readonly name: string;
  readonly actionId: string;
  readonly actionName: string;
  readonly targetId: string;
  /** Placed span start (seconds) — the `start` param verbatim. */
  readonly start: number;
  /** Placed span end (seconds) — derived, never a param (R5):
   *  `start + actLen·timeScale·repeat` (layeredChannels.ts:119). */
  readonly end: number;
  readonly timeScale: number;
  readonly repeat: number;
  readonly reverse: boolean;
  readonly blendMode: StripParams['blendMode'];
  readonly influence: number;
  readonly blendIn: number;
  readonly blendOut: number;
  /** TRUE iff THIS instance is the one the fold enumerates (owner appearance
   *  in the filtered scan AND not strip-muted AND not orphan). */
  readonly live: boolean;
  readonly stripMuted: boolean;
  readonly trackMuted: boolean;
  readonly soloedOut: boolean;
  /** Action id missing / Action has no keys / empty target — contributes
   *  nothing (layeredChannels.ts:180-186). */
  readonly orphan: boolean;
  /** This appearance is NOT the owning one — another (live) appearance of the
   *  same strip id folds instead; rendered inert with a warning title (§1.4). */
  readonly duplicateGhost: boolean;
}

/** One track row. Rows are returned in DISPLAY order (top = highest order). */
export interface NlaTrackRow {
  readonly trackId: string;
  readonly name: string;
  readonly order: number;
  readonly muted: boolean;
  readonly solo: boolean;
  /** Another track solos and this one does not (layeredChannels.ts:155-157). */
  readonly soloedOut: boolean;
  readonly strips: NlaStripBlock[];
}

export interface NlaLanes {
  /** DISPLAY order: index 0 = TOP row = HIGHEST `Track.order` (§1.3) — the
   *  fold's ascending sort (layeredChannels.ts:158) reversed. */
  readonly rows: NlaTrackRow[];
  /** Any track solos → every non-solo track is soloed-out (:155). */
  readonly soloActive: boolean;
}

/**
 * Local re-statement of the module-private `actionTimeDomain`
 * (layeredChannels.ts:61-76) — each line commented with the source line it
 * mirrors. Null when the Action has no keys at all (→ orphan strip).
 */
function actionTimeDomainMirror(
  channels: readonly ActionChannel[],
): { actStart: number; actLen: number } | null {
  let min = Infinity; // :64
  let max = -Infinity; // :65
  for (const ch of channels) {
    // :66
    const keys = (ch as { keyframes?: { time: number }[] }).keyframes; // :67
    if (!Array.isArray(keys)) continue; // :68
    for (const k of keys) {
      // :69
      if (k.time < min) min = k.time; // :70
      if (k.time > max) max = k.time; // :71
    }
  }
  if (min === Infinity) return null; // :74 (degenerate-domain guard)
  return { actStart: min, actLen: max - min }; // :75
}

/** stripId → the (trackId, strips-array index) of the appearance the fold
 *  enumerates. Key detail mirrored from :173-178: ownership is claimed by the
 *  FIRST RESOLVED appearance in the mute/solo-FILTERED ascending track scan —
 *  `seenStrips.add` fires BEFORE the muted/orphan gates, so a muted/orphan
 *  strip in the lowest live track still blocks a higher duplicate. */
type OwnerMap = Map<string, { trackId: string; stripIndex: number }>;

/**
 * Derive the lane display model from the DAG node table. Pure; recomputed per
 * state change; NEVER stored (drift from the fold is guarded by the §3.1
 * parity test, not by caching).
 */
export function buildNlaLanes(nodes: Readonly<Record<string, NodeLike>>): NlaLanes {
  // ── collect ALL tracks (the view shows authored state — muted ones flagged,
  //    never dropped, §1.3), mirroring the :150-154 scan.
  const tracks: { id: string; params: TrackParams }[] = [];
  for (const node of Object.values(nodes)) {
    if (node.type !== 'Track') continue; // :152
    tracks.push({ id: node.id, params: node.params as TrackParams }); // :153
  }

  // ── solo is GLOBAL: any solo → non-solo tracks are silenced (:155).
  const soloActive = tracks.some((t) => t.params.solo);

  // ── the fold's sort: `order` asc, then lexicographic id tie-break (:158).
  const sortedAsc = [...tracks].sort(
    (a, b) => a.params.order - b.params.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // ── FILTER-THEN-DEDUPE (§1.4): the live-owner scan runs over the
  //    mute/solo-FILTERED list in ASCENDING order (`activeTracksSorted` feeds
  //    `seenStrips`, :173-175) — the first LIVE track owning a strip id wins.
  //    If the lowest-order owner is muted/soloed-out it is NOT in this scan,
  //    so ownership SWAPS to the next live track (the live/ghost swap).
  const owner: OwnerMap = new Map();
  for (const t of sortedAsc) {
    if (t.params.mute || (soloActive && !t.params.solo)) continue; // :157 (the liveness filter)
    t.params.strips.forEach((stripId, stripIndex) => {
      // :174 (array order)
      if (owner.has(stripId)) return; // :175 (seenStrips — single owner)
      const stripNode = nodes[stripId];
      if (!stripNode || stripNode.type !== 'Strip') return; // :176-177 (missing ids never claim)
      owner.set(stripId, { trackId: t.id, stripIndex }); // :178 (claim precedes the muted/orphan gates at :180-186)
    });
  }

  // ── build one row per authored track, ascending, then reverse for display.
  const rowsAsc: NlaTrackRow[] = sortedAsc.map((t) => {
    const trackMuted = t.params.mute;
    const soloedOut = soloActive && !t.params.solo; // :155-157 (display flag, not a drop)
    const strips: NlaStripBlock[] = [];
    t.params.strips.forEach((stripId, stripIndex) => {
      // :174 (Track.strips array order)
      const stripNode = nodes[stripId];
      if (!stripNode || stripNode.type !== 'Strip') return; // :176-177 (missing Strip ids skipped exactly as the fold skips them)
      const strip = stripNode.params as StripParams;
      const actionNode = strip.action ? nodes[strip.action] : undefined; // :181
      const action =
        actionNode && actionNode.type === 'Action' ? (actionNode.params as ActionParams) : null; // :182
      const channels = (action?.channels ?? []) as ActionChannel[]; // :183
      const domain = channels.length > 0 ? actionTimeDomainMirror(channels) : null; // :184-186
      // orphan = action id missing / no keys / empty target (:180-186) — the
      // strip contributes nothing to the fold.
      const orphan = !strip.action || !action || channels.length === 0 || !domain || !strip.target;
      // placed span: end = start + actLen·timeScale·repeat (:119); an orphan
      // has no domain → degenerate zero-length span at `start`.
      const end = domain
        ? strip.start + domain.actLen * strip.timeScale * strip.repeat
        : strip.start;
      const own = owner.get(stripId);
      const isOwnerAppearance =
        own !== undefined && own.trackId === t.id && own.stripIndex === stripIndex;
      // duplicateGhost: some OTHER appearance owns this strip id — this one is
      // inert (§1.4). When NO live track owns it (e.g. every holder muted),
      // nothing folds and no appearance is a ghost — they are just degraded.
      const duplicateGhost = own !== undefined && !isOwnerAppearance;
      // live = the fold enumerates THIS instance: owner appearance (already
      // implies the track passed the :157 filter) minus the :180-186 gates.
      const live = isOwnerAppearance && !strip.muted && !orphan;
      strips.push({
        stripId,
        name: strip.name,
        actionId: strip.action,
        actionName: action?.name ?? '',
        targetId: strip.target,
        start: strip.start,
        end,
        timeScale: strip.timeScale,
        repeat: strip.repeat,
        reverse: strip.reverse,
        blendMode: strip.blendMode,
        influence: strip.influence,
        blendIn: strip.blendIn,
        blendOut: strip.blendOut,
        live,
        stripMuted: strip.muted, // :180
        trackMuted,
        soloedOut,
        orphan,
        duplicateGhost,
      });
    });
    return {
      trackId: t.id,
      name: t.params.name,
      order: t.params.order,
      muted: trackMuted,
      solo: t.params.solo,
      soloedOut,
      strips,
    };
  });

  // ── DISPLAY order: top = highest order (§1.3) — the ascending fold list
  //    exactly reversed.
  return { rows: rowsAsc.reverse(), soloActive };
}
