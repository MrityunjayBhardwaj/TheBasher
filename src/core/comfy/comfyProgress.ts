// comfyProgress — the PURE parser for ComfyUI's `/ws` progress stream (design §8
// "onProgress(cb)" / §16 Q-F). ComfyUI binds a websocket to a client by `clientId`
// (the one HttpComfyUICapability already sends on /prompt) and streams, DURING
// execution: text JSON `progress` (sampler step k/N) + `executing` (which node), and
// BINARY preview frames (the partially-denoised image as KSampler runs). This file is
// I/O-free and fully unit-testable; HttpComfyUICapability opens the socket and feeds
// each raw message through `parseComfyWsMessage`.
//
// Wire format (grounded in ComfyUI server.py:1268 encode_bytes + :1290 send_image,
// protocol.py BinaryEventTypes):
//   - text message  → `{ type, data }` JSON. progress.data={value,max,node},
//     executing.data={node}.
//   - binary message → `encode_bytes`: [uint32 BE event] ++ payload.
//       event 1 (PREVIEW_IMAGE)               → [uint32 type_num] ++ image bytes
//                                                 (type_num 1=JPEG, 2=PNG)
//       event 4 (PREVIEW_IMAGE_WITH_METADATA) → [uint32 metaLen] ++ json ++ image bytes
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §8/§16 Q-F; ../projects/comfyui/
//      server.py (encode_bytes/send_image/get('/ws')), protocol.py (BinaryEventTypes).

/** A progress event surfaced from ComfyUI's `/ws` stream during a (batched) submit. */
export type ComfyProgressEvent =
  | {
      readonly kind: 'progress';
      readonly value: number;
      readonly max: number;
      readonly node: string | null;
    }
  | { readonly kind: 'executing'; readonly node: string | null }
  | { readonly kind: 'preview'; readonly mime: string; readonly bytes: Uint8Array };

const PREVIEW_IMAGE = 1;
const PREVIEW_IMAGE_WITH_METADATA = 4;

/**
 * Parse one raw ComfyUI websocket message (a string for JSON events, an ArrayBuffer
 * for binary preview frames) into a ComfyProgressEvent, or null for messages we don't
 * surface (status / executed / unknown / malformed). Never throws.
 */
export function parseComfyWsMessage(data: string | ArrayBuffer): ComfyProgressEvent | null {
  if (typeof data === 'string') {
    let msg: { type?: string; data?: Record<string, unknown> } | null = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
    if (!msg || typeof msg !== 'object') return null;
    if (msg.type === 'progress') {
      const d = msg.data ?? {};
      return {
        kind: 'progress',
        value: typeof d.value === 'number' ? d.value : 0,
        max: typeof d.max === 'number' ? d.max : 0,
        node: typeof d.node === 'string' ? d.node : null,
      };
    }
    if (msg.type === 'executing') {
      const d = msg.data ?? {};
      return { kind: 'executing', node: typeof d.node === 'string' ? d.node : null };
    }
    return null;
  }

  // Binary: [uint32 BE event] ++ payload. Need at least the 4-byte event header + the
  // 4-byte sub-header.
  if (data.byteLength < 8) return null;
  const view = new DataView(data);
  const event = view.getUint32(0);
  if (event === PREVIEW_IMAGE) {
    const typeNum = view.getUint32(4);
    const mime = typeNum === 2 ? 'image/png' : 'image/jpeg';
    return { kind: 'preview', mime, bytes: new Uint8Array(data, 8) };
  }
  if (event === PREVIEW_IMAGE_WITH_METADATA) {
    const metaLen = view.getUint32(4);
    const off = 8 + metaLen;
    if (data.byteLength <= off) return null;
    let mime = 'image/png';
    try {
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 8, metaLen))) as {
        image_type?: string;
      };
      if (typeof meta.image_type === 'string') mime = meta.image_type;
    } catch {
      // keep the default mime
    }
    return { kind: 'preview', mime, bytes: new Uint8Array(data, off) };
  }
  return null;
}

/** Derive the `/ws` websocket URL (with the bound clientId) from an http(s) base URL. */
export function comfyWsUrl(httpUrl: string, clientId: string): string {
  const base = httpUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}/ws?clientId=${encodeURIComponent(clientId)}`;
}
