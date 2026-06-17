// overlayChannels — the ONE channel-overlay primitive (v0.7 unification, #196).
//
// Lifted verbatim out of `AnimationLayer.patchTarget` (the legacy wrapper) so the
// SAME overlay logic can be consumed directly by the renderer + read-side
// resolvers (the camera/glTF "direct channel" road) WITHOUT a wrapper node. This
// is the foundation the unification epic (#195) builds on: every animatable node
// resolves its value as `base + sampled channels @ paramPath`, one band, two
// callers (H40). AnimationLayer.evaluate now delegates here, so Phase 1 is a pure
// refactor — behaviour is byte-identical (proven by overlayChannels.test.ts).
//
// PURE: clone the base, sample each channel at `seconds`, `writeAt(paramPath,
// blend(...))`. No store reads, no three.js, no time subscription (the channels
// are function-of-time, V24/H48 — the caller picks the sample cadence).
//
// `writeAt` stays the ONE path-writer shared with `overlayTransients` (#149) so a
// transient overlay writes a paramPath EXACTLY the way the channel patch does —
// no drift (H40). It is re-exported from AnimationLayer.ts for back-compat.
//
// REF: docs/UNIFICATION-DESIGN.md §3.1/§3.2; vyapti V20/V24; hetvabhasa H40/H48.

import type { KeyframeChannelValue } from './types';

/**
 * Overlay each channel's (paramPath, sampled value @ seconds) onto a deep-cloned
 * copy of `base`.
 * - Returns `base` unchanged when there are no channels (avoids the clone cost).
 * - `paramPath` supports dot notation for nested fields (e.g. 'material.color',
 *   'materials.0.base.color' — `writeAt` indexes array segments too).
 * - `weight` blends each scalar / vector toward the base's static value.
 *   String / quat values pass through at weight≥0.5; <0.5 falls back to base.
 *
 * Channels are function-of-time (V24), so the per-channel value comes from
 * `ch.sample(seconds)`.
 *
 * GENERIC over the base shape (V57 — the ONE overlay primitive for EVERY animatable
 * node): a `SceneChild` (AnimationLayer / DirectChannelsR), a `GltfChildValue`
 * carrying `materials` (#188, the glTF-material road), or any future value object.
 * The body is structurally generic (JSON clone + `writeAt` at the paramPath); the
 * type param keeps the caller's shape on the way out.
 */
export function overlayChannels<T>(
  base: T | null,
  channels: readonly KeyframeChannelValue[],
  weight: number,
  seconds: number,
): T | null {
  if (!base) return null;
  // Per-channel mute gate (v0.7 #199 — lifted off the retired AnimationLayer):
  // a muted channel contributes nothing. Drop empty-path channels too. If none
  // remain, return the base unchanged (skip the clone cost).
  const active = channels.filter((ch) => !ch.mute && ch.paramPath);
  if (active.length === 0) return base;
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const ch of active) {
    const original = readAt(clone, ch.paramPath);
    // Effective weight = caller weight × per-channel weight (both identity by
    // default → byte-identical to pre-#199). `?? 1` is defensive for any
    // channel value constructed without the field.
    const w = weight * (ch.weight ?? 1);
    const blended = blend(original, ch.sample(seconds), ch.valueType, w);
    writeAt(clone, ch.paramPath, blended);
  }
  return clone as unknown as T;
}

export function readAt(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const key of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Write `value` at a dot-path on `obj`, IN PLACE. Shared with `overlayTransients`
 * (issue #149) so the transient overlay writes a paramPath EXACTLY the way the
 * channel patch does — one path-writer, no drift (H40). A missing intermediate
 * object is a no-op (the path must already exist; every animated/transient
 * paramPath does, because routeAnimatedGrab only fires on an existing animated
 * field and the inspector/gizmo route the whole band).
 */
export function writeAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop();
  if (last == null) return;
  let cur: Record<string, unknown> = obj;
  for (const key of parts) {
    const nxt = cur[key];
    if (nxt == null || typeof nxt !== 'object') return;
    cur = nxt as Record<string, unknown>;
  }
  cur[last] = value;
}

function blend(
  original: unknown,
  channelValue: unknown,
  valueType: KeyframeChannelValue['valueType'],
  weight: number,
): unknown {
  const w = Math.max(0, Math.min(1, weight));
  if (w >= 1) return channelValue;
  if (w <= 0) return original ?? channelValue;
  if (valueType === 'number' && typeof original === 'number' && typeof channelValue === 'number') {
    return original + (channelValue - original) * w;
  }
  if (
    valueType === 'vec3' &&
    Array.isArray(original) &&
    original.length === 3 &&
    Array.isArray(channelValue) &&
    channelValue.length === 3
  ) {
    return [
      (original[0] as number) + ((channelValue[0] as number) - (original[0] as number)) * w,
      (original[1] as number) + ((channelValue[1] as number) - (original[1] as number)) * w,
      (original[2] as number) + ((channelValue[2] as number) - (original[2] as number)) * w,
    ];
  }
  // quat / color / unknown: snap at the half-weight mark. Smooth blending for
  // these types needs slerp / HSL-lerp; defer until weight<1 is a real authoring
  // need.
  return w >= 0.5 ? channelValue : (original ?? channelValue);
}
