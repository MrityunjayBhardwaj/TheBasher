// LayerTimeline — the Compositor's layer timeline (spine 1c.3a): an AE-style
// outline column (one row per layer: twirl, name, visibility/solo/lock) beside a
// track area (each layer's time bar on a frame ruler, with the playhead). Rows
// render FRONT-on-top (the `layers` list is back→front; AE shows front first).
//
// Read-only bars in 3a — drag-trim/slide/reorder land in 3b; twirl-down keyframe
// property rows land in 3c. Geometry lives in videoTimelineGeometry (H95: one
// place for the constants the e2e mirrors). Edits go through setParam ops (V1).
//
// REF: docs/COMPOSITOR-DESIGN.md §7; vyapti V1 (ops) + V34 + V50 (shared timeline
//      geometry); hetvabhasa H95; issue #237.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import { collectLayerRows, type LayerRow } from './videoLayers';
import {
  OUTLINE_WIDTH_PX,
  ROW_HEIGHT_PX,
  RULER_HEIGHT_PX,
  barPercent,
  frameToPercent,
  layerBarSpan,
} from './videoTimelineGeometry';

const RULER_TICKS = 4; // → ticks at 0, ¼, ½, ¾, end

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function setLayerParam(layerId: NodeId, paramPath: string, value: unknown, label: string): void {
  useDagStore
    .getState()
    .dispatchAtomic([{ type: 'setParam', nodeId: layerId, paramPath, value }], 'user', label);
}

export function LayerTimeline({ compId, comp }: { compId: NodeId; comp: CompositionParams }) {
  const rows = useDagStore((s) => collectLayerRows(s.state, compId));
  const frame = useTimeStore((s) => s.frame);
  const [selectedId, setSelectedId] = useState<NodeId | null>(null);

  const totalFrames = Math.max(1, comp.durationFrames ?? 150);
  const fps = comp.fps ?? 30;
  // The global playhead (60fps seconds) mapped into this comp's frame space.
  const playheadFrame = clamp(Math.round((frame / FRAMES_PER_SECOND) * fps), 0, totalFrames);
  const playheadPct = frameToPercent(playheadFrame, totalFrames);

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
        {display.map((row) => (
          <OutlineRow
            key={row.id}
            row={row}
            selected={row.id === selectedId}
            onSelect={() => setSelectedId(row.id)}
          />
        ))}
      </div>

      {/* Track column (right): the coordinate space for bars + ruler + playhead. */}
      <div className="relative flex-1 bg-bg-2" style={{ minWidth: 0 }}>
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
          {display.map((row) => (
            <TrackRow
              key={row.id}
              row={row}
              totalFrames={totalFrames}
              selected={row.id === selectedId}
              onSelect={() => setSelectedId(row.id)}
            />
          ))}
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
  onSelect,
}: {
  row: LayerRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      data-testid={`layer-row-${row.id}`}
      data-selected={selected}
      onClick={onSelect}
      className={`flex items-center gap-1 border-b border-line px-1.5 text-[11px] ${
        selected ? 'bg-accent/15' : 'hover:bg-muted/30'
      }`}
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
}: {
  row: LayerRow;
  totalFrames: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const span = layerBarSpan(row, row.srcFrames);
  const { leftPct, widthPct } = barPercent(span, totalFrames);
  return (
    <div
      className="relative border-b border-line"
      style={{ height: ROW_HEIGHT_PX, opacity: row.enabled ? 1 : 0.4 }}
    >
      <button
        type="button"
        data-testid={`layer-bar-${row.id}`}
        onClick={onSelect}
        title={row.name}
        className={`absolute top-1/2 -translate-y-1/2 overflow-hidden rounded ${
          selected ? 'bg-accent' : 'bg-accent-dim'
        } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, height: ROW_HEIGHT_PX - 10 }}
      />
    </div>
  );
}
