// LivePreview — the small picture of what the live camera sees at the playhead, over the free view
// (#1708): "Shot N · camera · time" under it, collapsible to just that caption.
//
// This is the DOM frame: the box, the caption and the collapse toggle. The picture itself is drawn
// by `LivePreviewPass` inside the one viewport Canvas, into the box this frame publishes
// (`livePreviewStore.rect`); the box is transparent, so the canvas shows through it.
//
// Hidden while looking through (the viewport already is that picture) and in present mode, and
// when the film has no camera. V8: writes only its own projection store.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { useIsNarrowLayout } from './hooks/useIsNarrowLayout';
import { centerBandInsets, ISLAND_GAP, PLAYBACK_BAND } from './layoutIslands';
import { nodeDisplayName } from './sceneTreeWalk';
import { sceneEndSeconds } from './sceneRange';
import { liveShotIn, shotCameraColors } from './shotColors';
import { shotsOf } from './shots';
import { useChromeStore } from './stores/chromeStore';
import { useLivePreviewStore } from './stores/livePreviewStore';
import { useTimeStore } from './stores/timeStore';
import { useViewportStore } from './stores/viewportStore';

/** The caption for the shot on screen at `filmSeconds` and its colour, packed in one string so a
 *  selector can compare it; null when the film has no camera. One read of the shots. */
function captionAt(state: DagState, filmSeconds: number): string | null {
  const shots = shotsOf(state, sceneEndSeconds(state)).shots;
  const shot = liveShotIn(shots, filmSeconds);
  if (!shot?.cameraId) return null;
  const name = nodeDisplayName(state.nodes, shot.cameraId);
  const color = shotCameraColors(shots).get(shot.cameraId) ?? '';
  return [shot.index + 1, name, filmSeconds.toFixed(2), color].join('\u0000');
}

export function LivePreview(): ReactNode {
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);
  const present = useChromeStore((s) => s.presentMode);
  const collapsed = useLivePreviewStore((s) => s.collapsed);
  const toggle = useLivePreviewStore((s) => s.toggleCollapsed);
  const isNarrow = useIsNarrowLayout();
  const leftCollapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const inspectorCollapsed = useChromeStore((s) => s.inspectorCollapsed);
  const drawerOpen = useViewportStore((s) => s.timelineDrawerOpen);
  // One string per visible change (a cut, a rename, the time to the hundredth), so the caption
  // re-renders when what it says changes and not on every store write.
  useTimeStore((t) => captionAt(useDagStore.getState().state, t.filmSeconds));
  useDagStore((d) => captionAt(d.state, useTimeStore.getState().filmSeconds));
  const caption = captionAt(useDagStore.getState().state, useTimeStore.getState().filmSeconds);
  const shown = !lookThrough && !present && caption !== null;

  // The bottom-right of the clear band: beside the inspector island (whatever its width now), above
  // the floating playback bar, or down to the island gap when the drawer holds the playback.
  const { right } = centerBandInsets({ isNarrow, leftCollapsed, inspectorCollapsed, band: 'top' });
  const bottom = drawerOpen ? ISLAND_GAP : PLAYBACK_BAND;

  const imageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const setRect = useLivePreviewStore.getState().setRect;
    const image = imageRef.current;
    const viewport = image?.closest<HTMLElement>('[data-testid="viewport"]');
    if (!shown || collapsed || !image || !viewport) {
      setRect(null);
      return;
    }
    const publish = () => {
      const a = image.getBoundingClientRect();
      const b = viewport.getBoundingClientRect();
      setRect({ x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height });
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(image);
    ro.observe(viewport);
    window.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
      setRect(null);
    };
    // The box moves without resizing when an island folds or the drawer opens: re-publish then too.
  }, [shown, collapsed, right, bottom]);

  if (!shown) return null;
  const [index, name, time, color] = caption.split('\u0000');
  return (
    <div
      data-testid="live-preview"
      data-collapsed={collapsed || undefined}
      style={{ right, bottom }}
      className="absolute z-20 w-[288px] overflow-hidden rounded-md border border-border shadow-lg"
    >
      {collapsed ? null : (
        <div
          ref={imageRef}
          data-testid="live-preview-image"
          aria-hidden
          // Transparent: the canvas draws the picture through it. The outline is the shot colour.
          className="pointer-events-none h-[162px] w-full"
          style={{ boxShadow: `inset 0 0 0 1px ${color || 'transparent'}` }}
        />
      )}
      <div className="flex items-center gap-2 bg-bg-2/95 px-2 py-1 text-[12px] text-fg backdrop-blur-sm">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color || 'transparent' }}
        />
        <span data-testid="live-preview-caption" className="min-w-0 grow truncate">
          {`Shot ${index} · ${name} · ${time}`}
        </span>
        <button
          type="button"
          data-testid="live-preview-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show the live preview' : 'Collapse the live preview'}
          title={collapsed ? 'Show the live preview' : 'Collapse the live preview to its caption'}
          className="shrink-0 rounded px-1 text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
    </div>
  );
}
