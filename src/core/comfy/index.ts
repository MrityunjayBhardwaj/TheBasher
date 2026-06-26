export type {
  ComfyBatchResult,
  ComfyInputs,
  ComfySubmitResult,
  ComfyUICapability,
  ComfyWorkflowJson,
} from './ComfyUICapability';
export { HttpComfyUICapability, type HttpComfyOptions } from './HttpComfyUICapability';
export { StubComfyUICapability, type StubComfyOptions } from './StubComfyUICapability';

import { HttpComfyUICapability } from './HttpComfyUICapability';
import { StubComfyUICapability } from './StubComfyUICapability';
import type { ComfyUICapability } from './ComfyUICapability';

export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/** Connection options shared by `pickComfyUI` + `probeComfyUI` (ComfyUI Inc 2:
 *  the URL/auth come from the settings store at boot). */
export interface ComfyConnectionOptions {
  /** `Authorization` header value for a guarded server ('' / undefined = none). */
  readonly authHeader?: string;
}

/**
 * Pick the best available ComfyUI capability for the current runtime.
 *
 *   HTTP (preferred — real ComfyUI server reachable at the configured URL)
 *   →  Stub  (offline / tests / no server reachable)
 *
 * Mirrors `pickStorage()` from src/core/storage. D-07 (locked):
 * URL defaults to `DEFAULT_COMFYUI_URL`; boot wiring overrides via the settings
 * store (`comfyui.serverUrl` + auth — ComfyUI Inc 2).
 */
export async function pickComfyUI(
  url: string = DEFAULT_COMFYUI_URL,
  opts: ComfyConnectionOptions = {},
): Promise<ComfyUICapability> {
  const http = new HttpComfyUICapability(url, { authHeader: opts.authHeader });
  if (await http.isAvailable()) return http;
  return new StubComfyUICapability();
}

/** The result of a live connection probe — what the Settings "Test Connection"
 *  button shows. `reachable` is the boundary verdict; `version`/`device` enrich
 *  the success badge; `error` carries the failure reason (incl. the CORS 403 a
 *  ComfyUI without `--enable-cors-header` returns to the browser). */
export interface ComfyProbeResult {
  reachable: boolean;
  version?: string;
  device?: string;
  error?: string;
}

/**
 * Probe a ComfyUI server's `/system_stats` and report reachability + version.
 * Unlike `pickComfyUI` (which silently falls back to the stub), this surfaces
 * WHY a probe failed so the user can fix it — the boundary the Settings modal
 * observes. Never throws.
 */
export async function probeComfyUI(
  url: string = DEFAULT_COMFYUI_URL,
  opts: ComfyConnectionOptions = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ComfyProbeResult> {
  const base = url.replace(/\/+$/, '');
  const headers = opts.authHeader?.trim() ? { Authorization: opts.authHeader.trim() } : undefined;
  try {
    const res = await fetchImpl(`${base}/system_stats`, { method: 'GET', headers });
    if (!res.ok) return { reachable: false, error: `Server responded ${res.status}` };
    const body = (await res.json()) as {
      system?: { comfyui_version?: string };
      devices?: Array<{ type?: string }>;
    };
    return {
      reachable: true,
      version: body.system?.comfyui_version,
      device: body.devices?.[0]?.type,
    };
  } catch (e) {
    // A browser CORS block (no `--enable-cors-header`) and an unreachable host
    // both land here as a TypeError — the message distinguishes them in DevTools.
    return { reachable: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

/**
 * Check whether a ComfyUI server has ALL the given node types installed (via
 * `/object_info`, whose top-level keys are the registered class types). Used to
 * detect the `BasherSchedule` bridge extension before submitting a compiled batch
 * that references it — if absent, the batch would be rejected, so the caller warns
 * + falls back rather than failing opaquely (design §16 Q-E). Returns false on any
 * error (treat "can't tell" as "not installed" — the safe direction). Never throws.
 */
export async function comfyHasNodeTypes(
  nodeTypes: readonly string[],
  url: string = DEFAULT_COMFYUI_URL,
  opts: ComfyConnectionOptions = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (nodeTypes.length === 0) return true;
  const base = url.replace(/\/+$/, '');
  const headers = opts.authHeader?.trim() ? { Authorization: opts.authHeader.trim() } : undefined;
  try {
    const res = await fetchImpl(`${base}/object_info`, { method: 'GET', headers });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return nodeTypes.every((t) => Object.prototype.hasOwnProperty.call(body, t));
  } catch {
    return false;
  }
}
