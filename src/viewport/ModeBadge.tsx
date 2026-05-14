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

export function ModeBadge(): ReactNode {
  const mode = useModeStore((s) => s.mode);
  const frame = useTimeStore((s) => s.frame);
  const durationSeconds = useTimeStore((s) => s.durationSeconds);

  const label = formatBadge(mode, frame, durationSeconds, FRAMES_PER_SECOND);
  if (label === null) return null;

  return (
    <div
      data-testid="mode-badge"
      data-mode={mode}
      className="pointer-events-none absolute right-2 top-2 z-10 rounded border border-border-strong bg-bg-2/90 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-fg-dim backdrop-blur-sm"
    >
      {label}
    </div>
  );
}
