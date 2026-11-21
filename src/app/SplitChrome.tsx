// SplitChrome — #1709, the controls of the one fixed split (2D | 3D), board 11a/11b.
//
//   - SplitDivider        → the 6 px ew-resize bar between the sides; dragging sets the 2D share.
//   - Split3DHeader       → over the 3D side: "3D · free camera", Frame <selection>, ⇄ swap,
//                           ⇥ collapse (glyphs mirror when the 3D side is on the left).
//   - SplitCollapsedStrip → the 3D side folded: a 34 px strip with ⇤ expand and vertical text.
//
// Layout places them (splitPaneBoxes); these only render and write the split store. No scene data
// is touched — Frame moves the editor's free camera through the same frameSelected the F key uses.
//
// REF: src/app/stores/splitViewStore.ts; src/app/layoutIslands.ts (splitPaneBoxes, twoDShareAt);
//      src/app/character/framing.ts (frameSelected).

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import { useDagStore } from '../core/dag/store';
import { frameSelected } from './character/framing';
import { twoDShareAt } from './layoutIslands';
import { nodeDisplayName } from './sceneTreeWalk';
import { useSelectionStore } from './stores/selectionStore';
import { useSplitViewStore } from './stores/splitViewStore';

export function SplitDivider({
  style,
  insets,
}: {
  style: CSSProperties;
  insets: { left: number; right: number };
}) {
  const swapped = useSplitViewStore((s) => s.swapped);
  const setTwoDShare = useSplitViewStore((s) => s.setTwoDShare);
  const dragging = useRef(false);

  const shareAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const main = e.currentTarget.offsetParent as HTMLElement | null;
    if (!main) return null;
    const r = main.getBoundingClientRect();
    return twoDShareAt({
      pointerX: e.clientX,
      bandLeft: r.left + insets.left,
      bandWidth: r.width - insets.left - insets.right,
      swapped,
    });
  };

  return (
    <div
      data-testid="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize the split"
      style={{ ...style, cursor: 'ew-resize', touchAction: 'none' }}
      className="flex items-center justify-center"
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const share = shareAt(e);
        if (share !== null) setTwoDShare(share);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <span aria-hidden className="h-7 w-0.5 rounded-sm bg-fg/30" />
    </div>
  );
}

/** The name Frame shows: the primary selection's display name, or nothing selected. */
function useFrameLabel(): string | null {
  const primary = useSelectionStore((s) => s.primaryNodeId);
  const nodes = useDagStore((s) => s.state.nodes);
  return primary ? nodeDisplayName(nodes, primary) : null;
}

const chipButton =
  'flex h-[26px] items-center justify-center rounded-md px-2 text-fg/80 hover:bg-fg/10 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

export function Split3DHeader() {
  const swapped = useSplitViewStore((s) => s.swapped);
  const toggleSwapped = useSplitViewStore((s) => s.toggleSwapped);
  const setCollapsed = useSplitViewStore((s) => s.setCollapsed);
  const label = useFrameLabel();
  return (
    <div
      data-testid="split-3d-header"
      className="absolute left-2.5 top-3 z-10 flex h-[34px] max-w-[calc(100%-20px)] items-center gap-1 overflow-hidden whitespace-nowrap rounded-xl border border-border bg-bg-2/95 pl-2.5 pr-1 text-xs shadow-xl shadow-black/40 backdrop-blur-md"
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <b className="shrink-0 text-fg">3D</b>
      <span className="min-w-0 truncate text-fg/60">· free camera</span>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <button
        type="button"
        data-testid="split-frame"
        className={`${chipButton} min-w-0 max-w-[180px]`}
        disabled={label === null}
        title={label === null ? 'Select something to frame it' : `Frame ${label} (F)`}
        onClick={() => {
          frameSelected();
        }}
      >
        <span className="truncate">{label === null ? 'Frame' : `Frame ${label}`}</span>
      </button>
      <button
        type="button"
        data-testid="split-swap"
        aria-label="Swap sides"
        title="Swap sides"
        className={`${chipButton} w-[26px] shrink-0 px-0`}
        onClick={toggleSwapped}
      >
        ⇄
      </button>
      <button
        type="button"
        data-testid="split-collapse"
        aria-label="Collapse the 3D view"
        title="Collapse the 3D view"
        className={`${chipButton} w-[26px] shrink-0 px-0`}
        onClick={() => setCollapsed(true)}
      >
        {swapped ? '⇤' : '⇥'}
      </button>
    </div>
  );
}

export function SplitCollapsedStrip({ style }: { style: CSSProperties }) {
  const swapped = useSplitViewStore((s) => s.swapped);
  const setCollapsed = useSplitViewStore((s) => s.setCollapsed);
  return (
    <div
      data-testid="split-collapsed-strip"
      style={style}
      className="flex flex-col items-center gap-2 overflow-hidden rounded-2xl border border-border bg-bg-2/95 pt-2.5 shadow-xl shadow-black/40 backdrop-blur-md"
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        data-testid="split-expand"
        aria-label="Expand the 3D view"
        title="Expand the 3D view"
        className={`${chipButton} h-7 w-7 px-0 text-fg`}
        onClick={() => setCollapsed(false)}
      >
        {swapped ? '⇥' : '⇤'}
      </button>
      <span
        className="text-[11.5px] tracking-wide text-fg/60"
        style={{ writingMode: 'vertical-rl' }}
      >
        3D view · collapsed
      </span>
    </div>
  );
}
