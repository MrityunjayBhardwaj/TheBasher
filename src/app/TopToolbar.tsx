// TopToolbar — R3 per UI-SPEC §5.3. The top horizontal toolbar across
// the editor, three-zone flex layout:
//
//   left   — Add menu + Assets popover + space toggle (3D View ↔ UV)
//   center — (empty — the operational-mode pill was dissolved in v0.6 #4;
//            W1 will move the surviving controls onto the floating pill)
//   right  — live viewport zoom % readout + Export + Present toggle
//
// History note (P6 W7, 2026-05-14): the original W2 implementation
// nested TransformToolbar in the left zone, carrying gizmo + snap +
// shading + space groups. W7's FloatingViewportToolbar (R8) absorbed
// gizmo + grid + shading + snap (D-W7-3: viewport-state knobs belong
// near the viewport, Spline pattern). TransformToolbar.tsx was deleted
// in this wave; SpaceGroup's two buttons are inlined here since
// wrapping a single group in its own component is shallow per Hickey/
// Ousterhout. Testids (toolbar-space-view3d / toolbar-space-uv) are
// preserved verbatim so P2.6 + downstream e2e suites pass through
// without migration.
//
// Export: shares exportDagJson with the File → Export menu item —
// single source of truth.
//
// Present button: a one-click way to enter the fullscreen present /
// director-cut layout (chromeStore.presentMode — the re-home for the
// deleted `director` mode). Esc returns (KeyboardShortcuts Esc ladder).
//
// V8 file-rooted: this component reads + dispatches only UI projection
// stores. No DAG mutation.
//
// REF: docs/UI-SPEC.md §5.3, §6.4, §3.4; THESIS.md §11, §17.
// W7 ref: memory/project_p6_w7_plan.md C2.

import type { ReactNode } from 'react';
import { useAssetsPopoverStore } from './AssetsPopover';
import { exportDagJson } from './exportDag';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore, type SpaceType } from './stores/editorStore';
import { useViewportStore } from './stores/viewportStore';

interface SpaceEntry {
  readonly value: SpaceType;
  readonly label: string;
  readonly key: string;
}

const SPACES: readonly SpaceEntry[] = [
  { value: 'view3d', label: '3D View', key: 'Tab' },
  { value: 'uv', label: 'UV Editor', key: 'Tab' },
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
      className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span aria-hidden>+</span>
      <span>Add</span>
    </button>
  );
}

function AssetsButton(): ReactNode {
  // Anchor the popover to the bottom-left of this button so the list
  // appears directly below the trigger. Toggle behavior: clicking again
  // closes (no anchor change needed; the popover store flips open).
  const open = useAssetsPopoverStore((s) => s.open);
  const openAt = useAssetsPopoverStore((s) => s.openAt);
  const close = useAssetsPopoverStore((s) => s.close);
  return (
    <button
      type="button"
      onClick={(e) => {
        if (open) {
          close();
          return;
        }
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openAt(r.left, r.bottom + 4);
      }}
      data-testid="top-toolbar-assets"
      title="Sample assets"
      className={`flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-mono uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        open
          ? 'border-accent bg-accent/15 text-accent'
          : 'border-border bg-muted/40 text-fg/80 hover:border-accent hover:text-accent'
      }`}
    >
      <span aria-hidden>📦</span>
      <span>Assets</span>
    </button>
  );
}

// Inlined ex-TransformToolbar SpaceGroup. Same testids + visual treatment
// as the W2 implementation so e2e specs that exercised 3D↔UV switching
// pass through unchanged.
function SpaceGroup(): ReactNode {
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
          className={`rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            space === s.value ? 'bg-accent/25 text-accent' : 'text-fg/60 hover:text-fg'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function RightCluster(): ReactNode {
  const togglePresentMode = useChromeStore((s) => s.togglePresentMode);
  // c-1 (P6 W10 UIR): live viewport zoom %. The signal is the
  // OrbitControls camera→target distance, derived in viewportStore by
  // the Viewport.tsx onChange listener (§5.3 anatomy — the readout is
  // a real value, no longer a dead 100% placeholder). The control is
  // still a readout (not a zoom-input dropdown): §5.3 anatomy lists
  // `[100% ▾]` as the zoom % display; no interactive zoom-input
  // dropdown is promised by the spec, so the button stays disabled and
  // the ▾ is decorative.
  const cameraZoom = useViewportStore((s) => s.cameraZoom);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled
        data-testid="top-toolbar-zoom"
        title={`Viewport zoom — ${cameraZoom}%`}
        aria-label={`Viewport zoom ${cameraZoom} percent`}
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/30 px-2 text-[10px] font-mono uppercase tracking-wide text-fg-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span data-testid="top-toolbar-zoom-value">{cameraZoom}%</span>
        <span aria-hidden>▾</span>
      </button>
      <button
        type="button"
        onClick={exportDagJson}
        data-testid="top-toolbar-export"
        title="Export DAG as JSON"
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span aria-hidden>⬇</span>
        <span>Export</span>
      </button>
      <button
        type="button"
        onClick={() => togglePresentMode()}
        data-testid="top-toolbar-present"
        title="Present — chrome-hidden viewport (Esc returns)"
        className="flex h-7 items-center gap-1 rounded border border-border bg-muted/40 px-2 text-[11px] font-mono uppercase tracking-wide text-fg/80 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span aria-hidden>⛚</span>
        <span>Present</span>
      </button>
    </div>
  );
}

export function TopToolbar(): ReactNode {
  // Three-column flex pattern: left (flex-1, justify-start), center
  // (empty since the mode pill was dissolved in v0.6 #4 — W1 consolidates
  // the surviving controls onto the floating pill), right (flex-1,
  // justify-end). The two flex-1 outer columns keep the spacing balanced.
  return (
    <div
      data-testid="top-toolbar"
      role="toolbar"
      aria-orientation="horizontal"
      aria-label="Editor toolbar"
      className="flex items-center gap-3 border-b border-border bg-bg/95 px-3 py-1 font-mono text-fg"
    >
      {/* Left zone */}
      <div className="flex flex-1 min-w-0 items-center gap-3 overflow-x-auto">
        <AddButton />
        <AssetsButton />
        <SpaceGroup />
      </div>
      {/* Right zone */}
      <div className="flex flex-1 items-center justify-end">
        <RightCluster />
      </div>
    </div>
  );
}
