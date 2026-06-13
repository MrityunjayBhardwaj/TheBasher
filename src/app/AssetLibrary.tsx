// AssetLibrary — the asset browser body (bundled samples + my imports +
// per-row management), re-homed from the old floating AssetsPopover into the
// LeftSidebar's "Assets" tab (UX backlog #6 — Blender's asset-browser model:
// the library lives beside the outliner, not behind a transient popover or a
// left-footer link).
//
// This component is the CONTENT only — it has no open/close/position state.
// The LeftSidebar mounts it when the "Assets" tab is active; the toolbar
// "Assets" button selects that tab (leftSidebarStore). Drag a tile onto the
// viewport to import (same DRAG_MIME contract AssetDropZone already consumes —
// P1 Wave B unchanged). Test ids are preserved verbatim (`library-popover*`)
// so the import/management e2e corpus keeps working across the re-home.
//
// Freshness: availability + my-imports re-enumerate on mount AND on every
// successful import (`importRefreshStore.tick`) — so a same-session import
// appears immediately in the open tab (the popover used `open` as the trigger;
// the tab uses mount + tick).
//
// V6 + V8: reads StorageCapability via the boot helper; no DAG mutation here
// (node-creation Ops fire from AssetDropZone after a successful drop).
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §14 (asset library); P1 Wave B
// (drag-drop chain unchanged); UX-BACKLOG #6.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ASSET_CATALOG, DRAG_MIME, type CatalogEntry } from './asset/catalog';
import {
  deleteImportedAsset,
  listFilesDeep,
  renameImportedAsset,
  USER_IMPORTS_ROOT,
} from './asset/importCommon';
import { getStorage } from './boot';
import { useImportRefreshStore } from './stores/importRefreshStore';

/** OPFS swatch for user-imported entries — a standalone amber chip (#f0b85a).
 * Distinct from every bundled-asset swatch (cube #5af07a green, sphere #7aaaff
 * blue, cone #ff8a5a orange, skinned-bar #b07aff purple) AND from the `accent`
 * green so user-imported assets read as "yours" at-a-glance. These are asset-
 * identity DATA colors (like the catalog swatches), not chrome tokens. */
const MY_IMPORT_SWATCH = '#f0b85a';

interface AvailableAsset extends CatalogEntry {
  available: boolean;
}

/** A user-imported entry surfaced under the "my imports" section. Mirrors the
 * draggable shape of `AvailableAsset` (path + name + swatch) but is always
 * `available` — the entry's existence in OPFS is the availability proof. */
interface MyImportEntry {
  /** OPFS path of the entry file — .gltf/.glb (model) or .bvh/.fbx (motion).
   * The value passed via DRAG_MIME and consumed by AssetDropZone's library
   * branch (routed by extension). */
  readonly path: string;
  /** Display name — the user-imports subdirectory name (sanitized at ingest). */
  readonly name: string;
}

/**
 * Pick the entry file from a directory listing. glTF wins by container priority
 * (.glb single-file over .gltf), then a single motion file (.bvh/.fbx) — Phase
 * 7.14 (#111) D-05: BVH/FBX must list in My Imports like glTF. Returns the
 * matched filename, or null if the listing holds no importable entry.
 */
function findEntryFile(files: readonly string[]): string | null {
  const byExt = (ext: string) => files.find((f) => f.toLowerCase().endsWith(ext));
  return byExt('.glb') ?? byExt('.gltf') ?? byExt('.bvh') ?? byExt('.fbx') ?? null;
}

export function AssetLibrary(): ReactNode {
  // My-Imports freshness: every successful import bumps `tick` (the import core
  // bumps AFTER `dispatchAtomic` returns — see `src/app/asset/importGltf.ts:184`).
  // Including `tick` in the enumeration effect's dep array makes a same-session
  // import IMMEDIATELY appear in the mounted Assets tab.
  const tick = useImportRefreshStore((s) => s.tick);
  const [assets, setAssets] = useState<AvailableAsset[]>(
    ASSET_CATALOG.map((c) => ({ ...c, available: false })),
  );
  const [myImports, setMyImports] = useState<MyImportEntry[]>([]);
  // Per-row management UI state (Phase 7.14 #112). At most one row's ︙ menu /
  // rename field / file list is active at a time; the delete-block banner is
  // global to the section.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showFilesFor, setShowFilesFor] = useState<{ name: string; files: string[] } | null>(null);
  const [deleteBlock, setDeleteBlock] = useState<{ name: string; refs: number } | null>(null);
  // Guards the Enter/blur double-commit on the rename field (see commitRename).
  const renameCommittedRef = useRef(false);

  function beginRename(name: string): void {
    setMenuFor(null);
    setShowFilesFor(null);
    renameCommittedRef.current = false;
    setRenameFor(name);
    setRenameValue(name);
  }

  function commitRename(oldName: string): void {
    // Dedupe Enter + the unmount-`onBlur` that follows it — both call this; the
    // ref guarantees the rename fires at most once per edit.
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const next = renameValue.trim();
    setRenameFor(null);
    if (next === '' || next === oldName) return;
    void renameImportedAsset(oldName, next);
  }

  function doDelete(name: string, breakRefs: boolean): void {
    setMenuFor(null);
    setRenameFor(null);
    setShowFilesFor(null);
    void deleteImportedAsset(name, { breakRefs }).then((res) => {
      if (!res.deleted && res.referencedBy && res.referencedBy.length > 0) {
        // D-06: blocked because live nodes reference it — surface the banner.
        setDeleteBlock({ name, refs: res.referencedBy.length });
      } else {
        setDeleteBlock((cur) => (cur?.name === name ? null : cur));
      }
    });
  }

  async function showFiles(name: string): Promise<void> {
    setMenuFor(null);
    setRenameFor(null);
    const storage = await getStorage();
    const files = await listFilesDeep(storage, `${USER_IMPORTS_ROOT}/${name}`);
    setShowFilesFor({ name, files: files.sort() });
  }

  // Lazy-resolve bundled-asset availability on mount + whenever a successful
  // import bumps the tick (re-seeding assets mid-session keeps the indicator
  // honest).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storage = await getStorage();
      const presence = await Promise.all(ASSET_CATALOG.map((c) => storage.exists(c.path)));
      if (cancelled) return;
      setAssets(ASSET_CATALOG.map((c, i) => ({ ...c, available: presence[i] })));
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // My-Imports enumeration. Keyed on `[tick]` — mount + every successful import
  // re-enumerate. The OPFS dir IS the source of truth (V18 — no localStorage
  // mirror). On first run `user-imports/` does not exist and `storage.list`
  // THROWS (same shape as `exists()` in OpfsStorage.ts:72) so the outer list
  // call is wrapped in try/catch → []. Per-subdir list calls are independently
  // guarded so a single missing/disappeared entry doesn't wipe the section.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const storage = await getStorage();
        let subdirs: string[];
        try {
          subdirs = await storage.list(USER_IMPORTS_ROOT);
        } catch {
          // First-run crash mitigation: `user-imports` doesn't exist yet.
          subdirs = [];
        }
        const entries: MyImportEntry[] = [];
        for (const name of subdirs) {
          try {
            const files = await storage.list(`${USER_IMPORTS_ROOT}/${name}`);
            // Resolve the entry file. glTF: .glb (single-file container) wins
            // over .gltf at the same depth; if neither is at the root, recurse
            // one level (nested-entry exports like `<dir>/gltf/scene.gltf`).
            // Motion (Phase 7.14 #111, D-05): a single .bvh/.fbx is a valid
            // entry too — BVH/FBX must list in My Imports like glTF.
            let entryRel: string | null = findEntryFile(files);
            if (!entryRel) {
              for (const sub of files) {
                try {
                  const innerFiles = await storage.list(`${USER_IMPORTS_ROOT}/${name}/${sub}`);
                  const inner = findEntryFile(innerFiles);
                  if (inner) {
                    entryRel = `${sub}/${inner}`;
                    break;
                  }
                } catch {
                  // `sub` is a file (not a dir) — list throws on a file path;
                  // skip and try the next sibling.
                }
              }
            }
            if (!entryRel) continue; // orphan dir (no importable file anywhere)
            entries.push({
              path: `${USER_IMPORTS_ROOT}/${name}/${entryRel}`,
              name,
            });
          } catch {
            // Subdir disappeared between the outer list and this read;
            // silently skip — V18 keeps OPFS authoritative, no error needed.
          }
        }
        if (!cancelled) setMyImports(entries);
      } catch {
        // Storage unavailable entirely — render an empty section, silent.
        if (!cancelled) setMyImports([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <div
      data-testid="library-popover"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto font-mono text-xs text-fg"
    >
      <header className="mb-1 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-dim">
        sample assets
      </header>
      <ul className="flex flex-col gap-1">
        {assets.map((a) => (
          <li key={a.path}>
            <button
              type="button"
              draggable={a.available}
              data-testid={`library-popover-item-${a.path}`}
              data-available={a.available || undefined}
              onDragStart={(e) => {
                if (!a.available) return;
                e.dataTransfer.setData(DRAG_MIME, a.path);
                e.dataTransfer.setData('text/plain', a.path);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              className={`flex w-full items-center gap-2 rounded border border-border bg-bg-1/40 px-2 py-1.5 text-left ${
                a.available
                  ? 'cursor-grab text-fg/90 hover:bg-bg-1 hover:border-accent'
                  : 'cursor-not-allowed text-fg-mute'
              }`}
              title={a.available ? 'Drag onto viewport to import' : 'Asset not yet seeded'}
            >
              <span
                aria-hidden
                className="h-5 w-5 shrink-0 rounded border border-border"
                style={{ background: a.swatch }}
              />
              <span className="grow truncate">{a.name}</span>
              <span className="text-[9px] text-fg-mute">{a.available ? 'glb' : '—'}</span>
            </button>
          </li>
        ))}
      </ul>
      {myImports.length > 0 && (
        <>
          <header className="mb-1 mt-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-dim">
            my imports
          </header>
          {deleteBlock && (
            <div
              data-testid="library-popover-delete-banner"
              role="alert"
              className="mb-1 flex flex-col gap-1 rounded border border-border-strong bg-warn/10 px-2 py-1.5 text-[11px] text-warn"
            >
              <span>
                “{deleteBlock.name}” is used by {deleteBlock.refs} node
                {deleteBlock.refs === 1 ? '' : 's'} in the scene.
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  data-testid={`library-popover-delete-anyway-${deleteBlock.name}`}
                  onClick={() => doDelete(deleteBlock.name, true)}
                  className="rounded border border-border bg-bg-1 px-2 py-0.5 text-warn hover:border-accent hover:bg-bg-2"
                >
                  Delete anyway
                </button>
                <button
                  type="button"
                  data-testid="library-popover-delete-cancel"
                  onClick={() => setDeleteBlock(null)}
                  className="rounded border border-border px-2 py-0.5 text-fg-dim hover:border-accent hover:bg-bg-1"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <ul className="flex flex-col gap-1" data-testid="library-popover-my-imports">
            {myImports.map((entry) => (
              <li key={entry.path} className="relative">
                {renameFor === entry.name ? (
                  <input
                    type="text"
                    autoFocus
                    data-testid={`library-popover-rename-input-${entry.name}`}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(entry.name);
                      else if (e.key === 'Escape') {
                        // Reset the value first so the unmount `onBlur` commits
                        // a no-op (next === oldName) rather than the edited text.
                        setRenameValue(entry.name);
                        setRenameFor(null);
                      }
                    }}
                    onBlur={() => commitRename(entry.name)}
                    className="w-full rounded border border-accent bg-bg-1 px-2 py-1.5 text-fg outline-none"
                  />
                ) : (
                  <div className="flex w-full items-center gap-1">
                    <button
                      type="button"
                      draggable
                      data-testid={`library-popover-my-import-${entry.path}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_MIME, entry.path);
                        e.dataTransfer.setData('text/plain', entry.path);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className="flex grow cursor-grab items-center gap-2 rounded border border-border bg-bg-1/40 px-2 py-1.5 text-left text-fg/90 hover:border-accent hover:bg-bg-1"
                      title="Drag onto viewport to import"
                    >
                      <span
                        aria-hidden
                        className="h-5 w-5 shrink-0 rounded border border-border"
                        style={{ background: MY_IMPORT_SWATCH }}
                      />
                      <span className="grow truncate">{entry.name}</span>
                      <span className="text-[9px] text-fg-mute">user</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Manage ${entry.name}`}
                      data-testid={`library-popover-menu-btn-${entry.name}`}
                      onClick={() => setMenuFor((cur) => (cur === entry.path ? null : entry.path))}
                      className="shrink-0 rounded border border-border bg-bg-1/40 px-1.5 py-1.5 text-fg-dim hover:border-accent hover:bg-bg-1"
                    >
                      ⋮
                    </button>
                  </div>
                )}
                {menuFor === entry.path && (
                  <div
                    data-testid={`library-popover-menu-${entry.name}`}
                    className="absolute right-0 z-10 mt-1 flex w-32 flex-col rounded border border-border-strong bg-bg-2 py-1 shadow-md"
                  >
                    <button
                      type="button"
                      data-testid={`library-popover-menu-rename-${entry.name}`}
                      onClick={() => beginRename(entry.name)}
                      className="px-2 py-1 text-left text-fg/90 hover:bg-bg-1"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid={`library-popover-menu-showfiles-${entry.name}`}
                      onClick={() => void showFiles(entry.name)}
                      className="px-2 py-1 text-left text-fg/90 hover:bg-bg-1"
                    >
                      Show files
                    </button>
                    <button
                      type="button"
                      data-testid={`library-popover-menu-delete-${entry.name}`}
                      onClick={() => doDelete(entry.name, false)}
                      className="px-2 py-1 text-left text-error hover:bg-bg-1"
                    >
                      Delete
                    </button>
                  </div>
                )}
                {showFilesFor?.name === entry.name && (
                  <ul
                    data-testid={`library-popover-files-${entry.name}`}
                    className="mt-1 flex flex-col gap-0.5 rounded border border-border bg-bg-1/40 px-2 py-1 text-[10px] text-fg-dim"
                  >
                    {showFilesFor.files.map((f) => (
                      <li key={f} className="truncate">
                        {f}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
