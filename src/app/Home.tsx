// Home — the pre-editor launcher surface (v0.6 #4 W4, D-08/D-09).
//
// A Spline-style dashboard the user lands on for a true first run (and one
// click away from the editor thereafter). It is NOT a second authoring
// surface: it owns no creative state. It READS `listAllProjectMetadata()`
// (the same storage list every other project surface uses) and DELEGATES every
// mutation to the existing boot.ts helpers (switchProject / createNewProject /
// deleteProject — the single writers of the project store). The only state it
// owns is ephemeral view state (busy flag). Opening a project flips the route
// to 'editor' (routeStore), at which point App mounts the editor tree (and the
// single R3F canvas) on the hydrated project — see App.tsx's home XOR editor
// branch.
//
// Examples vs your projects: the gallery is ONE metadata read split client-side
// by EXAMPLE_PROJECT_IDS (examples.ts). Examples are ordinary Op-built-DAG
// projects (seeded idempotently at boot), visually separated but mechanically
// identical — opening one hydrates a real DAG whose every object is selectable
// (V34 — one substrate, no parallel state).
//
// V8 file-rooted: src/app/. No DAG mutation here beyond the documented boot
// helper seam (which goes through hydrate, the V1 exception).
//
// REF: docs/SPLINE-UI-REFERENCE.md §1 (home/dashboard anatomy), §2 #7;
//      CONTEXT D-08/D-09/D-W4-ROUTE/D-W4-THUMB/D-W4-SEED.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EXAMPLE_PROJECT_IDS } from '../core/project/examples';
import type { ProjectMetadata } from '../core/project/io';
import { createNewProject, deleteProject, listAllProjectMetadata, switchProject } from './boot';
import { useRouteStore } from './stores/routeStore';

const EXAMPLE_IDS = new Set(EXAMPLE_PROJECT_IDS);

/** Coarse "edited Nm ago" — placeholder-grade, no live ticking (D-02 spirit). */
function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface CardProps {
  meta: ProjectMetadata;
  isExample: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}

function ProjectCard({ meta, isExample, busy, onOpen, onDelete }: CardProps): ReactNode {
  const glyph = (meta.name.trim()[0] ?? '?').toUpperCase();
  return (
    <div
      data-testid={isExample ? 'home-example-card' : 'home-project-card'}
      data-project-id={meta.id}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-bg-2 text-left shadow-sm"
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => onOpen(meta.id)}
        aria-label={`Open ${isExample ? 'example' : 'project'} ${meta.name}`}
        data-testid={`home-open-${meta.id}`}
        className="flex flex-1 flex-col focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
      >
        {/* Thumbnail placeholder (D-W4-THUMB — glyph/gradient now; live
            render-to-thumbnail deferred). Examples get an accent-tinted wash. */}
        <div
          aria-hidden
          className={`flex h-24 items-center justify-center text-2xl font-semibold ${
            isExample ? 'bg-accent/15 text-accent' : 'bg-muted text-fg/40'
          }`}
        >
          {glyph}
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <span className="truncate text-xs font-medium text-fg">{meta.name}</span>
          <span className="text-[10px] text-fg-dim">
            {meta.nodeCount} {meta.nodeCount === 1 ? 'node' : 'nodes'} · edited{' '}
            {relativeTime(meta.updatedAt)}
          </span>
        </div>
      </button>
      {/* Examples are curated + re-seeded on boot, so deleting one is pointless
          (it returns) — only user projects get a delete affordance. */}
      {!isExample ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(meta.id, meta.name)}
          aria-label={`Delete project ${meta.name}`}
          data-testid={`home-delete-${meta.id}`}
          className="absolute right-1.5 top-1.5 rounded border border-border bg-bg-2/90 px-1.5 text-fg-mute opacity-0 hover:text-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover:opacity-100 disabled:opacity-50"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Home(): ReactNode {
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    let cancelled = false;
    void listAllProjectMetadata().then((p) => {
      if (!cancelled) setProjects(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const wrap = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);

  const onOpen = useCallback(
    (id: string) => {
      void wrap(async () => {
        await switchProject(id);
        useRouteStore.getState().openEditor();
      });
    },
    [wrap],
  );

  const onNew = useCallback(() => {
    void wrap(async () => {
      const name = window.prompt('New project name', 'Untitled');
      if (name === null) return;
      await createNewProject(name.trim() || 'Untitled');
      useRouteStore.getState().openEditor();
    });
  }, [wrap]);

  const onDelete = useCallback(
    (id: string, name: string) => {
      const ok = window.confirm(`Delete project "${name}"? This removes it from storage.`);
      if (!ok) return;
      void wrap(async () => {
        await deleteProject(id);
        refresh();
      });
    },
    [wrap, refresh],
  );

  const examples = projects.filter((p) => EXAMPLE_IDS.has(p.id));
  const mine = projects.filter((p) => !EXAMPLE_IDS.has(p.id));

  return (
    <div data-testid="home-view" className="h-full w-full overflow-y-auto bg-bg font-mono text-fg">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-8 py-10">
        <header className="flex items-baseline gap-3">
          <span className="text-lg font-semibold text-accent">basher</span>
          <span className="text-xs text-fg-dim">director-first 3D</span>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-fg-dim">Your projects</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={onNew}
              data-testid="home-new-project"
              className="flex h-[152px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-bg-1 text-fg-dim hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
            >
              <span aria-hidden className="text-2xl">
                +
              </span>
              <span className="text-xs">New project</span>
            </button>
            {mine.map((p) => (
              <ProjectCard
                key={p.id}
                meta={p}
                isExample={false}
                busy={busy}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>

        {examples.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-fg-dim">Examples</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
              {examples.map((p) => (
                <ProjectCard
                  key={p.id}
                  meta={p}
                  isExample
                  busy={busy}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
