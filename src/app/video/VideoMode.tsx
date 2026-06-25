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

import { useEffect, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { CompositionParams } from '../../nodes/Composition';
import type { NodeId } from '../../core/dag/types';
import { useCompositionStore } from '../stores/compositionStore';
import { useEditorStore } from '../stores/editorStore';
import { useTimeStore } from '../stores/timeStore';
import { createNewComposition } from './newComposition';
import { addComfyWorkflowLayer, openAddMediaLayerPicker } from './addLayer';
import { LayerTimeline } from './LayerTimeline';
import { CompositeViewer } from './CompositeViewer';
import { VideoTransport } from './VideoTransport';
import { compDurationSeconds } from './videoTimelineGeometry';
import { exportCompositionWithFeedback } from './exportCompositionAction';
import { useRenderAnimationStore } from '../stores/renderAnimationStore';

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
  const { name } = comp.params;
  const layerCount = useCompositionLayerCount(comp.id);
  const fps = comp.params.fps ?? 30;
  const totalFrames = Math.max(1, comp.params.durationFrames ?? 150);

  // Size the GLOBAL playhead range to this comp WHILE in video mode, so playback
  // loops at the comp boundary (the 3D default is 10s, unrelated). The video slot
  // stays mounted (display:none) across space switches, so this is gated on the
  // active space — not an unmount — and restores the prior duration on exit.
  const space = useEditorStore((s) => s.space);
  useEffect(() => {
    if (space !== 'video') return;
    const prev = useTimeStore.getState().durationSeconds;
    useTimeStore.getState().setDuration(compDurationSeconds(totalFrames, fps));
    return () => {
      useTimeStore.getState().setDuration(prev);
    };
  }, [space, totalFrames, fps]);

  return (
    <>
      {/* Composite viewer (top) — the live ordered composite at the playhead (1d). */}
      <CompositeViewer compId={comp.id} comp={comp.params} />
      {/* Layer timeline (bottom) — a transport bar over the outline + bars +
          twirl-down property rows. The strip header carries the comp name, the
          live layer count, and the Add Layer affordance (the layer Add path). */}
      <div
        data-testid="video-mode-timeline"
        className="flex flex-col border-t border-line bg-bg"
        style={{ height: 300 }}
      >
        <VideoTransport comp={comp.params} />
        <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
          <span className="text-fg" data-testid="video-mode-comp-name">
            {name}
          </span>
          <span className="text-mute" data-testid="video-mode-layer-count">
            {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
          </span>
          <div className="flex-1" />
          <AddLayerMenu compId={comp.id} />
          <ExportMenu />
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
          {/* A ComfyUIWorkflow generator layer (inc 3 spine) — composites a
              deterministic stub frame; real ComfyUI submit + keyframe-any-param
              are the next slices. */}
          <button
            type="button"
            role="menuitem"
            data-testid="video-mode-add-comfy"
            onClick={() => {
              setOpen(false);
              addComfyWorkflowLayer(compId);
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ComfyUI Workflow
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

/** Export the active composition to a video file (spine 1e) — MP4 (WebCodecs, →
 *  PNG-sequence fallback) or a PNG sequence (.zip). Disabled while a render runs
 *  (the global progress modal + cancel handle the in-flight UX). */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const rendering = useRenderAnimationStore((s) => s.active);
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="video-mode-export"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={rendering}
        onClick={() => setOpen((v) => !v)}
        className="rounded bg-bg-2 px-2 py-0.5 text-[11px] text-fg hover:bg-line focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-fg/40"
      >
        Export ▾
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Export video"
          data-testid="video-mode-export-menu"
          className="absolute bottom-full right-0 z-10 mb-1 w-44 overflow-hidden rounded border border-border bg-bg shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="video-mode-export-mp4"
            onClick={() => {
              setOpen(false);
              void exportCompositionWithFeedback('mp4');
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            MP4 (H.264)
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="video-mode-export-png"
            onClick={() => {
              setOpen(false);
              void exportCompositionWithFeedback('png-sequence');
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            PNG Sequence (.zip)
          </button>
        </div>
      ) : null}
    </div>
  );
}
