// Drop zone wrapping the viewport-slot. Catches HTML5 drops carrying
// `application/x-basher-asset` (Library payload), translates them into a
// dispatchAtomic Op chain, and shows a faint visual hint while a drag is
// over. The viewport itself remains read-only (V8) — the drop handler
// lives in `src/app/`, not `src/viewport/`.
//
// REF: THESIS.md §11 (V8), §14, P1 Wave B.

import { useState, type DragEvent, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import { DRAG_MIME } from './asset/catalog';
import { buildAssetDropOps } from './asset/dropChain';

interface Props {
  children: ReactNode;
}

export function AssetDropZone({ children }: Props) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const [over, setOver] = useState(false);

  function carriesAsset(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes(DRAG_MIME);
  }

  function onDragOver(e: DragEvent) {
    if (!carriesAsset(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!over) setOver(true);
  }

  function onDragLeave() {
    setOver(false);
  }

  function onDrop(e: DragEvent) {
    if (!carriesAsset(e)) return;
    e.preventDefault();
    setOver(false);
    const path = e.dataTransfer.getData(DRAG_MIME);
    if (!path) return;
    const state = useDagStore.getState().state;
    const sceneRef = state.outputs.scene;
    if (!sceneRef) {
      console.warn('AssetDropZone: project has no `scene` output; drop ignored');
      return;
    }
    const ops = buildAssetDropOps({ assetRef: path, sceneNodeId: sceneRef.node });
    dispatchAtomic(ops, 'user', `import asset: ${path}`);
  }

  return (
    <div
      data-testid="asset-drop-zone"
      data-drop-active={over || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative h-full w-full"
    >
      {children}
      {over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 border-2 border-dashed border-accent bg-accent/5"
        />
      )}
    </div>
  );
}
