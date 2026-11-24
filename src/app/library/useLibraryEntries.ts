// The Library tab's entries, read from the asset store (#1707 — moved here from AssetLibrary,
// which the left panel's Assets tab mounted).
//
// Two sources:
//   - the bundled samples (the static catalog), each `available` once its seed is in the store;
//   - your imports: every folder under `user-imports/` that holds an importable entry file.
//
// Freshness: both re-read on mount AND on every successful import (`importRefreshStore.tick`), so
// a same-session import appears in the open tab at once. The store's folders ARE the source of
// truth (V18 — no localStorage mirror).
//
// V6 + V8: reads StorageCapability via the boot helper; no DAG mutation.

import { useEffect, useState } from 'react';
import { ASSET_CATALOG } from '../asset/catalog';
import { USER_IMPORTS_ROOT } from '../asset/importCommon';
import { pickEntryFile } from '../asset/importFormats';
import { getStorage } from '../boot';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { kindOf, type LibraryEntry } from './libraryEntries';
import { importLicenceOf } from '../licence/assetLicences';

/** The swatch for your imports — an amber chip distinct from every bundled swatch and from the
 *  `accent` green, so your own assets read as yours at a glance. Asset-identity DATA colours (like
 *  the catalog swatches), not chrome tokens. */
export const MY_IMPORT_SWATCH = '#f0b85a';

export interface LibraryEntries {
  readonly samples: readonly LibraryEntry[];
  readonly imports: readonly LibraryEntry[];
}

function sampleEntries(presence: readonly boolean[] | null): LibraryEntry[] {
  return ASSET_CATALOG.map((c, i) => ({
    path: c.path,
    name: c.name,
    source: 'sample',
    kind: kindOf(c.path),
    swatch: c.swatch,
    available: presence?.[i] ?? false,
    licence: c.licence,
  }));
}

export function useLibraryEntries(): LibraryEntries {
  const tick = useImportRefreshStore((s) => s.tick);
  const [samples, setSamples] = useState<LibraryEntry[]>(() => sampleEntries(null));
  const [imports, setImports] = useState<LibraryEntry[]>([]);

  // Bundled-sample availability — re-checked on every import so the indicator stays honest.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const storage = await getStorage();
      const presence = await Promise.all(ASSET_CATALOG.map((c) => storage.exists(c.path)));
      if (!cancelled) setSamples(sampleEntries(presence));
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Your imports. On first run `user-imports/` does not exist and `storage.list` THROWS (same
  // shape as `exists()` in OpfsStorage.ts), so the outer list is guarded → []. Per-folder reads
  // are guarded independently so one vanished folder doesn't wipe the section.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const storage = await getStorage();
        let subdirs: string[];
        try {
          subdirs = await storage.list(USER_IMPORTS_ROOT);
        } catch {
          subdirs = [];
        }
        const entries: LibraryEntry[] = [];
        for (const name of subdirs) {
          try {
            const files = await storage.list(`${USER_IMPORTS_ROOT}/${name}`);
            // The entry file: glTF (.glb wins over .gltf at the same depth) or a single .bvh/.fbx
            // (#111). Not at the root → look one level down (exports like `<dir>/gltf/scene.gltf`).
            let entryRel: string | null = pickEntryFile(files);
            if (!entryRel) {
              for (const sub of files) {
                try {
                  const inner = pickEntryFile(
                    await storage.list(`${USER_IMPORTS_ROOT}/${name}/${sub}`),
                  );
                  if (inner) {
                    entryRel = `${sub}/${inner}`;
                    break;
                  }
                } catch {
                  // `sub` is a file, not a folder — list throws on a file path; try the next.
                }
              }
            }
            if (!entryRel) continue; // a folder with nothing importable in it
            const path = `${USER_IMPORTS_ROOT}/${name}/${entryRel}`;
            entries.push({
              path,
              name,
              source: 'import',
              kind: kindOf(path),
              swatch: MY_IMPORT_SWATCH,
              available: true,
              licence: await importLicenceOf(path),
            });
          } catch {
            // The folder vanished between the outer list and this read — skip it.
          }
        }
        if (!cancelled) setImports(entries);
      } catch {
        // No storage at all — an empty section, silently.
        if (!cancelled) setImports([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { samples, imports };
}
