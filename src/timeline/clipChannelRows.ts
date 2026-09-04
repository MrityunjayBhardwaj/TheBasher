// clipChannelRows — pure projector: an imported glTF clip track → read-only
// dopesheet/curve-editor rows for ONE bone (Phase 7.12 Wave B, issue #108).
//
// ─────────────────────────────────────────────────────────────────────────
// R5 — THE CLIP TRACK KEY IS childName, NOT the GltfChild dagId
// ─────────────────────────────────────────────────────────────────────────
// A TransformClip's keyframes are keyed by `targetNodeId`, which is the
// sanitised/deduped scene-node NAME (gltfImportChain.buildClipKeyframes:345
// pushes `targetNodeId: targetKey`, where targetKey === keyByGltfNodeIndex[i]
// === the dedup'd childName). It is NOT the GltfChild DAG node id.
//
//   clip keyframe `targetNodeId`  ===  GltfChild.params.childName
//   GltfChild node id             ===  hashId('gltfChild', assetRef, childName)
//                                       (gltfImportChain.ts:120, fnv1a32 hash —
//                                        e.g. `n_gltfChild_<hash>`)
//
// The two are BRIDGED by `childName`. A projector that filters the clip by the
// GltfChild dagId yields ZERO rows — the silent-empty-timeline symptom this
// module's R5 confirmation step exists to prevent (the #108 bug in reverse).
//
// REF: src/core/import/gltfImportChain.ts:294,345 (targetNodeId = targetKey);
//      src/core/import/gltfImportChain.ts:120 (dagId = hashId('gltfChild',…));
//      src/nodes/GltfChild.ts:60-61 (childName param = nodeNameMap key);
//      src/nodes/TransformClip.ts:48-65 (keyframes schema); PLAN.md Wave B (B1).
//
// PURE / V8-clean: args in, rows out. No store access, no DAG read, no
// dispatch. The single source of truth stays the TransformClip node's params.

/** One TRS keyframe as stored on a TransformClip node (TransformClip.ts:54-64). */
export interface ClipKeyframe {
  targetNodeId: string;
  time: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
}

/**
 * A dopesheet/curve-editor row. Mirrors the shape `collectChannelRows`
 * produces (TimelineCanvas.tsx:129-133), extended with an optional `readOnly`
 * flag (B1): a clip row is read-only until the first edit bakes it into an
 * editable per-bone KeyframeChannel (Wave D). The flag is optional so existing
 * baked-channel rows (which omit it) stay structurally identical.
 */
export interface ChannelRow {
  channelId: string;
  name: string;
  keyframes: ReadonlyArray<{ time: number }>;
  /** True for projected imported-clip rows — no drag/edit handlers (B2). */
  readOnly?: boolean;
  /**
   * True when the channel's `mute` param is set (#263 — the per-channel mute
   * restored after the AnimationLayer retirement, V57/#199). A muted channel
   * contributes nothing to the resolver (`overlayChannels.ts` filters it), so
   * the dopesheet paints its row dimmed. Optional so clip rows and existing
   * fixtures (which omit it) stay structurally identical.
   */
  mute?: boolean;
  /**
   * True when the channel's `solo` param is set (#263). Solo is RELATIONAL — when any
   * channel on the same `targetId` is solo'd, the resolver drives ONLY the solo'd ones
   * (`overlayChannels.ts`), so the dopesheet paints the solo'd row highlighted and its
   * soloed-out siblings dimmed. Optional so clip rows / fixtures stay identical.
   */
  solo?: boolean;
  /** The channel's `target` node id — the grouping key for the per-object solo scope. */
  targetId?: string;
}

/** The three TRS components a TransformClip carries, in dopesheet row order. */
const COMPONENTS = ['position', 'rotation', 'scale'] as const;
type Component = (typeof COMPONENTS)[number];

/**
 * Synthetic, namespaced row id for a projected clip component. Namespaced so
 * it can never collide with a real KeyframeChannel node id (which is an
 * `n_…` hashId): `clip:<childName>:<component>`. B2 routes the timeline's
 * active row through this id; D2 (Wave D) detects this namespace to fire the
 * copy-on-write bake.
 */
export function clipRowChannelId(childName: string, component: Component): string {
  return `clip:${childName}:${component}`;
}

/**
 * Project ONE bone's imported TransformClip track into the three per-component
 * read-only dopesheet rows (position / rotation / scale — each a Vec3, mirroring
 * how a baked KeyframeChannelVec3 would project, CurveEditor.expandToTracks).
 *
 * R5: filters `clipKeyframes` by `targetNodeId === childName` (the NAME key).
 * Querying with the GltfChild dagId yields [] by construction.
 *
 * @param clipKeyframes the active TransformClip's `params.keyframes`
 * @param childName     the selected GltfChild's `params.childName` (the bridge)
 */
export function clipRowsForChild(args: {
  clipKeyframes: readonly ClipKeyframe[];
  childName: string;
}): ChannelRow[] {
  const { clipKeyframes, childName } = args;

  // R5 filter — NAME key, never dagId.
  const forChild = clipKeyframes
    .filter((k) => k.targetNodeId === childName)
    .slice()
    .sort((a, b) => a.time - b.time);

  if (forChild.length === 0) return [];

  // Every keyframe carries the full TRS (gltfImportChain fills missing
  // components from the node's static defaults, :347-349), so the three
  // component rows share the same time set.
  const times = forChild.map((k) => ({ time: k.time }));

  return COMPONENTS.map((component: Component) => ({
    channelId: clipRowChannelId(childName, component),
    name: `${childName} — ${component}`,
    keyframes: times,
    readOnly: true,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// B2 — selection → clip-row wiring (pure DAG-param walk, V8-clean)
// ─────────────────────────────────────────────────────────────────────────
// These helpers walk the DAG by PARAMS + edges only — never the evaluator
// (the display path is D-04-independent: it reads `params.keyframes`, never the
// evaluated `.value`). They resolve "which clip track does this selected bone's
// display read?" the SAME way the renderer/resolver resolve the active clip:
//   GltfChild.assetRef → GltfAsset(assetRef) → ClipSelect (via the asset's
//   `transformClip` input edge) → selectedClipName → the matching TransformClip
//   among the ClipSelect's `clips` inputs → its params.keyframes.
//
// REF: src/core/import/gltfImportChain.ts:477-519 (TransformClip + ClipSelect
//      wiring); src/nodes/ClipSelect.ts:52 (name match); src/nodes/GltfAsset.ts
//      (transformClip socket); src/app/resolveEvaluatedTransform.ts:188-202
//      (the read-side twin walks the same asset→clip path).

/** Minimal structural view of a DAG node — only the fields these helpers read.
 *  Loosely typed so callers can pass the live `Record<string, Node>` without a
 *  cast (the real Node carries an `unknown` params). */
interface ClipWalkNode {
  type: string;
  params?: unknown;
  inputs?: Record<string, unknown>;
}

/** Normalise an input binding (single ref or list) to an array of node ids. */
function refNodeIds(binding: unknown): string[] {
  const arr = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return arr
    .map((r) => (r && typeof r === 'object' ? (r as { node?: unknown }).node : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/** The active `TransformClip`, as ONE answer.
 *
 *  🔴 THE KEYS AND THE TIME DOMAIN TRAVEL TOGETHER, AND THAT IS THE POINT (#916).
 *  This mirrors what `seedKeysFromClip` returns on the sibling `AnimationClip`
 *  road after #913: a caller that could take the keys WITHOUT the domain is a
 *  caller that can mint a copy which stops where its source wraps. Handing the
 *  domain back through a second function would rebuild exactly the separability
 *  that defect was made of. */
export interface ActiveClip {
  readonly keyframes: ClipKeyframe[];
  /** Does the source REPEAT past its duration?
   *
   *  🔴 TWO CARRIERS, TWO SPELLINGS, OPPOSITE DEFAULTS. `TransformClip.loop` is
   *  an ENUM defaulting to `'clamp'` (TransformClip.ts:47) where
   *  `AnimationClip.loop` is a BOOLEAN defaulting to `true`. Same concept, and
   *  the opposite default is exactly why this road's missing time domain never
   *  bit while the other one bit immediately. Normalised to the boolean the
   *  shared emitter takes, so the disagreement is resolved HERE rather than at
   *  the call site.
   *
   *  The precondition is the same one #913 measured and it holds for the same
   *  reason: a Cycles modifier repeats the CHANNEL'S key range, while the clip
   *  folds at `duration`, so the two agree only when the keys span the clip.
   *  A glTF import derives `duration` as `max(keyTime)` itself
   *  (gltfImportChain.ts:593), so the span is exact by construction. */
  readonly cyclic: boolean;
}

/**
 * Resolve the active TransformClip for the asset `assetRef`, keys and time
 * domain together. Pure: walks `nodes` by params + edges.
 * Returns null when there is no asset / no clip / no selected clip.
 */
export function activeClipForAsset(
  nodes: Record<string, ClipWalkNode>,
  assetRef: string,
): ActiveClip | null {
  // 1. The owning GltfAsset (matched by assetRef param).
  let asset: ClipWalkNode | undefined;
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfAsset') continue;
    if ((node.params as { assetRef?: unknown } | undefined)?.assetRef === assetRef) {
      asset = node;
      break;
    }
  }
  if (!asset) return null;

  // 2. The ClipSelect feeding the asset's `transformClip` socket.
  const clipSelectId = refNodeIds(asset.inputs?.transformClip)[0];
  const clipSelect = clipSelectId ? nodes[clipSelectId] : undefined;
  if (!clipSelect || clipSelect.type !== 'ClipSelect') return null;
  const selectedClipName = (clipSelect.params as { selectedClipName?: unknown } | undefined)
    ?.selectedClipName;
  if (typeof selectedClipName !== 'string') return null;

  // 3. The TransformClip whose name matches, among the ClipSelect's `clips`.
  const clipIds = refNodeIds(clipSelect.inputs?.clips);
  for (const id of clipIds) {
    const clip = nodes[id];
    if (!clip || clip.type !== 'TransformClip') continue;
    const cp = clip.params as { name?: unknown; keyframes?: unknown; loop?: unknown } | undefined;
    if (cp?.name !== selectedClipName) continue;
    const kfs = cp?.keyframes;
    return {
      keyframes: Array.isArray(kfs) ? (kfs as ClipKeyframe[]) : [],
      // `'loop'` and nothing else. An absent value is the schema's `'clamp'`, so
      // reading it positively keeps an unset clip on the holding road it is on
      // today rather than inventing a repeat for it.
      cyclic: cp?.loop === 'loop',
    };
  }
  return null;
}

/**
 * The active TransformClip's keyframes for `assetRef`, or [] when there is
 * none — the caller (B2) then surfaces no clip rows (the bone simply has no
 * imported animation).
 *
 * Delegates rather than walking again: two walks are two answers to "which clip
 * is active", and they would diverge silently.
 */
export function activeClipKeyframesForAsset(
  nodes: Record<string, ClipWalkNode>,
  assetRef: string,
): ClipKeyframe[] {
  return activeClipForAsset(nodes, assetRef)?.keyframes ?? [];
}

const CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

/**
 * FLAG-3 suppression predicate: the set of childNames that have ALREADY been
 * baked into editable KeyframeChannel node(s) for this asset (Wave D D1 stores
 * `params.childName` on every baked channel, BLOCK-2). A baked bone's editable
 * rows surface via the existing orphan-channel path (`collectChannelRows`); its
 * clip rows MUST be suppressed so the dopesheet shows exactly ONE row set per
 * bone — clip rows (un-baked) XOR baked-channel rows (baked), never both.
 *
 * Pre-Wave-D this returns ∅ (no baked channels exist yet); the predicate is in
 * place now so the single-row-set invariant holds the moment D1 lands.
 */
export function bakedChildNamesForAsset(
  nodes: Record<string, ClipWalkNode>,
  assetRef: string,
): Set<string> {
  // The asset's dagId namespace is content-addressed (hashId), but the baked
  // channel carries `params.childName` directly (BLOCK-2) — match on it. We
  // scope to THIS asset by also requiring the childName to belong to the
  // asset's clip (i.e. it targets a real bone), which the activeClip walk
  // already vouches for; here we simply collect every baked channel's
  // childName + asset assetRef pairing.
  const names = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!CHANNEL_TYPES.has(node.type)) continue;
    const cp = node.params as { childName?: unknown; assetRef?: unknown } | undefined;
    if (typeof cp?.childName !== 'string') continue;
    // A baked GltfChild channel carries both childName and assetRef (BLOCK-2).
    // Pre-D1 channels (authored, not baked) carry neither → skipped here.
    if (cp.assetRef !== undefined && cp.assetRef !== assetRef) continue;
    names.add(cp.childName);
  }
  return names;
}

/**
 * The complete row-set the timeline surfaces, given the DAG and the current
 * viewport selection. Appends the selected GltfChild's read-only clip rows
 * (B1) to the base channel rows, suppressed once that bone is baked (FLAG-3).
 *
 * `baseRows` is `collectChannelRows(nodes)` (passed in so this stays a pure
 * function of its args — no import cycle with TimelineCanvas).
 */
export function appendSelectionClipRows(args: {
  baseRows: ChannelRow[];
  nodes: Record<string, ClipWalkNode>;
  selectedNodeId: string | null;
}): ChannelRow[] {
  const { baseRows, nodes, selectedNodeId } = args;
  if (!selectedNodeId) return baseRows;
  const selected = nodes[selectedNodeId];
  if (!selected || selected.type !== 'GltfChild') return baseRows;

  const cp = selected.params as { assetRef?: unknown; childName?: unknown } | undefined;
  if (typeof cp?.assetRef !== 'string' || typeof cp?.childName !== 'string') return baseRows;

  // FLAG-3: if this bone is already baked, its editable rows are in baseRows
  // (the orphan-channel path) — do NOT also append clip rows.
  if (bakedChildNamesForAsset(nodes, cp.assetRef).has(cp.childName)) return baseRows;

  const clipKeyframes = activeClipKeyframesForAsset(nodes, cp.assetRef);
  const clipRows = clipRowsForChild({ clipKeyframes, childName: cp.childName });
  return clipRows.length > 0 ? [...baseRows, ...clipRows] : baseRows;
}

/**
 * Resolve a synthetic clip-row id (`clip:<childName>:<component>`) back to its
 * source clip keyframes, for the CurveEditor read-only render path. Returns
 * null when the id is not a clip-row id (a real channel) or the bone/clip is
 * gone. The childName is everything between the first and last `:`.
 */
export function resolveClipRow(
  nodes: Record<string, ClipWalkNode>,
  channelId: string,
): { childName: string; component: Component; keyframes: ClipKeyframe[] } | null {
  if (!channelId.startsWith('clip:')) return null;
  const lastColon = channelId.lastIndexOf(':');
  const component = channelId.slice(lastColon + 1);
  const childName = channelId.slice('clip:'.length, lastColon);
  if (!childName || !COMPONENTS.includes(component as Component)) return null;

  // Find the GltfChild for this childName to recover its assetRef, then the
  // active clip. (childName is unique within an asset; if two assets share a
  // bone name the first match wins — acceptable for the display read.)
  let assetRef: string | undefined;
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfChild') continue;
    const p = node.params as { childName?: unknown; assetRef?: unknown } | undefined;
    if (p?.childName === childName && typeof p?.assetRef === 'string') {
      assetRef = p.assetRef;
      break;
    }
  }
  if (!assetRef) return null;

  const all = activeClipKeyframesForAsset(nodes, assetRef);
  const keyframes = all
    .filter((k) => k.targetNodeId === childName)
    .slice()
    .sort((a, b) => a.time - b.time);
  if (keyframes.length === 0) return null;
  return { childName, component: component as Component, keyframes };
}

/** The component index (0/1/2) for a clip row's TRS component. */
export function componentIndex(component: Component): number {
  return COMPONENTS.indexOf(component);
}

// ─────────────────────────────────────────────────────────────────────────
// THE AnimationClip ROAD (#903) — the other kind of clip, and the only kind
// the AI track produces
// ─────────────────────────────────────────────────────────────────────────
// Everything above serves `TransformClip`: a glTF file's OWN embedded
// animation, emitted at gltfImportChain.ts:887, keyed by `targetNodeId` with a
// full TRS per key and rotation in degrees.
//
// A generated, BVH-imported, FBX-imported or retargeted motion is an
// `AnimationClip` — a different node type with a different schema: keyed by
// bone INDEX, position and rotation only, rotation in RADIANS
// (AnimationClip.ts:45-48). The walk above skips it by type
// (`clip.type !== 'TransformClip'`), so those characters had no clip rows at
// all.
//
// That was invisible while an eager bake gave every bone a real channel. The
// moment it stops (#889 slice 3), a character on this road animates perfectly
// and shows NOTHING in the timeline — measured on Robot-Walk.basher, 46 rows to
// 0 — which leaves no way to reach the minting road at all.
//
// TWO COMPONENTS, NOT THREE. An AnimationClip carries no scale track, and the
// eager bake agreed: 46 channels for 23 bones is position + rotation, never
// scale. A projected scale row would claim a track that does not exist.
//
// PER ASSET, NOT PER SELECTION. `collectChannelRows` lists every channel in the
// DAG regardless of what is selected — measured, 46 rows with a bone selected
// and 46 with nothing selected. Projecting only the selected bone's rows would
// silently shrink the dopesheet from the whole rig to two rows, so the
// projection covers the asset.
//
// REF: src/app/animate/boundClipsForAsset.ts (the shared bone→clip walk);
//      src/nodes/AnimationClip.ts:45-48 (the schema); issues #903, #889, #877.

import { boundClipsForAsset, type GraphNodeLike } from '../app/animate/boundClipsForAsset';
import type { AnimationClipParams } from '../nodes/AnimationClip';

/** The components an `AnimationClip` can carry. Scale is absent from the schema,
 *  so it is absent here — a row for it would be a claim with nothing behind it. */
const ANIMATION_CLIP_COMPONENTS = ['position', 'rotation'] as const;

/**
 * The (bone, component) pairs that already have a minted channel for this asset.
 *
 * PER COMPONENT, and that is the whole difference from `bakedChildNamesForAsset`
 * above. The eager bake was whole-bone, so "is this bone baked?" was a complete
 * question. Minting is per component (#889 slice 1): a bone can hold an authored
 * rotation while its position still follows the clip. Suppressing by bone would
 * then hide the position row entirely — the track would vanish from the timeline
 * while still driving the character, which reads as lost animation rather than
 * as a suppressed row.
 */
export function bakedChannelKeysForAsset(
  nodes: Record<string, ClipWalkNode>,
  assetRef: string,
): Set<string> {
  const keys = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!CHANNEL_TYPES.has(node.type)) continue;
    const cp = node.params as
      | { childName?: unknown; assetRef?: unknown; paramPath?: unknown }
      | undefined;
    if (typeof cp?.childName !== 'string' || typeof cp?.paramPath !== 'string') continue;
    if (cp.assetRef !== undefined && cp.assetRef !== assetRef) continue;
    keys.add(`${cp.childName}:${cp.paramPath}`);
  }
  return keys;
}

/**
 * Project the clip(s) bound to `assetRef` into read-only dopesheet rows — one
 * per (bone, component) the clip actually carries, minus the ones a director has
 * already authored.
 *
 * Uses the same `boundClipsForAsset` edge walk the read band and the mint use,
 * rather than a third answer to "which clip drives this bone". A row set built
 * from a different walk than the one that renders would show a director keys
 * that are not the ones playing.
 */
export function animationClipRowsForAsset(args: {
  nodes: Record<string, ClipWalkNode>;
  assetRef: string;
}): ChannelRow[] {
  const { nodes, assetRef } = args;
  const suppressed = bakedChannelKeysForAsset(nodes, assetRef);
  const rows: ChannelRow[] = [];
  const seen = new Set<string>();

  for (const clip of boundClipsForAsset(nodes as Record<string, GraphNodeLike>, assetRef)) {
    const keyframes = (clip.params as Partial<AnimationClipParams>).keyframes ?? [];
    // bone INDEX → the times that bone has keys at. The index is only meaningful
    // against the skeleton the clip hangs off, which is why the walk resolves it
    // by edge rather than by name.
    const byBone = new Map<number, number[]>();
    for (const k of keyframes) {
      const list = byBone.get(k.bone);
      if (list) list.push(k.time);
      else byBone.set(k.bone, [k.time]);
    }
    for (const [index, times] of byBone) {
      const childName = clip.jointKeys[index];
      if (typeof childName !== 'string' || childName.length === 0) continue;
      const sorted = times
        .slice()
        .sort((a, b) => a - b)
        .map((time) => ({ time }));
      for (const component of ANIMATION_CLIP_COMPONENTS) {
        const key = `${childName}:${component}`;
        // A bone whose component is authored shows its EDITABLE row from
        // `collectChannelRows`; showing both would break the one-row-set-per
        // (bone, component) invariant the dopesheet rests on.
        if (suppressed.has(key) || seen.has(key)) continue;
        seen.add(key);
        rows.push({
          channelId: clipRowChannelId(childName, component),
          name: `${childName} — ${component}`,
          keyframes: sorted,
          readOnly: true,
        });
      }
    }
  }
  return rows;
}

/**
 * Append the read-only `AnimationClip` rows for every asset in the graph.
 *
 * Selection-independent, matching `collectChannelRows`: the dopesheet shows the
 * whole rig, not just what is selected.
 */
export function appendAnimationClipRows(args: {
  baseRows: ChannelRow[];
  nodes: Record<string, ClipWalkNode>;
}): ChannelRow[] {
  const { baseRows, nodes } = args;
  const out = [...baseRows];
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfAsset') continue;
    const assetRef = (node.params as { assetRef?: unknown } | undefined)?.assetRef;
    if (typeof assetRef !== 'string' || assetRef.length === 0) continue;
    out.push(...animationClipRowsForAsset({ nodes, assetRef }));
  }
  return out;
}
