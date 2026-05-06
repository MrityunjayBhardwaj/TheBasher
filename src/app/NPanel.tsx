// NPanel — Blender-style "N" overlay anchored to the top-right of the
// viewport. Quick toggles for editor-only behaviors (gizmo mode, snap,
// grid + axis-widget visibility) plus a one-line read of the primary
// selection's transform.
//
// HTML, not R3F: this overlay is drawn over the Canvas via DOM, not as
// scene content. It belongs in src/app/ (file-rooted V8) and reads/writes
// UI projection stores only — never the DAG.
//
// Collapsed by default; toggle with the "N" pill or the keyboard handler
// in KeyboardShortcuts (P2.1 leaves the keybinding to v0.6 per Blender's
// "N" panel idiom — for now, click the pill).

import { useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore } from './stores/viewportStore';

const MODE_LABELS: { value: GizmoMode; label: string; key: string }[] = [
  { value: 'translate', label: 'Move', key: 'G' },
  { value: 'rotate', label: 'Rotate', key: 'R' },
  { value: 'scale', label: 'Scale', key: 'S' },
];

function ModeButtons() {
  const mode = useGizmoStore((s) => s.mode);
  const setMode = useGizmoStore((s) => s.setMode);
  return (
    <div className="flex gap-1">
      {MODE_LABELS.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => setMode(m.value)}
          data-testid={`npanel-mode-${m.value}`}
          className={`flex-1 rounded border px-2 py-1 text-[10px] uppercase tracking-wide ${
            mode === m.value
              ? 'border-accent bg-accent/20 text-accent'
              : 'border-border bg-muted text-fg/70 hover:border-accent/60'
          }`}
          title={`${m.label} (${m.key})`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function SnapControls() {
  const snapEnabled = useViewportStore((s) => s.snapEnabled);
  const snapStep = useViewportStore((s) => s.snapStep);
  const toggleSnap = useViewportStore((s) => s.toggleSnapEnabled);
  const setSnapStep = useViewportStore((s) => s.setSnapStep);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggleSnap}
        data-testid="npanel-snap-toggle"
        className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wide ${
          snapEnabled
            ? 'border-accent bg-accent/20 text-accent'
            : 'border-border bg-muted text-fg/70 hover:border-accent/60'
        }`}
      >
        snap {snapEnabled ? 'on' : 'off'}
      </button>
      <label className="flex flex-1 items-center gap-1 text-[10px] text-fg/60">
        step
        <input
          type="number"
          step="0.05"
          min={0}
          value={snapStep}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n)) setSnapStep(n);
          }}
          data-testid="npanel-snap-step"
          className="w-16 rounded border border-border bg-muted px-1.5 py-0.5 text-right font-mono text-[10px] text-fg focus:border-accent focus:outline-none"
        />
      </label>
    </div>
  );
}

function VisibilityToggles() {
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const axisWidgetVisible = useViewportStore((s) => s.axisWidgetVisible);
  const toggleGrid = useViewportStore((s) => s.toggleGridVisible);
  const toggleAxis = useViewportStore((s) => s.toggleAxisWidgetVisible);
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={toggleGrid}
        data-testid="npanel-toggle-grid"
        className={`flex-1 rounded border px-2 py-1 text-[10px] uppercase tracking-wide ${
          gridVisible
            ? 'border-accent bg-accent/20 text-accent'
            : 'border-border bg-muted text-fg/70 hover:border-accent/60'
        }`}
      >
        grid
      </button>
      <button
        type="button"
        onClick={toggleAxis}
        data-testid="npanel-toggle-axis"
        className={`flex-1 rounded border px-2 py-1 text-[10px] uppercase tracking-wide ${
          axisWidgetVisible
            ? 'border-accent bg-accent/20 text-accent'
            : 'border-border bg-muted text-fg/70 hover:border-accent/60'
        }`}
      >
        axis
      </button>
    </div>
  );
}

function PrimarySummary() {
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const node = useDagStore((s) => (primaryId ? s.state.nodes[primaryId] : null));
  if (!node) {
    return (
      <div className="text-[10px] text-fg/40" data-testid="npanel-primary-empty">
        nothing selected
      </div>
    );
  }
  const params = node.params as Record<string, unknown>;
  const pos = Array.isArray(params.position) ? (params.position as number[]) : null;
  return (
    <div className="flex flex-col gap-0.5 text-[10px] text-fg/60" data-testid="npanel-primary">
      <div className="flex justify-between">
        <span className="text-fg/40">node</span>
        <span className="font-mono text-fg/80">{node.type}</span>
      </div>
      {pos ? (
        <div className="flex justify-between gap-2">
          <span className="text-fg/40">pos</span>
          <span className="font-mono text-fg/80">
            {pos[0]?.toFixed(2)} {pos[1]?.toFixed(2)} {pos[2]?.toFixed(2)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function NPanel() {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-30 flex flex-col items-end gap-1 font-mono text-fg"
      data-testid="npanel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="npanel-toggle"
        className="pointer-events-auto rounded border border-border bg-bg/80 px-2 py-1 text-[10px] uppercase tracking-wide text-fg/70 backdrop-blur hover:border-accent"
        title="Toggle viewport panel"
      >
        N {open ? '▾' : '▸'}
      </button>
      {open ? (
        <div
          data-testid="npanel-body"
          className="pointer-events-auto flex w-[220px] flex-col gap-2 rounded border border-border bg-bg/80 p-2 text-[10px] backdrop-blur"
        >
          <ModeButtons />
          <SnapControls />
          <VisibilityToggles />
          <div className="border-t border-border pt-1.5">
            <PrimarySummary />
          </div>
        </div>
      ) : null}
    </div>
  );
}
