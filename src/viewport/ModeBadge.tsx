// ModeBadge — R6 top-right overlay surfacing the current operational
// mode in viewport gaze-proximity. Per UI-SPEC §5.6:
//
//   EDIT          — edit mode (the default; no time info)
//   RUN 47/600    — run mode, current frame / total frames
//   ANIMATE 60fps — animate mode, project fps reminder
//   (hidden)      — director mode (D-UX-9: chrome-hidden viewport)
//
// Sits inside Viewport.tsx as a sibling of FpsMeter + R8. The viewport
// `<div data-testid="viewport">` is `position: relative` so absolute
// positioning resolves against the viewport box, not the window.
//
// Pure formatting (formatBadge) lives below the React shell so the
// label logic is unit-testable without RTL (W2 acceptance gate #15 —
// no new external deps; React shell visibility covered by Playwright
// e2e in C4).
//
// File-rooted V8: src/viewport/. Reads useModeStore + useTimeStore.
// No DAG access.
//
// REF: docs/UI-SPEC.md §5.6, §3.4; memory/project_p6_w7_plan.md C3.

import type { ReactNode } from 'react';
import { useModeStore, type Mode } from '../app/stores/modeStore';
import { FRAMES_PER_SECOND, useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';

/** Pure formatter — given mode + time snapshot, returns the label
 *  string (or null when the badge should be hidden). Exported for the
 *  unit-test suite; the React component below calls this with the
 *  current store values. */
export function formatBadge(
  mode: Mode,
  frame: number,
  durationSeconds: number,
  fps: number,
): string | null {
  switch (mode) {
    case 'edit':
      return 'EDIT';
    case 'run': {
      const total = Math.max(0, Math.round(durationSeconds * fps));
      return `RUN ${frame}/${total}`;
    }
    case 'animate':
      return `ANIMATE ${fps}fps`;
    case 'director':
      return null;
  }
}

/** Pure formatter — SR-friendly aria-label for the current mode +
 *  counters. Mirrors formatBadge's mode switch so visible label and
 *  announced label are derived from the same source. Returns null for
 *  director mode (badge is hidden). */
export function formatBadgeAria(
  mode: Mode,
  frame: number,
  durationSeconds: number,
  fps: number,
): string | null {
  switch (mode) {
    case 'edit':
      return 'Edit mode';
    case 'run': {
      const total = Math.max(0, Math.round(durationSeconds * fps));
      return `Run mode — frame ${frame} of ${total}`;
    }
    case 'animate':
      return `Animate mode — ${fps} fps`;
    case 'director':
      return null;
  }
}

export function ModeBadge(): ReactNode {
  const mode = useModeStore((s) => s.mode);
  const frame = useTimeStore((s) => s.frame);
  const durationSeconds = useTimeStore((s) => s.durationSeconds);
  // #165: "Camera view" indicator while looking through the scene camera
  // (Blender shows the camera name in the viewport corner in camera view).
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);

  const label = formatBadge(mode, frame, durationSeconds, FRAMES_PER_SECOND);
  const ariaLabel = formatBadgeAria(mode, frame, durationSeconds, FRAMES_PER_SECOND);
  if (label === null) return null; // director mode hides all viewport chrome

  return (
    <>
      <div
        data-testid="mode-badge"
        data-mode={mode}
        className="pointer-events-none absolute right-2 top-2 z-10 rounded border border-border-strong bg-bg-2/90 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-fg-dim backdrop-blur-sm"
      >
        {/* aria-live on the inner span (which holds the label text) so SR
            engines watch the live element for content changes. Wrapping
            ensures the announcement fires when the label changes (e.g.
            mode flips edit → animate, or run frame advances). */}
        <span aria-label={ariaLabel ?? label} aria-live="polite">
          {label}
        </span>
      </div>
      {lookThrough ? (
        <div
          data-testid="camera-view-badge"
          className="pointer-events-none absolute right-2 top-9 z-10 rounded border border-accent/40 bg-bg-2/90 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-accent backdrop-blur-sm"
        >
          <span aria-label="Camera view — press 0 to exit" aria-live="polite">
            Camera view · 0
          </span>
        </div>
      ) : null}
    </>
  );
}
