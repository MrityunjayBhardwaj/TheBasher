// #397 — Blender's Move to Collection menu (M in the viewport): the Scene Collection, each of the
// scene's collections, and New Collection. Choosing one moves the selection there through one undo
// entry (`moveToCollectionOps`), and says what it did, as Blender's "P moved to A" report does.
// Lights and cameras stay out — their drawers honour no collection's hide yet — and the toast names
// how many were left where they were.

import { useEffect, useRef } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId } from '../core/dag/types';
import { moveToCollectionOps, sceneCollectionsOf, type MoveTarget } from './collections';
import { nodeDisplayName } from './sceneTreeWalk';
import { useMoveToCollectionMenuStore } from './stores/moveToCollectionMenuStore';
import { useNotificationStore } from './stores/notificationStore';
import { useSelectionStore } from './stores/selectionStore';

/** Move the selection to `target`, and report it. Exported for the menu and its tests. */
export function moveSelectionToCollection(target: MoveTarget): void {
  const dag = useDagStore.getState();
  const ids = [...useSelectionStore.getState().selectedNodeIds] as NodeId[];
  const notify = useNotificationStore.getState().notify;
  const result = moveToCollectionOps(dag.state, ids, target);
  if (!result) return;
  if (result.moved.length > 0 && result.ops.length > 0) {
    dag.dispatchAtomic(result.ops, 'user', 'move to collection');
  }
  const after = useDagStore.getState().state;
  const where =
    result.collectionId === null
      ? 'Scene Collection'
      : nodeDisplayName(after.nodes, result.collectionId);
  if (result.moved.length > 0) {
    const what =
      result.moved.length === 1
        ? nodeDisplayName(after.nodes, result.moved[0])
        : `${result.moved.length} objects`;
    notify({ severity: 'success', message: `${what} moved to ${where}` });
  }
  if (result.skipped.length > 0) {
    notify({
      severity: 'warn',
      message: `${result.skipped.length} selected item${result.skipped.length === 1 ? '' : 's'} stayed where ${result.skipped.length === 1 ? 'it was' : 'they were'}: only objects in the scene join a collection, and lights and cameras can’t yet`,
    });
  }
}

export function MoveToCollectionMenu() {
  const open = useMoveToCollectionMenuStore((s) => s.open);
  const x = useMoveToCollectionMenuStore((s) => s.x);
  const y = useMoveToCollectionMenuStore((s) => s.y);
  const close = useMoveToCollectionMenuStore((s) => s.close);
  const state = useDagStore((s) => s.state);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // Esc is the dismiss ladder's (`KeyboardShortcuts`): closing here as well would let the same
    // key fall through to the ladder's next rung and clear the selection being moved.
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  if (!open) return null;

  const items: { key: string; label: string; target: MoveTarget }[] = [
    { key: 'scene', label: 'Scene Collection', target: { collectionId: null } },
    ...sceneCollectionsOf(state).map((id) => ({
      key: id,
      label: nodeDisplayName(state.nodes, id),
      target: { collectionId: id },
    })),
    { key: 'new', label: '+ New Collection', target: { newCollection: true } as const },
  ];
  const W = 220;
  const H = 32 + items.length * 26;
  const cx = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const cy = Math.max(8, Math.min(y, window.innerHeight - H - 8));
  return (
    <div
      ref={ref}
      data-testid="move-to-collection-menu"
      className="fixed z-[100] overflow-hidden rounded border border-border bg-bg/95 font-mono text-xs text-fg shadow-lg backdrop-blur"
      style={{ left: cx, top: cy, width: W }}
    >
      <header className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-fg/50">
        Move to Collection
      </header>
      <ul role="menu" aria-label="Move to Collection" className="flex flex-col">
        {items.map((item) => (
          <li key={item.key} role="none">
            <button
              type="button"
              role="menuitem"
              data-testid={`move-to-collection-${item.key}`}
              className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted"
              onClick={() => {
                close();
                moveSelectionToCollection(item.target);
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
