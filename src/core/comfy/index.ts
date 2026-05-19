export type {
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

/**
 * Pick the best available ComfyUI capability for the current runtime.
 *
 *   HTTP (preferred — real ComfyUI server reachable at the configured URL)
 *   →  Stub  (offline / tests / no server reachable)
 *
 * Mirrors `pickStorage()` from src/core/storage. D-07 (locked):
 * URL defaults to `DEFAULT_COMFYUI_URL`; boot wiring overrides via
 * `settings.get('comfyui.serverUrl')`.
 */
export async function pickComfyUI(url: string = DEFAULT_COMFYUI_URL): Promise<ComfyUICapability> {
  const http = new HttpComfyUICapability(url);
  if (await http.isAvailable()) return http;
  return new StubComfyUICapability();
}
