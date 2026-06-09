// ProjectTabs — R1 per UI-SPEC §5.1. Always-visible strip across the
// top of the chrome carrying:
//
//   [⌂ MyShortFilm ●  ×] [⌃ Splat-Test  ×] [+]   spacer   [● live]
//
// Each tab is a project on disk. Click name → switchProject. Click × →
// confirm-delete (if active project is dirty) → deleteProject. Click +
// → createNewProject prompt. Active project's tab shows a warn-colored
// dot before the name when projectStore.dirty is true (D-UX-12). Hover
// any tab for 600ms → tooltip "saved Nm ago" computed at hover time
// (D-02 — no setInterval). Right edge mounts <ComfyStatusIndicator />
// migrated from Chrome.tsx (W2 temporary home, now permanent on R1 per
// §5.10).
//
// Data sources:
//   - useProjectStore.current  → active project meta + dirty + lastSavedAt
//   - listAllProjectMetadata() → all projects on disk (refresh on mount
//     and on current.id change). Same path ProjectsMenu uses; the
//     section-inventory pass logged in dharana B11 W3 confirmed the two
//     surfaces are distinct (CRUD popover vs always-visible switch strip)
//     and share only this read seam.
//
// V8 file-rooted: src/app/. Reads UI projection + project boot helpers;
// no DAG mutation. switchProject / createNewProject / deleteProject in
// boot.ts go through hydrate, which is the documented V1 exception seam.
//
// REF: UI-SPEC §5.1, §5.10, §11 #11 (D-UX-12, D-UX-13); D-02 locked W3;
// dharana B11 (section-inventory pass W3 = no shifts).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useProjectStore } from '../core/project/store';
import type { ProjectMetadata } from '../core/project/io';
import {
  createNewProject,
  deleteProject,
  listAllProjectMetadata,
  saveCurrent,
  switchProject,
} from './boot';
import { ComfyStatusIndicator } from './ComfyStatusIndicator';
import { ProjectsMenu } from './ProjectsMenu';
import { formatTooltip } from './projectTabsHelpers';

const HOVER_TOOLTIP_DELAY_MS = 600;

interface TabState {
  /** Page-coords (CSS pixels) for the tooltip — bottom-left of the tab. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export function ProjectTabs(): ReactNode {
  const current = useProjectStore((s) => s.current);
  const dirty = useProjectStore((s) => s.dirty);
  const lastSavedAt = useProjectStore((s) => s.lastSavedAt);
  // Defensive defaults at first paint: `current` is `null` until project boot
  // resolves (Risk A — V10 pattern). `?? 'no project'` keeps the aria-label
  // semantically valid through the bootstrap window. P6 W8 C4 / D-W8-4.
  const ariaLabel = `Project tabs — ${current?.name ?? 'no project'}, ${
    dirty ? 'unsaved changes' : 'all saved'
  }`;

  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [busy, setBusy] = useState(false);
  const [tooltip, setTooltip] = useState<TabState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Save cluster (folded from the deleted Chrome band, v0.6 #4 W1). The
  // project identity + save live top-left/right, Spline-style; the dirty
  // dot on the active tab is the live unsaved signal (D-UX-12).
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveCurrent();
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  // Refresh project list when current project changes (rename / duplicate
  // / new / delete bumps the id or updatedAt).
  useEffect(() => {
    let cancelled = false;
    listAllProjectMetadata().then((p) => {
      if (!cancelled) setProjects(p);
    });
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.updatedAt]);

  // Clean up any pending hover timer on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  const wrap = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onSelect = (id: string) => {
    if (id === current?.id || busy) return;
    void wrap(async () => {
      await switchProject(id);
    });
  };

  const onClose = (id: string, name: string) => {
    if (busy) return;
    // Confirm if closing the active project AND it has unsaved edits.
    // Otherwise no confirm — deleting a closed-tab project should be
    // boring. Per the plan's "v0.5 simpler scope" — close-tab IS delete.
    if (id === current?.id && dirty) {
      const ok = window.confirm(
        `Close project "${name}" with unsaved changes? This deletes it from storage.`,
      );
      if (!ok) return;
    } else if (projects.length > 1) {
      const ok = window.confirm(`Close project "${name}"? This deletes it from storage.`);
      if (!ok) return;
    } else {
      // Only one project remains — deletion falls back to seeding a
      // default (see deleteProject in boot.ts). Treat as a regular
      // confirm.
      const ok = window.confirm(
        `Close the last project "${name}"? A fresh default project will be created.`,
      );
      if (!ok) return;
    }
    void wrap(async () => {
      await deleteProject(id);
    });
  };

  const onNew = () => {
    if (busy) return;
    void wrap(async () => {
      const name = window.prompt('New project name', 'Untitled');
      if (!name) return;
      await createNewProject(name.trim() || 'Untitled');
    });
  };

  const onTabEnter = (e: React.MouseEvent<HTMLElement>, projId: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Hover-delay before showing. The text is computed *inside* the
    // setTimeout so it's freshly evaluated at hover-show time (D-02 —
    // even after a 30 minute hover, the tooltip's "saved Nm ago" reads
    // from Date.now() at show-time, not at enter-time).
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      // Show only for the active tab — dirty/lastSavedAt is per-active-
      // project; we don't track per-tab unsaved state for inactive ones
      // (a future wave that opens multiple "edited at once" projects
      // would need a per-tab dirty Map).
      const isActive = projId === current?.id;
      if (!isActive) return;
      setTooltip({
        x: r.left,
        y: r.bottom + 4,
        text: formatTooltip(Date.now(), lastSavedAt, dirty),
      });
    }, HOVER_TOOLTIP_DELAY_MS);
  };

  const onTabLeave = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setTooltip(null);
  };

  return (
    <div
      data-testid="project-tabs"
      role="tablist"
      aria-label={ariaLabel}
      className="flex h-8 items-stretch border-b border-border bg-bg-2/80 px-1 font-mono text-[11px] text-fg"
    >
      {/* Brand + project identity (folded from the deleted Chrome band).
          Leaves room to the right of the identity for W4's back-to-home
          affordance (W4 owns it — do not add here). */}
      <div className="flex shrink-0 items-center gap-2 px-2">
        <span className="text-accent">basher</span>
        <span className="text-fg/30">/</span>
        <span className="max-w-[160px] truncate text-fg/80" data-testid="project-name">
          {current?.name ?? 'Untitled'}
        </span>
      </div>
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {projects.map((p) => {
          const isActive = p.id === current?.id;
          return (
            <div
              key={p.id}
              data-testid={`project-tab-${p.id}`}
              data-active={isActive || undefined}
              className={`flex items-center gap-1 border-r border-border px-2 ${
                isActive ? 'bg-bg-1 text-fg' : 'text-fg-dim hover:bg-bg-1/40 hover:text-fg'
              }`}
              onMouseEnter={(e) => onTabEnter(e, p.id)}
              onMouseLeave={onTabLeave}
            >
              {isActive && dirty ? (
                <span
                  aria-hidden
                  data-testid="project-tab-dirty-dot"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
                />
              ) : null}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={`Open project ${p.name}`}
                onClick={() => onSelect(p.id)}
                disabled={busy}
                data-testid={`project-tab-select-${p.id}`}
                className="flex items-center gap-1 truncate text-left uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
              >
                <span aria-hidden className="text-fg-mute">
                  {isActive ? '⌂' : '⌃'}
                </span>
                <span className="max-w-[140px] truncate">{p.name}</span>
              </button>
              <button
                type="button"
                onClick={() => onClose(p.id, p.name)}
                disabled={busy}
                data-testid={`project-tab-close-${p.id}`}
                title="Close project (deletes from storage)"
                aria-label={`Close project ${p.name}`}
                className="ml-1 text-fg-mute hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          data-testid="project-tab-new"
          title="New project"
          aria-label="New project"
          className="flex items-center px-3 text-fg-mute hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
        >
          +
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-3 pr-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="save-button"
          className="rounded border border-border bg-muted px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
        >
          {saving ? 'saving…' : 'save'}
        </button>
        {savedAt && (
          <span data-testid="save-status" className="text-[10px] text-fg/40">
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        <ProjectsMenu />
        <ComfyStatusIndicator />
      </div>

      {tooltip ? (
        <div
          data-testid="project-tab-tooltip"
          className="pointer-events-none fixed z-50 rounded border border-border bg-bg-2/95 px-2 py-1 text-[10px] text-fg shadow-lg backdrop-blur"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      ) : null}
    </div>
  );
}
