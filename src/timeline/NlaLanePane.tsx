// NlaLanePane — the NLA lane view in the timeline dock (epic #283 Phase 5;
// UI-SPEC §1/§2). Tracks as rows (top = highest `Track.order`, the last-folded
// winner), strips as percent-positioned DOM blocks over the SHARED dock
// zoom/scroll window, every fold state (muted / soloed-out / orphan /
// duplicate-ghost / influence / blend / repeat) visibly styled and NEVER
// hidden — the view shows authored state, the fold shows live state.
//
// Rendering is PERCENT of the visible view window (R1: the pane mounts
// display:none, so px-computed positions would be garbage on first paint) via
// the ONE geometry module `nlaLaneGeometry` (H95 — the e2e imports the same
// functions). Rows derive from `buildNlaLanes` — the parity-gated mirror of
// `layeredChannels.ts` — recomputed per DAG change, never stored. H48: the
// selector returns the STABLE `s.state.nodes` ref; rows derive in useMemo.
//
// 5C gestures — the LayerTimeline.tsx:242-338 grammar verbatim: window
// pointermove/pointerup listeners installed at pointerdown (removed on up +
// unmount), NLA_DRAG_THRESHOLD_PX gates click-vs-drag, lane width measured
// ONCE at pointerdown into the drag record, live preview via component-local
// state (the DAG is untouched until pointerup), ONE commit at pointerup,
// suppressClickRef eats the trailing click so a drag never also selects.
// Every commit funnels through nlaCommit (commitNla → the five-gate mutator
// road; commitNlaSetParam → the ONE sanctioned raw road for Strip.muted) so
// {ok:false} always reaches the toast surface (H70/B26). Keyboard parity per
// §2.8: strip focused ←/→ nudge start (Shift ×10), M mutes; track header
// focused M/S toggle, Alt+↑/↓ reorder; Esc clears selection. Track ▲/▼ emit
// ONE dispatch on ONE track (midpointOrder) and are DISABLED at the extremes
// (no junk undo entries). NO "Add Track" button ever — track birth folds into
// addStrip (LOCKED, UI-SPEC §1.6).
//
// Strip labels are KNOCKED OUT (text-bg on the accent fills) in idle,
// selected AND dragging states: text-fg on accent-dim measures 2.79:1 and
// fails WCAG AA, so all states follow the §4.2 selected-knockout idiom
// (ROWS in contrastMatrix.test.ts audit every pairing).
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §1/§2/§3.2/§4/§6.2;
//      .planning/phases/nla-5-lane-ui/PLAN.md inc 5B/5C; sibling precedent
//      src/app/video/LayerTimeline.tsx; hetvabhasa H95/H48/H70; issue #283.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { useTimelineViewStore } from './timelineViewStore';
import { useNlaSelectionStore } from './nlaSelectionStore';
import { buildNlaLanes, type NlaStripBlock, type NlaTrackRow } from './nlaLaneModel';
import {
  NLA_HEADER_WIDTH_PX,
  NLA_ROW_HEIGHT_PX,
  NLA_RULER_HEIGHT_PX,
  NLA_STRIP_HANDLE_PX,
  NLA_DRAG_THRESHOLD_PX,
  spanToPercent,
  secondsToPercent,
  percentToSeconds,
  xDeltaToSecondsDelta,
  snapToFrame,
  resizeRight,
  resizeLeft,
  midpointOrder,
  reorderDisabled,
  type NlaReorderDirection,
} from './nlaLaneGeometry';
import { commitNla, commitNlaSetParam } from './nlaCommit';
import { NlaAddStripPopover } from './NlaAddStripPopover';
import { NlaStripInspector } from './NlaStripInspector';
import type { TimelineView } from './timelineView';

// ── Strip drag record (the LayerTimeline BarDrag shape): everything the
//    window listeners need, captured ONCE at pointerdown — including the lane
//    width (px→seconds) and the view window (a drag never re-reads either).
type StripDragZone = 'move' | 'left' | 'right';

interface StripDrag {
  zone: StripDragZone;
  stripId: string;
  startClientX: number;
  /** Lane width in px, measured ONCE at pointerdown (§2 LOCK). */
  laneWidthPx: number;
  totalFrames: number;
  view: TimelineView;
  orig: {
    start: number;
    end: number;
    timeScale: number;
    repeat: number;
    /** Action key-domain length — derived back out of the placed span so the
     *  resize math needs no second model lookup: (end−start)/(timeScale·repeat). */
    actLen: number;
  };
  moved: boolean;
}

/** The displayed span while a drag is in flight — component-local, discarded
 *  at pointerup; the committed position re-derives from the store (§3.3). */
interface StripPreviewSpan {
  stripId: string;
  start: number;
  end: number;
}

/** Preview span for a drag delta (pure — the SAME resize math the commit uses). */
function dragPreviewSpan(d: StripDrag, dSec: number): StripPreviewSpan {
  if (d.zone === 'move') {
    return { stripId: d.stripId, start: d.orig.start + dSec, end: d.orig.end + dSec };
  }
  if (d.zone === 'right') {
    const { timeScale } = resizeRight(
      d.orig.start,
      d.orig.end,
      d.orig.end + dSec,
      d.orig.timeScale,
    );
    return {
      stripId: d.stripId,
      start: d.orig.start,
      end: d.orig.start + d.orig.actLen * timeScale * d.orig.repeat,
    };
  }
  // left: right edge FIXED (§2.2).
  const { start } = resizeLeft(
    d.orig.start,
    d.orig.end,
    d.orig.start + dSec,
    d.orig.timeScale,
    d.orig.actLen,
    d.orig.repeat,
  );
  return { stripId: d.stripId, start, end: d.orig.end };
}

/** The add-strip popover's open state: which button anchored it + which
 *  track it pre-selects (null = "New track"). */
interface AddStripOpen {
  anchor: HTMLElement;
  trackId: string | null;
}

export function NlaLanePane() {
  // H48: select the STABLE nodes ref (unchanged between unrelated commits);
  // derive rows in useMemo — never return a fresh array from the selector.
  const nodes = useDagStore((s) => s.state.nodes);
  const lanes = useMemo(() => buildNlaLanes(nodes), [nodes]);
  // ≥1 Action gates every add-strip entry point (§2.6 — the popover's Action
  // select would be empty otherwise; the disabled title names the agent road).
  const hasActions = useMemo(
    () => Object.values(nodes).some((n) => (n as { type?: string }).type === 'Action'),
    [nodes],
  );
  const [addStrip, setAddStrip] = useState<AddStripOpen | null>(null);

  const seconds = useTimeStore((s) => s.seconds);
  const duration = useTimeStore((s) => s.durationSeconds);
  const view = useTimelineViewStore((s) => s.view);
  const selectedStripId = useNlaSelectionStore((s) => s.selectedStripId);
  const selectedTrackId = useNlaSelectionStore((s) => s.selectedTrackId);

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

  // ── Strip drag (5C): the LayerTimeline.tsx:242-338 grammar. The drag record
  //    lives in a ref (window listeners read it without re-binding); the
  //    preview lives in state (the dragged block re-renders at the pointer);
  //    the DAG is written ONCE at pointerup through the commitNla funnel.
  const dragRef = useRef<StripDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<StripPreviewSpan | null>(null);

  const onWindowMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = e.clientX - d.startClientX;
    if (Math.abs(deltaPx) > NLA_DRAG_THRESHOLD_PX) d.moved = true;
    const dSec = xDeltaToSecondsDelta(
      deltaPx,
      d.laneWidthPx,
      FRAMES_PER_SECOND,
      d.totalFrames,
      d.view,
    );
    setPreview(dragPreviewSpan(d, dSec));
  }, []);

  const onWindowUp = useCallback(
    (e: PointerEvent) => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      const d = dragRef.current;
      dragRef.current = null;
      setPreview(null);
      if (!d) return;
      if (!d.moved) return; // a click, not a drag → selection handled by onClick
      suppressClickRef.current = true;
      const dSec = xDeltaToSecondsDelta(
        e.clientX - d.startClientX,
        d.laneWidthPx,
        FRAMES_PER_SECOND,
        d.totalFrames,
        d.view,
      );
      if (d.zone === 'move') {
        // §2.1: snap to the frame grid; NO ≥0 clamp (the schema allows
        // negative start — the fold handles it, UI-SPEC §2.1).
        commitNla(
          'mutator.nla.setStripTiming',
          { stripId: d.stripId, start: snapToFrame(d.orig.start + dSec, FRAMES_PER_SECOND) },
          'Move strip',
        );
      } else if (d.zone === 'right') {
        const { timeScale } = resizeRight(
          d.orig.start,
          d.orig.end,
          d.orig.end + dSec,
          d.orig.timeScale,
        );
        commitNla('mutator.nla.setStripTiming', { stripId: d.stripId, timeScale }, 'Resize strip');
      } else {
        // left: BOTH fields in ONE dispatch = one undo entry (§2.2 LOCK).
        const { start, timeScale } = resizeLeft(
          d.orig.start,
          d.orig.end,
          d.orig.start + dSec,
          d.orig.timeScale,
          d.orig.actLen,
          d.orig.repeat,
        );
        commitNla(
          'mutator.nla.setStripTiming',
          { stripId: d.stripId, start, timeScale },
          'Resize strip',
        );
      }
    },
    [onWindowMove],
  );

  // Stop listening if the pane unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
    };
  }, [onWindowMove, onWindowUp]);

  const onStripPointerDown = useCallback(
    (e: React.PointerEvent, strip: NlaStripBlock, zone: StripDragZone) => {
      e.preventDefault();
      e.stopPropagation(); // a handle press must not ALSO start a body drag
      const lane = (e.currentTarget as HTMLElement).closest('[data-testid^="nla-lane-"]');
      if (!lane) return;
      const scale = strip.timeScale * strip.repeat;
      dragRef.current = {
        zone,
        stripId: strip.stripId,
        startClientX: e.clientX,
        laneWidthPx: (lane as HTMLElement).getBoundingClientRect().width,
        totalFrames,
        view,
        orig: {
          start: strip.start,
          end: strip.end,
          timeScale: strip.timeScale,
          repeat: strip.repeat,
          actLen: scale > 0 ? (strip.end - strip.start) / scale : 0,
        },
        moved: false,
      };
      setPreview(null);
      window.addEventListener('pointermove', onWindowMove);
      window.addEventListener('pointerup', onWindowUp);
    },
    [totalFrames, view, onWindowMove, onWindowUp],
  );

  // ── Selection (§2.8): click strip → selectStrip (a completed drag eats the
  //    trailing click); click track header → selectTrack; Esc clears.
  const onStripClick = useCallback((stripId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return; // the press was a drag, not a select
    }
    useNlaSelectionStore.getState().selectStrip(stripId);
  }, []);

  const onSelectTrack = useCallback((trackId: string) => {
    useNlaSelectionStore.getState().selectTrack(trackId);
  }, []);

  const onPaneKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') useNlaSelectionStore.getState().clear();
  }, []);

  // ── Keyboard parity for the strip gestures (§2.8): ←/→ nudge start by one
  //    frame (Shift = 10) through the SAME setStripTiming commit; M = the
  //    sanctioned raw Strip.muted road; Enter/Space = select.
  const onStripKeyDown = useCallback((e: React.KeyboardEvent, strip: NlaStripBlock) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      useNlaSelectionStore.getState().selectStrip(strip.stripId);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const frames = e.shiftKey ? 10 : 1;
      const delta = (frames / FRAMES_PER_SECOND) * (e.key === 'ArrowRight' ? 1 : -1);
      commitNla(
        'mutator.nla.setStripTiming',
        { stripId: strip.stripId, start: snapToFrame(strip.start + delta, FRAMES_PER_SECOND) },
        'Nudge strip',
      );
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      commitNlaSetParam(strip.stripId, 'muted', !strip.stripMuted, 'toggle strip mute');
    }
  }, []);

  // ── Track state (§2.3/§2.4): M/S through the setTrackState mutator (NOT the
  //    raw TimelineDrawer precedent — it predates the vocabulary); ▲/▼ = ONE
  //    dispatch on ONE track (midpointOrder), disabled at the extremes so a
  //    no-op move never lands a junk undo entry.
  const onToggleTrackMute = useCallback((row: NlaTrackRow) => {
    commitNla(
      'mutator.nla.setTrackState',
      { trackId: row.trackId, mute: !row.muted },
      row.muted ? 'Un-mute track' : 'Mute track',
    );
  }, []);

  const onToggleTrackSolo = useCallback((row: NlaTrackRow) => {
    commitNla(
      'mutator.nla.setTrackState',
      { trackId: row.trackId, solo: !row.solo },
      row.solo ? 'Un-solo track' : 'Solo track',
    );
  }, []);

  const onReorderTrack = useCallback(
    (trackId: string, direction: NlaReorderDirection) => {
      const rows = lanes.rows; // DISPLAY order: 0 = top = highest order
      const i = rows.findIndex((r) => r.trackId === trackId);
      if (i === -1 || reorderDisabled(direction, i, rows.length)) return; // no junk dispatch
      // 'up' lands the track between the row it passes (now below it) and the
      // one above that; 'down' mirrors. midpointOrder(belowOrder, aboveOrder).
      const order =
        direction === 'up'
          ? midpointOrder(rows[i - 1].order, i >= 2 ? rows[i - 2].order : null)
          : midpointOrder(i + 2 < rows.length ? rows[i + 2].order : null, rows[i + 1].order);
      commitNla(
        'mutator.nla.setTrackState',
        { trackId, order },
        direction === 'up' ? 'Move track up' : 'Move track down',
      );
    },
    [lanes],
  );

  // Track-header keyboard parity (§2.8): M/S toggle, Alt+↑/↓ reorder.
  const onHeaderKeyDown = useCallback(
    (e: React.KeyboardEvent, row: NlaTrackRow) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectTrack(row.trackId);
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        onToggleTrackMute(row);
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        onToggleTrackSolo(row);
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        onReorderTrack(row.trackId, e.key === 'ArrowUp' ? 'up' : 'down');
      }
    },
    [onSelectTrack, onToggleTrackMute, onToggleTrackSolo, onReorderTrack],
  );

  // Playhead percent across the visible window (unclamped — hidden when the
  // playhead scrolls off-window).
  const playheadPct = secondsToPercent(seconds, FRAMES_PER_SECOND, totalFrames, view);

  // ── Add-strip entry points (§2.6): a [+ Strip] per track header + one
  //    pane-level button (footer / empty state). All gated on ≥1 Action; the
  //    disabled title names the agent road (mutator.nla.createAction).
  const onOpenAddStrip = useCallback((e: React.MouseEvent, trackId: string | null) => {
    e.stopPropagation();
    setAddStrip({ anchor: e.currentTarget as HTMLElement, trackId });
  }, []);
  const onCloseAddStrip = useCallback(() => setAddStrip(null), []);

  return (
    <div
      role="region"
      aria-label="NLA tracks"
      onKeyDown={onPaneKeyDown}
      className="flex h-full w-full bg-bg text-fg"
    >
      {/* ── Left column: ruler + rows + playhead. The strip inspector (5D) is
          a SIBLING right column, so the playhead calc stays relative to this
          wrapper, not the whole pane. */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
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
            <EmptyState hasActions={hasActions} onAddStrip={onOpenAddStrip} />
          ) : (
            <>
              {lanes.rows.map((row, i) => (
                <TrackRowView
                  key={row.trackId}
                  row={row}
                  hasActions={hasActions}
                  selectedStripId={selectedStripId}
                  selectedTrack={selectedTrackId === row.trackId}
                  reorderUpDisabled={reorderDisabled('up', i, lanes.rows.length)}
                  reorderDownDisabled={reorderDisabled('down', i, lanes.rows.length)}
                  preview={preview}
                  onSelectTrack={onSelectTrack}
                  onHeaderKeyDown={onHeaderKeyDown}
                  onToggleMute={onToggleTrackMute}
                  onToggleSolo={onToggleTrackSolo}
                  onReorder={onReorderTrack}
                  onOpenAddStrip={onOpenAddStrip}
                  onStripPointerDown={onStripPointerDown}
                  onStripClick={onStripClick}
                  onStripKeyDown={onStripKeyDown}
                />
              ))}
              {/* Footer add-strip (the pane-level entry point; NO "Add Track"
                  button ever — track birth folds into addStrip, §1.6 LOCK). */}
              <div className="flex h-6 items-center px-1.5">
                <AddStripButton
                  testid="nla-add-strip"
                  hasActions={hasActions}
                  onClick={(e) => onOpenAddStrip(e, null)}
                />
              </div>
            </>
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

      {/* ── Strip inspector (5D): in-dock right column, shows when a strip is
          selected (stale ids degrade to hidden inside the component). */}
      <NlaStripInspector />

      {/* ── Add-strip popover (5D): portals to document.body — the 240px
          drawer + overflow-auto rows would clip an in-pane overlay (H103). */}
      {addStrip && (
        <NlaAddStripPopover
          anchor={addStrip.anchor}
          defaultTrackId={addStrip.trackId}
          onClose={onCloseAddStrip}
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
  hasActions,
  selectedStripId,
  selectedTrack,
  reorderUpDisabled,
  reorderDownDisabled,
  preview,
  onSelectTrack,
  onHeaderKeyDown,
  onToggleMute,
  onToggleSolo,
  onReorder,
  onOpenAddStrip,
  onStripPointerDown,
  onStripClick,
  onStripKeyDown,
}: {
  row: NlaTrackRow;
  hasActions: boolean;
  selectedStripId: string | null;
  selectedTrack: boolean;
  reorderUpDisabled: boolean;
  reorderDownDisabled: boolean;
  preview: StripPreviewSpan | null;
  onSelectTrack: (trackId: string) => void;
  onHeaderKeyDown: (e: React.KeyboardEvent, row: NlaTrackRow) => void;
  onToggleMute: (row: NlaTrackRow) => void;
  onToggleSolo: (row: NlaTrackRow) => void;
  onReorder: (trackId: string, direction: NlaReorderDirection) => void;
  onOpenAddStrip: (e: React.MouseEvent, trackId: string | null) => void;
  onStripPointerDown: (e: React.PointerEvent, strip: NlaStripBlock, zone: StripDragZone) => void;
  onStripClick: (stripId: string) => void;
  onStripKeyDown: (e: React.KeyboardEvent, strip: NlaStripBlock) => void;
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
      {/* Header cell: click selects the track; M/S/▲▼ commit through the one
          road; keyboard parity M/S/Alt+↑↓ (§2.3/§2.4/§2.8). */}
      <div
        role="button"
        tabIndex={0}
        data-testid={`nla-track-header-${row.trackId}`}
        data-selected={selectedTrack}
        aria-label={`Track ${row.name} — M mutes, S solos, Alt+ArrowUp/Down reorders`}
        onClick={() => onSelectTrack(row.trackId)}
        onKeyDown={(e) => onHeaderKeyDown(e, row)}
        className={`flex shrink-0 cursor-pointer items-center gap-0.5 border-r border-line px-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          selectedTrack ? 'bg-accent/15' : 'bg-bg-2'
        }`}
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
          title={row.muted ? 'Track muted — click to un-mute' : 'Mute track'}
          onToggle={() => onToggleMute(row)}
        />
        <HeaderToggle
          testid={`nla-track-solo-${row.trackId}`}
          label="S"
          pressed={row.solo}
          title={row.solo ? 'Track solos — click to un-solo' : 'Solo track (silences other tracks)'}
          onToggle={() => onToggleSolo(row)}
        />
        <HeaderButton
          testid={`nla-track-up-${row.trackId}`}
          label="▲"
          title="Move track up (Alt+ArrowUp)"
          disabled={reorderUpDisabled}
          onClick={() => onReorder(row.trackId, 'up')}
        />
        <HeaderButton
          testid={`nla-track-down-${row.trackId}`}
          label="▼"
          title="Move track down (Alt+ArrowDown)"
          disabled={reorderDownDisabled}
          onClick={() => onReorder(row.trackId, 'down')}
        />
        <AddStripButton
          testid={`nla-track-add-strip-${row.trackId}`}
          hasActions={hasActions}
          compact
          trackName={row.name}
          onClick={(e) => onOpenAddStrip(e, row.trackId)}
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
            preview={preview && preview.stripId === s.stripId ? preview : null}
            totalFrames={totalFrames}
            view={view}
            onPointerDown={onStripPointerDown}
            onClick={onStripClick}
            onKeyDown={onStripKeyDown}
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
  preview,
  totalFrames,
  view,
  onPointerDown,
  onClick,
  onKeyDown,
}: {
  strip: NlaStripBlock;
  trackName: string;
  selected: boolean;
  preview: StripPreviewSpan | null;
  totalFrames: number;
  view: TimelineView;
  onPointerDown: (e: React.PointerEvent, strip: NlaStripBlock, zone: StripDragZone) => void;
  onClick: (stripId: string) => void;
  onKeyDown: (e: React.KeyboardEvent, strip: NlaStripBlock) => void;
}) {
  // While a drag is in flight, the block renders the PREVIEW span (component-
  // local); the committed position re-derives from the store after pointerup.
  const dragging = preview !== null;
  const dispStart = preview ? preview.start : strip.start;
  const dispEnd = preview ? preview.end : strip.end;
  const { leftPct, widthPct } = spanToPercent(
    dispStart,
    dispEnd,
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

  const clipLen = strip.repeat > 0 ? (dispEnd - dispStart) / strip.repeat : 0;
  const repeatTicks: number[] = [];
  if (strip.repeat > 1 && clipLen > 0) {
    for (let k = 1; k < strip.repeat; k += 1) repeatTicks.push(dispStart + k * clipLen);
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-testid={`nla-strip-${strip.stripId}`}
        data-selected={selected}
        data-dragging={dragging}
        data-muted={strip.stripMuted || strip.trackMuted}
        data-degraded={degraded}
        data-live={strip.live}
        data-blend={strip.blendMode}
        aria-label={`Strip ${strip.name}, ${strip.start}s to ${strip.end}s on track ${trackName}${
          stateNotes.length > 0 ? ` (${stateNotes.join('; ')})` : ''
        }. Drag to move; arrow keys nudge start (Shift = 10 frames); M toggles mute`}
        title={title}
        onPointerDown={(e) => onPointerDown(e, strip, 'move')}
        onClick={() => onClick(strip.stripId)}
        onKeyDown={(e) => onKeyDown(e, strip)}
        className={`absolute top-1/2 flex -translate-y-1/2 cursor-grab items-center overflow-hidden rounded px-1 active:cursor-grabbing ${
          dragging ? 'bg-record' : selected ? 'bg-accent' : 'bg-accent-dim'
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
              width: `${wedgeLocalPct(dispStart, dispStart + strip.blendIn, widthPct, totalFrames, view)}%`,
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
              width: `${wedgeLocalPct(dispEnd - strip.blendOut, dispEnd, widthPct, totalFrames, view)}%`,
              background: 'rgba(14,14,17,0.35)',
              clipPath: 'polygon(0 0, 0 100%, 100% 100%)',
            }}
          />
        )}
        {/* Edge-resize handles (§2.2): 8px hit zones; left pins the right
            edge, right retimes. onStripPointerDown stops propagation → a
            handle press never ALSO starts a body drag. The keyboard path for
            resize = the 5D inspector's number fields (§2.8 LOCK). */}
        <div
          data-testid={`nla-strip-handle-left-${strip.stripId}`}
          aria-hidden
          onPointerDown={(e) => onPointerDown(e, strip, 'left')}
          className="absolute inset-y-0 left-0 cursor-ew-resize"
          style={{ width: NLA_STRIP_HANDLE_PX }}
        />
        <div
          data-testid={`nla-strip-handle-right-${strip.stripId}`}
          aria-hidden
          onPointerDown={(e) => onPointerDown(e, strip, 'right')}
          className="absolute inset-y-0 right-0 cursor-ew-resize"
          style={{ width: NLA_STRIP_HANDLE_PX }}
        />
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

// Track-header M/S toggle: shows the AUTHORED state (aria-pressed +
// data-active) and commits through the setTrackState mutator (§2.3).
// stopPropagation: a toggle press must not ALSO select the track.
function HeaderToggle({
  testid,
  label,
  pressed,
  title,
  onToggle,
}: {
  testid: string;
  label: string;
  pressed: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      data-active={pressed ? true : undefined}
      aria-pressed={pressed}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`shrink-0 rounded px-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        pressed ? 'bg-line text-accent' : 'text-mute hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

// Track-header ▲/▼ reorder button: ONE dispatch on ONE track; DISABLED at the
// display extremes (reorderDisabled) so a no-op move never dispatches (§2.4).
function HeaderButton({
  testid,
  label,
  title,
  disabled,
  onClick,
}: {
  testid: string;
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`shrink-0 rounded px-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        disabled ? 'cursor-not-allowed text-mute opacity-40' : 'text-mute hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

// Empty state (§1.6): names the agent road AND carries the director's
// [Add strip…] entry point (5D — enabled when ≥1 Action exists; the disabled
// title names mutator.nla.createAction). There is NO "Add Track" button ever —
// track birth folds into addStrip by design (LOCKED).
function EmptyState({
  hasActions,
  onAddStrip,
}: {
  hasActions: boolean;
  onAddStrip: (e: React.MouseEvent, trackId: string | null) => void;
}) {
  return (
    <div
      data-testid="nla-empty-state"
      className="flex h-full flex-col items-center justify-center gap-2 px-6"
    >
      <p className="max-w-md text-center text-[11px] text-fg-dim">
        No NLA tracks yet. A strip places a reusable Action on a track — author an Action via{' '}
        <code className="text-fg">mutator.nla.createAction</code> (agent road) or place an existing
        one with <code className="text-fg">mutator.nla.addStrip</code> / the button below (the track
        is created automatically).
      </p>
      <AddStripButton
        testid="nla-add-strip"
        hasActions={hasActions}
        onClick={(e) => onAddStrip(e, null)}
      />
    </div>
  );
}

// The add-strip entry point (§2.6): opens the popover anchored to itself.
// Disabled (with a title naming the agent road) when NO Action exists — the
// popover's Action select would be empty. `compact` = the per-track-header
// "+" variant; the full label lives on the pane-level button. stopPropagation:
// the header button must not ALSO select the track.
function AddStripButton({
  testid,
  hasActions,
  compact,
  trackName,
  onClick,
}: {
  testid: string;
  hasActions: boolean;
  compact?: boolean;
  trackName?: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  const title = hasActions
    ? trackName
      ? `Add strip to track “${trackName}”…`
      : 'Add strip… (place an Action on a track)'
    : 'No Actions yet — author one via mutator.nla.createAction first';
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={!hasActions}
      title={title}
      aria-label={trackName ? `Add strip to track ${trackName}` : 'Add strip'}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={`shrink-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        compact ? 'px-1 text-[10px]' : 'border border-line px-2 py-0.5 text-[11px]'
      } ${hasActions ? 'text-mute hover:text-fg' : 'cursor-not-allowed text-mute opacity-40'}`}
    >
      {compact ? '＋' : '＋ Strip…'}
    </button>
  );
}
