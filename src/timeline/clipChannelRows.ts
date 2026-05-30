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
