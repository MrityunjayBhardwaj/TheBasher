// TopToolbar — R3 per UI-SPEC §5.3. Wraps the existing TransformToolbar in
// its left segment and adds:
//
//   center  — 4-button mode pill (Edit / Run / Animate / Director)
//   right   — zoom % menu (placeholder), Export, Director Cut shortcut
//
// REUSE rule: the spec says "Mounts existing TransformToolbar in its left
// segment". TransformToolbar's existing groups (gizmo mode + snap +
// shading + space) move here as-is in W2; W7's FloatingViewportToolbar
// will absorb the gizmo + grid + persp/ortho controls and TransformToolbar
// will be split apart. For W2, no internal changes to TransformToolbar.
//
// Mode pill: click sets useModeStore.setMode. Active mode = bg-accent /
// text-bg, inactive = bg-muted / text-fg-dim. Keyboard 1/2/3/4 cycle the
// same setMode (wired in KeyboardShortcuts).
//
// Export: shares exportDagJson with the File → Export menu item — single
// source of truth.
//
// Director Cut button: a one-click way to enter director mode. Esc returns
// to edit (per W1's universal-Esc handler).
//
// V8 file-rooted: this component reads + dispatches only UI projection
// stores. No DAG mutation.
//
// REF: docs/UI-SPEC.md §5.3, §6.4, §3.4; THESIS.md §11, §17.

import type { ReactNode } from 'react';
import { exportDagJson } from './exportDag';
import { useAddMenuStore } from './stores/addMenuStore';
import { useModeStore, type Mode } from './stores/modeStore';
import { TransformToolbar } from './TransformToolbar';

interface ModePillEntry {
  readonly value: Mode;
  readonly label: string;
  readonly icon: string;
  readonly key: string;
}

const MODE_PILL: readonly ModePillEntry[] = [
  { value: 'edit', label: 'Edit', icon: '◐', key: '1' },
  { value: 'run', label: 'Run', icon: '▶', key: '2' },
  { value: 'animate', label: 'Animate', icon: '⏱', key: '3' },
  { value: 'director', label: 'Director', icon: '⛶', key: '4' },
];

function openAddMenuAtToolbar(): void {
  const tb = document.querySelector('[data-testid="top-toolbar"]') as HTMLElement | null;
  if (tb) {
    const r = tb.getBoundingClientRect();
    useAddMenuStore.getState().openAt(r.left + 16, r.bottom + 4);
    return;
  }
  useAddMenuStore.getState().openAt(window.innerWidth / 2, window.innerHeight / 2);
}

function AddButton(): ReactNode {
  return (
    <button
      type="button"
      onClick={openAddMenuAtToolbar}
      data-testid="top-toolbar-add"
      title="Add primitive (A or Shift+A)"
      className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent"
    >
      <span aria-hidden>+</span>
      <span>Add</span>
    </button>
  );
}

function ModePill(): ReactNode {
  const mode = useModeStore((s) => s.mode);
  const setMode = useModeStore((s) => s.setMode);
  return (
    <div
      data-testid="top-toolbar-mode-pill"
      className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5"
    >
      {MODE_PILL.map((m) => {
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            data-testid={`top-toolbar-mode-${m.value}`}
            title={`${m.label} (${m.key})`}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-mono uppercase tracking-wide transition-colors ${
              active
                ? 'bg-accent text-bg'
                : 'text-fg-dim hover:bg-muted hover:text-fg'
            }`}
          >
            <span aria-hidden>{m.icon}</span>
            <span>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RightCluster(): ReactNode {
  const setMode = useModeStore((s) => s.setMode);
  return (
    <div className="flex items-center gap-2">
      {/* Zoom % is a placeholder until a real zoom-control plumbing lands.
          Kept visible (per spec §5.3 anatomy) but disabled so it advertises
          the affordance without claiming it works. */}
      <button
        type="button"
        disabled
        data-testid="top-toolbar-zoom"
        title="Viewport zoom — coming in a later wave"
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/30 px-2 text-[10px] font-mono uppercase tracking-wide text-fg-mute"
      >
        <span>100%</span>
        <span aria-hidden>▾</span>
      </button>
      <button
        type="button"
        onClick={exportDagJson}
        data-testid="top-toolbar-export"
        title="Export DAG as JSON"
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent"
      >
        <span aria-hidden>⬇</span>
        <span>Export</span>
      </button>
      <button
        type="button"
        onClick={() => setMode('director')}
        data-testid="top-toolbar-present"
        title="Director Cut — chrome-hidden viewport (Esc returns)"
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent"
      >
        <span aria-hidden>⛚</span>
        <span>Present</span>
      </button>
    </div>
  );
}

export function TopToolbar(): ReactNode {
  // Three-zone layout: left (auto), center (absolute-centered), right (auto).
  // Absolute-centering the mode pill keeps it visually centered regardless
  // of how wide the left/right clusters get; the pill never drifts when
  // TransformToolbar gains/loses controls.
  return (
    <div
      data-testid="top-toolbar"
      className="relative flex items-center gap-3 border-b border-border bg-bg/95 px-3 py-1 font-mono text-fg"
    >
      {/* Left zone: primary actions + TransformToolbar internals (W2 reuse). */}
      <div className="flex items-center gap-3 min-w-0 overflow-x-auto">
        <AddButton />
        <TransformToolbar />
      </div>
      {/* Center zone: 4-button mode pill (D-UX-6). Absolute so it stays
          centered relative to the toolbar, not relative to left content. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="pointer-events-auto">
          <ModePill />
        </div>
      </div>
      {/* Right zone: viewport + output cluster, pinned right. */}
      <div className="ml-auto">
        <RightCluster />
      </div>
    </div>
  );
}
