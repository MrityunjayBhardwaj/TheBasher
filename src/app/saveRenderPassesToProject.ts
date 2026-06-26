// saveRenderPassesToProject — persist the 3D scene's control passes (beauty / depth
// / normal) at the current frame as PROJECT IMAGES, so they can be referenced in a
// video-mode ComfyUIWorkflow's image inputs (the Controls panel picker). This is the
// Basher thesis made concrete: the 3D scene is the control rig; its render passes
// drive the generation.
//
// Each pass is rendered through the SAME offscreen path "Render Image" uses
// (renderActiveProjectBlob → production camera, RAW for depth/normal), written to
// OPFS as `renders/render_<frame>_<pass>.png`, and registered as a MediaClip
// mediaKind:'image' node — exactly the asset `listProjectImages` enumerates for the
// image-input picker (comfyImageBinding.ts). Re-saving the same frame overwrites the
// bytes and reuses the node (dedup on src) so the picker stays clean.
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §9 (control passes); src/app/
//      renderImageAction.ts (renderActiveProjectBlob); src/app/video/comfyImageBinding.ts
//      (listProjectImages); vyapti V82 (control passes).

import { renderActiveProjectBlob } from './renderImageAction';
import { pickStorage } from '../core/storage';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from './stores/timeStore';
import { buildMediaClipOps, freshMediaClipId } from './asset/importMediaClip';
import { useNotificationStore } from './stores/notificationStore';
import type { MediaProbe } from '../core/media';
import type { RenderPassKind } from '../render/renderToImage';
import type { NodeId, Op } from '../core/dag/types';

/** The control passes saved per "→ Project" action, in order. */
const PASSES: readonly RenderPassKind[] = ['beauty', 'depth', 'normal'];

export interface SaveRenderPassesResult {
  readonly ok: boolean;
  readonly saved: readonly RenderPassKind[];
  readonly frame: number;
  readonly reason?: string;
}

/** The OPFS path (and user-facing filename) for a saved render pass at a frame:
 *  `renders/render_<frame>_<pass>.png`. The basename doubles as the MediaClip name. */
export function renderPassPath(frame: number, pass: RenderPassKind): string {
  return `renders/render_${frame}_${pass}.png`;
}

/** The MediaClip display name for a saved pass: `render_<frame>_<pass>`. */
export function renderPassName(frame: number, pass: RenderPassKind): string {
  return `render_${frame}_${pass}`;
}

/** Find an existing MediaClip node whose src matches `src`, or null. */
function findMediaClipBySrc(src: string): NodeId | null {
  const nodes = useDagStore.getState().state.nodes;
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (n?.type === 'MediaClip' && (n.params as { src?: unknown }).src === src) return id;
  }
  return null;
}

/**
 * Render beauty/depth/normal at the current frame and add them to the project as
 * image assets. Returns which passes were saved (a pass is skipped only if the
 * viewport isn't ready). Surfaces the outcome through the app-root toast (V38 —
 * never a silent no-op).
 */
export async function saveRenderPassesToProject(): Promise<SaveRenderPassesResult> {
  const frame = useTimeStore.getState().frame;
  const storage = await pickStorage();
  const saved: RenderPassKind[] = [];
  const ops: Op[] = [];
  const usedIds = new Set<string>(Object.keys(useDagStore.getState().state.nodes));

  for (const pass of PASSES) {
    const out = await renderActiveProjectBlob(pass);
    if (!out) continue; // viewport not ready — renderActiveProjectBlob logs the reason
    const path = renderPassPath(frame, pass);
    await storage.write(path, new Uint8Array(await out.blob.arrayBuffer()));
    saved.push(pass);
    // Register as a project image so the video-mode image-input picker lists it.
    // Re-saving the same frame overwrites the bytes above and reuses the node.
    if (findMediaClipBySrc(path)) continue;
    const probe: MediaProbe = {
      mediaKind: 'image',
      width: out.width,
      height: out.height,
      srcFps: 30,
      srcFrames: 1,
      durationSeconds: 0,
    };
    const id = freshMediaClipId(usedIds);
    usedIds.add(id);
    ops.push(...buildMediaClipOps(id, renderPassName(frame, pass), path, probe));
  }

  if (ops.length) {
    useDagStore.getState().dispatchAtomic(ops, 'user', `save render passes @${frame}`);
  }

  if (saved.length === 0) {
    useNotificationStore
      .getState()
      .notify({ severity: 'error', message: 'Couldn’t render passes — is the viewport ready?' });
    return { ok: false, saved: [], frame, reason: 'viewport-not-ready' };
  }
  useNotificationStore.getState().notify({
    severity: 'success',
    message: `Saved ${saved.length} render pass${saved.length > 1 ? 'es' : ''} (frame ${frame}) to project`,
  });
  return { ok: true, saved, frame };
}
