// NlaLanePane — the READ-ONLY NLA lane view in the timeline dock (epic #283
// Phase 5, inc 5B; UI-SPEC §1). Tracks as rows (top = highest `Track.order`,
// the last-folded winner), strips as percent-positioned DOM blocks over the
// SHARED dock zoom/scroll window, every fold state (muted / soloed-out /
// orphan / duplicate-ghost / influence / blend / repeat) visibly styled and
// NEVER hidden — the view shows authored state, the fold shows live state.
//
// Rendering is PERCENT of the visible view window (R1: the pane mounts
// display:none, so px-computed positions would be garbage on first paint) via
// the ONE geometry module `nlaLaneGeometry` (H95 — the e2e imports the same
// functions). Rows derive from `buildNlaLanes` — the parity-gated mirror of
// `layeredChannels.ts` — recomputed per DAG change, never stored. H48: the
// selector returns the STABLE `s.state.nodes` ref; rows derive in useMemo.
//
// 5B is read-only: the pane writes NOTHING to the DAG. The only write anywhere
// is the ruler scrub → `timeStore.setTime` (transport, not authoring — the
// LayerTimeline.tsx:345-368 precedent). Strip drag/resize, track M/S/▲▼
// gestures, selection and the strip inspector land in 5C/5D — the header
// buttons RENDER (aria-pressed + data-active reflect authored state) but are
// disabled. Empty state names the agent road (mutator.nla.createAction);
// the [Add strip…]/[Push down] affordances arrive in 5D/5E. NO "Add Track"
// button ever — track birth folds into addStrip (LOCKED, UI-SPEC §1.6).
//
// Strip labels are KNOCKED OUT (text-bg on the accent fills) in BOTH idle and
// selected states: text-fg on accent-dim measures 2.79:1 and fails WCAG AA,
// so both states follow the §4.2 selected-knockout idiom (within the FLEXIBLE
// class bounds; ROWS in contrastMatrix.test.ts audit both pairings).
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §1/§3.2/§4/§6.2;
//      .planning/phases/nla-5-lane-ui/PLAN.md inc 5B; sibling precedent
//      src/app/video/LayerTimeline.tsx; hetvabhasa H95/H48; issue #283.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { useTimelineViewStore } from './timelineViewStore';
import { useNlaSelectionStore } from './nlaSelectionStore';
import { buildNlaLanes, type NlaStripBlock, type NlaTrackRow } from './nlaLaneModel';
import {
  NLA_HEADER_WIDTH_PX,
  NLA_ROW_HEIGHT_PX,
  NLA_RULER_HEIGHT_PX,
  spanToPercent,
  secondsToPercent,
  percentToSeconds,
} from './nlaLaneGeometry';
import type { TimelineView } from './timelineView';

export function NlaLanePane() {
  // H48: select the STABLE nodes ref (unchanged between unrelated commits);
  // derive rows in useMemo — never return a fresh array from the selector.
  const nodes = useDagStore((s) => s.state.nodes);
  const lanes = useMemo(() => buildNlaLanes(nodes), [nodes]);

  const seconds = useTimeStore((s) => s.seconds);
  const duration = useTimeStore((s) => s.durationSeconds);
  const view = useTimelineViewStore((s) => s.view);
  const selectedStripId = useNlaSelectionStore((s) => s.selectedStripId);

  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));

  // ── Ruler scrub (TRANSPORT, not authoring): press/drag on the ruler moves
  //    the global playhead via timeStore.setTime — the LayerTimeline.tsx:345
  //    precedent. The lane is percent-laid-out; the pointer arrives in px, so
  //    the live ruler width is measured per event (gestures only happen on a
  //    VISIBLE pane — width is never 0 here).
  const rulerRef = useRef<HTMLDivElement>(null);
  const scrubToClientX = useCallback(
    (clientX: number) => {
      const el = rulerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      useTimeStore.getState().setTime(percentToSeconds(pct, FRAMES_PER_SECOND, totalFrames, view));
    },
    [totalFrames, view],
  );
  const onScrubMove = useCallback((e: PointerEvent) => scrubToClientX(e.clientX), [scrubToClientX]);
  const onScrubUp = useCallback(() => {
    window.removeEventListener('pointermove', onScrubMove);
    window.removeEventListener('pointerup', onScrubUp);
  }, [onScrubMove]);
  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      scrubToClientX(e.clientX);
      window.addEventListener('pointermove', onScrubMove);
      window.addEventListener('pointerup', onScrubUp);
    },
    [scrubToClientX, onScrubMove, onScrubUp],
  );
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onScrubMove);
      window.removeEventListener('pointerup', onScrubUp);
    };
  }, [onScrubMove, onScrubUp]);

  // Playhead percent across the visible window (unclamped — hidden when the
  // playhead scrolls off-window).
  const playheadPct = secondsToPercent(seconds, FRAMES_PER_SECOND, totalFrames, view);

  return (
    <div
      role="region"
      aria-label="NLA tracks"
      className="relative flex h-full w-full flex-col bg-bg text-fg"
    >
      {/* ── Ruler row: header spacer + the scrubbable time ruler. */}
      <div className="flex w-full shrink-0" style={{ height: NLA_RULER_HEIGHT_PX }}>
        <div
          className="shrink-0 border-b border-r border-line bg-bg-2"
          style={{ width: NLA_HEADER_WIDTH_PX }}
        />
        <div
          ref={rulerRef}
          data-testid="nla-ruler"
          onPointerDown={onRulerPointerDown}
          className="relative min-w-0 flex-1 cursor-ew-resize border-b border-line bg-bg-2"
        >
          <RulerTicks totalFrames={totalFrames} view={view} />
        </div>
      </div>

      {/* ── Track rows (top = highest order — the model list is pre-reversed). */}
      <div className="min-h-0 w-full flex-1 overflow-auto">
        {lanes.rows.length === 0 ? (
          <EmptyState />
        ) : (
          lanes.rows.map((row) => (
            <TrackRowView key={row.trackId} row={row} selectedStripId={selectedStripId} />
          ))
        )}
      </div>

      {/* ── Playhead line over the lane column (transport read-back). */}
      {playheadPct >= 0 && playheadPct <= 100 && (
        <div
          data-testid="nla-playhead"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent"
          style={{
            left: `calc(${NLA_HEADER_WIDTH_PX}px + (100% - ${NLA_HEADER_WIDTH_PX}px) * ${
              playheadPct / 100
            })`,
          }}
        />
      )}
    </div>
  );
}

// Second-grid tick labels through the SAME percent map as the strips (H95).
// Step widens as the visible window grows so labels stay ≲ 12 per view.
function RulerTicks({ totalFrames, view }: { totalFrames: number; view: TimelineView }) {
  const visStartSec = percentToSeconds(0, FRAMES_PER_SECOND, totalFrames, view);
  const visEndSec = percentToSeconds(100, FRAMES_PER_SECOND, totalFrames, view);
  const stepSec = Math.max(1, Math.ceil((visEndSec - visStartSec) / 12));
  const ticks: number[] = [];
  for (let s = Math.ceil(visStartSec); s <= Math.floor(visEndSec); s += stepSec) {
    ticks.push(s);
  }
  return (
    <>
      {ticks.map((s) => {
        const pct = secondsToPercent(s, FRAMES_PER_SECOND, totalFrames, view);
        if (pct < 0 || pct > 100) return null;
        return (
          <div key={s} aria-hidden className="absolute inset-y-0" style={{ left: `${pct}%` }}>
            <div className="h-full w-px" style={{ background: 'rgba(237,237,242,0.15)' }} />
            <span className="absolute left-1 top-0 select-none text-[9px] text-fg-dim">{s}s</span>
          </div>
        );
      })}
    </>
  );
}

function TrackRowView({
  row,
  selectedStripId,
}: {
  row: NlaTrackRow;
  selectedStripId: string | null;
}) {
  const duration = useTimeStore((s) => s.durationSeconds);
  const view = useTimelineViewStore((s) => s.view);
  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));
  const dimmed = row.muted || row.soloedOut;
  return (
    <div
      data-testid={`nla-track-row-${row.trackId}`}
      data-muted={row.muted}
      data-soloed-out={row.soloedOut}
      className="flex w-full border-b border-line"
      style={{ height: NLA_ROW_HEIGHT_PX }}
    >
      {/* Header cell: name + M/S/▲▼ (rendered, inert in 5B — gestures land 5C). */}
      <div
        className="flex shrink-0 items-center gap-0.5 border-r border-line bg-bg-2 px-1.5"
        style={{ width: NLA_HEADER_WIDTH_PX, opacity: dimmed ? 0.5 : 1 }}
      >
        <span
          data-testid={`nla-track-name-${row.trackId}`}
          title={
            row.soloedOut
              ? `${row.name} — silenced: another track solos`
              : row.muted
                ? `${row.name} — muted`
                : row.name
          }
          className="min-w-0 flex-1 truncate text-[11px] text-fg"
        >
          {row.name}
        </span>
        <HeaderToggle
          testid={`nla-track-mute-${row.trackId}`}
          label="M"
          pressed={row.muted}
          title={row.muted ? 'Track muted (toggle lands in 5C)' : 'Mute track (lands in 5C)'}
        />
        <HeaderToggle
          testid={`nla-track-solo-${row.trackId}`}
          label="S"
          pressed={row.solo}
          title={row.solo ? 'Track solos (toggle lands in 5C)' : 'Solo track (lands in 5C)'}
        />
        <HeaderButton
          testid={`nla-track-up-${row.trackId}`}
          label="▲"
          title="Move track up (lands in 5C)"
        />
        <HeaderButton
          testid={`nla-track-down-${row.trackId}`}
          label="▼"
          title="Move track down (lands in 5C)"
        />
      </div>
      {/* Lane: strips + blend wedges + repeat ticks, all percent-positioned.
          Track-muted / soloed-out dims the WHOLE lane (blocks stay visible). */}
      <div
        data-testid={`nla-lane-${row.trackId}`}
        className="relative min-w-0 flex-1"
        style={{ opacity: dimmed ? 0.4 : 1 }}
      >
        {row.strips.map((s, i) => (
          <StripBlock
            key={`${s.stripId}:${i}`}
            strip={s}
            trackName={row.name}
            selected={selectedStripId === s.stripId}
            totalFrames={totalFrames}
            view={view}
          />
        ))}
      </div>
    </div>
  );
}

function StripBlock({
  strip,
  trackName,
  selected,
  totalFrames,
  view,
}: {
  strip: NlaStripBlock;
  trackName: string;
  selected: boolean;
  totalFrames: number;
  view: TimelineView;
}) {
  const { leftPct, widthPct } = spanToPercent(
    strip.start,
    strip.end,
    FRAMES_PER_SECOND,
    totalFrames,
    view,
  );
  const degraded =
    strip.stripMuted || strip.trackMuted || strip.soloedOut || strip.orphan || strip.duplicateGhost;

  const stateNotes: string[] = [];
  if (strip.stripMuted) stateNotes.push('muted');
  if (strip.trackMuted) stateNotes.push('track muted');
  if (strip.soloedOut) stateNotes.push('silenced: another track solos');
  if (strip.orphan)
    stateNotes.push(
      'orphan: its Action is missing/empty or the target is unset — contributes nothing',
    );
  if (strip.duplicateGhost)
    stateNotes.push('duplicate reference: another track owns this strip — this copy is inert');
  const title =
    `${strip.name}${strip.actionName ? ` — Action “${strip.actionName}”` : ''}` +
    (stateNotes.length > 0 ? ` (${stateNotes.join('; ')})` : '');

  const clipLen = strip.repeat > 0 ? (strip.end - strip.start) / strip.repeat : 0;
  const repeatTicks: number[] = [];
  if (strip.repeat > 1 && clipLen > 0) {
    for (let k = 1; k < strip.repeat; k += 1) repeatTicks.push(strip.start + k * clipLen);
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-testid={`nla-strip-${strip.stripId}`}
        data-selected={selected}
        data-muted={strip.stripMuted || strip.trackMuted}
        data-degraded={degraded}
        data-live={strip.live}
        data-blend={strip.blendMode}
        aria-label={`Strip ${strip.name}, ${strip.start}s to ${strip.end}s on track ${trackName}${
          stateNotes.length > 0 ? ` (${stateNotes.join('; ')})` : ''
        }`}
        title={title}
        className={`absolute top-1/2 flex -translate-y-1/2 items-center overflow-hidden rounded px-1 ${
          selected ? 'bg-accent' : 'bg-accent-dim'
        } ${
          strip.orphan || strip.duplicateGhost ? 'border border-warn' : ''
        } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
        style={{
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          height: NLA_ROW_HEIGHT_PX - 10,
          opacity: strip.stripMuted ? 0.4 : 1,
        }}
      >
        {/* Glyphs, not color-only: ⊘ mute, ! orphan/ghost, C combine badge. */}
        {(strip.stripMuted || strip.orphan || strip.duplicateGhost) && (
          <span aria-hidden className="mr-0.5 shrink-0 text-[9px] text-bg">
            {strip.stripMuted ? '⊘' : '!'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-bg">{strip.name}</span>
        {strip.blendMode === 'combine' && (
          <span
            aria-hidden
            title="Combine blend"
            className="ml-0.5 shrink-0 rounded-sm bg-bg px-0.5 text-[9px] text-fg"
          >
            C
          </span>
        )}
        {/* Influence cue: thin bottom bar at influence% when < 1 (§1.4). */}
        {strip.influence < 1 && (
          <div
            aria-hidden
            data-influence={strip.influence}
            className="absolute bottom-0 left-0 h-px bg-fg"
            style={{ width: `${strip.influence * 100}%` }}
          />
        )}
        {/* blendIn/blendOut wedges: real time spans through the SAME map —
            widths are lane-percent converted to strip-local percent. */}
        {strip.blendIn > 0 && widthPct > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0"
            style={{
              width: `${wedgeLocalPct(strip.start, strip.start + strip.blendIn, widthPct, totalFrames, view)}%`,
              background: 'rgba(14,14,17,0.35)',
              clipPath: 'polygon(0 100%, 100% 100%, 100% 0)',
            }}
          />
        )}
        {strip.blendOut > 0 && widthPct > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0"
            style={{
              width: `${wedgeLocalPct(strip.end - strip.blendOut, strip.end, widthPct, totalFrames, view)}%`,
              background: 'rgba(14,14,17,0.35)',
              clipPath: 'polygon(0 0, 0 100%, 100% 100%)',
            }}
          />
        )}
      </div>
      {/* Repeat ticks: faint verticals at each clip boundary (actLen·timeScale
          intervals), lane-positioned through the same map. */}
      {repeatTicks.map((sec) => {
        const pct = secondsToPercent(sec, FRAMES_PER_SECOND, totalFrames, view);
        if (pct < 0 || pct > 100) return null;
        return (
          <div
            key={sec}
            aria-hidden
            className="pointer-events-none absolute w-px"
            style={{
              left: `${pct}%`,
              top: 5,
              height: NLA_ROW_HEIGHT_PX - 10,
              background: 'rgba(14,14,17,0.6)',
            }}
          />
        );
      })}
    </>
  );
}

// A time span → its width as a percent OF THE STRIP BLOCK (the wedges are
// children of the block, whose width is `widthPct` of the lane) — the same
// spanToPercent family, composed, so wedges stay in the one coordinate map.
function wedgeLocalPct(
  startSec: number,
  endSec: number,
  stripWidthPct: number,
  totalFrames: number,
  view: TimelineView,
): number {
  const span = spanToPercent(startSec, endSec, FRAMES_PER_SECOND, totalFrames, view);
  if (stripWidthPct <= 0) return 0;
  return Math.min((span.widthPct / stripWidthPct) * 100, 100);
}

// Inert 5B header toggle: shows the AUTHORED state (aria-pressed + data-active)
// but is disabled — the setTrackState gestures land in 5C. ToolbarButton idiom.
function HeaderToggle({
  testid,
  label,
  pressed,
  title,
}: {
  testid: string;
  label: string;
  pressed: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      data-active={pressed ? true : undefined}
      aria-pressed={pressed}
      title={title}
      disabled
      className={`shrink-0 cursor-not-allowed rounded px-1 text-[10px] ${
        pressed ? 'bg-line text-accent' : 'text-mute'
      }`}
    >
      {label}
    </button>
  );
}

function HeaderButton({ testid, label, title }: { testid: string; label: string; title: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={title}
      disabled
      className="shrink-0 cursor-not-allowed rounded px-1 text-[10px] text-mute"
    >
      {label}
    </button>
  );
}

// Empty state (§1.6): names the agent road. The [Add strip…]/[Push down]
// director affordances arrive in 5D/5E; there is NO "Add Track" button ever —
// track birth folds into addStrip by design (LOCKED).
function EmptyState() {
  return (
    <div data-testid="nla-empty-state" className="flex h-full items-center justify-center px-6">
      <p className="max-w-md text-center text-[11px] text-fg-dim">
        No NLA tracks yet. A strip places a reusable Action on a track — ask the agent to author one
        via <code className="text-fg">mutator.nla.createAction</code> and place it with{' '}
        <code className="text-fg">mutator.nla.addStrip</code> (the track is created automatically).
        Director authoring (Add strip…) arrives with the strip inspector.
      </p>
    </div>
  );
}
