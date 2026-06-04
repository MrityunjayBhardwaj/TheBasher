// renderImageAction — the "Render Image" user action (#168). Glue between the
// stores and the pure offscreen renderer: read the live renderer + scene
// (threeRef), the production camera pose + RenderOutput config (DAG), produce
// a PNG, and download it. Fires from the TopToolbar button, File menu, and is
// covered by the falsifiable real-canvas e2e.
//
// Why read the LIVE scene (not a re-evaluation): the three.js objects already
// reflect the current animation frame (the render loop applies it). So the
// render captures exactly what is on screen at the current playhead — we only
// evaluate RenderOutput to read postFx + width + height, and read the active
// camera node's pose for the production framing (Blender F12 — independent of
// where the editor view orbited).
//
// REF: issue #168; THESIS.md §11; activeCamera.ts (#165); renderToImage.ts.

import { cameraPoseFromNode, DEFAULT_CAMERA_POSE, selectActiveCameraNode } from './activeCamera';
import { useDagStore } from '../core/dag/store';
import { createEvaluatorCache, evaluate } from '../core/dag/evaluator';
import { useProjectStore } from '../core/project/store';
import type { RenderOutputValue } from '../nodes/types';
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from '../nodes/RenderOutput';
import { renderSceneToPngBlob } from '../render/renderToImage';
import { useThreeRef } from './character/threeRef';

/** Frozen evaluation time — we only read RenderOutput's static config here;
 *  animation is already baked into the live three.js objects we render. */
const FROZEN_TIME = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface RenderImageResult {
  ok: boolean;
  reason?: string;
  width?: number;
  height?: number;
}

/** Core — render the active project's production frame to a PNG Blob. Returns
 *  null when the viewport isn't ready. Shared by the download action and the
 *  DEV inspection seam so they render through one identical path. */
export async function renderActiveProjectBlob(): Promise<{
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

  const pose = cameraPoseFromNode(selectActiveCameraNode(state)) ?? DEFAULT_CAMERA_POSE;
  const blob = await renderSceneToPngBlob({ gl, scene, pose, width, height, postFx });
  return { blob, width, height };
}

/**
 * Render the active project's production frame to a PNG and download it.
 * Returns a result so any future UI feedback can assert outcome.
 */
export async function renderActiveProjectToPng(): Promise<RenderImageResult> {
  const out = await renderActiveProjectBlob();
  if (!out) return { ok: false, reason: 'viewport-not-ready' };

  const name = useProjectStore.getState().current?.name ?? 'untitled';
  const slug = name.replace(/\s+/g, '-').toLowerCase() || 'render';
  downloadBlob(out.blob, `${slug}-${out.width}x${out.height}.png`);
  return { ok: true, width: out.width, height: out.height };
}

/**
 * DEV-only — render and return the PNG as a data URL (no download), so the
 * falsifiable e2e can decode pixels and assert non-blank / correct size /
 * no-chrome. H65-safe: only installed under import.meta.env.DEV in boot.ts.
 */
export async function renderActiveProjectToDataUrl(): Promise<{
  width: number;
  height: number;
  dataUrl: string;
} | null> {
  const out = await renderActiveProjectBlob();
  if (!out) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(out.blob);
  });
  return { width: out.width, height: out.height, dataUrl };
}
