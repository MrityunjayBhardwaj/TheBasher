// renderImageAction — the "Render Image" user action (#168). Glue between the
// stores and the pure offscreen renderer: read the live renderer + scene
// (threeRef), the production camera pose + RenderOutput config (DAG), produce
// a PNG, and download it. Fires from the TopToolbar button, File menu, and is
// covered by the falsifiable real-canvas e2e.
//
// Why read the LIVE scene (not a re-evaluation): the three.js objects already
// reflect the current animation frame (the render loop applies it). So the
// render captures exactly what is on screen at the current playhead — we only
// evaluate RenderOutput to read postFx + width + height, and resolve the active
// camera's EVALUATED pose at the current playhead for the production framing
// (Blender F12 — independent of where the editor view orbited).
//
// #190 — the pose comes from resolveActiveCameraPoseAt(state, seconds), NOT the
// static cameraPoseFromNode, so a keyframed camera frames the shot at time T.
// This is the SAME resolver the viewport look-through (slice 4) samples, so the
// still at time T matches the viewport at time T (viewport==render, V37/V51).
//
// REF: issue #168 / #190; THESIS.md §11; activeCamera.ts (#165); renderToImage.ts.

import { resolveActiveCameraPoseAt, selectActiveCameraNode } from './activeCamera';
import { resolveCameraDof } from './cameraDof';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from './stores/timeStore';
import { useEditorStore } from './stores/editorStore';
import { useTwoDViewStore } from './stores/twoDViewStore';
import { useRenderResultStore } from './stores/renderResultStore';
import { createEvaluatorCache, evaluate } from '../core/dag/evaluator';
import { useProjectStore } from '../core/project/store';
import type { RenderOutputValue } from '../nodes/types';
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from '../nodes/RenderOutput';
import { type RenderPassKind, renderSceneToPngBlob } from '../render/renderToImage';
import { useThreeRef } from './character/threeRef';
import { downloadBlob } from './downloadBlob';
import { type NotifyInput, useNotificationStore } from './stores/notificationStore';

/** Frozen evaluation time — we only read RenderOutput's static config here;
 *  animation is already baked into the live three.js objects we render. */
const FROZEN_TIME = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

export interface RenderImageResult {
  ok: boolean;
  reason?: string;
  width?: number;
  height?: number;
}

/** Core — render the active project's production frame to a PNG Blob. Returns
 *  null when the viewport isn't ready. Shared by the download action and the
 *  DEV inspection seam so they render through one identical path. */
export async function renderActiveProjectBlob(pass: RenderPassKind = 'beauty'): Promise<{
  blob: Blob;
  width: number;
  height: number;
} | null> {
  const { gl, scene } = useThreeRef.getState();
  if (!gl || !scene) {
    console.error('[render] viewport not ready — cannot render image');
    return null;
  }

  const state = useDagStore.getState().state;
  const target = state.outputs.render;

  // Resolve the render config (postFx + resolution). Defensive defaults so a
  // malformed / pre-#168 project never renders at NaN×NaN (V10/H14).
  let width = DEFAULT_RENDER_WIDTH;
  let height = DEFAULT_RENDER_HEIGHT;
  let postFx: RenderOutputValue['postFx'] = { tonemap: 'ACES', smaa: true };
  if (target) {
    const value = evaluate(state, target.node, {
      cache: createEvaluatorCache(),
      ctx: FROZEN_TIME,
    }).value as RenderOutputValue;
    width = value.width || DEFAULT_RENDER_WIDTH;
    height = value.height || DEFAULT_RENDER_HEIGHT;
    postFx = value.postFx ?? postFx;
  }

  const activeCamera = selectActiveCameraNode(state);
  // #190 — the EVALUATED pose at the current playhead, so a keyframed camera
  // frames the shot at time T (matches the viewport look-through at the same
  // time). An unanimated camera resolves to the static authored pose.
  const seconds = useTimeStore.getState().seconds;
  const pose = resolveActiveCameraPoseAt(state, seconds);
  // UX #12 — depth of field, resolved through the SAME pure helper the live
  // viewport uses (cameraDof.ts) so the still's bokeh matches the screen. null
  // when off → the fast manual render path. (Aperture reads static here; framing
  // is the #190 scope.) #247 — focus-on-target uses the evaluated pose distance
  // (|position − lookAt| at this frame) so the still's focus matches the viewport.
  const targetFocusDistance = Math.hypot(
    pose.lookAt[0] - pose.position[0],
    pose.lookAt[1] - pose.position[1],
    pose.lookAt[2] - pose.position[2],
  );
  const dof = resolveCameraDof(activeCamera, targetFocusDistance);
  // Control passes (depth/normal) ignore DoF — they encode geometry, not a
  // photographic frame; the override path renders raw values without the bokeh.
  const blob = await renderSceneToPngBlob({
    gl,
    scene,
    pose,
    width,
    height,
    postFx,
    dof: pass === 'beauty' ? dof : null,
    pass,
  });
  return { blob, width, height };
}

/**
 * Render the active project's production frame INTO the Render Result view
 * (Blender F12: render → Image Editor, NOT an immediate download). Switches to
 * the 2D View + Render Result tab so the result is where the user looks, then
 * renders through the shared `renderActiveProjectToDataUrl` path and parks the
 * image in `renderResultStore`. Saving is a separate explicit action
 * (`downloadRenderResult`). Returns a result so callers can toast the outcome.
 */
export async function renderActiveProjectToView(
  pass: RenderPassKind = 'beauty',
): Promise<RenderImageResult> {
  // Guard against a double-fire while a render is already in flight.
  if (useRenderResultStore.getState().status === 'rendering') {
    return { ok: false, reason: 'already-rendering' };
  }
  // Reveal the result where it lands BEFORE the blocking render, so the pane
  // shows "Rendering…" immediately.
  useEditorStore.getState().setSpace('uv');
  useTwoDViewStore.getState().setMode('render');
  useRenderResultStore.getState().setRendering(pass);

  const out = await renderActiveProjectToDataUrl(pass);
  if (!out) {
    useRenderResultStore.getState().setError('Viewport isn’t ready yet — try again in a moment.');
    return { ok: false, reason: 'viewport-not-ready' };
  }
  useRenderResultStore.getState().setResult({
    dataUrl: out.dataUrl,
    width: out.width,
    height: out.height,
    source: 'render',
    pass,
  });
  return { ok: true, width: out.width, height: out.height };
}

/**
 * Download the render currently SHOWN in the Render Result view (the explicit
 * "Save" action — what you see is what you save, no re-render). Returns a
 * result so the caller can toast the outcome.
 */
export async function downloadRenderResult(): Promise<RenderImageResult> {
  const { dataUrl, width, height, status } = useRenderResultStore.getState();
  if (!dataUrl || status !== 'ready') return { ok: false, reason: 'no-result' };
  const blob = await (await fetch(dataUrl)).blob();
  const name = useProjectStore.getState().current?.name ?? 'untitled';
  const slug = name.replace(/\s+/g, '-').toLowerCase() || 'render';
  downloadBlob(blob, `${slug}-${width}x${height}.png`);
  return { ok: true, width, height };
}

/**
 * Map a render outcome to a toast (#170). Pure so the success/failure copy is
 * unit-testable without a live renderer. Before this, the callers `void`-ed
 * the result, so a failed render (viewport not ready) was a silent no-op.
 */
export function renderResultToToast(result: RenderImageResult): NotifyInput {
  if (result.ok) {
    return {
      severity: 'success',
      message: `Rendered ${result.width}×${result.height} — shown in the 2D view.`,
    };
  }
  return {
    severity: 'error',
    message: 'Render failed — the viewport isn’t ready yet. Try again in a moment.',
    durationMs: 8000,
  };
}

/**
 * The user-facing render action wired to feedback (#170): render INTO the view,
 * then surface the outcome as a toast. The toolbar button and File-menu item
 * call THIS, not the bare action, so a failure is never silent. A no-op
 * (already rendering) skips the toast.
 */
export async function renderToViewWithFeedback(): Promise<RenderImageResult> {
  const result = await renderActiveProjectToView();
  if (result.reason === 'already-rendering') return result;
  useNotificationStore.getState().notify(renderResultToToast(result));
  return result;
}

/**
 * Render the active project's production frame and return it as a PNG data URL
 * (no download). Two consumers:
 *   - the 2D View's Render Result pane (#168 follow-up) — draws it in-app and,
 *     later, hands it to the fal AI edit (sync_mode returns the same data-URL
 *     shape, so the render and the AI output round-trip through one path);
 *   - the falsifiable e2e seam — decode pixels to assert non-blank / correct
 *     size / no-chrome. That window install is H65-safe (only under
 *     import.meta.env.DEV in boot.ts); the function itself leaks nothing.
 */
export async function renderActiveProjectToDataUrl(pass: RenderPassKind = 'beauty'): Promise<{
  width: number;
  height: number;
  dataUrl: string;
} | null> {
  const out = await renderActiveProjectBlob(pass);
  if (!out) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(out.blob);
  });
  return { width: out.width, height: out.height, dataUrl };
}
