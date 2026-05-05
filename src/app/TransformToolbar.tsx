// TransformToolbar — top-bar surface for the most-frequent viewport
// behaviors: gizmo mode (Move / Rotate / Scale), snap on/off + step,
// and the editor SpaceType toggle (3D viewport ↔ UV editor).
//
// Sits above Chrome in Layout. NPanel keeps the same controls inside
// the viewport overlay; the toolbar makes them always visible without
// requiring users to open the N panel.
//
// File-rooted V8: lives in src/app/, mutates only UI projection stores
// (gizmoStore, viewportStore, editorStore) — never the DAG.
//
// REF: THESIS.md §11, §15.

import { useEditorStore, type SpaceType } from './stores/editorStore';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useViewportStore } from './stores/viewportStore';

const MODES: { value: GizmoMode; label: string; key: string; icon: string }[] = [
  { value: 'translate', label: 'Move', key: 'G', icon: '⇄' },
  { value: 'rotate', label: 'Rotate', key: 'R', icon: '⟲' },
  { value: 'scale', label: 'Scale', key: 'S', icon: '⤢' },
];

const SPACES: { value: SpaceType; label: string; key: string }[] = [
  { value: 'view3d', label: '3D View', key: 'Tab' },
  { value: 'uv', label: 'UV Editor', key: 'Tab' },
];

function ModeGroup() {
  const mode = useGizmoStore((s) => s.mode);
  const setMode = useGizmoStore((s) => s.setMode);
  return (
    <div className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => setMode(m.value)}
          data-testid={`toolbar-mode-${m.value}`}
          title={`${m.label} (${m.key})`}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-mono uppercase tracking-wide ${
            mode === m.value
              ? 'bg-accent/25 text-accent'
              : 'text-fg/70 hover:bg-muted hover:text-fg'
          }`}
        >
          <span aria-hidden>{m.icon}</span>
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

function SnapGroup() {
  const snapEnabled = useViewportStore((s) => s.snapEnabled);
  const snapStep = useViewportStore((s) => s.snapStep);
  const toggle = useViewportStore((s) => s.toggleSnapEnabled);
  const setStep = useViewportStore((s) => s.setSnapStep);
  return (
    <div className="flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        data-testid="toolbar-snap-toggle"
        title="Toggle translation snap"
        className={`rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${
          snapEnabled ? 'bg-accent/25 text-accent' : 'text-fg/60 hover:text-fg'
        }`}
      >
        snap
      </button>
      <input
        type="number"
        step="0.05"
        min={0}
        value={snapStep}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) setStep(n);
        }}
        data-testid="toolbar-snap-step"
        className="w-14 rounded border border-border bg-bg px-1.5 py-0.5 text-right font-mono text-[10px] text-fg focus:border-accent focus:outline-none"
        title="Snap step (world units)"
      />
    </div>
  );
}

function ShadingGroup() {
  const shading = useViewportStore((s) => s.shading);
  const setShading = useViewportStore((s) => s.setShading);
  return (
    <div className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5">
      <button
        type="button"
        onClick={() => setShading('studio')}
        data-testid="toolbar-shading-studio"
        title="Studio fill — editor-only lights for visibility"
        className={`rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${
          shading === 'studio' ? 'bg-accent/25 text-accent' : 'text-fg/60 hover:text-fg'
        }`}
      >
        studio
      </button>
      <button
        type="button"
        onClick={() => setShading('rendered')}
        data-testid="toolbar-shading-rendered"
        title="Rendered — DAG lights only (matches what renders will look like)"
        className={`rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${
          shading === 'rendered' ? 'bg-accent/25 text-accent' : 'text-fg/60 hover:text-fg'
        }`}
      >
        rendered
      </button>
    </div>
  );
}

function SpaceGroup() {
  const space = useEditorStore((s) => s.space);
  const setSpace = useEditorStore((s) => s.setSpace);
  return (
    <div className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5">
      {SPACES.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => setSpace(s.value)}
          data-testid={`toolbar-space-${s.value}`}
          title={`${s.label} (${s.key} to toggle)`}
          className={`rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${
            space === s.value ? 'bg-accent/25 text-accent' : 'text-fg/60 hover:text-fg'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function TransformToolbar() {
  return (
    <div
      data-testid="transform-toolbar"
      className="flex items-center gap-3 border-b border-border bg-bg/95 px-3 py-1.5 font-mono text-fg"
    >
      <ModeGroup />
      <SnapGroup />
      <ShadingGroup />
      <div className="ml-auto">
        <SpaceGroup />
      </div>
    </div>
  );
}
