// bakeOnEdit — the copy-on-write intercept (Phase 7.12 Wave D / D2, issue #108).
//
// ─────────────────────────────────────────────────────────────────────────
// WHERE THE BAKE FIRES (R3 — the timeline mutation site, NOT the grab)
// ─────────────────────────────────────────────────────────────────────────
// The FIRST timeline edit of a clip-backed bone transparently materializes that
// bone's clip track into editable per-bone KeyframeChannel node(s) (D1's
// `mutator.timeline.bakeGltfChannel`), THEN applies the edit to the now-real
// baked channel — both as ONE atomic undo entry (K6).
//
// The trigger is a timeline edit on a READ-ONLY CLIP ROW (B2's synthetic
// `clip:<childName>:<component>` id namespace), NOT the NPanel/Gizmo grab. A
// clip-only bone returns 'none' from paramAnimationState, so the grab falls
// through to a MANUAL single-pose override (the existing #91 path) — a different
// operation from a curve edit. Hooking the bake at the grab would never fire on
// a key drag (R3 pre-mortem).
//
// ─────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY KEY (BLOCK-2) — match the bone's dagId, the SAME key
// paramAnimationState:74 uses
// ─────────────────────────────────────────────────────────────────────────
// "Does a baked channel already exist for this bone?" is answered by matching a
// KeyframeChannel whose `params.target === gltfChildDagId(assetRef, childName)`.
// Once baked, B2's single-row-set predicate SUPPRESSES the clip rows and surfaces
// the real channel rows instead — so a second edit never re-enters this path
// (its row id is a real `n_…` channel id, not a `clip:` id). The bake is
// therefore a true once-per-bone copy-on-write.
//
// This module is PURE detection + id resolution (V8-clean: args in, ids out).
// The atomic bake+edit composite lives in dispatchMutator.ts (where the
// propose/accept seam helpers live) — see `dispatchBakeThenRetime`.
//
// REF: PLAN 7.12 Wave D (D2, R3 / BLOCK-2 / K6); src/timeline/clipChannelRows.ts
//      (clipRowChannelId — the synthetic id namespace this parses);
//      src/agent/mutators/builders/bakeGltfChannel.ts (D1, the bake mutator);
//      src/app/animate/paramAnimationState.ts:74 (the p.target===dagId key).

import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';

/** The three TRS components a clip row / baked channel can address. */
const COMPONENTS = ['position', 'rotation', 'scale'] as const;
type Component = (typeof COMPONENTS)[number];

/** Minimal structural node view — params only (no evaluator). */
interface NodeLike {
  type: string;
  params?: unknown;
}

const CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

/**
 * Parse a synthetic clip-row id (`clip:<childName>:<component>`) into its parts.
 * Returns null for a real channel id (`n_…`) or a malformed id. The childName is
 * everything between the first and last `:` (bone names cannot contain `:` —
 * sanitizeBoneName strips it). Mirrors clipChannelRows.resolveClipRow's parse so
 * the two stay in lockstep.
 */
export function parseClipRowId(
  channelId: string,
): { childName: string; component: Component } | null {
  if (!channelId.startsWith('clip:')) return null;
  const lastColon = channelId.lastIndexOf(':');
  const component = channelId.slice(lastColon + 1);
  const childName = channelId.slice('clip:'.length, lastColon);
  if (!childName || !COMPONENTS.includes(component as Component)) return null;
  return { childName, component: component as Component };
}

/**
 * Resolve a bone's `assetRef` from its `childName` by finding the GltfChild that
 * carries it (childName is unique within an asset; first match wins across
 * assets, acceptable for the edit intercept). Returns null when no GltfChild
 * carries this childName.
 */
export function assetRefForChild(
  nodes: Record<string, NodeLike>,
  childName: string,
): string | null {
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfChild') continue;
    const p = node.params as { childName?: unknown; assetRef?: unknown } | undefined;
    if (p?.childName === childName && typeof p?.assetRef === 'string') return p.assetRef;
  }
  return null;
}

/**
 * Does a baked KeyframeChannel already exist for this bone? Matches by
 * `params.target === gltfChildDagId(assetRef, childName)` — the SAME key
 * paramAnimationState uses (BLOCK-2). True ⇒ the bone is already baked, skip the
 * bake and edit the channel directly.
 */
export function hasBakedChannel(
  nodes: Record<string, NodeLike>,
  assetRef: string,
  childName: string,
): boolean {
  const dagId = gltfChildDagId(assetRef, childName);
  for (const node of Object.values(nodes)) {
    if (!CHANNEL_TYPES.has(node.type)) continue;
    const p = node.params as { target?: unknown } | undefined;
    if (p?.target === dagId) return true;
  }
  return false;
}

/**
 * The deterministic baked-channel id for a bone's TRS component (D1's
 * gltfChannelDagId). After the bake lands, the edit re-targets THIS id without a
 * DAG round-trip (the composite references it directly — D1 makes it knowable).
 */
export function bakedChannelId(assetRef: string, childName: string, component: Component): string {
  return gltfChannelDagId(assetRef, childName, component);
}

export type { Component as ClipRowComponent };
