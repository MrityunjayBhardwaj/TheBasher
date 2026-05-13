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

export function AssetsPopover(): ReactNode {
  const open = useAssetsPopoverStore((s) => s.open);
  const x = useAssetsPopoverStore((s) => s.x);
  const y = useAssetsPopoverStore((s) => s.y);
  const close = useAssetsPopoverStore((s) => s.close);
  const ref = useRef<HTMLDivElement | null>(null);
  const [assets, setAssets] = useState<AvailableAsset[]>(
    ASSET_CATALOG.map((c) => ({ ...c, available: false })),
  );

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
    </div>
  );
}
