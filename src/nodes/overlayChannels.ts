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
 * The copy an overlay patches: a SHALLOW copy of the root. Everything below it is the very object
 * the evaluator produced until `writeAt` writes through it, and a write copies only the path it
 * goes through (copy-on-write, tracked per root).
 *
 * #1236 — this used to be a JSON-style deep copy, and that did two kinds of harm. It dropped every
 * function, so a value carrying a pose as a `sample` closure lost it the moment its Object was
 * keyed. And it copied everything else every frame, so a keyed armature Object copied its whole
 * action — 2,425 µs a frame on `walk.bvh` (9,360 keys), against 42 µs for the deform itself — and
 * every memo keyed on a sub-value's identity missed every frame (#1207: 10 skinned-mesh builds
 * over 10 frames). Sharing what is not written fixes both, and it is what a reader of an unkeyed
 * Object already gets. Blender's animation system works the same way: it writes each animated
 * property path into the evaluated object and leaves what isn't animated alone.
 *
 * #1158's typed arrays are shared for the same reason, now without a special case.
 *
 * THE RULE THIS RESTS ON: nothing writes into an overlay's copy except through `writeAt`. The
 * writers are the channel fold below, `overlayTransients`, and the two identity repairs in
 * `overlayWithIdentity` (which the constraint road also calls on its own spread). A direct
 * assignment below the root would write into the evaluator's cached value.
 */
export function cloneForOverlay<T>(base: T): T {
  if (base === null || typeof base !== 'object') return base;
  const root = (Array.isArray(base) ? base.slice() : { ...base }) as T & object;
  ownedBy.set(root, new WeakSet());
  return root;
}

/** Per root: the objects below it a write has already copied, and so may write into. */
const ownedBy = new WeakMap<object, WeakSet<object>>();

/** A copy of one object on a write's path, of the same shape. `null` when it cannot be copied. */
function copyForWrite(value: object): object | null {
  if (ArrayBuffer.isView(value)) {
    return 'slice' in value && typeof value.slice === 'function' ? (value.slice() as object) : null;
  }
  return Array.isArray(value) ? value.slice() : { ...value };
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
 * Write `value` at a dot-path on `obj`. Shared with `overlayTransients`
 * (issue #149) so the transient overlay writes a paramPath EXACTLY the way the
 * channel patch does — one path-writer, no drift (H40). A missing intermediate
 * object is a no-op (the path must already exist; every animated/transient
 * paramPath does, because routeAnimatedGrab only fires on an existing animated
 * field and the inspector/gizmo route the whole band).
 *
 * `obj` itself is written in place; every object BELOW it on the path is copied the first time
 * a write goes through it from this root, and the copy is written instead (#1236). So a write
 * never reaches an object the root shares with anything else — the evaluator's value under an
 * overlay's shallow copy (`cloneForOverlay`), or the overlaid value under the constraint road's
 * spread — and a second write through the same object reuses its copy.
 */
export function writeAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop();
  if (last == null) return;
  let owned = ownedBy.get(obj);
  if (!owned) {
    owned = new WeakSet();
    ownedBy.set(obj, owned);
  }
  let cur: Record<string, unknown> = obj;
  for (const key of parts) {
    const nxt = cur[key];
    if (nxt == null || typeof nxt !== 'object') return;
    if (owned.has(nxt)) {
      cur = nxt as Record<string, unknown>;
      continue;
    }
    const copy = copyForWrite(nxt);
    if (copy === null) return;
    owned.add(copy);
    cur[key] = copy;
    cur = copy as Record<string, unknown>;
  }
  cur[last] = value;
}
