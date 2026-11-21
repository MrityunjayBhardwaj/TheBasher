// LibraryPane — the asset library, in the bottom drawer's Library tab (#1707).
//
// Moved here from the left panel's Assets tab (UX backlog #6 had put it there; the drawer gives it
// the width a narrow column could not — Unreal's content drawer, without covering the shot). The
// left panel is the outliner only now.
//
//   sources │ kind filter · search            │ details
//           │ Generate · tiles…               │ (the selected tile, or the Generate form)
//   Import… · "drag a tile onto the viewport"
//
// What it does is what the Assets tab did: Import… (the same picker File ▸ Import uses), the
// Generate form (the prompt road beside the file road, #764), the bundled samples and your
// imports, drag a tile onto the viewport to add it (DRAG_MIME → AssetDropZone, unchanged), and
// rename / show files / delete for your imports. The test ids of the old list (`library-popover*`)
// are kept on the same elements, so the import and management browser tests keep working.
//
// The sources and kinds offered are only the ones the data can tell apart (libraryEntries.ts).
//
// V8: app-layer. No DAG mutation here — the drop zone's import dispatches.
//
// REF: src/app/library/libraryEntries.ts; src/app/library/useLibraryEntries.ts;
//      src/app/AssetDropZone.tsx; issue #1707.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { DRAG_MIME } from '../asset/catalog';
import {
  deleteImportedAsset,
  listFilesDeep,
  renameImportedAsset,
  USER_IMPORTS_ROOT,
} from '../asset/importCommon';
import { openImportPicker } from '../asset/importPicker';
import { getStorage } from '../boot';
import { GeneratePanel } from '../GeneratePanel';
import {
  countBySource,
  filterEntries,
  formatBadge,
  KIND_FILTERS,
  KIND_LABEL,
  SOURCE_FILTERS,
  SOURCE_LABEL,
  type KindFilter,
  type LibraryEntry,
  type SourceFilter,
} from './libraryEntries';
import { useLibraryEntries } from './useLibraryEntries';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function LibraryPane(): ReactNode {
  const { samples, imports } = useLibraryEntries();
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  // The selected tile, by path; null shows the Generate form in the details column.
  const [selected, setSelected] = useState<string | null>(null);

  // Per-tile management (Phase 7.14 #112): at most one tile's ⋮ menu / rename field / file list is
  // active at a time; the delete-block banner is global.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showFilesFor, setShowFilesFor] = useState<{ name: string; files: string[] } | null>(null);
  const [deleteBlock, setDeleteBlock] = useState<{ name: string; refs: number } | null>(null);
  // Guards the Enter/blur double-commit on the rename field (see commitRename).
  const renameCommittedRef = useRef(false);

  const all = useMemo(() => [...samples, ...imports], [samples, imports]);
  const counts = useMemo(() => countBySource(all, { kind, query }), [all, kind, query]);
  const filter = { source, kind, query };
  const shownSamples = filterEntries(samples, filter);
  const shownImports = filterEntries(imports, filter);
  const selectedEntry = all.find((e) => e.path === selected) ?? null;

  function beginRename(name: string): void {
    setMenuFor(null);
    setShowFilesFor(null);
    renameCommittedRef.current = false;
    setRenameFor(name);
    setRenameValue(name);
  }

  function commitRename(oldName: string): void {
    // Enter and the unmount `onBlur` that follows it both call this; fire once per edit.
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

  async function showFiles(entry: LibraryEntry): Promise<void> {
    setMenuFor(null);
    setRenameFor(null);
    setSelected(entry.path);
    const storage = await getStorage();
    const files = await listFilesDeep(storage, `${USER_IMPORTS_ROOT}/${entry.name}`);
    setShowFilesFor({ name: entry.name, files: files.sort() });
  }

  function select(path: string | null): void {
    setSelected(path);
    setShowFilesFor(null);
  }

  const sections = [
    { id: 'sample' as const, label: 'Samples', entries: shownSamples },
    { id: 'import' as const, label: 'Your imports', entries: shownImports },
  ].filter((s) => s.entries.length > 0);

  const generateTile = (
    <button
      type="button"
      data-testid="library-generate-tile"
      data-selected={selected === null || undefined}
      onClick={() => select(null)}
      title="Generate a motion or a model from a sentence"
      className={`flex h-[116px] w-[124px] flex-col items-center justify-center gap-1 rounded-md border border-dashed text-fg-dim hover:border-accent hover:text-fg ${FOCUS_RING} ${
        selected === null ? 'border-accent text-accent' : 'border-border'
      }`}
    >
      <span aria-hidden className="text-[18px] leading-none">
        ＋
      </span>
      <span className="text-[12px] font-medium">Generate…</span>
      <span className="text-[10px] text-fg-mute">from a sentence</span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-xs text-fg">
      <div className="flex min-h-0 flex-1">
        {/* Sources. */}
        <nav
          aria-label="Library sources"
          data-testid="library-sources"
          className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
        >
          {SOURCE_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`library-source-${s.id === 'import' ? 'imports' : s.id === 'sample' ? 'samples' : 'all'}`}
              aria-pressed={source === s.id}
              data-active={source === s.id || undefined}
              onClick={() => setSource(s.id)}
              className={`flex items-center justify-between rounded px-2 py-1 text-left text-[12px] ${FOCUS_RING} ${
                source === s.id ? 'bg-bg-1 text-fg' : 'text-fg-dim hover:bg-bg-1 hover:text-fg'
              }`}
            >
              <span className="truncate">{s.label}</span>
              <span className="tabular-nums text-fg-dim">{counts[s.id]}</span>
            </button>
          ))}
        </nav>

        {/* Kind filter + search, over the tiles. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <div role="group" aria-label="Kind" className="flex items-center gap-0.5">
              {KIND_FILTERS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  data-testid={`library-kind-${k.id}`}
                  aria-pressed={kind === k.id}
                  data-active={kind === k.id || undefined}
                  onClick={() => setKind(k.id)}
                  className={`rounded px-2 py-0.5 text-[12px] ${FOCUS_RING} ${
                    kind === k.id ? 'bg-bg-1 text-fg' : 'text-fg-dim hover:text-fg'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search assets…"
              aria-label="Search assets"
              data-testid="library-search"
              className={`h-6 w-56 rounded-md border border-border bg-bg px-2 text-[12px] text-fg placeholder:text-fg-dim ${FOCUS_RING}`}
            />
          </div>

          <div
            data-testid="library-popover"
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2"
          >
            {deleteBlock && (
              <div
                data-testid="library-popover-delete-banner"
                role="alert"
                className="flex items-center gap-2 rounded border border-border-strong bg-warn/10 px-2 py-1.5 text-[11px] text-warn"
              >
                <span className="grow">
                  “{deleteBlock.name}” is used by {deleteBlock.refs} node
                  {deleteBlock.refs === 1 ? '' : 's'} in the scene.
                </span>
                <button
                  type="button"
                  data-testid={`library-popover-delete-anyway-${deleteBlock.name}`}
                  onClick={() => doDelete(deleteBlock.name, true)}
                  className={`rounded border border-border bg-bg-1 px-2 py-0.5 text-warn hover:border-accent hover:bg-bg-2 ${FOCUS_RING}`}
                >
                  Delete anyway
                </button>
                <button
                  type="button"
                  data-testid="library-popover-delete-cancel"
                  onClick={() => setDeleteBlock(null)}
                  className={`rounded border border-border px-2 py-0.5 text-fg-dim hover:border-accent hover:bg-bg-1 ${FOCUS_RING}`}
                >
                  Cancel
                </button>
              </div>
            )}
            {sections.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {generateTile}
                <p data-testid="library-empty" className="self-center px-2 text-fg-dim">
                  No assets match.
                </p>
              </div>
            )}
            {sections.map((section, i) => (
              <section key={section.id} aria-label={section.label}>
                <header className="mb-1 px-0.5 text-[10px] uppercase tracking-wide text-fg-dim">
                  {section.label}
                </header>
                <ul
                  className="flex flex-wrap gap-2"
                  data-testid={section.id === 'import' ? 'library-popover-my-imports' : undefined}
                >
                  {i === 0 && <li>{generateTile}</li>}
                  {section.entries.map((entry) => (
                    <li key={entry.path} className="relative">
                      <Tile
                        entry={entry}
                        selected={selected === entry.path}
                        renaming={renameFor === entry.name && entry.source === 'import'}
                        renameValue={renameValue}
                        onRenameChange={setRenameValue}
                        onRenameCommit={() => commitRename(entry.name)}
                        onRenameCancel={() => {
                          // Reset first so the unmount `onBlur` commits a no-op.
                          setRenameValue(entry.name);
                          setRenameFor(null);
                        }}
                        onSelect={() => select(entry.path)}
                        onMenu={() => setMenuFor((cur) => (cur === entry.path ? null : entry.path))}
                      />
                      {menuFor === entry.path && entry.source === 'import' && (
                        <div
                          data-testid={`library-popover-menu-${entry.name}`}
                          className="absolute right-0 top-7 z-10 flex w-32 flex-col rounded border border-border-strong bg-bg-2 py-1 shadow-md"
                        >
                          <button
                            type="button"
                            data-testid={`library-popover-menu-rename-${entry.name}`}
                            onClick={() => beginRename(entry.name)}
                            className={`px-2 py-1 text-left text-fg/90 hover:bg-bg-1 ${FOCUS_RING}`}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            data-testid={`library-popover-menu-showfiles-${entry.name}`}
                            onClick={() => void showFiles(entry)}
                            className={`px-2 py-1 text-left text-fg/90 hover:bg-bg-1 ${FOCUS_RING}`}
                          >
                            Show files
                          </button>
                          <button
                            type="button"
                            data-testid={`library-popover-menu-delete-${entry.name}`}
                            onClick={() => doDelete(entry.name, false)}
                            className={`px-2 py-1 text-left text-error hover:bg-bg-1 ${FOCUS_RING}`}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        {/* Details — the selected tile, or the Generate form. The form stays mounted while a tile
            is shown, so a generation in flight keeps its progress. */}
        <aside
          aria-label="Asset details"
          className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-2"
        >
          {selectedEntry && (
            <Details
              entry={selectedEntry}
              files={showFilesFor?.name === selectedEntry.name ? showFilesFor.files : null}
            />
          )}
          <div className={selectedEntry ? 'hidden' : 'contents'}>
            <GeneratePanel />
          </div>
        </aside>
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-2 py-1">
        {/* Import… — the same picker File ▸ Import uses (V34, one path). */}
        <button
          type="button"
          data-testid="library-import"
          onClick={() => openImportPicker()}
          className={`flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[12px] text-fg/90 hover:border-accent hover:text-accent ${FOCUS_RING}`}
        >
          <span aria-hidden>＋</span>
          <span>Import…</span>
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-fg-dim">Drag a tile onto the viewport to add it</span>
      </footer>
    </div>
  );
}

function Tile({
  entry,
  selected,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onMenu,
}: {
  entry: LibraryEntry;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onMenu: () => void;
}): ReactNode {
  const mine = entry.source === 'import';
  const badge = formatBadge(entry.path);
  if (renaming) {
    return (
      <div className="flex h-[116px] w-[124px] flex-col justify-end rounded-md border border-accent bg-bg-1 p-1.5">
        <input
          type="text"
          autoFocus
          data-testid={`library-popover-rename-input-${entry.name}`}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            else if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={onRenameCommit}
          aria-label={`Rename ${entry.name}`}
          className="w-full rounded border border-accent bg-bg-1 px-1.5 py-1 text-fg outline-none"
        />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        draggable={entry.available}
        data-testid={
          mine ? `library-popover-my-import-${entry.path}` : `library-popover-item-${entry.path}`
        }
        data-library-tile={entry.path}
        data-kind={entry.kind ?? undefined}
        data-source={entry.source}
        data-available={entry.available || undefined}
        data-selected={selected || undefined}
        aria-pressed={selected}
        onClick={onSelect}
        onDragStart={(e) => {
          if (!entry.available) return;
          e.dataTransfer.setData(DRAG_MIME, entry.path);
          e.dataTransfer.setData('text/plain', entry.path);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        title={entry.available ? 'Drag onto the viewport to add it' : 'Not yet in the asset store'}
        className={`flex h-[116px] w-[124px] flex-col gap-1 rounded-md border bg-bg-1/40 p-1.5 text-left ${FOCUS_RING} ${
          selected ? 'border-accent' : 'border-border hover:border-accent'
        } ${entry.available ? 'cursor-grab' : 'cursor-not-allowed'}`}
      >
        <span className="relative flex h-16 w-full items-center justify-center rounded bg-bg-2">
          <span
            aria-hidden
            className="h-8 w-8 rounded border border-border"
            style={{ background: entry.swatch }}
          />
          <span className="absolute bottom-0.5 right-1 font-mono text-[9px] text-fg-mute">
            {entry.available ? badge : '—'}
          </span>
        </span>
        <span
          className={`truncate text-[12px] font-medium ${entry.available ? 'text-fg/90' : 'text-fg-mute'}`}
        >
          {entry.name}
        </span>
        <span className="truncate text-[10px] text-fg-dim">
          {entry.kind ? KIND_LABEL[entry.kind] : 'Asset'} · {mine ? 'yours' : 'sample'}
        </span>
      </button>
      {mine && (
        <button
          type="button"
          aria-label={`Manage ${entry.name}`}
          data-testid={`library-popover-menu-btn-${entry.name}`}
          onClick={onMenu}
          className={`absolute right-1 top-1 rounded border border-border bg-bg-2 px-1 text-fg-dim hover:border-accent hover:bg-bg-1 ${FOCUS_RING}`}
        >
          ⋮
        </button>
      )}
    </>
  );
}

function Details({ entry, files }: { entry: LibraryEntry; files: string[] | null }): ReactNode {
  const rows: [string, string][] = [
    ['Kind', entry.kind ? KIND_LABEL[entry.kind] : '—'],
    ['Format', formatBadge(entry.path) || '—'],
    ['Source', SOURCE_LABEL[entry.source]],
    ['Stored at', entry.path],
  ];
  return (
    <div data-testid="library-details" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-10 w-10 shrink-0 rounded border border-border"
          style={{ background: entry.swatch }}
        />
        <div className="flex min-w-0 flex-col">
          <span
            data-testid="library-details-name"
            className="truncate text-[13px] font-medium text-fg"
          >
            {entry.name}
          </span>
          <span className="text-[11px] text-fg-dim">
            {entry.kind ? KIND_LABEL[entry.kind] : 'Asset'} · {SOURCE_LABEL[entry.source]}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-dim">{k}</dt>
            <dd className="truncate font-mono text-fg/90" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-fg-dim">
        {entry.available
          ? 'Drag onto the viewport to add it to the scene.'
          : 'Still being copied into the asset store.'}
      </p>
      {files && (
        <ul
          data-testid={`library-popover-files-${entry.name}`}
          className="flex flex-col gap-0.5 rounded border border-border bg-bg-1/40 px-2 py-1 text-[10px] text-fg-dim"
        >
          {files.map((f) => (
            <li key={f} className="truncate">
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
