// Projects menu — list / switch / new / rename / duplicate / delete.
//
// Lives in the Chrome header. Click opens a popover; click an existing
// project to switch to it; "+ new", "duplicate", "rename", "delete"
// buttons handle the rest.
//
// V1 stays clean: every action funnels through boot.ts helpers, which
// dispatch through saveProject / loadProject / hydrate. The DAG store is
// only mutated via hydrate() (the project-load seam, by design).

import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../core/project/store';
import type { ProjectMetadata } from '../core/project/io';
import {
  createNewProject,
  deleteProject,
  duplicateCurrentProject,
  listAllProjectMetadata,
  renameCurrentProject,
  switchProject,
} from './boot';

export function ProjectsMenu() {
  const current = useProjectStore((s) => s.current);
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Refresh the project list whenever the menu opens or the current project
  // metadata changes (rename / duplicate / delete bumps the list).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listAllProjectMetadata().then((p) => {
      if (!cancelled) setProjects(p);
    });
    return () => {
      cancelled = true;
    };
  }, [open, current?.id, current?.updatedAt, current?.name]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const wrap = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onSelect = (id: string) => {
    if (id === current?.id) {
      setOpen(false);
      return;
    }
    void wrap(async () => {
      await switchProject(id);
      setOpen(false);
    });
  };

  const onNew = () =>
    void wrap(async () => {
      const name = window.prompt('New project name', 'Untitled');
      if (!name) return;
      await createNewProject(name.trim() || 'Untitled');
      setOpen(false);
    });

  const onDuplicate = () =>
    void wrap(async () => {
      if (!current) return;
      await duplicateCurrentProject(`${current.name} (copy)`);
      setOpen(false);
    });

  const onRename = () =>
    void wrap(async () => {
      if (!current) return;
      const next = window.prompt('Rename project', current.name);
      if (!next || next.trim() === current.name) return;
      await renameCurrentProject(next.trim());
    });

  const onDelete = (id: string, name: string) =>
    void wrap(async () => {
      const ok = window.confirm(`Delete project "${name}"? This can't be undone.`);
      if (!ok) return;
      await deleteProject(id);
    });

  return (
    <div ref={menuRef} className="relative" data-testid="projects-menu">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="projects-menu-toggle"
        className="rounded border border-border bg-muted px-2 py-1 text-xs hover:border-accent"
      >
        projects ▾
      </button>
      {open ? (
        <div
          className="absolute right-0 z-50 mt-1 max-h-[60vh] w-[320px] overflow-auto rounded border border-border bg-bg shadow-lg"
          data-testid="projects-menu-panel"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[10px] uppercase tracking-wide text-fg/50">your projects</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={onNew}
                disabled={busy}
                data-testid="projects-menu-new"
                className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] hover:border-accent disabled:opacity-50"
              >
                + new
              </button>
              <button
                type="button"
                onClick={onDuplicate}
                disabled={busy || !current}
                data-testid="projects-menu-duplicate"
                className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] hover:border-accent disabled:opacity-50"
              >
                duplicate
              </button>
              <button
                type="button"
                onClick={onRename}
                disabled={busy || !current}
                data-testid="projects-menu-rename"
                className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] hover:border-accent disabled:opacity-50"
              >
                rename
              </button>
            </div>
          </div>
          <ul className="divide-y divide-border">
            {projects.length === 0 ? (
              <li className="px-3 py-2 text-[11px] text-fg/40">no projects yet</li>
            ) : (
              projects.map((p) => {
                const active = p.id === current?.id;
                return (
                  <li
                    key={p.id}
                    className={`group flex items-center gap-2 px-3 py-2 text-[11px] ${
                      active ? 'bg-muted/40' : 'hover:bg-muted/20'
                    }`}
                    data-testid={`projects-menu-item-${p.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(p.id)}
                      disabled={busy}
                      className="flex-1 truncate text-left disabled:opacity-50"
                    >
                      <span className={active ? 'text-accent' : 'text-fg'}>{p.name}</span>
                      <span className="ml-2 text-[10px] text-fg/40">
                        {p.nodeCount} nodes · {new Date(p.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(p.id, p.name)}
                      disabled={busy}
                      data-testid={`projects-menu-delete-${p.id}`}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/50 opacity-0 hover:border-red-500 hover:text-red-400 group-hover:opacity-100 disabled:opacity-50"
                      title="delete"
                    >
                      ✕
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
