// AssetsPopover — small floating panel listing bundled glTF samples,
// triggered by a button in TopToolbar. Replaces the dedicated Library
// panel (which occupied 180px of permanent screen real estate for three
// tiles).
//
// Why a popover and not a panel: the bundled-glTF list is small (3
// items) and rarely accessed after onboarding. A permanent column is
// expensive; a popover gives the user one click to reach the list while
// reclaiming the column for viewport / scene tree.
//
// Drag contract preserved: tiles use the same DRAG_MIME payload the
// existing Library used, so AssetDropZone needs zero changes — drag a
// tile from the popover onto the viewport and the existing drop chain
// fires (P1 Wave B unchanged).
//
// State: useAssetsPopoverStore controls open/close + anchor coords.
// Open state is ephemeral (no persistence). Closes on outside-click,
// Esc, or drag-end.
//
// V6 + V8: reads StorageCapability via the boot helper to check
// availability. No DAG mutation here — the actual node-creation Ops
// fire from AssetDropZone after a successful drop.
//
// REF: docs/UI-SPEC.md §5.5 (Library tab dropped — replaced by
// popover); THESIS.md §14 (asset library); P1 Wave B (drag-drop chain
// unchanged); P6 W2.5 (Library deletion).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { ASSET_CATALOG, DRAG_MIME, type CatalogEntry } from './asset/catalog';
import { getStorage } from './boot';
import { useImportRefreshStore } from './stores/importRefreshStore';

/** OPFS swatch for user-imported entries — the `warn` token (#f0b85a, amber).
 * Distinct from every bundled-asset swatch (cube #5af07a green, sphere #7aaaff
 * blue, cone #ff8a5a orange, skinned-bar #b07aff purple) AND from the `accent`
 * green so user-imported assets read as "yours" at-a-glance. Lives in the
 * existing palette (`tailwind.config.ts:26`) — no new token introduced. */
const MY_IMPORT_SWATCH = '#f0b85a';

/** OPFS root for user-imported asset folders (Phase 7.9 Wave A — mirrors
 * `USER_IMPORTS_ROOT` in `src/app/asset/importGltf.ts:74`). */
const USER_IMPORTS_ROOT = 'user-imports';

interface AssetsPopoverState {
  open: boolean;
  /** Anchor: bottom-left of the trigger button (CSS pixels). */
  x: number;
  y: number;
  openAt: (x: number, y: number) => void;
  close: () => void;
}

export const useAssetsPopoverStore = create<AssetsPopoverState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  openAt(x, y) {
    set({ open: true, x, y });
  },
  close() {
    set({ open: false });
  },
}));

interface AvailableAsset extends CatalogEntry {
  available: boolean;
}

/** A user-imported entry surfaced under the "my imports" section. Mirrors the
 * draggable shape of `AvailableAsset` (path + name + swatch) but is always
 * `available` — the entry's existence in OPFS is the availability proof. */
interface MyImportEntry {
  /** OPFS path of the entry .gltf/.glb (the value passed via DRAG_MIME and
   * consumed by AssetDropZone's library branch). */
  readonly path: string;
  /** Display name — the user-imports subdirectory name (sanitized at ingest). */
  readonly name: string;
}

export function AssetsPopover(): ReactNode {
  const open = useAssetsPopoverStore((s) => s.open);
  const x = useAssetsPopoverStore((s) => s.x);
  const y = useAssetsPopoverStore((s) => s.y);
  const close = useAssetsPopoverStore((s) => s.close);
  // My-Imports freshness: every successful import bumps `tick` (the import core
  // bumps AFTER `dispatchAtomic` returns — see `src/app/asset/importGltf.ts:184`,
  // pre-mortem #3 mitigation). Including `tick` in the enumeration effect's dep
  // array makes a same-session import IMMEDIATELY appear in an already-open
  // popover (checker C3 non-optional freshness guarantee).
  const tick = useImportRefreshStore((s) => s.tick);
  const ref = useRef<HTMLDivElement | null>(null);
  const [assets, setAssets] = useState<AvailableAsset[]>(
    ASSET_CATALOG.map((c) => ({ ...c, available: false })),
  );
  const [myImports, setMyImports] = useState<MyImportEntry[]>([]);

  // Lazy-resolve availability whenever the popover opens. Re-checking on
  // every open keeps the indicator honest if the user re-seeded assets
  // mid-session.
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  // My-Imports enumeration. Keyed on `[open, tick]` — every popover open AND
  // every successful import re-enumerates. The OPFS dir IS the source of truth
  // (V18 — no localStorage mirror). On first run `user-imports/` does not exist
  // and `storage.list` THROWS (the same shape as `exists()` in OpfsStorage.ts:72)
  // so the outer list call is wrapped in try/catch → []. Per-subdir list calls
  // are independently guarded so a single missing/disappeared entry doesn't
  // wipe the whole section.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const storage = await getStorage();
        let subdirs: string[];
        try {
          subdirs = await storage.list(USER_IMPORTS_ROOT);
        } catch {
          // First-run crash mitigation: `user-imports` doesn't exist yet.
          // Mirror OpfsStorage.exists's try/catch → fall back to empty.
          subdirs = [];
        }
        const entries: MyImportEntry[] = [];
        for (const name of subdirs) {
          try {
            const files = await storage.list(`${USER_IMPORTS_ROOT}/${name}`);
            // Resolve the entry file. .glb (single-file container) wins over
            // .gltf at the same depth. If neither is present at the root of
            // the subdir, recurse one level (a common shape for nested-entry
            // exports like `<dir>/gltf/scene.gltf`).
            const rootGlb = files.find((f) => f.toLowerCase().endsWith('.glb'));
            const rootGltf = files.find((f) => f.toLowerCase().endsWith('.gltf'));
            let entryRel: string | null = rootGlb ?? rootGltf ?? null;
            if (!entryRel) {
              for (const sub of files) {
                try {
                  const innerFiles = await storage.list(`${USER_IMPORTS_ROOT}/${name}/${sub}`);
                  const innerGlb = innerFiles.find((f) => f.toLowerCase().endsWith('.glb'));
                  const innerGltf = innerFiles.find((f) => f.toLowerCase().endsWith('.gltf'));
                  if (innerGlb || innerGltf) {
                    entryRel = `${sub}/${innerGlb ?? innerGltf}`;
                    break;
                  }
                } catch {
                  // `sub` is a file (not a dir) — list throws on a file path;
                  // skip and try the next sibling.
                }
              }
            }
            if (!entryRel) continue; // orphan dir (no .gltf/.glb anywhere)
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
  }, [open, tick]);

  // Outside-click + Esc → close. Mirrors AddMenu's dismiss UX.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      data-testid="library-popover"
      className="fixed z-50 w-56 rounded border border-border-strong bg-bg-2/95 p-2 font-mono text-xs text-fg shadow-md backdrop-blur-sm"
      style={{ left: x, top: y }}
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
              onDragEnd={() => close()}
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
          <ul className="flex flex-col gap-1" data-testid="library-popover-my-imports">
            {myImports.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  draggable
                  data-testid={`library-popover-my-import-${entry.path}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME, entry.path);
                    e.dataTransfer.setData('text/plain', entry.path);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={() => close()}
                  className="flex w-full cursor-grab items-center gap-2 rounded border border-border bg-bg-1/40 px-2 py-1.5 text-left text-fg/90 hover:border-accent hover:bg-bg-1"
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
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
