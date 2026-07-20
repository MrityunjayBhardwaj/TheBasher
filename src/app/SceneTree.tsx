// Scene tree — Pro-mode hierarchy projection. Drag-reorder among siblings
// emits `disconnect → connect(index)` via dispatchAtomic, so one Cmd+Z
// reverts the move (acceptance #4).
//
// THESIS.md §12: this is a projection, not the truth. Two non-identical
// DAGs that evaluate to the same hierarchy show the same tree.
//
// REF: THESIS.md §12, §39, krama K2; vyapti V1.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDagStore } from '../core/dag/store';
import type { NodeId, Op } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { useRenameStore } from './stores/renameStore';
import { RenameInput } from './RenameInput';
import { SceneTreeIcon, iconKindForNode } from './SceneTreeIcon';
import { buildSceneTreeRows, type TreeRow } from './sceneTreeWalk';
import { buildDeleteNodesOps, buildDuplicateNodeOps } from './sceneNodeActions';
import { selectActiveCameraNode } from './activeCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';

const TREE_DRAG_MIME = 'application/x-basher-tree-row';

// Row types that own a collapsible subtree and so get a chevron. GltfAsset
// defaults COLLAPSED (node-flood, D-05); the rest default EXPANDED.
const COLLAPSIBLE_TYPES = new Set(['Group', 'Transform', 'MaterialOverride', 'GltfAsset']);
// The collapsible types that default EXPANDED (opt-out via `collapsedNodes`),
// in contrast to GltfAsset which defaults collapsed (opt-in via `expandedAssets`).
const CONTAINER_TYPES = new Set(['Group', 'Transform', 'MaterialOverride']);

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

// #227 S4 — eye / eye-off glyph for the visibility toggle. Inline SVG (stroke
// currentColor) so it themes with the row's text token — no new bg-/text- pair.
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {!open ? <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" /> : null}
    </svg>
  );
}

// One context-menu item — mirrors the MenuBar Item styling (audited tokens, no new
// bg-/text- pair → W8 gate clean).
function CtxItem({
  children,
  onClick,
  testId,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-[12px] text-fg/80 hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {children}
    </button>
  );
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
  const clearSelection = useSelectionStore((s) => s.clear);
  const renaming = useRenameStore((s) => s.renaming);
  const beginRename = useRenameStore((s) => s.begin);
  const allRows = useMemo(() => buildSceneTreeRows(state), [state]);
  // #231 Inc 3.2 — the scene's active camera (resolved THROUGH any CameraSelect,
  // V79). Drives the solid-triangle marker + which camera rows offer "Set Active".
  const activeCameraId = useMemo(() => selectActiveCameraNode(state)?.id ?? null, [state]);
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // #227 Slice 2 — right-click context menu, anchored at the cursor.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: NodeId } | null>(null);
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

  // Group / Transform / MaterialOverride subtrees start EXPANDED by default
  // (these are the user's own small hierarchies, not a glTF node-flood). This
  // is the set the user has explicitly COLLAPSED. Pure UI state, never the DAG.
  const [collapsedNodes, setCollapsedNodes] = useState<Set<NodeId>>(() => new Set());

  function toggleCollapsed(nodeId: NodeId) {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  // A row "has children" when a later row's key nests under its own (the walk is
  // pre-order, so descendants follow contiguously). Keyed by row key — only rows
  // with children get a chevron. Covers glTF assets and Group/Transform/Material
  // wrappers alike (the wrappers always project their child).
  const rowsWithChildren = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < allRows.length - 1; i++) {
      if (allRows[i + 1].key.startsWith(`${allRows[i].key}/`)) s.add(allRows[i].key);
    }
    return s;
  }, [allRows]);

  // Visible rows = the pre-order walk with every COLLAPSED container's subtree
  // cut. One pass: when a collapsed container is reached, skip every following
  // row whose key nests under it. glTF assets default collapsed (opt-in via
  // `expandedAssets`); Group/Transform/MaterialOverride default expanded (opt-out
  // via `collapsedNodes`). The rows (and their DAG nodes) still EXIST — this is
  // purely which rows render (projection only, no DAG mutation).
  const rows = useMemo(() => {
    if (filtering) {
      // While filtering, search the FULL tree (ignore collapse) so a match inside
      // a collapsed subtree still surfaces. The Scene root (depth 0) stays as the
      // anchor row so the panel never renders fully empty when the user is mid-type
      // on a query that hasn't matched a child yet. Match the row's display
      // (id/name) OR its node TYPE — display no longer carries the type (it's the
      // icon now), so searching "BoxMesh" must still match unnamed boxes.
      return allRows.filter(
        (r) =>
          r.depth === 0 ||
          r.display.toLowerCase().includes(query) ||
          r.nodeType.toLowerCase().includes(query),
      );
    }
    const visible: TreeRow[] = [];
    let cutKey: string | null = null;
    for (const row of allRows) {
      if (cutKey !== null && row.key.startsWith(`${cutKey}/`)) continue; // hidden descendant
      cutKey = null; // this row is not under the cut — we've left it
      visible.push(row);
      if (!rowsWithChildren.has(row.key)) continue;
      const collapsed =
        row.nodeType === 'GltfAsset'
          ? !expandedAssets.has(row.nodeId)
          : CONTAINER_TYPES.has(row.nodeType) && collapsedNodes.has(row.nodeId);
      if (collapsed) cutKey = row.key;
    }
    return visible;
  }, [allRows, expandedAssets, collapsedNodes, rowsWithChildren, filtering, query]);

  // #227 Slice 5(b) — scroll-to / expand-to the active row. The active row's
  // element is captured here; `scrolledFor` debounces so we scroll once per
  // selection change (not on every unrelated `rows` rebuild, e.g. a drag).
  const activeRowRef = useRef<HTMLLIElement | null>(null);
  const scrolledFor = useRef<NodeId | null>(null);
  // #227 Slice 5(c) — set when arrow-key nav moves the active row, so the scroll
  // effect FOCUSES the new active row (keeping keystrokes flowing) instead of a
  // plain scrollIntoView. Cleared once consumed.
  const navByKeyboard = useRef(false);

  // When the active node changes (e.g. a viewport pick), EXPAND every collapsed
  // ancestor so the row can surface. glTF asset ancestors → add to expandedAssets;
  // Group/Transform/Material ancestors → remove from collapsedNodes. Ancestors are
  // the rows whose key path is a strict prefix of the active row's key. Returns the
  // SAME set reference when nothing changes so this never loops.
  useEffect(() => {
    if (!primary) return;
    const selRow = allRows.find((r) => r.nodeId === primary);
    if (!selRow) return;
    const ancestors = allRows.filter(
      (r) => r.key !== selRow.key && selRow.key.startsWith(`${r.key}/`),
    );
    const assetIds = ancestors.filter((r) => r.nodeType === 'GltfAsset').map((r) => r.nodeId);
    const containerIds = ancestors
      .filter((r) => CONTAINER_TYPES.has(r.nodeType))
      .map((r) => r.nodeId);
    if (assetIds.length) {
      setExpandedAssets((prev) => {
        if (assetIds.every((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        assetIds.forEach((id) => next.add(id));
        return next;
      });
    }
    if (containerIds.length) {
      setCollapsedNodes((prev) => {
        if (!containerIds.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        containerIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [primary, allRows]);

  // Scroll the active row into view once it's actually rendered. Depends on `rows`
  // so it re-runs after the expand-to effect above reveals a previously-hidden row.
  useEffect(() => {
    if (!primary) return;
    const el = activeRowRef.current;
    if (!el) return; // row not visible yet — re-runs when `rows` updates after expand
    if (scrolledFor.current === primary && !navByKeyboard.current) return;
    scrolledFor.current = primary;
    if (navByKeyboard.current) {
      navByKeyboard.current = false;
      el.focus(); // keep keystrokes on the moved row (focus() scrolls into view too)
    } else {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [primary, rows]);

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

  // #227 Slice 5(c) — the expand state of a row, for arrow-key collapse/expand.
  function rowExpansion(row: TreeRow): { expandable: boolean; expanded: boolean } {
    const expandable = COLLAPSIBLE_TYPES.has(row.nodeType) && rowsWithChildren.has(row.key);
    const expanded =
      expandable &&
      (row.nodeType === 'GltfAsset'
        ? expandedAssets.has(row.nodeId)
        : !collapsedNodes.has(row.nodeId));
    return { expandable, expanded };
  }

  function setExpanded(row: TreeRow, open: boolean) {
    const { expanded } = rowExpansion(row);
    if (expanded === open) return;
    if (row.nodeType === 'GltfAsset') toggleAsset(row.nodeId);
    else toggleCollapsed(row.nodeId);
  }

  // The nearest visible ancestor row (longest key that strictly prefixes this row's).
  function parentRowOf(row: TreeRow): TreeRow | undefined {
    let best: TreeRow | undefined;
    for (const r of rows) {
      if (r.key !== row.key && row.key.startsWith(`${r.key}/`)) {
        if (!best || r.key.length > best.key.length) best = r;
      }
    }
    return best;
  }

  function moveActive(target: TreeRow | undefined) {
    if (!target) return;
    navByKeyboard.current = true;
    select(target.nodeId);
  }

  // #227 Slice 5(c) — arrow-key tree navigation (ARIA tree pattern, roving
  // tabindex). Up/Down move the active row; Right expands a collapsed container or
  // steps into its first child; Left collapses an expanded container or steps to
  // the parent; Enter/Space (re)select. Ignored while an inline rename input owns
  // the keystroke.
  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>, row: TreeRow) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' '];
    if (!NAV_KEYS.includes(e.key)) return;
    // The focused row OWNS these keys — stop them reaching the global shortcut
    // handler (window keydown), or Space would also toggle playback. React's
    // stopPropagation calls the native one, halting the bubble before window.
    e.stopPropagation();
    const idx = rows.findIndex((r) => r.key === row.key);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(rows[idx + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(rows[idx - 1]);
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const { expandable, expanded } = rowExpansion(row);
        if (expandable && !expanded) setExpanded(row, true);
        else {
          const child = rows[idx + 1];
          if (child && child.key.startsWith(`${row.key}/`)) moveActive(child);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const { expandable, expanded } = rowExpansion(row);
        if (expandable && expanded) setExpanded(row, false);
        else moveActive(parentRowOf(row));
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        moveActive(row);
        break;
      default:
        break;
    }
  }

  // Esc closes the context menu. CAPTURE phase + stopImmediatePropagation so it
  // preempts the global Escape handler (which would otherwise also clear the
  // selection). No-op when the menu is closed.
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setCtxMenu(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctxMenu]);

  // #227 Slice 2 — right-click context menu. Opening it on a row that isn't part
  // of the current multi-set selects it alone first (Blender's behavior), so the
  // action targets what the user pointed at.
  function onRowContextMenu(e: ReactMouseEvent, row: TreeRow) {
    e.preventDefault();
    if (!selectedIds.has(row.nodeId)) select(row.nodeId);
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: row.nodeId });
  }

  // The nodes a context action targets: the whole selection when the right-clicked
  // row is part of a multi-set, else just that row.
  function ctxTargetIds(nodeId: NodeId): NodeId[] {
    return selectedIds.has(nodeId) && selectedIds.size > 1 ? [...selectedIds] : [nodeId];
  }

  function ctxRename(nodeId: NodeId) {
    beginRename(nodeId, 'outliner');
    setCtxMenu(null);
  }

  // Duplicate the node's subtree as a sibling and select the copy (#227 Slice 3).
  function ctxDuplicate(nodeId: NodeId) {
    const res = buildDuplicateNodeOps(state, nodeId);
    if (res) {
      dispatchAtomic(res.ops, 'user', 'duplicate node');
      select(res.newRootId);
    }
    setCtxMenu(null);
  }

  // Select the node + every descendant row (Blender "Select Hierarchy"). Descendants
  // are the rows whose key path is prefixed by this row's key.
  function ctxSelectHierarchy(nodeId: NodeId) {
    const rootRow = rows.find((r) => r.nodeId === nodeId);
    if (rootRow) {
      const ids = rows
        .filter((r) => r.key === rootRow.key || r.key.startsWith(`${rootRow.key}/`))
        .map((r) => r.nodeId);
      selectMany([...new Set(ids)]);
    }
    setCtxMenu(null);
  }

  // #227 S4 — toggle a node's visibility (one setHidden op → one undo). The
  // renderer (SceneFromDAG) skips a hidden top-level node in the viewport AND the
  // offscreen render (V37, one band). v1 affordance is on top-level rows only.
  function toggleHidden(nodeId: NodeId, hidden: boolean) {
    dispatchAtomic(
      [{ type: 'setHidden', nodeId, hidden }],
      'user',
      hidden ? 'hide node' : 'show node',
    );
  }

  // #231 Inc 3.2 — make a camera the scene's active camera (Blender Ctrl-Numpad0).
  // The ONE op-builder lazily inserts a CameraSelect when 2+ cameras exist (V79);
  // a single camera wires directly. No-op when already active (null → nothing
  // dispatched). Closes the menu when invoked from there.
  function setActiveCameraAction(nodeId: NodeId, closeMenu = false) {
    const ops = buildSetActiveCameraOps(state, nodeId);
    if (ops && ops.length > 0) dispatchAtomic(ops, 'user', 'set active camera');
    if (closeMenu) setCtxMenu(null);
  }

  function ctxDelete(nodeId: NodeId) {
    const ids = ctxTargetIds(nodeId);
    const ops = buildDeleteNodesOps(state, ids);
    if (ops.length > 0) dispatchAtomic(ops, 'user', `delete ${ids.length} node(s)`);
    clearSelection();
    setCtxMenu(null);
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

  // Same-parent reorder (the original behavior): both rows hang off the SAME
  // parent socket → drag changes the sibling index.
  function canDropOn(srcRow: TreeRow, dstRow: TreeRow): boolean {
    if (!srcRow.parent || !dstRow.parent) return false;
    // #231 Inc 3.2 — `scene.camera` is a SINGLE socket, not a list; there is no
    // sibling reorder for cameras (a disconnect/connect-index would corrupt the
    // single binding). Camera rows are also non-draggable, but guard the target too.
    if (srcRow.parent.socket === 'camera' || dstRow.parent.socket === 'camera') return false;
    return (
      srcRow.parent.nodeId === dstRow.parent.nodeId && srcRow.parent.socket === dstRow.parent.socket
    );
  }

  // #231 Inc 2a — a light's "home list" on the Scene is `lights` (the rich
  // top-level band: helpers, direct channels, Track-To), a mesh's is `children`.
  // A Group only has `children`, so a light dropped into a Group goes there.
  const LIGHT_NODE_TYPES = new Set([
    'DirectionalLight',
    'PointLight',
    'SpotLight',
    'AreaLight',
    'AmbientLight',
  ]);

  // #227 Slice 1 — the list socket a row can RECEIVE the dragged node into
  // (reparent target): a Group's `children`, or one of the Scene root's lists.
  // #231 Inc 2a — the Scene-root target is kind-aware: a light rejoins
  // `scene.lights`, everything else `scene.children` (so unparenting a grouped
  // light returns it to the rich light band, not the generic children band).
  // Returns null for rows that can't hold children (leaves, Transform/Material
  // wrappers — single `target` socket, glTF children).
  function reparentSocket(
    srcRow: TreeRow,
    dstRow: TreeRow,
  ): { node: NodeId; socket: string } | null {
    if (dstRow.nodeType === 'Group') return { node: dstRow.nodeId, socket: 'children' };
    if (dstRow.depth === 0) {
      const socket = LIGHT_NODE_TYPES.has(srcRow.nodeType) ? 'lights' : 'children';
      return { node: dstRow.nodeId, socket }; // Scene root
    }
    return null;
  }

  // Can the dragged row be re-parented INTO dstRow? Requires: the src is a real
  // scene child on the `children` OR `lights` list (#231 — a top-level light hangs
  // off `lights`; glTF children have no parent → inert); dst is a Group/Scene; dst
  // is NOT already src's parent socket (no-op); and dst is NOT src itself or one of
  // src's descendants (cycle guard via the row key path — a descendant's key is
  // prefixed by the src key).
  function canReparent(srcRow: TreeRow, dstRow: TreeRow): boolean {
    if (
      !srcRow.parent ||
      (srcRow.parent.socket !== 'children' && srcRow.parent.socket !== 'lights')
    )
      return false;
    const target = reparentSocket(srcRow, dstRow);
    if (!target) return false;
    if (target.node === srcRow.parent.nodeId && target.socket === srcRow.parent.socket)
      return false;
    if (dstRow.key === srcRow.key || dstRow.key.startsWith(`${srcRow.key}/`)) return false;
    return true;
  }

  // #231 Inc 3.3 — camera reparent. A camera has NO scene-level list socket (it
  // wires to `scene.camera`, a single ref, managed by Set Active) — so its parent
  // is purely Group membership: nested in a Group (`parent.socket === 'children'`)
  // or floating top-level (`parent.socket === 'camera'`, the enumeration fiction).
  // Reparent moves ONLY that Group.children membership; the active (`scene.camera`)
  // edge is independent and untouched. Returns the move kind or null.
  //   - 'into' : connect into dstRow (a Group), disconnecting a prior Group edge.
  //   - 'root' : a NESTED camera dropped on the Scene root → disconnect from its
  //              Group → floating top-level (still enumerated + still active if it was).
  function cameraReparent(srcRow: TreeRow, dstRow: TreeRow): 'into' | 'root' | null {
    if (!srcRow.nodeType.endsWith('Camera')) return null;
    if (dstRow.key === srcRow.key) return null;
    if (dstRow.nodeType === 'Group') {
      return dstRow.nodeId === srcRow.parent?.nodeId ? null : 'into'; // not its current group
    }
    if (dstRow.depth === 0) return srcRow.parent?.socket === 'children' ? 'root' : null; // unparent
    return null;
  }

  function onDragOver(e: DragEvent, dstRow: TreeRow) {
    if (!isTreeRowDrag(e)) return;
    if (!dragKey) return;
    const srcRow = rows.find((r) => r.key === dragKey);
    if (!srcRow || srcRow === dstRow) return;
    // Reparent takes precedence when dst is a Group/Scene the node isn't already in.
    if (
      !canReparent(srcRow, dstRow) &&
      !canDropOn(srcRow, dstRow) &&
      !cameraReparent(srcRow, dstRow)
    )
      return;
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
    if (!srcRow || !srcRow.parent) return;

    const ref = { node: srcRow.nodeId, socket: 'out' };

    // #231 Inc 3.3 — camera reparent (handled FIRST; cameras never reorder/reparent
    // via the list path — they have no scene-level list socket). Moves Group.children
    // membership only; the active (`scene.camera`) edge is untouched.
    const camMove = cameraReparent(srcRow, dstRow);
    if (camMove === 'into') {
      const dstList = state.nodes[dstRow.nodeId]?.inputs.children;
      const appendIndex = Array.isArray(dstList) ? dstList.length : 0;
      const ops: Op[] = [];
      // If it was already nested in a Group, disconnect that edge first.
      if (srcRow.parent?.socket === 'children') {
        ops.push({
          type: 'disconnect',
          from: ref,
          to: { node: srcRow.parent.nodeId, socket: 'children' },
        });
      }
      ops.push({
        type: 'connect',
        from: ref,
        to: { node: dstRow.nodeId, socket: 'children' },
        index: appendIndex,
      });
      dispatchAtomic(ops, 'user', 'parent camera to group');
      return;
    }
    if (camMove === 'root') {
      // Unparent a nested camera → floating top-level (disconnect its Group edge).
      dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: ref,
            to: { node: srcRow.parent!.nodeId, socket: 'children' },
          },
        ],
        'user',
        'unparent camera',
      );
      return;
    }

    // #227 — REPARENT: move into a Group / the Scene root (different parent).
    // disconnect from the old parent socket, connect at the END of the new
    // children list (a different list → no index-shift to compensate).
    if (canReparent(srcRow, dstRow)) {
      const target = reparentSocket(srcRow, dstRow)!;
      // #231 — append at the END of the TARGET socket's list (children OR lights).
      const dstList = state.nodes[target.node]?.inputs[target.socket];
      const appendIndex = Array.isArray(dstList) ? dstList.length : 0;
      const ops: Op[] = [
        {
          type: 'disconnect',
          from: ref,
          to: { node: srcRow.parent.nodeId, socket: srcRow.parent.socket },
        },
        { type: 'connect', from: ref, to: target, index: appendIndex },
      ];
      dispatchAtomic(ops, 'user', 'reparent scene node');
      return;
    }

    // REORDER: same-parent sibling index change (the original behavior).
    if (!dstRow.parent || !canDropOn(srcRow, dstRow)) return;
    if (srcRow.parent.index === dstRow.parent.index) return;
    const to = { node: dstRow.parent.nodeId, socket: dstRow.parent.socket };
    // Drop semantic: source takes target's visual slot. After disconnecting the
    // source, indices shift left for everything to its right — including the
    // target when dst > src. Compensate so the source lands where it was dropped.
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
          // Rows that own a child subtree get a collapse/expand chevron. glTF
          // assets default collapsed (D2 node-flood); Group/Transform/Material
          // wrappers default expanded. Suppressed while filtering (the filtered
          // list isn't the contiguous subtree).
          const hasChildTree =
            !filtering && COLLAPSIBLE_TYPES.has(row.nodeType) && rowsWithChildren.has(row.key);
          const isExpanded =
            hasChildTree &&
            (row.nodeType === 'GltfAsset'
              ? expandedAssets.has(row.nodeId)
              : !collapsedNodes.has(row.nodeId));
          // #227 S4 — visibility. The eye lives on TOP-LEVEL rows (depth 1, the
          // Scene's direct children) — the renderer skips exactly these by source
          // node id, so the affordance can't lie. `hidden` dims the row + flips the
          // glyph. Suppressed while filtering (same as the chevron).
          // #231 Inc 3.2 — a camera row shows the active-marker / Set-Active
          // affordance instead of the eye (the eye toggles `meta.hidden`, which the
          // renderer only honours for top-level CHILDREN — a camera frustum isn't in
          // that band, so the eye would be a lying affordance on a camera).
          const isCamera = row.nodeType.endsWith('Camera');
          const isActiveCamera = isCamera && row.nodeId === activeCameraId;
          const isHideable = !filtering && row.depth === 1 && !isCamera;
          const hidden = state.nodes[row.nodeId]?.meta?.hidden ?? false;
          return (
            <li
              key={row.key}
              ref={isActive ? activeRowRef : undefined}
              data-testid={`scene-tree-row-${row.nodeId}`}
              data-depth={row.depth}
              data-selected={isInSet || undefined}
              data-active={isActive || undefined}
              data-dragging={isDragging || undefined}
              data-drop-hover={isHover || undefined}
              data-expanded={hasChildTree ? isExpanded : undefined}
              // Drag-reorder is inert while filtering: a filtered list is not the
              // contiguous sibling set, so a dropped index would be wrong.
              // #231 Inc 3.3 — camera rows ARE draggable now (reparent into / out of
              // a Group via the camera-specific onDrop path); they still never
              // REORDER (canDropOn rejects the single `scene.camera` socket).
              draggable={Boolean(row.parent) && !filtering}
              onDragStart={(e) => onDragStart(e, row)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, row)}
              onDrop={(e) => onDrop(e, row)}
              onClick={(e) => onRowClick(e, row)}
              onContextMenu={(e) => onRowContextMenu(e, row)}
              // Roving tabindex (ARIA tree): only the active row is tab-reachable;
              // arrows move the active row, which moves the focus. When nothing is
              // selected the Scene root anchors focus.
              tabIndex={isActive || (!primary && row.depth === 0) ? 0 : -1}
              onKeyDown={(e) => onRowKeyDown(e, row)}
              className="outline-none"
            >
              <div
                className={`group flex items-center gap-1.5 rounded-md px-2 py-1 ${
                  isActive
                    ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/40'
                    : isInSet
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-dim hover:bg-bg-1 hover:text-fg'
                } ${isHover ? 'outline outline-1 outline-accent' : ''}`}
                style={{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }}
                // Double-click ANYWHERE on the row renames in place (Blender
                // parity; F2 does the same via the global shortcut). #250-adjacent
                // fix: the handler used to sit only on the label span, so a
                // double-click on the icon or the row padding was a dead no-op
                // (the tell in p224). The action buttons below stopPropagation
                // their own double-clicks so toggling one never opens rename.
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  beginRename(row.nodeId, 'outliner');
                }}
              >
                {hasChildTree ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid={`scene-tree-toggle-${row.nodeId}`}
                    aria-label={isExpanded ? 'Collapse children' : 'Expand children'}
                    aria-expanded={isExpanded}
                    className="shrink-0 text-[10px] text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onDoubleClick={(e) => e.stopPropagation()} // never open rename
                    onClick={(e) => {
                      e.stopPropagation(); // toggle only — do NOT select the row
                      if (row.nodeType === 'GltfAsset') toggleAsset(row.nodeId);
                      else toggleCollapsed(row.nodeId);
                    }}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                ) : null}
                <span className={`flex shrink-0 ${hidden ? 'opacity-40' : ''}`}>
                  <SceneTreeIcon kind={iconKindForNode(state, row.nodeId, row.nodeType)} />
                </span>
                {renaming?.scope === 'outliner' && renaming.nodeId === row.nodeId ? (
                  <RenameInput
                    nodeId={row.nodeId}
                    priorName={state.nodes[row.nodeId]?.meta?.name}
                    placeholder={row.display}
                    testId={`scene-tree-rename-${row.nodeId}`}
                    className="grow rounded-sm border border-accent bg-bg-2 px-1 text-[13px] text-fg outline-none"
                  />
                ) : (
                  <span className={`grow truncate ${hidden ? 'opacity-40' : ''}`}>
                    {row.display}
                  </span>
                )}
                {isActiveCamera ? (
                  // The scene's active camera — a persistent solid triangle marker
                  // (Blender's filled-triangle active-camera indicator).
                  <span
                    data-testid={`scene-tree-active-camera-${row.nodeId}`}
                    title="Active camera"
                    aria-label="Active camera"
                    className="shrink-0 text-[11px] leading-none text-accent"
                  >
                    ▲
                  </span>
                ) : isCamera ? (
                  // Any other camera — hover-reveal "Set Active" (hollow triangle).
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid={`scene-tree-set-active-${row.nodeId}`}
                    aria-label="Set active camera"
                    title="Set active camera"
                    onDoubleClick={(e) => e.stopPropagation()} // never open rename
                    onClick={(e) => {
                      e.stopPropagation(); // set-active only — do NOT re-select
                      setActiveCameraAction(row.nodeId);
                    }}
                    className="shrink-0 text-[11px] leading-none text-fg-dim opacity-0 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover:opacity-100"
                  >
                    △
                  </button>
                ) : null}
                {isHideable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-testid={`scene-tree-eye-${row.nodeId}`}
                    data-hidden={hidden || undefined}
                    aria-label={hidden ? 'Show' : 'Hide'}
                    aria-pressed={hidden}
                    title={hidden ? 'Show' : 'Hide'}
                    onDoubleClick={(e) => e.stopPropagation()} // never open rename
                    onClick={(e) => {
                      e.stopPropagation(); // toggle only — do NOT select the row
                      toggleHidden(row.nodeId, !hidden);
                    }}
                    // Visible on hover, or always when hidden (so the way back is
                    // never invisible). Audited text tokens only → W8-clean.
                    className={`shrink-0 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      hidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <EyeIcon open={!hidden} />
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {ctxMenu
        ? createPortal(
            <>
              {/* Click-away backdrop. Portalled to body so a scroll/overflow
                  ancestor can't clip the menu (the MenuBar overflow-clip trap). */}
              <div
                className="fixed inset-0 z-40"
                onMouseDown={() => setCtxMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu(null);
                }}
              />
              <div
                data-testid="outliner-context-menu"
                role="menu"
                className="fixed z-50 min-w-[160px] overflow-hidden rounded border border-border bg-bg py-1 shadow-lg"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
              >
                <CtxItem
                  testId="outliner-ctx-rename"
                  onClick={() => ctxRename(ctxMenu.nodeId)}
                  disabled={ctxTargetIds(ctxMenu.nodeId).length > 1}
                >
                  Rename
                </CtxItem>
                <CtxItem
                  testId="outliner-ctx-duplicate"
                  onClick={() => ctxDuplicate(ctxMenu.nodeId)}
                >
                  Duplicate
                </CtxItem>
                <CtxItem
                  testId="outliner-ctx-select-hierarchy"
                  onClick={() => ctxSelectHierarchy(ctxMenu.nodeId)}
                >
                  Select Hierarchy
                </CtxItem>
                {/* #231 Inc 3.2 — only on a camera that isn't already active. */}
                {state.nodes[ctxMenu.nodeId]?.type.endsWith('Camera') &&
                ctxMenu.nodeId !== activeCameraId ? (
                  <CtxItem
                    testId="outliner-ctx-set-active-camera"
                    onClick={() => setActiveCameraAction(ctxMenu.nodeId, true)}
                  >
                    Set Active Camera
                  </CtxItem>
                ) : null}
                <div className="my-1 h-px bg-border" />
                <CtxItem testId="outliner-ctx-delete" onClick={() => ctxDelete(ctxMenu.nodeId)}>
                  {ctxTargetIds(ctxMenu.nodeId).length > 1
                    ? `Delete ${ctxTargetIds(ctxMenu.nodeId).length} Objects`
                    : 'Delete'}
                </CtxItem>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
