export type { DecodedFrame, MediaDecodeCapability, MediaProbe } from './MediaDecodeCapability';
export { StubMediaDecode, type StubMediaDecodeOptions } from './StubMediaDecode';
export { WebCodecsMediaDecode } from './WebCodecsMediaDecode';

import type { MediaDecodeCapability } from './MediaDecodeCapability';
import { StubMediaDecode } from './StubMediaDecode';
import { WebCodecsMediaDecode } from './WebCodecsMediaDecode';

/**
 * Pick the best media decoder for the current runtime.
 *   WebCodecs/createImageBitmap (browser)  →  Stub (headless / tests)
 * Mirrors pickStorage() / pickComfyUI().
 */
export function pickMediaDecode(): MediaDecodeCapability {
  const wc = new WebCodecsMediaDecode();
  return wc.isAvailable() ? wc : new StubMediaDecode();
}
