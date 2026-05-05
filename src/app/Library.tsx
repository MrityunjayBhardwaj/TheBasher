// Asset Library — left rail in Director mode. Lists OPFS-backed assets;
// items are HTML5-draggable. The dataTransfer payload is the OPFS path,
// which becomes the GltfAsset.assetRef in the dropped node.
//
// V6: Library reads via StorageCapability only (resolveAssetUrl + storage
// list). No direct OPFS API.
//
// REF: THESIS.md §14, P1 Wave B.

import { useEffect, useState } from 'react';
import { ASSET_CATALOG, DRAG_MIME, type CatalogEntry } from './asset/catalog';
import { getStorage } from './boot';

interface AvailableAsset extends CatalogEntry {
  available: boolean;
}

export function Library() {
  const [assets, setAssets] = useState<AvailableAsset[]>(
    ASSET_CATALOG.map((c) => ({ ...c, available: false })),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storage = await getStorage();
      const next: AvailableAsset[] = [];
      const presence = await Promise.all(ASSET_CATALOG.map((c) => storage.exists(c.path)));
      ASSET_CATALOG.forEach((c, i) => next.push({ ...c, available: presence[i] }));
      if (!cancelled) setAssets(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside
      data-testid="library"
      className="flex flex-col overflow-y-auto border-r border-border bg-muted/40 text-xs"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        library
      </header>
      <ul className="flex flex-col gap-1 p-2">
        {assets.map((a) => (
          <li key={a.path}>
            <button
              type="button"
              draggable={a.available}
              data-testid={`library-item-${a.path}`}
              data-available={a.available || undefined}
              onDragStart={(e) => {
                if (!a.available) return;
                e.dataTransfer.setData(DRAG_MIME, a.path);
                e.dataTransfer.setData('text/plain', a.path);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              className={`flex w-full items-center gap-2 rounded border border-border bg-muted/40 px-2 py-2 text-left font-mono ${
                a.available
                  ? 'cursor-grab text-fg/90 hover:bg-muted'
                  : 'cursor-not-allowed text-fg/30'
              }`}
              title={a.available ? 'Drag into the viewport' : 'Asset not yet seeded'}
            >
              <span
                aria-hidden
                className="h-6 w-6 shrink-0 rounded border border-border"
                style={{ background: a.swatch }}
              />
              <span className="grow truncate">{a.name}</span>
              <span className="text-[9px] text-fg/40">{a.available ? 'glb' : '—'}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
