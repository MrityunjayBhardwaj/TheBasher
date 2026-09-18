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
/**
 * Does this channel contribute to a fold at all? The gate every overlay road must
 * apply, spelled ONCE (#1016).
 *
 * It used to live only inside `overlayChannels` below. `resolveEvaluatedParam` folds a
 * SINGLE param path and so could not call `overlayChannels` (which overlays a whole
 * base object); it re-implemented the fold and reproduced everything except this line,
 * so a muted channel lost in the viewport and won at every read surface — the inspector,
 * the compositor, a bake. Exported so the two folds read the same predicate instead of
 * keeping two copies of it.
 *
 * Per-channel SOLO (#263) is deliberately NOT here: it is filtered UPSTREAM, per TARGET,
 * in `channelValuesFromNodes`, because a fold sees only a param-subset and cannot answer
 * a per-target question.
 */
export function channelIsActive(ch: KeyframeChannelValue): boolean {
  return !ch.mute && !!ch.paramPath;
}

/**
 * The copy an overlay patches: what `JSON.parse(JSON.stringify(base))` gives, except that typed
 * arrays come back as the SAME arrays rather than as `{ "0": …, "1": … }`.
 *
 * #1158 — a Group's value carries its children's, so an overlay on a Group clones its whole
 * subtree, and a stored mesh below it held its points and faces as typed arrays. JSON destroyed
 * them, and a cold geometry cache then built from the wreck and unmounted the editor. An overlay
 * writes params by path and never into a typed array, and the no-overlay road already hands
 * consumers these very arrays, so sharing them loses nothing.
 *
 * Written as a direct copy rather than JSON with a replacer: the replacer alone measured 2.7×
 * slower on a value with no typed array in it (9.3 → 25.4 µs), and this runs per animated node per
 * frame. It keeps JSON's rules for everything else — a non-finite number becomes null, `-0`
 * becomes 0, `undefined` and functions drop out of objects and become null in arrays, `toJSON` is
 * honoured, and only own enumerable keys are copied — so no overlay reads a different value.
 */
export function cloneForOverlay<T>(base: T): T {
  return copyLikeJson(base, '') as T;
}

function copyLikeJson(value: unknown, key: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    case 'string':
    case 'boolean':
      return value;
    case 'object': {
      if (ArrayBuffer.isView(value)) return value;
      const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
      if (typeof toJSON === 'function') return copyLikeJson(toJSON.call(value, key), key);
      if (Array.isArray(value)) {
        const out = new Array<unknown>(value.length);
        for (let i = 0; i < value.length; i++) {
          const item = copyLikeJson(value[i], String(i));
          out[i] = item === undefined ? null : item;
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value)) {
        const item = copyLikeJson((value as Record<string, unknown>)[k], k);
        if (item !== undefined) out[k] = item;
      }
      return out;
    }
    default:
      // undefined, function, symbol: absent, as JSON leaves them. (A bigint throws in JSON; none is
      // ever an overlaid value.)
      return undefined;
  }
}

export function overlayChannels<T>(
  base: T | null,
  channels: readonly KeyframeChannelValue[],
  weight: number,
  seconds: number,
): T | null {
  if (!base) return null;
  // Per-channel mute gate (v0.7 #199 — lifted off the retired AnimationLayer):
  // a muted channel contributes nothing. Drop empty-path channels too. If none
  // remain, return the base unchanged (skip the clone cost). (Per-channel SOLO
  // (#263) is filtered UPSTREAM in `channelValuesFromNodes` — per TARGET, so the
  // render and read roads agree — not here, where a fold sees only a param-subset.)
  const active = channels.filter(channelIsActive);
  if (active.length === 0) return base;
  const clone = cloneForOverlay(base) as Record<string, unknown>;
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
      // #283 Phase 3 — time-varying influence: a crossfading channel carries an
      // `influenceAt` closure evaluated at THIS sample time; bare channels + non-
      // crossfade strips omit it → the static `weight` path (byte-identical).
      influence: weight * (ch.influenceAt ? ch.influenceAt(seconds) : (ch.weight ?? 1)),
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
