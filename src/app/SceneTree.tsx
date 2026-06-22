// Scene tree — Pro-mode hierarchy projection. Drag-reorder among siblings
// emits `disconnect → connect(index)` via dispatchAtomic, so one Cmd+Z
// reverts the move (acceptance #4).
//
// THESIS.md §12: this is a projection, not the truth. Two non-identical
// DAGs that evaluate to the same hierarchy show the same tree.
//
// REF: THESIS.md §12, §39, krama K2; vyapti V1.

import { useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId, Op } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { useRenameStore } from './stores/renameStore';
import { RenameInput } from './RenameInput';
import { SceneTreeIcon } from './SceneTreeIcon';
import { buildSceneTreeRows, type TreeRow } from './sceneTreeWalk';

const TREE_DRAG_MIME = 'application/x-basher-tree-row';

interface SceneTreeProps {
  /**
   * Substring filter from the outliner search box (Spline redesign Wave B).
   * Empty / whitespace = show the full tree. Non-empty = show only rows whose
   * display name contains the query (case-insensitive); a flat match (depth
   * indentation kept) — the Scene root row is always shown as the anchor.
   * Drag-reorder is implicitly inert while filtering because a filtered list
   * isn't the contiguous sibling set, so a dropped index would be wrong —
   * gated below by `filtering`.
   */
  readonly filter?: string;
}

export function SceneTree({ filter = '' }: SceneTreeProps) {
  const state = useDagStore((s) => s.state);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  // #226 Slice 2 — the outliner reads the whole SET + the active id (not just
  // the primary) so ctrl/shift multi-select shows every member, with the active
  // row distinguished (Blender's active-vs-selected highlight).
  const selectedIds = useSelectionStore((s) => s.selectedNodeIds);
  const primary = useSelectionStore((s) => s.primaryNodeId);
  const select = useSelectionStore((s) => s.select);
  const selectAdditive = useSelectionStore((s) => s.selectAdditive);
  const selectMany = useSelectionStore((s) => s.selectMany);
  const renaming = useRenameStore((s) => s.renaming);
  const beginRename = useRenameStore((s) => s.begin);
  const allRows = useMemo(() => buildSceneTreeRows(state), [state]);
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // GltfAsset child subtrees start COLLAPSED by default (D-05 node-flood:
  // a 50-100-bone character would otherwise flood the outliner). This is a
  // local set of the GltfAsset node ids the user has EXPANDED — empty =
  // every glTF subtree collapsed. Pure UI state, never touches the DAG.
  const [expandedAssets, setExpandedAssets] = useState<Set<NodeId>>(() => new Set());

  function toggleAsset(assetId: NodeId) {
    setExpandedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  // GltfAsset node ids that own at least one projected child row — only those
  // rows get the collapse/expand chevron (an asset with no children doesn't).
  const assetsWithChildren = useMemo(() => {
    const s = new Set<NodeId>();
    for (const r of allRows) if (r.gltfAssetOwner) s.add(r.gltfAssetOwner);
    return s;
  }, [allRows]);

  // Hide projected GltfChild rows whose owning asset is collapsed. The rows
  // (and their GltfChild DAG nodes) still EXIST — this is purely which rows
  // render (projection only, no DAG mutation).
  const rows = useMemo(() => {
    const collapsed = allRows.filter(
      (r) => !r.gltfAssetOwner || expandedAssets.has(r.gltfAssetOwner),
    );
    if (!filtering) return collapsed;
    // While filtering, search the FULL tree (ignore collapse) so a match inside
    // a collapsed glTF subtree still surfaces. The Scene root (depth 0) stays as
    // the anchor row so the panel never renders fully empty when the user is
    // mid-type on a query that hasn't matched a child yet. Match the row's
    // display (id/name) OR its node TYPE — display no longer carries the type
    // (it's the icon now), so searching "BoxMesh" must still match unnamed boxes.
    return allRows.filter(
      (r) =>
        r.depth === 0 ||
        r.display.toLowerCase().includes(query) ||
        r.nodeType.toLowerCase().includes(query),
    );
  }, [allRows, expandedAssets, filtering, query]);

  // #226 Slice 2 — modifier-aware row selection (Blender outliner parity):
  //   plain click → replace selection; Ctrl/Cmd-click → toggle the row in the
  //   set; Shift-click → select the inclusive range from the active row to the
  //   clicked row (the clicked row becomes active). Selection is a UI projection
  //   (V1/V8) — no DAG write.
  function onRowClick(e: ReactMouseEvent, row: TreeRow) {
    if (e.metaKey || e.ctrlKey) {
      selectAdditive(row.nodeId);
      return;
    }
    if (e.shiftKey && primary) {
      const ids = rows.map((r) => r.nodeId);
      const from = ids.indexOf(primary);
      const to = ids.indexOf(row.nodeId);
      if (from !== -1 && to !== -1) {
        const range = from <= to ? ids.slice(from, to + 1) : ids.slice(to, from + 1).reverse();
        // selectMany makes the LAST id active — `range` ends at the clicked row.
        selectMany(range);
        return;
      }
    }
    select(row.nodeId);
  }

  function onDragStart(e: DragEvent, row: TreeRow) {
    if (!row.parent) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(TREE_DRAG_MIME, row.key);
    e.dataTransfer.effectAllowed = 'move';
    setDragKey(row.key);
  }

  function onDragEnd() {
    setDragKey(null);
    setHoverKey(null);
  }

  function isTreeRowDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes(TREE_DRAG_MIME);
  }

  function canDropOn(srcRow: TreeRow, dstRow: TreeRow): boolean {
    if (!srcRow.parent || !dstRow.parent) return false;
    return (
      srcRow.parent.nodeId === dstRow.parent.nodeId && srcRow.parent.socket === dstRow.parent.socket
    );
  }

  function onDragOver(e: DragEvent, dstRow: TreeRow) {
    if (!isTreeRowDrag(e)) return;
    if (!dragKey) return;
    const srcRow = rows.find((r) => r.key === dragKey);
    if (!srcRow || srcRow === dstRow) return;
    if (!canDropOn(srcRow, dstRow)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHoverKey(dstRow.key);
  }

  function onDrop(e: DragEvent, dstRow: TreeRow) {
    if (!isTreeRowDrag(e)) return;
    e.preventDefault();
    setHoverKey(null);
    const srcKey = e.dataTransfer.getData(TREE_DRAG_MIME);
    setDragKey(null);
    const srcRow = rows.find((r) => r.key === srcKey);
    if (!srcRow || !srcRow.parent || !dstRow.parent) return;
    if (!canDropOn(srcRow, dstRow)) return;
    if (srcRow.parent.index === dstRow.parent.index) return;

    const ref = { node: srcRow.nodeId, socket: 'out' };
    const to = { node: dstRow.parent.nodeId, socket: dstRow.parent.socket };
    // Drop semantic: source takes target's visual slot. After disconnecting
    // the source from its current position, indices shift left for
    // everything that was to its right — including the target row when
    // dst > src. Compensate so the connected source lands precisely where
    // the user dropped.
    const adjusted =
      dstRow.parent.index > srcRow.parent.index ? dstRow.parent.index - 1 : dstRow.parent.index;

    const ops: Op[] = [
      { type: 'disconnect', from: ref, to },
      { type: 'connect', from: ref, to, index: adjusted },
    ];
    dispatchAtomic(ops, 'user', 'reorder scene tree');
  }

  return (
    <div
      data-testid="scene-tree"
      data-filtering={filtering || undefined}
      className="no-scrollbar flex h-full flex-col overflow-y-auto text-[13px]"
    >
      {filtering && rows.length <= 1 ? (
        <p data-testid="scene-tree-no-matches" className="px-3 py-2 text-[12px] text-fg-dim">
          No objects match “{filter.trim()}”.
        </p>
      ) : null}
      <ul className="flex flex-col px-1.5 py-1">
        {rows.map((row) => {
          // #226 Slice 2 — a row is "in the set" (a selected member) and/or the
          // "active" node (the primary, what the inspector/gizmo focus). Active
          // gets the brighter ring; a non-active member gets the fill only.
          const isInSet = selectedIds.has(row.nodeId);
          const isActive = primary === row.nodeId;
          const isDragging = dragKey === row.key;
          const isHover = hoverKey === row.key;
          // GltfAsset rows that own child rows get a collapse/expand chevron
          // (D2 — the D-05 node-flood toggle). Collapsed by default. Suppressed
          // while filtering (the filtered list isn't the contiguous subtree).
          const hasChildTree =
            !filtering && row.nodeType === 'GltfAsset' && assetsWithChildren.has(row.nodeId);
          const isExpanded = hasChildTree && expandedAssets.has(row.nodeId);
          return (
            <li
              key={row.key}
              data-testid={`scene-tree-row-${row.nodeId}`}
              data-depth={row.depth}
              data-selected={isInSet || undefined}
              data-active={isActive || undefined}
              data-dragging={isDragging || undefined}
              data-drop-hover={isHover || undefined}
              data-gltf-expanded={hasChildTree ? isExpanded : undefined}
              // Drag-reorder is inert while filtering: a filtered list is not the
              // contiguous sibling set, so a dropped index would be wrong.
              draggable={Boolean(row.parent) && !filtering}
              onDragStart={(e) => onDragStart(e, row)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, row)}
              onDrop={(e) => onDrop(e, row)}
              onClick={(e) => onRowClick(e, row)}
            >
              <div
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${
                  isActive
                    ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/40'
                    : isInSet
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-dim hover:bg-bg-1 hover:text-fg'
                } ${isHover ? 'outline outline-1 outline-accent' : ''}`}
                style={{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }}
              >
                {hasChildTree ? (
                  <button
                    type="button"
                    data-testid={`scene-tree-toggle-${row.nodeId}`}
                    aria-label={isExpanded ? 'Collapse children' : 'Expand children'}
                    aria-expanded={isExpanded}
                    className="shrink-0 text-[10px] text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={(e) => {
                      e.stopPropagation(); // toggle only — do NOT select the asset
                      toggleAsset(row.nodeId);
                    }}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                ) : null}
                <SceneTreeIcon nodeType={row.nodeType} />
                {renaming?.scope === 'outliner' && renaming.nodeId === row.nodeId ? (
                  <RenameInput
                    nodeId={row.nodeId}
                    priorName={state.nodes[row.nodeId]?.meta?.name}
                    placeholder={row.display}
                    testId={`scene-tree-rename-${row.nodeId}`}
                    className="grow rounded-sm border border-accent bg-bg-2 px-1 text-[13px] text-fg outline-none"
                  />
                ) : (
                  <span
                    className="grow truncate"
                    // Double-click renames in place (F2 does the same via the
                    // global shortcut). stopPropagation so the dbl-click doesn't
                    // re-fire the row's single-click select underneath.
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      beginRename(row.nodeId, 'outliner');
                    }}
                  >
                    {row.display}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
