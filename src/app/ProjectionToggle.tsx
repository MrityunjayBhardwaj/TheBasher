// ProjectionToggle — the bottom-right ortho|persp segmented pill (Spline
// region: viewport, "Orthographic | Perspective toggle pill" next to the
// orbit/axis nav gizmo). Sets the EDITOR-VIEW projection on viewportStore;
// EditorViewCamera swaps the one always-default editor camera accordingly.
//
// This is which camera the editor looks THROUGH — an editor-session
// projection (V8/V34, never persisted, never in the DAG), the same class as
// the camera zoom and grid toggle. It is NOT a DAG camera's `.type`
// ([[H67]] view-IS-scene-object conflation). Keyboard mirror: `M`.
//
// Placement: absolute bottom-right of the viewport, below the axis-ball nav
// gizmo (which renders inside the Canvas at margin [80,80]). Hidden in present
// mode, mirroring the FloatingViewportToolbar's chrome-hide.
//
// File-rooted V8: src/app/. Reads + mutates the viewportStore UI projection
// only. Never the DAG.
//
// REF: docs/SPLINE-UI-REFERENCE.md (viewport row, `M` persp↔ortho); vyapti
// V8, V34; hetvabhasa H67.

import type { ReactNode } from 'react';
import { useChromeStore } from './stores/chromeStore';
import { useViewportStore, type CameraProjection } from './stores/viewportStore';

interface ProjEntry {
  readonly value: CameraProjection;
  readonly label: string;
  readonly testId: string;
}

const PROJECTIONS: readonly ProjEntry[] = [
  { value: 'perspective', label: 'Persp', testId: 'projection-toggle-perspective' },
  { value: 'orthographic', label: 'Ortho', testId: 'projection-toggle-orthographic' },
];

export function ProjectionToggle(): ReactNode {
  const presentMode = useChromeStore((s) => s.presentMode);
  const projection = useViewportStore((s) => s.cameraProjection);
  const setCameraProjection = useViewportStore((s) => s.setCameraProjection);

  // Chrome-hide in present mode, like the floating toolbar — a clean stage
  // for the director cut.
  if (presentMode) return null;

  return (
    <div
      data-testid="projection-toggle"
      role="radiogroup"
      aria-label="Viewport camera projection"
      className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-bg-2/95 p-0.5 text-fg shadow-xl shadow-black/40 backdrop-blur-md"
    >
      {PROJECTIONS.map((p) => {
        const active = projection === p.value;
        return (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setCameraProjection(p.value)}
            data-testid={p.testId}
            data-active={active || undefined}
            title={`${p.label === 'Persp' ? 'Perspective' : 'Orthographic'} projection (M)`}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              active ? 'bg-bg-1 text-accent' : 'text-fg-dim hover:bg-bg-1 hover:text-fg'
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
