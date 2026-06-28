// comfyImageBinding — the generic image-input affordance for a ComfyUIWorkflow's
// 'image'-valueKind params (the Controls panel source section, COMPOSITOR §7.1).
// An image input (e.g. a LoadImage.image) is bound to an image already in the
// project, OR a freshly uploaded one — NOT typed as a server-side filename, and
// NOT a ControlNet-specific path. The binding lives in the node's `imageBindings`
// map (`"<nodeId>.<inputName>" → OPFS path`); the decode reads the bytes, uploads
// them to ComfyUI under a stable name, and rewrites the input at /prompt time
// (compositeDecode.resolveComfyParamsAtFrame).
//
// "Images in this project" = MediaClip nodes with mediaKind:'image' — the same
// asset MediaClip layers carry. Upload reuses the ONE media ingest path
// (ingestMediaClipFile → probe + OPFS write), adding an orphan MediaClip node (no
// layer) so the uploaded image joins the picker list.
//
// REF: docs/COMPOSITOR-DESIGN.md §7.1; src/app/asset/importMediaClip.ts (ingest);
//      src/app/video/compositeDecode.ts (the submit-time upload + rewrite); the
//      app-root toast (NOT assetErrorStore — covered in VIDEO mode, [[H122]]).

import type { DagState } from '../../core/dag/state';
import type { NodeId, Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { buildMediaClipOps, freshMediaClipId, ingestMediaClipFile } from '../asset/importMediaClip';
import { pickMediaFiles } from '../asset/importPicker';
import { useNotificationStore } from '../stores/notificationStore';

export interface ProjectImage {
  readonly nodeId: NodeId;
  readonly name: string;
  /** OPFS path — what the decode reads + uploads, and what the binding stores. */
  readonly src: string;
}

/** The comfy param key for an image input row: `"<nodeId>.<inputName>"`. Matches
 *  the `imageBindings` map key and the decode's resolved-value key. */
export function comfyImageBindingKey(nodeId: string, inputName: string): string {
  return `${nodeId}.${inputName}`;
}

/** Bytes to upload to ComfyUI before a submit: the OPFS `path` to read, and the
 *  stable `name` (no extension) the LoadImage input was rewritten to reference. */
export interface ComfyImageUpload {
  readonly path: string;
  /** The exact filename uploaded to ComfyUI's input dir (WITH extension, e.g.
   *  `basher_img_3_image.png` or `basher_img_12_video.mp4`) — the media input is
   *  rewritten to reference it, and the bytes are uploaded under it. */
  readonly filename: string;
}

/** One resolved image binding: the node/input to rewrite, the stable `${name}.png`
 *  filename it now references on the server, and the bytes to upload under `name`. */
export interface ResolvedImageBinding {
  readonly nodeId: string;
  readonly inputName: string;
  /** The stable filename the LoadImage input is rewritten to (`${name}.png`). */
  readonly filename: string;
  readonly upload: ComfyImageUpload;
}

/** A stable, filesystem-safe ComfyUI upload name for a bound image input. The
 *  compiled workflow's input is rewritten to `${name}.png` and the bytes are
 *  uploaded under the same name — so the LoadImage node resolves on the server. */
export function comfyImageUploadName(nodeId: string, inputName: string): string {
  return `basher_img_${nodeId}_${inputName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** The video container extensions a `basher_controller` kind=video round-trips. The
 *  upload filename must KEEP the real container ext so ComfyUI's LoadVideo/PyAV picks
 *  the right demuxer (an image sniffs content, so `.png` is always fine for it). */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

/** The server-filename extension for a bound OPFS path: the real container ext for a
 *  known video, else `png` (images upload as bytes; ComfyUI sniffs image content). */
export function comfyUploadExt(opfsPath: string): string {
  const dot = opfsPath.lastIndexOf('.');
  const ext = dot >= 0 ? opfsPath.slice(dot + 1).toLowerCase() : '';
  return VIDEO_EXTS.has(ext) ? ext : 'png';
}

/** Resolve a node's `imageBindings` map (`"<nodeId>.<inputName>" → OPFS path`) into
 *  rewrite targets + uploads. Each binding yields the stable filename its LoadImage
 *  input must reference and the bytes to upload under that name. Malformed keys and
 *  empty paths are skipped. Shared by the per-frame PREVIEW decode AND the BATCHED
 *  coherent compile so both rewrite + upload identically — a static bound image is
 *  constant across the batch → ONE upload, the same name on every frame. */
export function resolveComfyImageBindings(imageBindingsParam: unknown): ResolvedImageBinding[] {
  const out: ResolvedImageBinding[] = [];
  const bindings =
    imageBindingsParam && typeof imageBindingsParam === 'object'
      ? (imageBindingsParam as Record<string, unknown>)
      : {};
  for (const key of Object.keys(bindings)) {
    const path = bindings[key];
    if (typeof path !== 'string' || !path) continue;
    const dot = key.indexOf('.');
    if (dot <= 0 || dot >= key.length - 1) continue;
    const nodeId = key.slice(0, dot);
    const inputName = key.slice(dot + 1);
    const filename = `${comfyImageUploadName(nodeId, inputName)}.${comfyUploadExt(path)}`;
    out.push({ nodeId, inputName, filename, upload: { path, filename } });
  }
  return out;
}

/** Every image available in this project: MediaClip nodes with mediaKind:'image'.
 *  Pure read over the DAG — the source of truth for the image-input picker. */
export function listProjectImages(state: DagState): ProjectImage[] {
  const out: ProjectImage[] = [];
  for (const id of Object.keys(state.nodes)) {
    const n = state.nodes[id];
    if (!n || n.type !== 'MediaClip') continue;
    const p = n.params as Record<string, unknown>;
    if ((p.mediaKind ?? 'video') !== 'image') continue;
    const src = typeof p.src === 'string' ? p.src : '';
    if (!src) continue;
    out.push({ nodeId: id, name: typeof p.name === 'string' ? p.name : id, src });
  }
  return out;
}

/** Every video available in this project: MediaClip nodes with mediaKind:'video' (the
 *  source of truth for a kind=video controller's asset picker). Pure read over the DAG. */
export function listProjectVideos(state: DagState): ProjectImage[] {
  const out: ProjectImage[] = [];
  for (const id of Object.keys(state.nodes)) {
    const n = state.nodes[id];
    if (!n || n.type !== 'MediaClip') continue;
    const p = n.params as Record<string, unknown>;
    if ((p.mediaKind ?? 'video') !== 'video') continue;
    const src = typeof p.src === 'string' ? p.src : '';
    if (!src) continue;
    out.push({ nodeId: id, name: typeof p.name === 'string' ? p.name : id, src });
  }
  return out;
}

/** Read a copy of the comfy node's current imageBindings map. */
function currentBindings(comfyNodeId: NodeId): Record<string, string> {
  const node = useDagStore.getState().state.nodes[comfyNodeId];
  const b = (node?.params as { imageBindings?: unknown } | undefined)?.imageBindings;
  return b && typeof b === 'object' ? { ...(b as Record<string, string>) } : {};
}

/** Bind a comfy image param to a project image (by its OPFS path), or clear it
 *  when `opfsPath` is null. One atomic setParam on the node's imageBindings map. */
export function setComfyImageBinding(
  comfyNodeId: NodeId,
  paramKey: string,
  opfsPath: string | null,
): void {
  const next = currentBindings(comfyNodeId);
  if (opfsPath) next[paramKey] = opfsPath;
  else delete next[paramKey];
  useDagStore
    .getState()
    .dispatchAtomic(
      [{ type: 'setParam', nodeId: comfyNodeId, paramPath: 'imageBindings', value: next }],
      'user',
      `bind image ${paramKey}`,
    );
}

/** Upload a media file into the project and bind it to this comfy media param in ONE
 *  atomic op chain (an orphan MediaClip node + the binding). A pick whose kind doesn't
 *  match `accept` is rejected to the app-root toast (NOT assetErrorStore — covered in
 *  VIDEO mode, [[H122]]). Fire-and-forget through the shared media picker. */
export function uploadMediaAndBind(
  comfyNodeId: NodeId,
  paramKey: string,
  accept: 'image' | 'video' = 'image',
): void {
  pickMediaFiles(async (file) => {
    const ingested = await ingestMediaClipFile(file);
    if (!ingested) return; // ingest failure already surfaced by importMediaClip
    if (ingested.probe.mediaKind !== accept) {
      useNotificationStore.getState().notify({
        severity: 'error',
        message: `“${ingested.name}” isn’t ${accept === 'image' ? 'an image' : 'a video'} — this input takes ${accept === 'image' ? 'an image' : 'a video'} file.`,
      });
      return;
    }
    const dag = useDagStore.getState();
    const mediaId = freshMediaClipId(Object.keys(dag.state.nodes));
    const next = currentBindings(comfyNodeId);
    next[paramKey] = ingested.opfsPath;
    const ops: Op[] = [
      ...buildMediaClipOps(mediaId, ingested.name, ingested.opfsPath, ingested.probe),
      { type: 'setParam', nodeId: comfyNodeId, paramPath: 'imageBindings', value: next },
    ];
    dag.dispatchAtomic(ops, 'user', `upload + bind ${accept} ${paramKey}`);
  });
}

/** Back-compat alias — an image-only upload+bind (the LoadImage rows + image controllers). */
export function uploadImageAndBind(comfyNodeId: NodeId, paramKey: string): void {
  uploadMediaAndBind(comfyNodeId, paramKey, 'image');
}
