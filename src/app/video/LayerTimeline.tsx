// LayerTimeline — the Compositor's layer timeline (spine 1c.3a): an AE-style
// outline column (one row per layer: twirl, name, visibility/solo/lock) beside a
// track area (each layer's time bar on a frame ruler, with the playhead). Rows
// render FRONT-on-top (the `layers` list is back→front; AE shows front first).
//
// Bars are draggable in 3b: the left/right handles trim inPoint/outPoint, the
// body slides startFrame, and a locked layer ignores the gesture. Drag-reorder
// of rows + twirl-down keyframe property rows land in 3b-ii/3c. Geometry +
// the drag math live in videoTimelineGeometry (H95: one place for the constants
// the e2e mirrors). Edits go through setParam ops (V1), one atomic per drag.
//
// REF: docs/COMPOSITOR-DESIGN.md §7; vyapti V1 (ops) + V34 + V50 (shared timeline
//      geometry); hetvabhasa H95; issue #237.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { NodeId, Op } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import { buildReorderLayerOps, collectLayerRows, type LayerRow } from './videoLayers';
import {
  BAR_TRIM_HANDLE_PX,
  OUTLINE_WIDTH_PX,
  ROW_HEIGHT_PX,
  RULER_HEIGHT_PX,
  applyBarDrag,
  barPercent,
  frameToPercent,
  layerBarSpan,
  xDeltaToFrameDelta,
  type BarDragMode,
  type LayerBarParams,
} from './videoTimelineGeometry';

const RULER_TICKS = 4; // → ticks at 0, ¼, ½, ¾, end
/** Movement (CSS px) past which a press becomes a drag, not a click-to-select. */
const DRAG_THRESHOLD_PX = 3;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function setLayerParam(layerId: NodeId, paramPath: string, value: unknown, label: string): void {
  useDagStore
    .getState()
    .dispatchAtomic([{ type: 'setParam', nodeId: layerId, paramPath, value }], 'user', label);
}

/** An in-flight bar drag — the start anchor + the layer's params at grab time. */
interface BarDrag {
  layerId: NodeId;
  mode: BarDragMode;
  startClientX: number;
  trackWidthPx: number;
  totalFrames: number;
  srcFrames: number;
  orig: LayerBarParams;
  moved: boolean;
}

const DRAG_LABELS: Record<BarDragMode, string> = {
  'trim-left': 'trim layer in-point',
  'trim-right': 'trim layer out-point',
  slide: 'slide layer in time',
};

export function LayerTimeline({ compId, comp }: { compId: NodeId; comp: CompositionParams }) {
  const rows = useDagStore((s) => collectLayerRows(s.state, compId));
  const frame = useTimeStore((s) => s.frame);
  const [selectedId, setSelectedId] = useState<NodeId | null>(null);

  const totalFrames = Math.max(1, comp.durationFrames ?? 150);
  const fps = comp.fps ?? 30;
  // The global playhead (60fps seconds) mapped into this comp's frame space.
  const playheadFrame = clamp(Math.round((frame / FRAMES_PER_SECOND) * fps), 0, totalFrames);
  const playheadPct = frameToPercent(playheadFrame, totalFrames);

  // Bar drag (3b): the track element (for measuring px width), the live drag, a
  // preview of the dragged layer's params, and a flag to swallow the trailing
  // click so a drag never also selects.
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<BarDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<{ layerId: NodeId; params: LayerBarParams } | null>(null);

  const onWindowMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = e.clientX - d.startClientX;
    if (Math.abs(deltaPx) > DRAG_THRESHOLD_PX) d.moved = true;
    const deltaFrames = xDeltaToFrameDelta(deltaPx, d.trackWidthPx, d.totalFrames);
    setPreview({
      layerId: d.layerId,
      params: applyBarDrag(d.orig, d.srcFrames, d.mode, deltaFrames),
    });
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
      const deltaFrames = xDeltaToFrameDelta(
        e.clientX - d.startClientX,
        d.trackWidthPx,
        d.totalFrames,
      );
      const next = applyBarDrag(d.orig, d.srcFrames, d.mode, deltaFrames);
      const ops: Op[] = [];
      if (next.startFrame !== d.orig.startFrame)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'startFrame',
          value: next.startFrame,
        });
      if (next.inPoint !== d.orig.inPoint)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'inPoint',
          value: next.inPoint,
        });
      if (next.outPoint !== d.orig.outPoint)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'outPoint',
          value: next.outPoint,
        });
      if (ops.length) useDagStore.getState().dispatchAtomic(ops, 'user', DRAG_LABELS[d.mode]);
    },
    [onWindowMove],
  );

  // Stop listening if the timeline unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
    };
  }, [onWindowMove, onWindowUp]);

  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, row: LayerRow, mode: BarDragMode) => {
      if (row.locked) return; // lock gates drag (the L toggle)
      const track = trackRef.current;
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        layerId: row.id,
        mode,
        startClientX: e.clientX,
        trackWidthPx: track.getBoundingClientRect().width,
        totalFrames,
        srcFrames: row.srcFrames,
        orig: { startFrame: row.startFrame, inPoint: row.inPoint, outPoint: row.outPoint },
        moved: false,
      };
      setPreview(null);
      window.addEventListener('pointermove', onWindowMove);
      window.addEventListener('pointerup', onWindowUp);
    },
    [totalFrames, onWindowMove, onWindowUp],
  );

  const onRowClick = useCallback((id: NodeId) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return; // the press was a drag, not a select
    }
    setSelectedId(id);
  }, []);

  // Row drag (3b-ii): drag an outline row vertically to reorder comp.layers. The
  // rows render front-on-top (display index 0 = top/front); the dropped DISPLAY
  // slot converts to a raw layer index (back→front) for the reorder op.
  const rowsRef = useRef<HTMLDivElement>(null);
  const rowDragRef = useRef<{
    layerId: NodeId;
    containerTop: number;
    rowCount: number;
    moved: boolean;
  } | null>(null);
  const [rowDragId, setRowDragId] = useState<NodeId | null>(null);
  const [dropDisplay, setDropDisplay] = useState<number | null>(null);

  const dropIndexAt = (clientY: number, top: number, rowCount: number) =>
    clamp(Math.floor((clientY - top) / ROW_HEIGHT_PX), 0, rowCount - 1);

  const onRowWindowMove = useCallback((e: PointerEvent) => {
    const d = rowDragRef.current;
    if (!d) return;
    d.moved = true;
    setDropDisplay(dropIndexAt(e.clientY, d.containerTop, d.rowCount));
  }, []);

  const onRowWindowUp = useCallback(
    (e: PointerEvent) => {
      window.removeEventListener('pointermove', onRowWindowMove);
      window.removeEventListener('pointerup', onRowWindowUp);
      const d = rowDragRef.current;
      rowDragRef.current = null;
      setRowDragId(null);
      setDropDisplay(null);
      if (!d || !d.moved) return;
      suppressClickRef.current = true;
      const display = dropIndexAt(e.clientY, d.containerTop, d.rowCount);
      const rawTo = d.rowCount - 1 - display; // display (front-on-top) → raw (back→front)
      const ops = buildReorderLayerOps(useDagStore.getState().state, compId, d.layerId, rawTo);
      if (ops.length) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder layer');
    },
    [compId, onRowWindowMove],
  );

  const onRowPointerDown = useCallback(
    (e: React.PointerEvent, row: LayerRow) => {
      if (row.locked) return; // lock gates reorder
      if ((e.target as HTMLElement).closest('button')) return; // a toggle, not a drag-grab
      const container = rowsRef.current;
      if (!container) return;
      rowDragRef.current = {
        layerId: row.id,
        containerTop: container.getBoundingClientRect().top,
        rowCount: rows.length,
        moved: false,
      };
      setRowDragId(row.id);
      window.addEventListener('pointermove', onRowWindowMove);
      window.addEventListener('pointerup', onRowWindowUp);
    },
    [rows.length, onRowWindowMove, onRowWindowUp],
  );

  // Stop listening if the timeline unmounts mid row-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onRowWindowMove);
      window.removeEventListener('pointerup', onRowWindowUp);
    };
  }, [onRowWindowMove, onRowWindowUp]);

  // Front-on-top: the layers list is back→front; reverse for display.
  const display = [...rows].reverse();

  return (
    <div
      data-testid="layer-timeline"
      className="flex flex-1 overflow-auto"
      style={{ minHeight: 0 }}
    >
      {/* Outline column (left): layer names + toggles. */}
      <div
        className="flex shrink-0 flex-col border-r border-line bg-bg"
        style={{ width: OUTLINE_WIDTH_PX }}
      >
        <div
          className="flex items-center border-b border-line px-2 text-[10px] uppercase tracking-wide text-mute"
          style={{ height: RULER_HEIGHT_PX }}
        >
          Layers
        </div>
        <div ref={rowsRef} className="relative">
          {display.map((row) => (
            <OutlineRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              dragging={row.id === rowDragId}
              onSelect={() => onRowClick(row.id)}
              onPointerDownDrag={(e) => onRowPointerDown(e, row)}
            />
          ))}
          {/* Drop indicator — where a dragged row would land. */}
          {dropDisplay !== null && (
            <div
              data-testid="layer-row-drop-indicator"
              className="pointer-events-none absolute left-0 right-0 h-0.5 bg-accent"
              style={{ top: dropDisplay * ROW_HEIGHT_PX }}
            />
          )}
        </div>
      </div>

      {/* Track column (right): the coordinate space for bars + ruler + playhead. */}
      <div ref={trackRef} className="relative flex-1 bg-bg-2" style={{ minWidth: 0 }}>
        {/* Frame ruler. */}
        <div className="relative border-b border-line" style={{ height: RULER_HEIGHT_PX }}>
          {Array.from({ length: RULER_TICKS + 1 }, (_, i) => {
            const tickFrame = Math.round((totalFrames * i) / RULER_TICKS);
            return (
              <span
                key={i}
                className="absolute top-1/2 -translate-y-1/2 px-1 text-[10px] text-mute"
                style={{ left: `${frameToPercent(tickFrame, totalFrames)}%` }}
              >
                {tickFrame}
              </span>
            );
          })}
        </div>
        {/* Layer bars. */}
        <div>
          {display.map((row) => {
            // While dragging this row, render from the live preview params.
            const shown =
              preview && preview.layerId === row.id ? { ...row, ...preview.params } : row;
            return (
              <TrackRow
                key={row.id}
                row={shown}
                totalFrames={totalFrames}
                selected={row.id === selectedId}
                onSelect={() => onRowClick(row.id)}
                onPointerDownMode={(e, mode) => onBarPointerDown(e, row, mode)}
              />
            );
          })}
        </div>
        {/* Playhead — spans the rows below the ruler. */}
        <div
          data-testid="layer-timeline-playhead"
          className="pointer-events-none absolute w-px bg-accent"
          style={{ top: RULER_HEIGHT_PX, bottom: 0, left: `${playheadPct}%` }}
        />
      </div>
    </div>
  );
}

function OutlineRow({
  row,
  selected,
  dragging,
  onSelect,
  onPointerDownDrag,
}: {
  row: LayerRow;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onPointerDownDrag: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      data-testid={`layer-row-${row.id}`}
      data-selected={selected}
      data-dragging={dragging}
      onClick={onSelect}
      onPointerDown={onPointerDownDrag}
      className={`flex items-center gap-1 border-b border-line px-1.5 text-[11px] ${
        row.locked ? '' : 'cursor-grab active:cursor-grabbing'
      } ${dragging ? 'opacity-50' : ''} ${selected ? 'bg-accent/15' : 'hover:bg-muted/30'}`}
      style={{ height: ROW_HEIGHT_PX }}
    >
      {/* Twirl — opens the property rows in 3c (inert for now). */}
      <span className="w-3 text-center text-mute" aria-hidden>
        ▸
      </span>
      <span className="flex-1 truncate text-fg" title={row.name}>
        {row.name}
      </span>
      <ToggleButton
        testId={`layer-vis-${row.id}`}
        label="Toggle visibility"
        active={row.enabled}
        glyph={row.enabled ? '◉' : '◌'}
        onToggle={() => setLayerParam(row.id, 'enabled', !row.enabled, 'toggle layer visibility')}
      />
      <ToggleButton
        testId={`layer-solo-${row.id}`}
        label="Toggle solo"
        active={row.solo}
        glyph="S"
        onToggle={() => setLayerParam(row.id, 'solo', !row.solo, 'toggle layer solo')}
      />
      <ToggleButton
        testId={`layer-lock-${row.id}`}
        label="Toggle lock"
        active={row.locked}
        glyph="L"
        onToggle={() => setLayerParam(row.id, 'locked', !row.locked, 'toggle layer lock')}
      />
    </div>
  );
}

function ToggleButton({
  testId,
  label,
  active,
  glyph,
  onToggle,
}: {
  testId: string;
  label: string;
  active: boolean;
  glyph: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`flex h-4 w-4 items-center justify-center rounded text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'text-accent' : 'text-fg/40 hover:text-fg'
      }`}
    >
      {glyph}
    </button>
  );
}

function TrackRow({
  row,
  totalFrames,
  selected,
  onSelect,
  onPointerDownMode,
}: {
  row: LayerRow;
  totalFrames: number;
  selected: boolean;
  onSelect: () => void;
  onPointerDownMode: (e: React.PointerEvent, mode: BarDragMode) => void;
}) {
  const span = layerBarSpan(row, row.srcFrames);
  const { leftPct, widthPct } = barPercent(span, totalFrames);
  // A locked layer is a plain select target — no drag handles, no grab cursor.
  const draggable = !row.locked;
  return (
    <div
      className="relative border-b border-line"
      style={{ height: ROW_HEIGHT_PX, opacity: row.enabled ? 1 : 0.4 }}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`layer-bar-${row.id}`}
        data-locked={row.locked}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        title={row.name}
        className={`absolute top-1/2 flex -translate-y-1/2 overflow-hidden rounded ${
          selected ? 'bg-accent' : 'bg-accent-dim'
        } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, height: ROW_HEIGHT_PX - 10 }}
      >
        {draggable && (
          <div
            data-testid={`layer-handle-trim-left-${row.id}`}
            aria-hidden
            onPointerDown={(e) => onPointerDownMode(e, 'trim-left')}
            className="h-full shrink-0 cursor-ew-resize"
            style={{ width: BAR_TRIM_HANDLE_PX }}
          />
        )}
        <div
          data-testid={`layer-handle-slide-${row.id}`}
          aria-hidden
          onPointerDown={draggable ? (e) => onPointerDownMode(e, 'slide') : undefined}
          className={`h-full flex-1 ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
        />
        {draggable && (
          <div
            data-testid={`layer-handle-trim-right-${row.id}`}
            aria-hidden
            onPointerDown={(e) => onPointerDownMode(e, 'trim-right')}
            className="h-full shrink-0 cursor-ew-resize"
            style={{ width: BAR_TRIM_HANDLE_PX }}
          />
        )}
      </div>
    </div>
  );
}
