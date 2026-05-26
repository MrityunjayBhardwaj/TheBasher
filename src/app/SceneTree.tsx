// Scene tree — Pro-mode hierarchy projection. Drag-reorder among siblings
// emits `disconnect → connect(index)` via dispatchAtomic, so one Cmd+Z
// reverts the move (acceptance #4).
//
// THESIS.md §12: this is a projection, not the truth. Two non-identical
// DAGs that evaluate to the same hierarchy show the same tree.
//
// REF: THESIS.md §12, §39, krama K2; vyapti V1.

import { useMemo, useState, type DragEvent } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId, Op } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { buildSceneTreeRows, type TreeRow } from './sceneTreeWalk';

const TREE_DRAG_MIME = 'application/x-basher-tree-row';

export function SceneTree() {
  const state = useDagStore((s) => s.state);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const selected = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);
  const allRows = useMemo(() => buildSceneTreeRows(state), [state]);

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
  const rows = useMemo(
    () => allRows.filter((r) => !r.gltfAssetOwner || expandedAssets.has(r.gltfAssetOwner)),
    [allRows, expandedAssets],
  );

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
    <aside
      data-testid="scene-tree"
      className="flex h-full flex-col overflow-y-auto border-r border-border bg-muted/20 text-xs"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        scene tree
      </header>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const isSel = selected === row.nodeId;
          const isDragging = dragKey === row.key;
          const isHover = hoverKey === row.key;
          // GltfAsset rows that own child rows get a collapse/expand chevron
          // (D2 — the D-05 node-flood toggle). Collapsed by default.
          const hasChildTree = row.nodeType === 'GltfAsset' && assetsWithChildren.has(row.nodeId);
          const isExpanded = hasChildTree && expandedAssets.has(row.nodeId);
          return (
            <li
              key={row.key}
              data-testid={`scene-tree-row-${row.nodeId}`}
              data-depth={row.depth}
              data-dragging={isDragging || undefined}
              data-drop-hover={isHover || undefined}
              data-gltf-expanded={hasChildTree ? isExpanded : undefined}
              draggable={Boolean(row.parent)}
              onDragStart={(e) => onDragStart(e, row)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, row)}
              onDrop={(e) => onDrop(e, row)}
              onClick={() => select(row.nodeId)}
            >
              <div
                className={`flex items-baseline gap-2 border-b border-border/40 px-2 py-1 font-mono ${
                  isSel ? 'bg-accent/15 text-accent' : 'text-fg/80 hover:bg-muted'
                } ${isHover ? 'outline outline-1 outline-accent' : ''}`}
                style={{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }}
              >
                {hasChildTree && (
                  <button
                    type="button"
                    data-testid={`scene-tree-toggle-${row.nodeId}`}
                    aria-label={isExpanded ? 'Collapse children' : 'Expand children'}
                    aria-expanded={isExpanded}
                    className="shrink-0 text-fg/40 hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-accent"
                    onClick={(e) => {
                      e.stopPropagation(); // toggle only — do NOT select the asset
                      toggleAsset(row.nodeId);
                    }}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                )}
                <span className="grow truncate">{row.display}</span>
                <span className="text-[10px] text-fg/40">{row.nodeId}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
