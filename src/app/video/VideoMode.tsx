// VideoMode — the Video editor space (the third top-level content space, beside
// 3D and 2D). Hosts the After Effects-style compositor: a composite viewer (top)
// over the layer timeline (bottom). This is the AE layout shell; the live
// composite viewer (1d) and the layer-timeline chrome (1c.3) fill it in.
//
// Comp lifecycle (1c): the surface resolves the ACTIVE Composition (the explicit
// selection from compositionStore, falling back to the first Composition node in
// the DAG). With none, an empty-state CTA invites `File ▸ New Composition`
// (nothing is auto-created — the user's chosen lifecycle).
//
// REF: docs/COMPOSITOR-DESIGN.md §2 (chrome) / §6 (viewer); vyapti V8 + V34 +
//      V80 (the 2D-View viewer this will reuse); issue #237.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { CompositionParams } from '../../nodes/Composition';
import type { NodeId } from '../../core/dag/types';
import { useCompositionStore } from '../stores/compositionStore';
import { createNewComposition } from './newComposition';
import { openAddMediaLayerPicker } from './addLayer';
import { LayerTimeline } from './LayerTimeline';

interface ActiveComposition {
  id: NodeId;
  params: CompositionParams;
}

/** Resolve the active Composition: the explicitly-selected one, else the first
 *  Composition node in the DAG. A stale active id (deleted node) degrades to the
 *  fallback rather than dangling. */
function useActiveComposition(): ActiveComposition | null {
  const nodes = useDagStore((s) => s.state.nodes);
  const activeId = useCompositionStore((s) => s.activeCompositionId);

  const active = activeId ? nodes[activeId] : undefined;
  if (active && active.type === 'Composition') {
    return { id: activeId as NodeId, params: active.params as CompositionParams };
  }
  for (const node of Object.values(nodes)) {
    if (node.type === 'Composition') {
      return { id: node.id as NodeId, params: node.params as CompositionParams };
    }
  }
  return null;
}

export function VideoMode() {
  const comp = useActiveComposition();

  return (
    <div data-testid="video-mode" className="flex h-full w-full flex-col bg-bg text-fg">
      {comp ? <CompositionShell comp={comp} /> : <EmptyState />}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="video-mode-empty"
      className="flex flex-1 flex-col items-center justify-center gap-4 text-center"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm text-fg">No composition yet</p>
        <p className="text-xs text-mute">
          Create a composition to start editing video. (File ▸ New Composition)
        </p>
      </div>
      <button
        type="button"
        data-testid="video-mode-new-comp"
        onClick={() => createNewComposition()}
        className="rounded bg-bg-2 px-3 py-1.5 text-xs text-fg hover:bg-line focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        New Composition
      </button>
    </div>
  );
}

/** The number of layers wired into a Composition's `layers` list socket. */
function useCompositionLayerCount(compId: NodeId): number {
  return useDagStore((s) => {
    const binding = s.state.nodes[compId]?.inputs?.layers;
    if (Array.isArray(binding)) return binding.length;
    return binding ? 1 : 0;
  });
}

function CompositionShell({ comp }: { comp: ActiveComposition }) {
  const { name, width, height, fps, durationFrames } = comp.params;
  const layerCount = useCompositionLayerCount(comp.id);
  return (
    <>
      {/* Composite viewer (top) — placeholder until 1d wires the live composite. */}
      <div
        data-testid="video-mode-viewer"
        className="flex flex-1 items-center justify-center bg-bg-2"
        style={{ minHeight: 0 }}
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-xs text-mute">Composite viewer</p>
          <p className="text-[11px] text-mute">
            {width}×{height} · {fps}fps · {durationFrames}f
          </p>
        </div>
      </div>
      {/* Layer timeline (bottom) — the outline + bars + twirl-down property rows
          land in 1c.3. For now the strip carries the comp name, the live layer
          count, and the Add Layer affordance (the layer Add path, 1c.2). */}
      <div
        data-testid="video-mode-timeline"
        className="flex flex-col border-t border-line bg-bg"
        style={{ height: 260 }}
      >
        <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
          <span className="text-fg" data-testid="video-mode-comp-name">
            {name}
          </span>
          <span className="text-mute" data-testid="video-mode-layer-count">
            {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
          </span>
          <div className="flex-1" />
          <AddLayerMenu compId={comp.id} />
        </div>
        <LayerTimeline compId={comp.id} comp={comp.params} />
      </div>
    </>
  );
}

function AddLayerMenu({ compId }: { compId: NodeId }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="video-mode-add-layer"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded bg-bg-2 px-2 py-0.5 text-[11px] text-fg hover:bg-line focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        + Add Layer ▾
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Add layer"
          data-testid="video-mode-add-layer-menu"
          className="absolute bottom-full right-0 z-10 mb-1 w-44 overflow-hidden rounded border border-border bg-bg shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="video-mode-add-media"
            onClick={() => {
              setOpen(false);
              openAddMediaLayerPicker(compId);
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Media File…
          </button>
          {/* The 3D-scene-render source needs a rendered animation persisted to
              OPFS first (the V82/1a open finding) — surfaced as "coming soon"
              rather than hidden so the affordance is discoverable. */}
          <button
            type="button"
            role="menuitem"
            disabled
            data-testid="video-mode-add-scene-render"
            title="Render an animation from the 3D scene first (render → OPFS persistence is coming)"
            className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/40"
          >
            3D Scene Render (soon)
          </button>
        </div>
      ) : null}
    </div>
  );
}
