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
import { foldChannelValue, type ChannelContribution } from './foldChannel';

/**
 * Overlay each channel's (paramPath, sampled value @ seconds) onto a deep-cloned
 * copy of `base`.
 * - Returns `base` unchanged when there are no channels (avoids the clone cost).
 * - `paramPath` supports dot notation for nested fields (e.g. 'material.color',
 *   'materials.0.base.color' — `writeAt` indexes array segments too).
 * - Multiple channels on ONE paramPath compose by an ordered, weighted fold
 *   (foldChannel.ts, #283): `order` sets bottom→top position, `blendMode` picks
 *   Replace (lerp — quat slerps) or Combine (additive / manifold over the per-type
 *   identity). `weight` (caller × per-channel) is the fold influence. Colour / text
 *   / image snap at weight≥0.5. A single Replace channel is byte-identical to the
 *   pre-#283 single-slot overwrite.
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
  // #283 Phase 1 (NLA) — the multi-writer fold. Group channels by paramPath so
  // ALL contributions to one (target,param) compose by an ORDERED, WEIGHTED,
  // explicit-blend-mode fold (foldChannelValue), not a scan-order-dependent
  // single-slot overwrite (fixes V88 D3). Byte-identical to the pre-NLA loop for
  // existing animations: a single Replace channel @ order 0 folds to the same
  // value the old `blend` produced, and the sequential acc reproduces the old
  // running-clone read for stacked Replace channels (proven by
  // overlayChannels.test.ts).
  const byPath = new Map<string, KeyframeChannelValue[]>();
  for (const ch of active) {
    const arr = byPath.get(ch.paramPath);
    if (arr) arr.push(ch);
    else byPath.set(ch.paramPath, [ch]);
  }
  for (const [path, chs] of byPath) {
    // Stable-sort by authored order (default 0 → preserves DAG/insertion order →
    // byte-identical). Array.sort is stable (ES2019+).
    const sorted = chs.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const contribs: ChannelContribution[] = sorted.map((ch) => ({
      value: ch.sample(seconds),
      // `?? 'replace'` / `?? 1` are defensive for any channel value constructed
      // without the #283 fields (byte-identity: Replace @ order 0).
      mode: ch.blendMode ?? 'replace',
      influence: weight * (ch.weight ?? 1),
    }));
    const folded = foldChannelValue(readAt(clone, path), contribs, sorted[0].valueType, path);
    writeAt(clone, path, folded);
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
