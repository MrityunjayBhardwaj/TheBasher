// renderAnimationAction — the "Render Animation" user action (#189): export the
// whole timeline to a downloadable MP4 or PNG sequence. Glue between the stores
// (timeStore playhead/duration, threeRef live renderer, DAG RenderOutput config)
// and the format-agnostic loop + sinks in render/renderAnimation.ts.
//
// Each frame is the SAME offscreen production render the still uses
// (renderSceneToImageCanvas), captured after advancing the playhead — so an
// animation frame is just a still at a given time. Playback is paused for the
// duration so the rAF Clock doesn't fight our setTime, and the playhead is
// always restored (finally). The viewport is never mutated by the render.
//
// REF: issue #189; #168 (renderImageAction sibling); renderAnimation.ts (loop +
// sinks); timeStore (FPS + duration); vyapti V37/V51 (parity), V38 (surface
// every outcome).

import { cameraPoseFromNode, DEFAULT_CAMERA_POSE, selectActiveCameraNode } from './activeCamera';
import { resolveCameraDof } from './cameraDof';
import { useDagStore } from '../core/dag/store';
import { createEvaluatorCache, evaluate } from '../core/dag/evaluator';
import { useProjectStore } from '../core/project/store';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';
import type { RenderOutputValue } from '../nodes/types';
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from '../nodes/RenderOutput';
import { renderSceneToImageCanvas } from '../render/renderToImage';
import {
  createMp4Sink,
  createPngSequenceSink,
  renderAnimation,
  RenderAnimationAborted,
  type FrameSink,
  type RenderAnimationFormat,
} from '../render/renderAnimation';
import { useThreeRef } from './character/threeRef';
import { downloadBlob } from './downloadBlob';
import { type NotifyInput, useNotificationStore } from './stores/notificationStore';
import { useRenderAnimationStore } from './stores/renderAnimationStore';

/** Frozen evaluation time — only the STATIC RenderOutput config is read here
 *  (resolution + postFx); the animation is in the live scene we render. */
const FROZEN_TIME = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

export interface RenderAnimationResult {
  ok: boolean;
  reason?: string;
  cancelled?: boolean;
  format?: RenderAnimationFormat;
  frameCount?: number;
}

/** Resolve after the live scene has applied a just-set playhead time. The R3F
 *  render loop (frameloop="always") mutates the scene objects on its own rAF;
 *  awaiting two frames guarantees at least one of its ticks ran in between. */
function waitForApply(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Render the active project's timeline to a file and download it. `format`
 * 'mp4' falls back to a PNG sequence when WebCodecs H.264 is unavailable (a
 * surfaced warning, never silent — V38). Always restores the playhead + play
 * state; returns a result the feedback wrapper maps to a toast.
 */
export async function renderAnimationToFile(
  format: RenderAnimationFormat,
): Promise<RenderAnimationResult> {
  const { gl, scene } = useThreeRef.getState();
  if (!gl || !scene) return { ok: false, reason: 'viewport-not-ready' };

  // Static render config (resolution + postFx), read once (V10/H14 defaults).
  const state = useDagStore.getState().state;
  let width = DEFAULT_RENDER_WIDTH;
  let height = DEFAULT_RENDER_HEIGHT;
  let postFx: RenderOutputValue['postFx'] = { tonemap: 'ACES', smaa: true };
  const target = state.outputs.render;
  if (target) {
    const value = evaluate(state, target.node, {
      cache: createEvaluatorCache(),
      ctx: FROZEN_TIME,
    }).value as RenderOutputValue;
    width = value.width || DEFAULT_RENDER_WIDTH;
    height = value.height || DEFAULT_RENDER_HEIGHT;
    postFx = value.postFx ?? postFx;
  }

  // Production camera pose + DoF, read once. NOTE (known limitation): an
  // ANIMATED camera is not yet followed per-frame — the pose is the node's
  // authored value, matching the still render (#168). Tracked for a follow-up.
  const activeCamera = selectActiveCameraNode(state);
  const pose = cameraPoseFromNode(activeCamera) ?? DEFAULT_CAMERA_POSE;
  const dof = resolveCameraDof(activeCamera);

  const fps = FRAMES_PER_SECOND;
  const time = useTimeStore.getState();
  // Inclusive of frame 0 AND the final duration frame.
  const frameCount = Math.max(1, Math.floor(time.durationSeconds * fps) + 1);

  // Pick the sink; MP4 → PNG-sequence fallback when WebCodecs is unavailable.
  let sink: FrameSink;
  if (format === 'mp4') {
    const mp4 = await createMp4Sink(width, height, fps);
    if (mp4) {
      sink = mp4;
    } else {
      sink = createPngSequenceSink();
      useNotificationStore.getState().notify({
        severity: 'warning',
        message: 'MP4 isn’t supported in this browser — rendering a PNG sequence (.zip) instead.',
        durationMs: 8000,
      });
    }
  } else {
    sink = createPngSequenceSink();
  }

  const ctrl = new AbortController();
  useRenderAnimationStore.getState().begin(sink.format, frameCount, () => ctrl.abort());

  const restoreSeconds = time.seconds;
  const wasPlaying = time.playing;
  useTimeStore.getState().pause();

  try {
    const output = await renderAnimation(
      {
        frameCount,
        fps,
        setTime: (s) => useTimeStore.getState().setTime(s),
        waitForApply,
        capture: () => renderSceneToImageCanvas({ gl, scene, pose, width, height, postFx, dof }),
      },
      sink,
      {
        signal: ctrl.signal,
        onProgress: (done, total) => useRenderAnimationStore.getState().setProgress(done, total),
      },
    );

    const name = useProjectStore.getState().current?.name ?? 'untitled';
    const slug = name.replace(/\s+/g, '-').toLowerCase() || 'render';
    downloadBlob(output.blob, `${slug}-${width}x${height}.${output.ext}`);
    return { ok: true, format: output.format, frameCount: output.frameCount };
  } catch (e) {
    if (e instanceof RenderAnimationAborted) return { ok: false, cancelled: true };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    useTimeStore.getState().setTime(restoreSeconds);
    if (wasPlaying) useTimeStore.getState().play();
    useRenderAnimationStore.getState().end();
  }
}

/** Map a render outcome to a toast (V38 — every outcome surfaced). Pure. */
export function renderAnimationResultToToast(result: RenderAnimationResult): NotifyInput {
  if (result.ok) {
    const label = result.format === 'mp4' ? 'MP4' : 'PNG sequence';
    return {
      severity: 'success',
      message: `Rendered ${result.frameCount} frames → ${label} downloaded.`,
    };
  }
  if (result.cancelled) {
    return { severity: 'info', message: 'Animation render cancelled.' };
  }
  if (result.reason === 'viewport-not-ready') {
    return {
      severity: 'error',
      message: 'Render failed — the viewport isn’t ready yet. Try again in a moment.',
      durationMs: 8000,
    };
  }
  return {
    severity: 'error',
    message: `Animation render failed: ${result.reason ?? 'unknown error'}.`,
    durationMs: 8000,
  };
}

/** The user-facing action wired to feedback: render + download, then toast the
 *  outcome. The File-menu items call THIS, so a failure is never silent. */
export async function renderAnimationWithFeedback(
  format: RenderAnimationFormat,
): Promise<RenderAnimationResult> {
  const result = await renderAnimationToFile(format);
  useNotificationStore.getState().notify(renderAnimationResultToToast(result));
  return result;
}
