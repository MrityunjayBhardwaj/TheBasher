// What the Library tab lists, and how its source list, kind filter and search narrow it (#1707).
//
// Pure: no storage, no React. `useLibraryEntries` reads the asset store and hands its result here;
// `LibraryPane` renders what comes back.
//
// Only distinctions the data can make are offered:
//   - SOURCE — a bundled sample (the static catalog) or one of your imports (a folder under
//     `user-imports/`). The asset store is shared by every project, so there is no honest "this
//     project" source; and a saved generated asset is an ordinary import on purpose (#819), so
//     there is no "generated" source either. "My library across projects" and "Packs" have no
//     data model yet and are not shown.
//   - KIND — what the importer does with the file, read off its extension (`importFormatOf`): a
//     model or a motion. Telling a character from a prop or a set would need the file opened, so
//     those kinds are not offered; nor are materials, HDRIs or images, which the library does not
//     hold.
//
// REF: src/app/asset/importFormats.ts (the extension → family table); src/app/asset/catalog.ts.

import { importFormatOf, type ImportFamily } from '../asset/importFormats';

export type LibrarySource = 'sample' | 'import';
export type LibraryKind = ImportFamily;

export interface LibraryEntry {
  /** Storage path of the entry file — what a drag carries and the importer reads. */
  readonly path: string;
  readonly name: string;
  readonly source: LibrarySource;
  /** null when the extension is not one the importer knows. */
  readonly kind: LibraryKind | null;
  /** Placeholder thumbnail colour. */
  readonly swatch: string;
  /** A bundled sample is listed before its seed lands in the store; it can be dragged once it has. */
  readonly available: boolean;
}

export type SourceFilter = 'all' | LibrarySource;
export type KindFilter = 'all' | LibraryKind;

export interface LibraryFilter {
  readonly source: SourceFilter;
  readonly kind: KindFilter;
  readonly query: string;
}

export const SOURCE_FILTERS: readonly { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sample', label: 'Samples' },
  { id: 'import', label: 'Your imports' },
];

export const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'model', label: 'Models' },
  { id: 'motion', label: 'Motions' },
];

export const KIND_LABEL: Record<LibraryKind, string> = { model: 'Model', motion: 'Motion' };
export const SOURCE_LABEL: Record<LibrarySource, string> = {
  sample: 'Sample',
  import: 'Your import',
};

/** The entry's kind, from what the importer does with its extension. */
export function kindOf(path: string): LibraryKind | null {
  return importFormatOf(path)?.family ?? null;
}

/** The tile's format badge, read off the path (#816). Lowercase, no dot; empty when the path has
 *  no extension, so the badge shows nothing rather than a slice of the filename. */
export function formatBadge(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Does `entry` pass the kind filter and the search? (The source is applied separately, so the
 *  source list can count what each source would show.) */
function matchesKindAndQuery(entry: LibraryEntry, kind: KindFilter, query: string): boolean {
  if (kind !== 'all' && entry.kind !== kind) return false;
  const q = query.trim().toLowerCase();
  return q === '' || entry.name.toLowerCase().includes(q);
}

export function filterEntries(
  entries: readonly LibraryEntry[],
  filter: LibraryFilter,
): LibraryEntry[] {
  return entries.filter(
    (e) =>
      (filter.source === 'all' || e.source === filter.source) &&
      matchesKindAndQuery(e, filter.kind, filter.query),
  );
}

/** How many entries each source would show under the current kind filter and search. */
export function countBySource(
  entries: readonly LibraryEntry[],
  filter: Pick<LibraryFilter, 'kind' | 'query'>,
): Record<SourceFilter, number> {
  const counts: Record<SourceFilter, number> = { all: 0, sample: 0, import: 0 };
  for (const e of entries) {
    if (!matchesKindAndQuery(e, filter.kind, filter.query)) continue;
    counts.all += 1;
    counts[e.source] += 1;
  }
  return counts;
}
